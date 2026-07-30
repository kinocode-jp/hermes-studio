import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  KanbanBoardSummary,
  OfficeInventoryKind,
  OfficeInventoryPage,
  OfficeInventoryMetadata,
  OfficeSnapshot,
  RuntimeStatus,
} from "@hermes-studio/protocol";
import { brandStatePath } from "./brand-env.js";
import { OFFICE_PROTOCOL_VERSION } from "./demo-state.js";
import { createHermesChatTransport, type HermesChatTransport } from "./hermes-chat.js";
import { createHermesChildEnvironment, discardHermesChildOutput } from "./hermes-child-environment.js";
import { collectHermesInventory, HermesInventoryCache, type CollectedHermesInventory, type HermesJsonResult } from "./hermes-inventory.js";
import { createHermesKanbanHttpRequester, HermesKanbanAdapter } from "./hermes-kanban.js";
import { GlobalInheritanceCoordinator } from "./global-inheritance.js";
import { HermesProfileBackendPool } from "./hermes-profile-pool.js";
import { isRecognizedHermesVersion, probeHermesCli } from "./hermes-runtime.js";
import {
  createHermesSettingsAdapter,
  OfficeGlobalSettingsStore,
  type HermesProfileBackendAccess,
  type HermesProfileBackendResolveOptions,
  type HermesSettingsAdapter,
} from "./hermes-settings.js";
import { createHermesModelsAdapter, type HermesModelsAdapter } from "./hermes-models.js";
import { createHermesProjectsAdapter, type HermesProjectsAdapter } from "./hermes-projects.js";
import { OfficeAgentBehaviorStore } from "./office-agent-behavior.js";
import type { OfficeTeamSkillLayer } from "./office-teams.js";

const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_START_OUTPUT = 32 * 1024;
const MANAGED_RESTART_ATTEMPTS = 3;
const MANAGED_RESTART_BACKOFF_MS = 250;
const CHILD_STOP_GRACE_MS = 3_000;
const CHILD_SETTLEMENT_GRACE_MS = 1_000;

export interface HermesBackendOptions {
  executable?: string;
  baseUrl?: string;
  sessionToken?: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
  globalSettingsPath?: string;
  agentBehaviorPath?: string;
  maxProfileBackends?: number;
  managedRestartAttempts?: number;
  managedRestartBackoffMs?: number;
  /** Test/custom resolver for APIs whose storage is scoped by HERMES_HOME. */
  resolveProfileBackend?(profile: string, options?: HermesProfileBackendResolveOptions): Promise<HermesProfileBackendAccess>;
  /** Middle inheritance tier: teams that contribute skills/context per profile. */
  listTeamLayers?(): Promise<readonly OfficeTeamSkillLayer[]>;
}

export interface HermesRuntimeSource {
  status(): RuntimeStatus;
  snapshot(): Promise<OfficeSnapshot>;
  inventoryPage?(kind: OfficeInventoryKind, cursor: string, limit: number): Promise<OfficeInventoryPage>;
  /** Permanently delete a durable Hermes session. Absent ids are treated as success. */
  deleteSession?(profile: string, sessionId: string): Promise<void>;
  deleteSessions?(profile: string, sessionIds: readonly string[]): Promise<void>;
  /** Create a durable Hermes profile (proxied to upstream POST /api/profiles). */
  createProfile?(name: string, options?: { cloneFromDefault?: boolean; description?: string }): Promise<void>;
  /** Permanently delete a Hermes profile and its local state. */
  deleteProfile?(name: string): Promise<void>;
  close(): Promise<void>;
  chat(options?: { maxEventBytes?: number }): HermesChatTransport;
  kanban(): HermesKanbanAdapter;
  settings?(): HermesSettingsAdapter;
  models?(): HermesModelsAdapter;
  projects?(): HermesProjectsAdapter;
  globalSettings?(): OfficeGlobalSettingsStore;
  globalInheritance?(): GlobalInheritanceCoordinator;
  agentBehavior?(): OfficeAgentBehaviorStore;
  onStatusChange?(listener: (status: RuntimeStatus) => void): () => void;
}

export class HermesCommitUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesCommitUnconfirmedError";
  }
}

