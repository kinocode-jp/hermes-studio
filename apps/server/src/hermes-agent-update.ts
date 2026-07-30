import { spawn, type ChildProcess } from "node:child_process";
import type { HermesAgentUpdateFailure, HermesAgentUpdatePhase, HermesAgentUpdateStatus } from "@hermes-studio/protocol";
import { createVersionProbeEnvironment, isRecognizedHermesVersion, probeHermesCli } from "./hermes-runtime.js";

const UPDATE_TIMEOUT_MS = 20 * 60 * 1_000;
const UPDATE_KILL_GRACE_MS = 5_000;
const UPDATE_SETTLEMENT_GRACE_MS = 1_000;
const SHUTDOWN_KILL_GRACE_MS = 2_000;
const SHUTDOWN_SETTLEMENT_GRACE_MS = 500;
const CHECK_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * Fixed-function Hermes Agent updater. Clients cannot supply an executable,
 * branch, shell fragment, or extra argument. The only allowed argv is the
 * stock `hermes update --yes` surface (or `--check` for availability).
 */
export class HermesAgentUpdateManager {
  #executable: string;
  #phase: HermesAgentUpdatePhase = "checking";
  #failure: HermesAgentUpdateFailure | undefined;
  #currentVersion: string | undefined;
  #updater: ChildProcess | undefined;
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #killTimeout: ReturnType<typeof setTimeout> | undefined;
  #checkFlight: Promise<HermesAgentUpdateStatus> | undefined;
  #postUpdateProbe: Promise<void> | undefined;
  #closeFlight: Promise<void> | undefined;
  readonly #closeController = new AbortController();
  #lastCheckedAt = 0;
  #closing = false;

  constructor(executable = "hermes") {
    this.#executable = executable.trim() || "hermes";
  }

