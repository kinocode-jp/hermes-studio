import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
  HermesSettingsError,
  type HermesProfileBackendAccess,
  type HermesProfileBackendResolveOptions,
} from "./hermes-settings.js";
import { createHermesChildEnvironment, discardHermesChildOutput } from "./hermes-child-environment.js";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHILD_STOP_GRACE_MS = 3_000;
const CHILD_SETTLEMENT_GRACE_MS = 1_000;
type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export interface HermesProfileBackendPoolOptions {
  executable: string;
  startTimeoutMs?: number;
  maxBackends?: number;
  cwd?: string;
  isKnownProfile?: (profile: string) => Promise<boolean>;
}

interface PoolEntry {
  baseUrl: string;
  sessionToken: string;
  child: ManagedChild;
  lastUsed: number;
  leases: number;
}

interface StartSlot { promise: Promise<PoolEntry>; leases: number }

/** Lease-aware LRU pool for Hermes APIs whose scope is the process HERMES_HOME. */
export class HermesProfileBackendPool {
  readonly #options: Required<Omit<HermesProfileBackendPoolOptions, "isKnownProfile">>
    & Pick<HermesProfileBackendPoolOptions, "isKnownProfile">;
  readonly #entries = new Map<string, PoolEntry>();
  readonly #starts = new Map<string, StartSlot>();
  readonly #capacityWaiters = new Set<() => void>();
  #allocationTail = Promise.resolve();
  #closed = false;