export class HermesProfileError extends Error {
  constructor(readonly code: "invalid" | "exists" | "not_found" | "default") {
    super(`Hermes profile operation failed: ${code}.`);
    this.name = "HermesProfileError";
  }
}

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;
type ConnectionGeneration = { generation: number; baseUrl: URL; token: string };
type SnapshotCollection = { inventory: CollectedHermesInventory; boards: KanbanBoardSummary[] };
type SnapshotRefresh = { generation: number; promise: Promise<SnapshotCollection> };

export class HermesBackend implements HermesRuntimeSource {
  readonly #options: HermesBackendOptions;
  #child: ManagedChild | undefined;
  #baseUrl: URL | undefined;
  #token: string | undefined;
  #state: RuntimeStatus;
  #sequence = 0;
  readonly #profilePool: HermesProfileBackendPool;
  readonly #resolveProfileBackend: (profile: string, options?: HermesProfileBackendResolveOptions) => Promise<HermesProfileBackendAccess>;
  readonly #globalSettings: OfficeGlobalSettingsStore;
  readonly #agentBehavior: OfficeAgentBehaviorStore;
  readonly #inventory = new HermesInventoryCache();
  #snapshotRefresh: SnapshotRefresh | undefined;
  #globalInheritance?: GlobalInheritanceCoordinator;
  #settingsAdapter?: HermesSettingsAdapter;
  #modelsAdapter?: HermesModelsAdapter;
  #projectsAdapter?: HermesProjectsAdapter;
  #childGeneration = 0;
  #connectionGeneration = 0;
  #startFlight: Promise<RuntimeStatus> | undefined;
  #closeFlight: Promise<void> | undefined;
  #recoveryFlight: Promise<void> | undefined;
  #shutdownRequested = false;
  readonly #shutdownController = new AbortController();
  readonly #statusListeners = new Set<(status: RuntimeStatus) => void>();