  setExecutable(executable: string | undefined): void {
    const next = executable?.trim() || "hermes";
    if (next === this.#executable) return;
    this.#executable = next;
    // Invalidate cached probe after the managed runtime path changes.
    this.#lastCheckedAt = 0;
    if (this.#phase !== "updating") {
      this.#phase = "checking";
      this.#failure = undefined;
      this.#currentVersion = undefined;
    }
  }

  status(): HermesAgentUpdateStatus {
    return this.#statusDto();
  }

  async refresh(options: { force?: boolean } = {}): Promise<HermesAgentUpdateStatus> {
    if (this.#closing) return this.#statusDto();
    if (this.#updater !== undefined || this.#phase === "updating") return this.#statusDto();
    const force = options.force === true;
    const now = Date.now();
    if (!force && this.#checkFlight === undefined && now - this.#lastCheckedAt < 15_000 && this.#phase !== "checking") {
      return this.#statusDto();
    }
    if (this.#checkFlight !== undefined) return await this.#checkFlight;

    const flight = this.#runCheck();
    this.#checkFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.#checkFlight === flight) this.#checkFlight = undefined;
    }
  }

  startUpdate(): HermesAgentUpdateStatus {
    const current = this.#statusDto();
    if (this.#closing || current.phase === "updating" || !current.canUpdate) return current;
    if (this.#executable.includes("\0")) {
      this.#phase = "blocked";
      this.#failure = "executable_missing";
      return this.#statusDto();
    }

    this.#phase = "updating";
    this.#failure = undefined;
    const child = spawn(this.#executable, ["update", "--yes"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
      env: createVersionProbeEnvironment(),
    });
    this.#updater = child;
    this.#timeout = setTimeout(() => {
      if (this.#updater !== child) return;
      this.#failure = "update_timeout";
      this.#phase = "failed";
      child.kill("SIGTERM");
      this.#killTimeout = setTimeout(() => {
        if (this.#updater === child) child.kill("SIGKILL");
      }, UPDATE_KILL_GRACE_MS);
      this.#killTimeout.unref?.();
    }, UPDATE_TIMEOUT_MS);
    this.#timeout.unref?.();

    child.once("error", () => this.#finishUpdate(child, false));
    child.once("exit", (code) => this.#finishUpdate(child, code === 0));
    return this.#statusDto();
  }

  close(): Promise<void> {
    if (this.#closeFlight !== undefined) return this.#closeFlight;
    this.#closing = true;
    this.#closeController.abort();
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    if (this.#killTimeout !== undefined) clearTimeout(this.#killTimeout);
    this.#timeout = undefined;
    this.#killTimeout = undefined;
    const child = this.#updater;
    const checkFlight = this.#checkFlight;
    const postUpdateProbe = this.#postUpdateProbe;
    const flight = terminateChild(child, SHUTDOWN_KILL_GRACE_MS, SHUTDOWN_SETTLEMENT_GRACE_MS).then(async () => {
      if (this.#updater === child) this.#updater = undefined;
      await Promise.allSettled([
        ...(checkFlight === undefined ? [] : [checkFlight]),
        ...(postUpdateProbe === undefined ? [] : [postUpdateProbe]),
      ]);
    });
    this.#closeFlight = flight;
    return flight;
  }

  async #runCheck(): Promise<HermesAgentUpdateStatus> {
    this.#phase = this.#phase === "updating" ? "updating" : "checking";
    this.#failure = undefined;

    if (this.#executable.includes("\0")) {
      this.#phase = "blocked";
      this.#failure = "executable_missing";
      this.#currentVersion = undefined;
      this.#lastCheckedAt = Date.now();
      return this.#statusDto();
    }

    const cli = await probeHermesCli(this.#executable, 5_000, this.#closeController.signal);
    if (this.#closing) return this.#statusDto();
    if (cli.state !== "available" || cli.version === undefined) {
      this.#phase = "blocked";
      this.#failure = "executable_missing";
      this.#currentVersion = undefined;
      this.#lastCheckedAt = Date.now();
      return this.#statusDto();
    }
    this.#currentVersion = cli.version;

    const check = await runHermesUpdateCheck(this.#executable, CHECK_TIMEOUT_MS, this.#closeController.signal);
    if (this.#closing) return this.#statusDto();
    if (check.outcome === "available") {
      this.#phase = "available";
      this.#failure = undefined;
    } else if (check.outcome === "up_to_date") {
      this.#phase = "up_to_date";
      this.#failure = undefined;
    } else if (check.outcome === "unsupported") {
      this.#phase = "unsupported";
      this.#failure = "unsupported_install";
    } else {
      this.#phase = "failed";
      this.#failure = "check_failed";
    }
    this.#lastCheckedAt = Date.now();
    return this.#statusDto();
  }

  #finishUpdate(child: ChildProcess, succeeded: boolean): void {
    if (this.#updater !== child) return;
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    if (this.#killTimeout !== undefined) clearTimeout(this.#killTimeout);
    this.#timeout = undefined;
    this.#killTimeout = undefined;
    this.#updater = undefined;

    if (this.#closing) return;

    if (!succeeded) {
      this.#phase = "failed";
      this.#failure ??= "update_failed";
      return;
    }

    let probe: Promise<void>;
    probe = probeHermesCli(this.#executable, 5_000, this.#closeController.signal).then((cli) => {
      if (this.#closing || this.#updater !== undefined) return;
      if (cli.state === "available" && cli.version !== undefined) {
        this.#currentVersion = cli.version;
        this.#phase = "updated";
        this.#failure = undefined;
      } else {
        this.#phase = "failed";
        this.#failure = "update_failed";
      }
      this.#lastCheckedAt = 0;
    }).catch(() => {
      if (this.#closing || this.#updater !== undefined) return;
      this.#phase = "failed";
      this.#failure = "update_failed";
    }).finally(() => {
      if (this.#postUpdateProbe === probe) this.#postUpdateProbe = undefined;
    });
    this.#postUpdateProbe = probe;
  }

  #statusDto(): HermesAgentUpdateStatus {
    const canUpdate = (this.#phase === "available" || this.#phase === "failed") && this.#updater === undefined;
    return {
      phase: this.#phase,
      canUpdate,
      updateMethod: "hermes-update",
      ...(this.#currentVersion === undefined ? {} : { currentVersion: this.#currentVersion }),
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
    };
  }
}

async function terminateChild(
  child: ChildProcess | undefined,
  termGraceMs: number,
  settlementGraceMs: number,
): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
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
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      settlementTimer = setTimeout(finish, settlementGraceMs);
    }, termGraceMs);
  });
}

type UpdateCheckOutcome = "available" | "up_to_date" | "unsupported" | "failed";

async function runHermesUpdateCheck(
  executable: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ outcome: UpdateCheckOutcome }> {
  if (signal?.aborted === true) return { outcome: "failed" };
  return await new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopping: Promise<void> | undefined;
    const finish = (outcome: UpdateCheckOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ outcome });
    };

    const child = spawn(executable, ["update", "--check"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: createVersionProbeEnvironment(),
    });
    const stop = (termGraceMs: number): void => {
      stopping ??= terminateChild(child, termGraceMs, UPDATE_SETTLEMENT_GRACE_MS)
        .finally(() => finish("failed"));
    };
    const abort = (): void => stop(UPDATE_KILL_GRACE_MS);
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => stop(0), timeoutMs);
    timer.unref();

    const capture = (chunk: Buffer): void => {
      if (output.length >= MAX_OUTPUT_BYTES) return;
      output += chunk.toString("utf8", 0, MAX_OUTPUT_BYTES - output.length);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", () => finish("failed"));
    child.on("close", (code) => {
      const text = output;
      if (/unsupported|not a git|install method|cannot update|unknown command/i.test(text)) {
        finish("unsupported");
        return;
      }
      if (/update available|commits? behind|behind origin|new version/i.test(text)) {
        finish("available");
        return;
      }
      if (/up to date|already up|no update|latest version|nothing to update/i.test(text)) {
        finish("up_to_date");
        return;
      }
      // Some Hermes builds exit 0 when current and non-zero when behind.
      if (code === 0) {
        finish("up_to_date");
        return;
      }
      finish("failed");
    });
  });
}

export function createHermesAgentUpdateManager(executable?: string): HermesAgentUpdateManager {
  return new HermesAgentUpdateManager(executable);
}

// Re-export for tests that need version recognition parity.
export { isRecognizedHermesVersion };