  constructor(options: HermesProfileBackendPoolOptions) {
    if (options.executable.trim() === "" || options.executable.includes("\0")) throw new Error("Hermes executable is invalid.");
    this.#options = {
      executable: options.executable,
      startTimeoutMs: bounded(options.startTimeoutMs, 20_000, 1_000, 60_000),
      maxBackends: bounded(options.maxBackends, 4, 1, 16),
      cwd: options.cwd ?? process.cwd(),
      ...(options.isKnownProfile === undefined ? {} : { isKnownProfile: options.isKnownProfile }),
    };
  }

  async resolve(profile: string, request: HermesProfileBackendResolveOptions = {}): Promise<HermesProfileBackendAccess> {
    if (this.#closed) throw new Error("Hermes profile backend pool is closed.");
    assertAcquisitionActive(request);
    if (!PROFILE_PATTERN.test(profile)) throw new Error("Hermes profile name is invalid.");
    // Reusing a backend already proven to belong to this profile must not hit
    // the global profile inventory again. Bulk operations otherwise turn one
    // validation into N slow inventory requests and time out before reaching
    // the profile-scoped API.
    const existing = this.#entries.get(profile);
    if (existing !== undefined && isChildRunning(existing.child)) {
      existing.leases += 1;
      return this.#publicLease(existing);
    }
    if (existing !== undefined) this.#entries.delete(profile);
    const starting = this.#starts.get(profile);
    if (starting !== undefined) {
      starting.leases += 1;
      return await this.#settleReservedLease(starting.promise, request);
    }

    if (this.#options.isKnownProfile !== undefined) {
      const known = await settleAcquisition(this.#options.isKnownProfile(profile), request);
      if (!known) throw new HermesSettingsError("not_found", "Hermes profile does not exist.");
    }
    assertAcquisitionActive(request);

    const allocation = await this.#allocate(profile, request);
    return await this.#settleReservedLease(allocation.promise, request);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#notifyCapacity();
    await this.#allocationTail;
    await Promise.allSettled([...this.#starts.values()].map((slot) => slot.promise));
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(async (entry) => await stopChild(entry.child)));
  }

  async #start(profile: string): Promise<PoolEntry> {
    const sessionToken = randomBytes(32).toString("base64url");
    const child = spawn(
      this.#options.executable,
      ["--profile", profile, "serve", "--host", "127.0.0.1", "--port", "0"],
      {
        cwd: this.#options.cwd,
        env: createHermesChildEnvironment({ sessionToken, cwd: this.#options.cwd }),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    // Observe process death from the instant spawn returns. READY and exit can
    // occur in the same turn; installing this only after readiness loses that
    // exit forever and leaves a dead entry cached.
    child.once("exit", () => {
      if (this.#entries.get(profile)?.child === child) this.#entries.delete(profile);
      this.#notifyCapacity();
    });
    const port = await waitForReadyPort(child, this.#options.startTimeoutMs).catch(async (error: unknown) => {
      await stopChild(child);
      throw error;
    });
    if (this.#closed) { await stopChild(child); throw new Error("Hermes profile backend pool is closed."); }
    const entry: PoolEntry = { child, baseUrl: `http://127.0.0.1:${port}`, sessionToken, lastUsed: Date.now(), leases: 0 };
    return entry;
  }

  async #allocate(profile: string, request: HermesProfileBackendResolveOptions): Promise<{ promise: Promise<PoolEntry> }> {
    while (true) {
      assertAcquisitionActive(request);
      const previous = this.#allocationTail;
      let release!: () => void;
      this.#allocationTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      let waitForCapacity = false;
      try {
        assertAcquisitionActive(request);
        if (this.#closed) throw new Error("Hermes profile backend pool is closed.");
        const existing = this.#entries.get(profile);
        if (existing !== undefined && isChildRunning(existing.child)) {
          existing.leases += 1;
          return { promise: Promise.resolve(existing) };
        }
        if (existing !== undefined) this.#entries.delete(profile);
        const starting = this.#starts.get(profile);
        if (starting !== undefined) {
          starting.leases += 1;
          return { promise: starting.promise };
        }

        if (this.#entries.size + this.#starts.size >= this.#options.maxBackends) {
          if (this.#oldestIdle() !== undefined) await this.#evictOldestIdle();
          else waitForCapacity = true;
        }

        if (!waitForCapacity) {
          assertAcquisitionActive(request);
          const started = this.#start(profile);
          const slot = { promise: started, leases: 1 } satisfies StartSlot;
          let tracked!: Promise<PoolEntry>;
          tracked = started.then(
            (entry) => {
              if (this.#starts.get(profile) === slot) this.#starts.delete(profile);
              if (!isChildRunning(entry.child)) {
                this.#notifyCapacity();
                throw new Error("Hermes profile process exited during startup.");
              }
              entry.leases = slot.leases;
              this.#entries.set(profile, entry);
              return entry;
            },
            (error: unknown) => {
              if (this.#starts.get(profile) === slot) this.#starts.delete(profile);
              this.#notifyCapacity();
              throw error;
            },
          );
          slot.promise = tracked;
          this.#starts.set(profile, slot);
          return { promise: tracked };
        }
      } finally {
        release();
      }
      // Capacity waits must not hold the global allocation gate. Expired
      // callers therefore disappear without blocking or starting later work.
      await this.#waitForCapacity(request);
    }
  }

  #oldestIdle(): [string, PoolEntry] | undefined {
    let oldest: [string, PoolEntry] | undefined;
    for (const item of this.#entries) {
      if (item[1].leases === 0 && (oldest === undefined || item[1].lastUsed < oldest[1].lastUsed)) oldest = item;
    }
    return oldest;
  }

  async #evictOldestIdle(): Promise<void> {
    const oldest = this.#oldestIdle();
    if (oldest === undefined) return;
    this.#entries.delete(oldest[0]);
    await stopChild(oldest[1].child);
    this.#notifyCapacity();
  }

  async #waitForCapacity(request: HermesProfileBackendResolveOptions): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: HermesSettingsError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", aborted);
        this.#capacityWaiters.delete(ready);
        if (error === undefined) resolve(); else reject(error);
      };
      const ready = (): void => finish();
      const aborted = (): void => finish(acquisitionTimedOut());
      const deadlineRemaining = request.deadlineMs === undefined
        ? this.#options.startTimeoutMs
        : request.deadlineMs - Date.now();
      if (deadlineRemaining <= 0 || request.signal?.aborted === true) {
        reject(acquisitionTimedOut());
        return;
      }
      const timer = setTimeout(
        () => finish(request.deadlineMs !== undefined && request.deadlineMs <= Date.now()
          ? acquisitionTimedOut()
          : new HermesSettingsError("timed_out", "Hermes profile capacity is busy.")),
        Math.min(this.#options.startTimeoutMs, deadlineRemaining),
      );
      timer.unref();
      this.#capacityWaiters.add(ready);
      request.signal?.addEventListener("abort", aborted, { once: true });
      if (signalIsAborted(request.signal)) aborted();
    });
  }

  #notifyCapacity(): void {
    const waiters = [...this.#capacityWaiters];
    this.#capacityWaiters.clear();
    for (const ready of waiters) ready();
  }

  #publicLease(entry: PoolEntry): HermesProfileBackendAccess {
    let released = false;
    return {
      baseUrl: entry.baseUrl,
      sessionToken: entry.sessionToken,
      release: () => {
        if (released) return;
        released = true;
        this.#releaseEntry(entry);
      },
    };
  }

  async #settleReservedLease(
    promise: Promise<PoolEntry>,
    request: HermesProfileBackendResolveOptions,
  ): Promise<HermesProfileBackendAccess> {
    try {
      return this.#publicLease(await settleAcquisition(promise, request));
    } catch (error) {
      // The shared start cannot be cancelled safely. If it eventually succeeds,
      // release this caller's reservation without pinning the idle backend.
      void promise.then((entry) => this.#releaseEntry(entry), () => undefined);
      throw error;
    }
  }

  #releaseEntry(entry: PoolEntry): void {
    entry.leases = Math.max(0, entry.leases - 1);
    entry.lastUsed = Date.now();
    this.#notifyCapacity();
  }
}

async function waitForReadyPort(child: ManagedChild, timeoutMs: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error, port?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener("data", inspect);
      child.stderr.removeListener("data", inspect);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      discardHermesChildOutput(child);
      if (error !== undefined) reject(error); else resolve(port!);
    };
    const inspect = (chunk: Buffer): void => {
      if (output.length < 32 * 1024) output += chunk.toString("utf8", 0, 32 * 1024 - output.length);
      const match = /HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d{1,5})/.exec(output);
      const port = match === null ? 0 : Number(match[1]);
      if (port >= 1 && port <= 65_535) finish(undefined, port);
      else if (output.length >= 32 * 1024) finish(new Error("Hermes profile startup output exceeded its limit."));
    };
    const onError = (): void => finish(new Error("Hermes profile process failed to start."));
    const onExit = (): void => finish(new Error("Hermes profile process exited before readiness."));
    const timer = setTimeout(() => finish(new Error("Hermes profile process startup timed out.")), timeoutMs);
    timer.unref();
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", onError);
    child.once("exit", onExit);
    if (!isChildRunning(child)) onExit();
  });
}