  constructor(options: HermesBackendOptions = {}) {
    this.#options = options;
    this.#profilePool = new HermesProfileBackendPool({
      executable: options.executable?.trim() || "hermes",
      ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
      ...(options.maxProfileBackends === undefined ? {} : { maxBackends: options.maxProfileBackends }),
      isKnownProfile: async (profile) => recordArray(await this.#requestJson("/api/profiles"), "profiles")
        .some((item) => item.name === profile),
    });
    this.#resolveProfileBackend = options.resolveProfileBackend
      ?? (async (profile, resolveOptions) => {
        // The managed sidecar already owns the default HERMES_HOME. Starting
        // `hermes --profile default serve` creates a second writer for the same
        // state.db and log files, which can split live-session ownership after a
        // reconnect. Reuse the primary sidecar and keep the lease API symmetric.
        if (profile === "default") {
          if (resolveOptions?.signal?.aborted === true
            || (resolveOptions?.deadlineMs !== undefined && resolveOptions.deadlineMs <= Date.now())) {
            throw new Error("Hermes profile backend acquisition timed out.");
          }
          const { baseUrl, token } = this.#connectionConfig();
          return { baseUrl: baseUrl.origin, sessionToken: token, release: () => undefined };
        }
        return await this.#profilePool.resolve(profile, resolveOptions);
      });
    this.#globalSettings = new OfficeGlobalSettingsStore(
      options.globalSettingsPath ?? brandStatePath("global-settings.json"),
    );
    this.#agentBehavior = new OfficeAgentBehaviorStore(
      options.agentBehaviorPath ?? brandStatePath("agent-behavior.json"),
    );
    this.#state = {
      mode: options.baseUrl === undefined ? "managed-sidecar" : "existing-local",
      state: "unconfigured",
      adapterVersion: "0.2.0",
    };
  }

  status(): RuntimeStatus {
    return { ...this.#state };
  }

  onStatusChange(listener: (status: RuntimeStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  chat(options: { maxEventBytes?: number } = {}): HermesChatTransport {
    const { baseUrl, token } = this.#connectionConfig();
    const maxEventBytes = options.maxEventBytes;
    return createHermesChatTransport({
      baseUrl,
      sessionToken: token,
      ...(maxEventBytes === undefined ? {} : {
        maxFrameBytes: Math.max(4_096, maxEventBytes),
        maxTextBytes: Math.max(1_024, maxEventBytes - 2_048),
      }),
    });
  }

  kanban(): HermesKanbanAdapter {
    const { baseUrl, token } = this.#connectionConfig();
    return new HermesKanbanAdapter({
      request: createHermesKanbanHttpRequester({ baseUrl: baseUrl.origin, sessionToken: token }),
      listAllowedProfiles: async () => recordArray(await this.#requestJson("/api/profiles"), "profiles")
        .flatMap((profile) => typeof profile.name === "string" ? [profile.name] : []),
    });
  }

  settings(): HermesSettingsAdapter {
    this.#settingsAdapter ??= createHermesSettingsAdapter({
      resolveProfileBackend: async (profile, resolveOptions) => {
        if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
        return await this.#resolveProfileBackend(profile, resolveOptions);
      },
      ...(this.#options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.#options.requestTimeoutMs }),
    });
    return this.#settingsAdapter;
  }

  models(): HermesModelsAdapter {
    this.#modelsAdapter ??= createHermesModelsAdapter({
      resolveProfileBackend: async (profile, resolveOptions) => {
        if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
        return await this.#resolveProfileBackend(profile, resolveOptions);
      },
      ...(this.#options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.#options.requestTimeoutMs }),
    });
    return this.#modelsAdapter;
  }

  projects(): HermesProjectsAdapter {
    this.#projectsAdapter ??= createHermesProjectsAdapter({
      resolveProfileBackend: async (profile, resolveOptions) => {
        if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
        return await this.#resolveProfileBackend(profile, resolveOptions);
      },
      ...(this.#options.requestTimeoutMs === undefined ? {} : { timeoutMs: this.#options.requestTimeoutMs }),
    });
    return this.#projectsAdapter;
  }

  globalSettings(): OfficeGlobalSettingsStore {
    return this.#globalSettings;
  }

  agentBehavior(): OfficeAgentBehaviorStore {
    return this.#agentBehavior;
  }

  globalInheritance(): GlobalInheritanceCoordinator {
    this.#globalInheritance ??= new GlobalInheritanceCoordinator({
      store: this.#globalSettings,
      settings: this.settings(),
      listProfiles: async () => recordArray(await this.#requestJson("/api/profiles"), "profiles")
        .flatMap((profile) => typeof profile.name === "string" ? [profile.name] : []),
      ...(this.#options.listTeamLayers === undefined
        ? {}
        : { listTeamLayers: this.#options.listTeamLayers }),
    });
    return this.#globalInheritance;
  }

  start(): Promise<RuntimeStatus> {
    if (this.#state.state === "ready" || this.#shutdownRequested) return Promise.resolve(this.status());
    if (this.#startFlight !== undefined) return this.#startFlight;
    const flight = this.#startInitial();
    this.#startFlight = flight;
    void flight.finally(() => {
      if (this.#startFlight === flight) this.#startFlight = undefined;
    }).catch(() => undefined);
    return flight;
  }

  async #startInitial(): Promise<RuntimeStatus> {
    if (this.#recoveryFlight !== undefined) {
      await this.#recoveryFlight;
      if (this.#shutdownRequested) return this.status();
      return this.status();
    }
    this.#setState({ ...this.#state, state: "starting", compatibilityMessage: "Hermes backendを確認しています。" });

    const attempts = this.#options.baseUrl === undefined ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (this.#options.baseUrl !== undefined) {
          this.#baseUrl = safeLoopbackOrigin(this.#options.baseUrl);
          this.#token = requiredToken(this.#options.sessionToken);
          this.#connectionGeneration += 1;
        } else {
          const executable = this.#options.executable?.trim() || "hermes";
          const cli = await probeHermesCli(executable, 5_000);
          if (this.#shutdownRequested) return this.status();
          if (cli.state !== "available" || cli.version === undefined) {
            throw new Error("Hermes CLI is unavailable or unsupported.");
          }
          await this.#spawnManaged();
          if (this.#shutdownRequested) { await this.#stopChild(); return this.status(); }
        }
        const version = await this.#compatibleVersion();
        if (this.#shutdownRequested) { await this.#stopChild(); return this.status(); }
        if (!this.#observeManagedChild()) throw new Error("Hermes process exited during startup.");
        if (this.#shutdownRequested) { await this.#stopChild(); return this.status(); }
        this.#setState({
          ...this.#state,
          state: "ready",
          hermesVersion: version,
          compatibilityMessage: "Hermes runtimeに接続済み",
        });
        return this.status();
      } catch (error) {
        lastError = error;
        await this.#stopChild();
        if (this.#shutdownRequested) return this.status();
        if (error instanceof IncompatibleHermesError) break;
      }
    }
    if (this.#shutdownRequested) return this.status();
    const incompatible = lastError instanceof IncompatibleHermesError;
    this.#setState({
      ...this.#state,
      state: incompatible ? "incompatible" : "unreachable",
      compatibilityMessage: incompatible
        ? "HermesのAPI契約を確認してください。"
        : this.#options.baseUrl === undefined
          ? "Hermes runtimeを起動できませんでした。再試行しています。"
          : "Hermes runtimeを起動できませんでした。",
    });
    if (!incompatible) this.#startRecovery();
    return this.status();
  }

  async snapshot(): Promise<OfficeSnapshot> {
    if (this.#state.state !== "ready") return unavailableSnapshot(this.status(), ++this.#sequence);

    try {
      const connection = this.#captureConnection();
      const { inventory, boards } = await this.#collectSnapshotData(connection);
      if (!this.#isCurrentConnection(connection)) {
        return unavailableSnapshot(this.status(), ++this.#sequence);
      }
      const firstPage = this.#inventory.replace(inventory);
      if (!this.#isCurrentConnection(connection)) {
        return unavailableSnapshot(this.status(), ++this.#sequence);
      }
      this.#setState({ ...this.#state, state: "ready", compatibilityMessage: "Hermes runtimeに接続済み" });
      return makeSnapshot(this.status(), ++this.#sequence, firstPage.profiles, firstPage.sessions, firstPage.metadata, boards);
    } catch {
      // A transient snapshot failure must not disable chat/settings for the
      // rest of the process lifetime. Keep the established transport usable;
      // the next snapshot refresh can recover the visible state.
      const degraded = { ...this.#state, compatibilityMessage: "Hermesの状態を再取得しています。" };
      return unavailableSnapshot(degraded, ++this.#sequence);
    }
  }

  async inventoryPage(kind: OfficeInventoryKind, cursor: string, limit: number): Promise<OfficeInventoryPage> {
    if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
    return this.#inventory.page(kind, cursor, limit);
  }

  async deleteSession(profile: string, sessionId: string): Promise<void> {
    await this.deleteSessions(profile, [sessionId]);
  }

  async deleteSessions(profile: string, sessionIds: readonly string[]): Promise<void> {
    if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
    const safeProfile = requireProfile(profile);
    const safeSessionIds = [...new Set(sessionIds.map(requireSessionId))];
    if (safeSessionIds.length === 0 || safeSessionIds.length > 500) {
      throw new Error("Hermes session delete batch size is invalid.");
    }
    const result = await this.#requestJson(
      "/api/sessions/bulk-delete",
      true,
      15_000,
      undefined,
      { method: "POST", body: { ids: safeSessionIds, profile: safeProfile } },
    );
    const deleted = isRecord(result) ? result.deleted : undefined;
    if (!isRecord(result) || result.ok !== true || !Number.isSafeInteger(deleted)
      || (deleted as number) < 0 || (deleted as number) > safeSessionIds.length) {
      throw new Error("Hermes did not confirm durable session deletion.");
    }
    this.#inventory.clear();
    this.#snapshotRefresh = undefined;
  }

  async createProfile(name: string, options?: { cloneFromDefault?: boolean; description?: string }): Promise<void> {
    if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
    const safeName = requireProfile(name);
    try {
      await this.#requestJson("/api/profiles", true, undefined, undefined, {
        method: "POST",
        body: {
          name: safeName,
          clone_from_default: options?.cloneFromDefault !== false,
          ...(options?.description === undefined ? {} : { description: options.description }),
        },
      });
    } catch (error) {
      if (error instanceof IncompatibleHermesError && error.status === 400) throw new HermesProfileError("invalid");
      if (error instanceof IncompatibleHermesError && error.status === 409) throw new HermesProfileError("exists");
      throw error;
    }
    this.#inventory.clear();
    this.#snapshotRefresh = undefined;
  }

  async deleteProfile(name: string): Promise<void> {
    if (this.#state.state !== "ready") throw new Error("Hermes backend is not ready.");
    const safeName = requireProfile(name);
    if (safeName === "default") throw new HermesProfileError("default");
    try {
      await this.#requestJson(`/api/profiles/${encodeURIComponent(safeName)}`, true, undefined, undefined, { method: "DELETE" });
    } catch (error) {
      if (error instanceof IncompatibleHermesError && error.status === 400) throw new HermesProfileError("invalid");
      if (error instanceof IncompatibleHermesError && error.status === 404) throw new HermesProfileError("not_found");
      throw error;
    }
    this.#inventory.clear();
    this.#snapshotRefresh = undefined;
  }

  async #collectSnapshotData(connection: ConnectionGeneration): Promise<SnapshotCollection> {
    const current = this.#snapshotRefresh;
    if (current?.generation === connection.generation) return await current.promise;
    const refresh = Promise.all([
      collectHermesInventory(async (path, timeoutMs) => await this.#requestJsonResult(path, true, timeoutMs, connection)),
      this.#collectBoardSummaries(connection),
    ]).then(([inventory, boards]) => ({ inventory, boards }));
    const entry = { generation: connection.generation, promise: refresh };
    this.#snapshotRefresh = entry;
    try {
      return await refresh;
    } finally {
      if (this.#snapshotRefresh === entry) this.#snapshotRefresh = undefined;
    }
  }

  async #collectBoardSummaries(connection: ConnectionGeneration): Promise<KanbanBoardSummary[]> {
    try {
      return mapBoards((await this.#requestJsonResult("/api/plugins/kanban/board", true, undefined, connection)).value);
    } catch {
      // Kanban is an optional, independently-failing feature. An unavailable
      // or incompatible board must not discard otherwise healthy inventory.
      return emptyBoards();
    }
  }

  close(): Promise<void> {
    if (this.#closeFlight !== undefined) return this.#closeFlight;
    if (this.#state.state === "stopped") return Promise.resolve();
    this.#shutdownRequested = true;
    this.#shutdownController.abort();
    this.#setState({ ...this.#state, state: "stopping" });
    const flight = this.#closeLifecycle(this.#startFlight, this.#recoveryFlight);
    this.#closeFlight = flight;
    return flight;
  }

  async #closeLifecycle(startFlight: Promise<RuntimeStatus> | undefined, recoveryFlight: Promise<void> | undefined): Promise<void> {
    const stopFlight = this.#stopChild();
    const lifecycleFlights: Promise<unknown>[] = [stopFlight];
    if (startFlight !== undefined) lifecycleFlights.push(startFlight);
    if (recoveryFlight !== undefined) lifecycleFlights.push(recoveryFlight);
    await Promise.allSettled(lifecycleFlights);
    await Promise.all([this.#stopChild(), this.#profilePool.close()]);
    this.#setState({ ...this.#state, state: "stopped" });
  }

  async #spawnManaged(): Promise<void> {
    if (this.#shutdownRequested) throw new Error("Hermes backend is shutting down.");
    const executable = this.#options.executable?.trim() || "hermes";
    if (executable.includes("\0")) throw new Error("Invalid Hermes executable.");
    const token = randomBytes(32).toString("base64url");
    const child = spawn(executable, ["serve", "--host", "127.0.0.1", "--port", "0"], {
      cwd: process.cwd(),
      env: createHermesChildEnvironment({ sessionToken: token, cwd: process.cwd() }),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#childGeneration += 1;
    this.#child = child;
    this.#token = token;
    const port = await waitForReadyPort(child, bounded(this.#options.startTimeoutMs, START_TIMEOUT_MS, 1_000, 60_000));
    if (this.#shutdownRequested || this.#child !== child) throw new Error("Hermes startup was cancelled.");
    this.#baseUrl = new URL(`http://127.0.0.1:${port}`);
    this.#connectionGeneration += 1;
  }

  #observeManagedChild(): boolean {
    if (this.#options.baseUrl !== undefined) return true;
    const child = this.#child;
    const generation = this.#childGeneration;
    if (child === undefined) return false;
    const onExit = (): void => this.#handleManagedExit(child, generation);
    child.once("exit", onExit);
    if (child.exitCode !== null) {
      child.off("exit", onExit);
      return false;
    }
    return true;
  }

  async #compatibleVersion(): Promise<string> {
    const raw = await this.#requestJson("/api/status", false);
    const version = readString(raw, "version");
    if (version === undefined) throw new IncompatibleHermesError("Hermes status contract is unavailable.");
    if (!isRecognizedHermesVersion(version)) throw new IncompatibleHermesError("Hermes API version is invalid.");
    return version;
  }

  #handleManagedExit(child: ManagedChild, generation: number): void {
    if (this.#shutdownRequested || this.#child !== child || this.#childGeneration !== generation) return;
    this.#child = undefined;
    this.#invalidateConnection();
    this.#setState({ ...this.#state, state: "unreachable", compatibilityMessage: "Hermes runtimeが終了したため再起動しています。" });
    this.#startRecovery();
  }

  #startRecovery(): void {
    if (this.#shutdownRequested || this.#options.baseUrl !== undefined || this.#recoveryFlight !== undefined) return;
    const recovery = this.#recoverManaged();
    this.#recoveryFlight = recovery;
    void recovery.finally(() => {
      if (this.#recoveryFlight === recovery) this.#recoveryFlight = undefined;
    }).catch(() => undefined);
  }

  async #recoverManaged(): Promise<void> {
    const attempts = bounded(this.#options.managedRestartAttempts, MANAGED_RESTART_ATTEMPTS, 1, 5);
    const backoffMs = bounded(this.#options.managedRestartBackoffMs, MANAGED_RESTART_BACKOFF_MS, 10, 5_000);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await delay(backoffMs * (attempt + 1), this.#shutdownController.signal);
      if (this.#shutdownRequested) return;
      this.#setState({ ...this.#state, state: "starting", compatibilityMessage: `Hermes runtimeを再起動しています (${attempt + 1}/${attempts})。` });
      try {
        await this.#spawnManaged();
        if (this.#shutdownRequested) { await this.#stopChild(); return; }
        const version = await this.#compatibleVersion();
        if (this.#shutdownRequested) { await this.#stopChild(); return; }
        if (!this.#observeManagedChild()) throw new Error("Recovered Hermes process exited during startup.");
        this.#setState({ ...this.#state, state: "ready", hermesVersion: version, compatibilityMessage: "Hermes runtimeに再接続しました。" });
        await delay(backoffMs, this.#shutdownController.signal);
        if (this.#shutdownRequested) { await this.#stopChild(); return; }
        if (this.#state.state !== "ready" || this.#child === undefined) {
          lastError = new Error("Recovered Hermes process exited before the stability window.");
          continue;
        }
        return;
      } catch (error) {
        lastError = error;
        await this.#stopChild();
        if (this.#shutdownRequested) return;
        if (error instanceof IncompatibleHermesError) {
          this.#setState({ ...this.#state, state: "incompatible", compatibilityMessage: "再起動したHermesのAPI契約が互換ではありません。" });
          return;
        }
        if (!this.#shutdownRequested) this.#setState({ ...this.#state, state: "unreachable", compatibilityMessage: "Hermes runtimeの再起動を再試行します。" });
      }
    }
    if (!this.#shutdownRequested) {
      this.#setState({ ...this.#state, state: "error", compatibilityMessage: lastError === undefined
        ? "Hermes runtimeの再起動回数が上限に達しました。"
        : "Hermes runtimeを再起動できませんでした。Officeを再起動してください。" });
    }
  }

  #setState(state: RuntimeStatus): void {
    const changed = JSON.stringify(state) !== JSON.stringify(this.#state);
    this.#state = state;
    if (!changed) return;
    const snapshot = this.status();
    for (const listener of this.#statusListeners) {
      try { listener(snapshot); } catch { /* Runtime supervision must survive observer failures. */ }
    }
  }

  #connectionConfig(): { baseUrl: URL; token: string } {
    if (this.#state.state !== "ready" || this.#baseUrl === undefined || this.#token === undefined) {
      throw new Error("Hermes backend is not ready.");
    }
    return { baseUrl: new URL(this.#baseUrl), token: this.#token };
  }

  #captureConnection(): ConnectionGeneration {
    const { baseUrl, token } = this.#connectionConfig();
    return { generation: this.#connectionGeneration, baseUrl, token };
  }

  #isCurrentConnection(connection: ConnectionGeneration): boolean {
    return this.#state.state === "ready"
      && this.#connectionGeneration === connection.generation
      && this.#baseUrl?.origin === connection.baseUrl.origin
      && this.#token === connection.token;
  }

  async #requestJson(
    path: string,
    authenticated = true,
    timeoutLimitMs?: number,
    connection?: ConnectionGeneration,
    init?: { method?: "GET" | "POST" | "DELETE"; body?: Record<string, unknown>; allowNotFound?: boolean },
  ): Promise<unknown> {
    return (await this.#requestJsonResult(path, authenticated, timeoutLimitMs, connection, init)).value;
  }

  async #requestJsonResult(
    path: string,
    authenticated = true,
    timeoutLimitMs?: number,
    connection?: ConnectionGeneration,
    init?: { method?: "GET" | "POST" | "DELETE"; body?: Record<string, unknown>; allowNotFound?: boolean },
  ): Promise<HermesJsonResult> {
    const baseUrl = connection?.baseUrl ?? this.#baseUrl;
    if (baseUrl === undefined) throw new Error("Hermes backend is not configured.");
    const target = new URL(path, baseUrl);
    if (target.origin !== baseUrl.origin || !target.pathname.startsWith("/api/")) {
      throw new Error("Refusing Hermes request outside the configured API origin.");
    }
    const controller = new AbortController();
    const configuredTimeout = bounded(this.#options.requestTimeoutMs, REQUEST_TIMEOUT_MS, 250, 15_000);
    const timeoutMs = timeoutLimitMs === undefined ? configuredTimeout : Math.max(1, Math.min(configuredTimeout, Math.trunc(timeoutLimitMs)));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const token = connection?.token ?? this.#token;
    timeout.unref();
    const method = init?.method ?? "GET";
    try {
      const response = await fetch(target, {
        method,
        headers: {
          Accept: "application/json",
          ...(authenticated && token !== undefined ? { "X-Hermes-Session-Token": token } : {}),
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = response.status;
        try { await response.body?.cancel(); } catch { /* Preserve the HTTP classification if body disposal fails. */ }
        // Only callers whose resource contract explicitly makes absence
        // idempotent may turn a 404 into success.
        if (method === "DELETE" && status === 404 && init?.allowNotFound === true) {
          return { value: { ok: true, absent: true }, bytes: 0 };
        }
        if (status === 408 || status === 425 || status === 429 || status >= 500) {
          throw new Error(`Hermes temporarily returned ${status}.`);
        }
        throw new IncompatibleHermesError(`Hermes returned ${status}.`, status);
      }
      if (response.status === 204) {
        return { value: { ok: true }, bytes: 0 };
      }
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      if (text.trim() === "") return { value: { ok: true }, bytes: 0 };
      return { value: JSON.parse(text) as unknown, bytes: Buffer.byteLength(text) };
    } catch (error) {
      if (method === "POST" && !(error instanceof IncompatibleHermesError)
        && !(error instanceof HermesCommitUnconfirmedError)) {
        throw new HermesCommitUnconfirmedError("Hermes may have committed the profile creation; refresh profiles before retrying.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#invalidateConnection();
    await terminateManagedChild(child, CHILD_STOP_GRACE_MS, CHILD_SETTLEMENT_GRACE_MS);
  }

  #invalidateConnection(): void {
    if (this.#baseUrl !== undefined || this.#token !== undefined) this.#connectionGeneration += 1;
    this.#baseUrl = undefined;
    this.#token = undefined;
    this.#snapshotRefresh = undefined;
  }
}

async function delay(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", finish, { once: true });
  });
}

async function waitForReadyPort(child: ManagedChild, timeoutMs: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error, port?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      discardHermesChildOutput(child);
      if (error !== undefined) reject(error);
      else resolve(port!);
    };
    const inspect = (chunk: Buffer): void => {
      if (output.length < MAX_START_OUTPUT) output += chunk.toString("utf8", 0, MAX_START_OUTPUT - output.length);
      const match = /HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d{1,5})/.exec(output);
      const port = match === null ? 0 : Number(match[1]);
      if (port >= 1 && port <= 65_535) finish(undefined, port);
      else if (output.length >= MAX_START_OUTPUT) finish(new Error("Hermes startup output exceeded its limit."));
    };
    const onError = (): void => finish(new Error("Hermes process failed to start."));
    const onExit = (): void => finish(new Error("Hermes process exited before readiness."));
    const timer = setTimeout(() => finish(new Error("Hermes startup timed out.")), timeoutMs);
    timer.unref();
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return result + decoder.decode();
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error("Hermes response exceeded its limit."); }
    result += decoder.decode(value, { stream: true });
  }
}

function safeLoopbackOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("Existing Hermes URL must be a credential-free HTTP origin.");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1" && url.hostname !== "[::1]") {
    throw new Error("Existing Hermes backend must be loopback-only.");
  }
  return url;
}

function requiredToken(value: string | undefined): string {
  if (value === undefined || value.length < 16 || value.length > 512) throw new Error("Existing Hermes token is missing or invalid.");
  return value;
}

function mapBoards(value: unknown): KanbanBoardSummary[] {
  if (!isRecord(value) || !Array.isArray(value.columns)) throw new Error("Hermes Kanban board contract is incompatible.");
  let count = 0;
  for (const column of value.columns) {
    if (!isRecord(column) || (column.tasks !== undefined && !Array.isArray(column.tasks))) {
      throw new Error("Hermes Kanban column contract is incompatible.");
    }
    count += Array.isArray(column.tasks) ? column.tasks.length : 0;
    if (!Number.isSafeInteger(count)) throw new Error("Hermes Kanban card count is invalid.");
  }
  const revision = value.latest_event_id;
  if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) {
    throw new Error("Hermes Kanban revision is invalid.");
  }
  return [{ id: "hermes-kanban", name: "Hermes Kanban", cardCount: count, revision: revision ?? 0 }];
}

function emptyBoards(): KanbanBoardSummary[] {
  return [{ id: "hermes-kanban", name: "Hermes Kanban", cardCount: 0, revision: 0 }];
}

function makeSnapshot(runtime: RuntimeStatus, sequence: number, profiles: OfficeSnapshot["profiles"], sessions: OfficeSnapshot["sessions"], inventory: OfficeInventoryMetadata, boards: KanbanBoardSummary[]): OfficeSnapshot {
  return {
    generatedAt: new Date().toISOString(), sequence,
    capabilities: {
      protocolVersion: OFFICE_PROTOCOL_VERSION, serverVersion: "0.2.0", runtime,
      access: { deviceId: "local-desktop", tier: "owner", exposure: "loopback", authentication: "desktop-capability", allowedOperations: ["state.read"] },
      features: ["chat", "profiles", "skills", "memory", "kanban", "teams", "global-inheritance"],
    },
    globalSettings: { sharedContextEnabled: true, sharedSkillsEnabled: true, revision: 1 },
    profiles, sessions, inventory, boards,
  };
}

function unavailableSnapshot(runtime: RuntimeStatus, sequence: number): OfficeSnapshot {
  const unavailable = { returned: 0, available: 0, hasMore: false, truncated: true, partialFailures: 1 };
  return makeSnapshot(runtime, sequence, [], [], { profiles: unavailable, sessions: unavailable }, emptyBoards());
}

function recordArray(value: unknown, key: string): Record<string, unknown>[] { const rows = isRecord(value) ? value[key] : undefined; return Array.isArray(rows) ? rows.filter(isRecord) : []; }
function readString(value: unknown, key: string): string | undefined { const item = isRecord(value) ? value[key] : undefined; return typeof item === "string" ? item : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bounded(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))); }

class IncompatibleHermesError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "IncompatibleHermesError";
  }
}

async function terminateManagedChild(
  child: ManagedChild | undefined,
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


const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireProfile(value: string): string {
  const profile = value.trim();
  if (!PROFILE_ID_PATTERN.test(profile)) throw new Error("Profile identifier is invalid.");
  return profile;
}

function requireSessionId(value: string): string {
  const sessionId = value.trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Session identifier is invalid.");
  return sessionId;
}