async function stopChild(child: ManagedChild): Promise<void> {
  if (!isChildRunning(child)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
      child.off("close", finish);
      resolve();
    };
    child.once("close", finish);
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (isChildRunning(child)) child.kill("SIGKILL");
      settlementTimer = setTimeout(finish, CHILD_SETTLEMENT_GRACE_MS);
    }, CHILD_STOP_GRACE_MS);
  });
}

function isChildRunning(child: ManagedChild): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function acquisitionTimedOut(): HermesSettingsError {
  return new HermesSettingsError("timed_out", "Hermes profile backend acquisition timed out.");
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function assertAcquisitionActive(request: HermesProfileBackendResolveOptions): void {
  if (request.signal?.aborted === true || (request.deadlineMs !== undefined && request.deadlineMs <= Date.now())) {
    throw acquisitionTimedOut();
  }
}

async function settleAcquisition<T>(operation: Promise<T>, request: HermesProfileBackendResolveOptions): Promise<T> {
  assertAcquisitionActive(request);
  if (request.deadlineMs === undefined && request.signal === undefined) return await operation;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      request.signal?.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error); else resolve(value as T);
    };
    const aborted = (): void => finish(acquisitionTimedOut());
    request.signal?.addEventListener("abort", aborted, { once: true });
    if (request.signal?.aborted === true) aborted();
    if (request.deadlineMs !== undefined) {
      timer = setTimeout(aborted, Math.max(1, request.deadlineMs - Date.now()));
      timer.unref();
    }
    operation.then((value) => finish(undefined, value), (error: unknown) => finish(error));
  });
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))); }
