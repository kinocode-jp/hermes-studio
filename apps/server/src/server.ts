import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { EventTopic } from "@hermes-studio/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { OfficeAuth, type OfficeAuditRecord } from "./office-auth.js";
import { isKanbanHttpPath, isKanbanMutation, routeKanbanHttp } from "./kanban-http.js";
import { isSettingsHttpPath, isSettingsMutation, routeSettingsHttp } from "./settings-http.js";
import { isTeamsHttpPath, isTeamsMutation, routeTeamsHttp } from "./teams-http.js";
import { OfficeTeamsStore } from "./office-teams.js";
import { brandStatePath } from "./brand-env.js";
import { DeviceAuthBodyError, readDeviceAuthBody } from "./device-auth-http.js";
import { ChatDeviceRateLimiter, handleOfficeChatConnection } from "./chat-gateway.js";
import { createChatSocketAuthGuard, invalidateChatSocket, type ChatSocketAuthGuard } from "./chat-socket-auth.js";
import { ChatSessionCoordinator } from "./chat-session-coordinator.js";
import { ChatUpstreamHub } from "./chat-upstream-hub.js";
import { fetchOfficeHistoryPage, HistoryHttpInputError } from "./history-http.js";
import { routeInventoryHttp } from "./inventory-http.js";
import { handleSessionDelete, isSessionResourcePath, SESSION_BULK_DELETE_PATH } from "./sessions-http.js";
import { handleProfilesHttp, isProfilesHttpPath, isProfilesMutation, profilesOperation } from "./profiles-http.js";
import {
  isModelsHttpPath,
  OFFICE_MODELS_LOCAL_CLI_SYNC_PATH,
  OFFICE_MODELS_REFRESH_PATH,
  routeModelsHttp,
} from "./models-http.js";
import { StaticWebAssets } from "./static-web.js";
import {
  OFFICE_PROTOCOL_VERSION,
  createDemoRuntimeStatus,
  createDemoSnapshot,
} from "./demo-state.js";
import { DEFAULT_OFFICE_ORIGINS, listenerOrigins } from "./server-origins.js";
import {
  DESKTOP_PROOF_PATH,
  allowedCorsOrigin,
  applySecurityHeaders,
  boundedInteger,
  createDesktopReadinessProof,
  isApiPath,
  isDesktopProofRequest,
  isLoopbackHost,
  kanbanOperation,
  makeEvent,
  makeOriginAllowlist,
  parseRequestUrl,
  rejectUpgrade,
  requestHasBody,
  sendBoundedEvent,
  settingsOperation,
  teamsOperation,
  writeAuthorizationError,
  writeError,
  writeJson,
  writeStaticWebAsset,
} from "./server-http.js";
import { buildTokenUsageQuery, TokenUsageStore } from "./usage-stats.js";
import { UsageTelemetryStore } from "./usage-telemetry.js";
import { SecretTransferStore } from "./secret-transfer.js";
import { HostAppManager } from "./host-apps.js";
import { HermesAgentUpdateManager } from "./hermes-agent-update.js";
import { ObsidianVaultManager } from "./obsidian-vaults.js";
import { OfficeChatModelPreferencesStore } from "./chat-model-preferences.js";
import {
  HostFileActionError,
  listHostDirectories,
  performHostFileAction,
  readHostFileAction,
} from "./host-fs.js";

const TRANSPORT_CLOSE_GRACE_MS = 750;
const SHUTDOWN_PERSISTENCE_GRACE_MS = 1_500;
const SHUTDOWN_MANAGER_GRACE_MS = 3_000;
const SHUTDOWN_RUNTIME_GRACE_MS = 4_250;

export {
  allowedCorsOrigin,
  createDesktopReadinessProof,
  isLoopbackHost,
  makeOriginAllowlist,
} from "./server-http.js";
export { normalizeOrigin } from "./origin.js";

export interface OfficeServerOptions {
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  allowNonLoopback?: boolean;
  trustedProxyHops?: number;
  deviceRegistryPath?: string;
  /** Absolute path for Studio-owned teams JSON; defaults under brand state home (~/.hermes-studio). */
  teamsPath?: string;
  /** Shared store instance (preferred when inheritance also reads teams). */
  teamsStore?: OfficeTeamsStore;
  /** Durable per-day token usage counters (default: no persistence). */
  tokenUsagePath?: string;
  /** Studio-owned skill/MCP/tool usage telemetry JSON path. */
  usageTelemetryPath?: string;
  /** Studio-owned model preference JSON shared by every authenticated client. */
  chatModelPreferencesPath?: string;
  maxJsonBytes?: number;
  /** Chat WebSocket frame cap; defaults to 1 MiB so bounded inline attachments fit. */
  maxChatJsonBytes?: number;
  /** Large profile text settings (skills/SOUL/memory) use a separate JSON body cap. */
  maxSettingsJsonBytes?: number;
  maxResponseJsonBytes?: number;
  maxEventBytes?: number;
  maxWebSocketClients?: number;
  /** Live chat attachments allowed for one authenticated Studio connection. */
  maxChatSessionLeasesPerOwner?: number;
  /** Per-profile share of one connection's live chat attachments. */
  maxChatSessionLeasesPerProfile?: number;
  /** Process-wide live chat attachment ceiling across all connections. */
  maxChatSessionLeasesTotal?: number;
  runtimeSource?: HermesRuntimeSource;
  remoteToken?: string;
  desktopCapability?: string;
  desktopOrigins?: readonly string[];
  staticWebRoot?: string;
  /**
   * When true, remote owner device sessions may use privileged config + secrets.
   * Default false. Enabled intentionally by the Tailscale launcher env.
   */
  remotePrivilegedEnabled?: boolean;
  /** Optional fixed Hermes Agent updater (managed local installs). */
  hermesAgentUpdate?: HermesAgentUpdateManager;
}

export interface OfficeServer {
  readonly host: string;
  readonly port: number;
  readonly originAllowlist: ReadonlySet<string>;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
  broadcast<T>(topic: EventTopic, payload: T, aggregateId?: string): boolean;
}

export function createOfficeServer(options: OfficeServerOptions = {}): OfficeServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const maxJsonBytes = boundedInteger(options.maxJsonBytes, 64 * 1024, 1_024, 1024 * 1024);
  const maxChatJsonBytes = boundedInteger(
    options.maxChatJsonBytes,
    options.maxJsonBytes === undefined ? 1024 * 1024 : maxJsonBytes,
    4_096,
    1024 * 1024,
  );
  const maxSettingsJsonBytes = boundedInteger(
    options.maxSettingsJsonBytes,
    4 * 1024 * 1024,
    64 * 1024,
    8 * 1024 * 1024,
  );
  const maxResponseJsonBytes = boundedInteger(options.maxResponseJsonBytes, 4 * 1024 * 1024, 1024 * 1024, 8 * 1024 * 1024);
  const maxEventBytes = boundedInteger(options.maxEventBytes, 64 * 1024, 1_024, 1024 * 1024);
  const maxWebSocketClients = boundedInteger(options.maxWebSocketClients, 32, 1, 256);
  const maxChatSessionLeasesPerOwner = boundedInteger(options.maxChatSessionLeasesPerOwner, 16, 1, 128);
  const maxChatSessionLeasesPerProfile = boundedInteger(
    options.maxChatSessionLeasesPerProfile,
    8,
    1,
    maxChatSessionLeasesPerOwner,
  );
  const maxChatSessionLeasesTotal = boundedInteger(
    options.maxChatSessionLeasesTotal,
    256,
    maxChatSessionLeasesPerOwner,
    4_096,
  );
  const effectiveDesktopOrigins = options.desktopOrigins ?? DEFAULT_OFFICE_ORIGINS;
  const desktopCapability = options.desktopCapability;
  const originAllowlist = new Set(makeOriginAllowlist([...(options.allowedOrigins ?? DEFAULT_OFFICE_ORIGINS), ...effectiveDesktopOrigins]));
  const runtimeSource = options.runtimeSource;
  const staticWeb = options.staticWebRoot === undefined ? undefined : new StaticWebAssets(options.staticWebRoot);
  const teamsStore = options.teamsStore ?? new OfficeTeamsStore(
    options.teamsPath ?? brandStatePath("teams.json"),
  );
  const chatModelPreferences = new OfficeChatModelPreferencesStore(
    options.chatModelPreferencesPath ?? brandStatePath("chat-model-preferences.json"),
  );
  let publishAudit = (_record: OfficeAuditRecord): void => {};
  const remotePrivilegedEnabled = options.remotePrivilegedEnabled === true;
  const auth = new OfficeAuth({
    ...(options.remoteToken === undefined ? {} : { remoteToken: options.remoteToken }),
    ...(desktopCapability === undefined ? {} : { desktopCapability }),
    desktopOrigins: effectiveDesktopOrigins,
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.trustedProxyHops === undefined ? {} : { trustedProxyHops: options.trustedProxyHops }),
    ...(options.deviceRegistryPath === undefined ? {} : { deviceRegistryPath: options.deviceRegistryPath }),
    remotePrivilegedEnabled,
    onAudit: (record) => publishAudit(record),
  });
  const secretTransfers = new SecretTransferStore();
  const hostApps = new HostAppManager();
  const hermesAgentUpdate = options.hermesAgentUpdate ?? new HermesAgentUpdateManager();
  const obsidianVaults = new ObsidianVaultManager();

  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing direct non-loopback bind (${host}); use a trusted HTTPS reverse proxy to the loopback listener.`);
  }

  let sequence = 0;
  let closeFlight: Promise<void> | undefined;
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxJsonBytes,
    perMessageDeflate: false,
    clientTracking: true,
  });
  const chatWebSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxChatJsonBytes,
    perMessageDeflate: false,
    clientTracking: true,
  });
  const eventSocketPrincipals = new WeakMap<WebSocket, string>();
  const eventSocketSessions = new WeakMap<WebSocket, import("./office-auth.js").OfficeAuthSession>();
  const chatSocketPrincipals = new WeakMap<WebSocket, string>();
  const chatSocketSessions = new WeakMap<WebSocket, import("./office-auth.js").OfficeAuthSession>();
  const chatSocketAuthGuards = new WeakMap<WebSocket, ChatSocketAuthGuard>();
  const chatDeviceLimiter = new ChatDeviceRateLimiter();
  const chatSessionCoordinator = new ChatSessionCoordinator({
    maxLeasesPerOwner: maxChatSessionLeasesPerOwner,
    maxLeasesPerProfile: maxChatSessionLeasesPerProfile,
    maxLeasesTotal: maxChatSessionLeasesTotal,
  });
  const tokenUsage = options.tokenUsagePath === undefined
    ? undefined
    : new TokenUsageStore(options.tokenUsagePath);
  const chatUpstreamHub = runtimeSource === undefined
    ? undefined
    : new ChatUpstreamHub(runtimeSource, chatSessionCoordinator, maxChatJsonBytes, {
      ...(tokenUsage === undefined ? {} : { usage: tokenUsage }),
    });
  const usageTelemetry = new UsageTelemetryStore({
    filePath: options.usageTelemetryPath ?? brandStatePath("usage-telemetry.json"),
    resolveSkillNames: async (profile) => {
      try {
        const skills = await runtimeSource?.settings?.().listSkills(profile);
        if (skills === undefined) return new Set();
        return new Set(skills.map((skill) => skill.name));
      } catch {
        return new Set();
      }
    },
  });
  const publishRuntimeStatus = (status: import("@hermes-studio/protocol").RuntimeStatus): void => {
    const event = makeEvent(++sequence, "runtime.status", status);
    for (const client of websocketServer.clients) sendBoundedEvent(client, event, maxEventBytes);
  };
  const unsubscribeRuntimeStatus = runtimeSource?.onStatusChange?.(publishRuntimeStatus);
  publishAudit = (record) => {
    const publicRecord = {
      occurredAt: record.occurredAt,
      operation: record.operation,
      outcome: record.outcome,
      deviceName: record.deviceName,
      local: record.local,
    };
    const event = makeEvent(++sequence, "access.changed", { audit: publicRecord });
    for (const client of websocketServer.clients) {
      const session = eventSocketSessions.get(client);
      if (session !== undefined && auth.authorizeSession(session, "audit.read").allowed) {
        sendBoundedEvent(client, event, maxEventBytes);
      }
    }
    if (record.operation === "auth.logout" && record.actorId !== null) {
      for (const client of websocketServer.clients) {
        if (eventSocketPrincipals.get(client) === record.actorId) client.close(1008, "Session revoked");
      }
      for (const client of chatWebSocketServer.clients) {
        if (chatSocketPrincipals.get(client) === record.actorId) {
          invalidateChatSocket(client, chatSocketAuthGuards);
          client.close(1008, "Session revoked");
        }
      }
    }
  };

  const httpServer = createHttpServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    applySecurityHeaders(response);

    const origin = request.headers.origin;
    const allowedOrigin = origin !== undefined ? allowedCorsOrigin(origin, originAllowlist) : undefined;
    if (origin !== undefined && allowedOrigin === undefined) {
      writeError(response, 403, "forbidden", "Origin is not allowed.", maxJsonBytes);
      return;
    }

    if (allowedOrigin !== undefined) {
      response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Vary", "Origin");
    }

    const requestUrl = parseRequestUrl(request.url);
    if (requestUrl === undefined) {
      writeError(response, 400, "bad_request", "Malformed request URL.", maxJsonBytes);
      return;
    }

    if (requestUrl.pathname === DESKTOP_PROOF_PATH) {
      if (desktopCapability === undefined || !isDesktopProofRequest(request, requestUrl)) {
        if (requestHasBody(request)) request.resume();
        writeError(response, 404, "not_found", "Route not found.", maxJsonBytes, { "Cache-Control": "no-store" });
        return;
      }
      const nonce = requestUrl.searchParams.get("nonce")!;
      const proof = createDesktopReadinessProof(desktopCapability, nonce);
      writeJson(response, 200, { proof }, maxJsonBytes, { "Cache-Control": "no-store" });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/auth/local") {
      const hasBody = requestHasBody(request);
      if (origin === undefined || hasBody) {
        if (hasBody) request.resume();
        writeError(response, 400, "bad_request", "Local bootstrap requires an allowed browser origin and no body.", maxJsonBytes);
        return;
      }
      const session = auth.bootstrapLocal(request, response);
      if (session === undefined) writeError(response, 403, "forbidden", "Local bootstrap is loopback-only.", maxJsonBytes);
      else writeJson(response, 200, session, maxResponseJsonBytes);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/auth/device") {
      if (!auth.remoteEnabled) {
        request.resume();
        writeError(response, 404, "not_found", "Route not found.", maxJsonBytes);
        return;
      }
      try {
        const credentials = await readDeviceAuthBody(request, maxJsonBytes);
        const result = await auth.bootstrapDevice(request, response, credentials);
        if (result.outcome === "success") writeJson(response, 200, result.session, maxResponseJsonBytes);
        else if (result.outcome === "rate_limited") {
          writeError(response, 429, "rate_limited", "Too many device authentication attempts.", maxJsonBytes, { "Retry-After": "60" });
        } else if (result.outcome === "insecure_transport") {
          writeError(response, 403, "forbidden", "Remote enrollment requires a configured trusted HTTPS proxy.", maxJsonBytes);
        } else if (result.outcome === "enrollment_consumed") {
          writeError(response, 409, "conflict", "The one-time enrollment token has already been used.", maxJsonBytes);
        } else if (result.outcome === "storage_unavailable") {
          writeError(response, 503, "internal_error", "Device enrollment could not be persisted.", maxJsonBytes);
        } else {
          writeError(response, 401, "unauthenticated", "Device credentials are invalid.", maxJsonBytes);
        }
      } catch (error) {
        if (error instanceof DeviceAuthBodyError) {
          writeError(response, error.status, "bad_request", error.message, maxJsonBytes);
        } else {
          writeError(response, 400, "bad_request", "Device authentication request is invalid.", maxJsonBytes);
        }
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/auth/device/renew") {
      if (requestHasBody(request)) { request.resume(); writeError(response, 413, "bad_request", "Renewal request bodies are not accepted.", maxJsonBytes); return; }
      const result = auth.renewDevice(request, response);
      if (result.outcome === "success") writeJson(response, 200, result.session, maxResponseJsonBytes);
      else if (result.outcome === "rate_limited") writeError(response, 429, "rate_limited", "Too many device renewal attempts.", maxJsonBytes, { "Retry-After": "60" });
      else if (result.outcome === "insecure_transport") writeError(response, 403, "forbidden", "Remote renewal requires a configured trusted HTTPS proxy.", maxJsonBytes);
      else writeError(response, 401, "unauthenticated", "Device credential is invalid or revoked.", maxJsonBytes);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/auth/logout") {
      if (requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "Logout request bodies are not accepted.", maxJsonBytes);
      } else if (auth.authenticate(request) === undefined) {
        writeError(response, 401, "unauthenticated", "Studio session is not active.", maxJsonBytes);
      } else if (!auth.authorizeOperation(request, "state.read", true).allowed) {
        writeError(response, 403, "forbidden", "A valid Studio session and CSRF token are required.", maxJsonBytes);
      } else if (!await auth.revoke(request, response)) {
        writeError(response, 401, "unauthenticated", "Studio session is not active.", maxJsonBytes);
      } else {
        writeJson(response, 200, { ok: true }, maxResponseJsonBytes);
      }
      return;
    }

    if (request.method === "OPTIONS") {
      // GET/POST are widely used. PUT and PATCH are intentionally supported here
      // for settings-http and kanban-http mutations, so keep them in the allowlist.
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token, X-Hermes-Office-Desktop-Capability",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }

    if (isTeamsHttpPath(requestUrl.pathname)) {
      const access = auth.authorizeOperation(request, teamsOperation(request.method), isTeamsMutation(request.method));
      if (!access.allowed) { request.resume(); writeAuthorizationError(response, access.reason, maxJsonBytes); return; }
      if (request.method === "GET" && requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "GET request bodies are not accepted.", maxJsonBytes);
        return;
      }
      try {
        const result = await routeTeamsHttp(request, requestUrl, {
          store: teamsStore,
          ...(runtimeSource?.globalInheritance === undefined
            ? {}
            : { globalInheritance: runtimeSource.globalInheritance() }),
        }, maxJsonBytes);
        if (!request.readableEnded) request.resume();
        writeJson(response, result.status, result.body, maxResponseJsonBytes, result.headers ?? {});
      } catch {
        writeError(response, 500, "internal_error", "Teams request failed.", maxJsonBytes);
      }
      return;
    }

    if (isKanbanHttpPath(requestUrl.pathname)) {
      const access = auth.authorizeOperation(request, kanbanOperation(request.method, requestUrl.pathname), isKanbanMutation(request.method));
      if (!access.allowed) { request.resume(); writeAuthorizationError(response, access.reason, maxJsonBytes); return; }
      if (request.method === "GET" && requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "GET request bodies are not accepted.", maxJsonBytes);
        return;
      }
      if (runtimeSource === undefined) {
        request.resume();
        writeError(response, 503, "runtime_unavailable", "Hermes runtime is unavailable.", maxJsonBytes);
        return;
      }
      try {
        const result = await routeKanbanHttp(request, requestUrl, runtimeSource.kanban(), maxJsonBytes);
        if (!request.readableEnded) request.resume();
        writeJson(response, result.status, result.body, maxResponseJsonBytes, result.headers ?? {});
        if (result.changedCardId !== undefined && result.status >= 200 && result.status < 300) {
          const event = makeEvent(++sequence, "kanban.changed", {
            cardId: result.changedCardId,
            operation: result.changedOperation ?? "card.updated",
          }, result.changedCardId);
          for (const client of websocketServer.clients) sendBoundedEvent(client, event, maxEventBytes);
        }
      } catch {
        writeError(response, 502, "runtime_unavailable", "Hermes Kanban is unavailable.", maxJsonBytes);
      }
      return;
    }

    if (isSettingsHttpPath(requestUrl.pathname)) {
      const access = auth.authorizeOperation(request, settingsOperation(request.method, requestUrl.pathname), isSettingsMutation(request.method));
      if (!access.allowed) { request.resume(); writeAuthorizationError(response, access.reason, maxJsonBytes); return; }
      if (request.method === "GET" && requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "GET request bodies are not accepted.", maxJsonBytes);
        return;
      }
      // Secret transfer deposit is desktop-only and does not need Hermes settings.
      const isStandaloneStudioSetting = requestUrl.pathname === "/api/v1/secret-transfers"
        || requestUrl.pathname === "/api/v1/settings/chat-model-preferences";
      if (!isStandaloneStudioSetting && (runtimeSource?.settings === undefined || runtimeSource.globalSettings === undefined)) {
        request.resume();
        writeError(response, 503, "runtime_unavailable", "Hermes settings are unavailable.", maxJsonBytes);
        return;
      }
      const result = await routeSettingsHttp(
        request,
        requestUrl,
        {
          ...(runtimeSource?.settings === undefined || runtimeSource.globalSettings === undefined
            ? {}
            : {
              settings: runtimeSource.settings(),
              globalSettings: runtimeSource.globalSettings(),
              ...(runtimeSource.globalInheritance === undefined ? {} : { globalInheritance: runtimeSource.globalInheritance() }),
              ...(runtimeSource.agentBehavior === undefined ? {} : { agentBehavior: runtimeSource.agentBehavior() }),
              ...(runtimeSource.projects === undefined ? {} : { projects: runtimeSource.projects() }),
            }),
          secretTransfers,
          chatModelPreferences,
          // Server-derived privileged-owner session (never client headers).
          privilegedOwnerSession: auth.allowsPrivilegedSettings(access.session),
        },
        maxSettingsJsonBytes,
      );
      if (!request.readableEnded) request.resume();
      writeJson(response, result.status, result.body, maxResponseJsonBytes, result.headers ?? {});
      if (result.changed !== undefined && result.status >= 200 && result.status < 300) {
        const aggregateId = result.changed.profile ?? result.changed.id ?? "global";
        const event = makeEvent(++sequence, "profile.changed", result.changed, aggregateId);
        for (const client of websocketServer.clients) sendBoundedEvent(client, event, maxEventBytes);
      }
      return;
    }

    const revokeDeviceMatch = /^\/api\/v1\/devices\/([^/]+)\/revoke$/.exec(requestUrl.pathname);
    if (request.method === "POST" && revokeDeviceMatch !== null) {
      if (requestHasBody(request)) { request.resume(); writeError(response, 413, "bad_request", "Device revocation request bodies are not accepted.", maxJsonBytes); return; }
      // SECURITY: POST device revoke is intentionally local-owner + CSRF, not
      // desktop-exclusive. It forms a trusted loopback recovery boundary so the
      // owner can revoke devices even if the Tauri desktop bridge is unavailable.
      // This path is not exposed to remote devices and is not weakened by
      // removing or bypassing CSRF.
      const access = auth.authorizeOperation(request, "device.revoke", true);
      if (!access.allowed) { writeAuthorizationError(response, access.reason, maxJsonBytes); return; }
      let deviceId: string;
      try { deviceId = decodeURIComponent(revokeDeviceMatch[1]!); }
      catch { writeError(response, 400, "bad_request", "Device identifier is malformed.", maxJsonBytes); return; }
      if (!await auth.revokeDevice(access.session, deviceId)) { writeError(response, 404, "not_found", "Active device was not found.", maxJsonBytes); return; }
      for (const client of websocketServer.clients) if (eventSocketPrincipals.get(client) === deviceId) client.close(1008, "Device revoked");
      for (const client of chatWebSocketServer.clients) if (chatSocketPrincipals.get(client) === deviceId) {
        invalidateChatSocket(client, chatSocketAuthGuards);
        client.close(1008, "Device revoked");
      }
      writeJson(response, 200, { ok: true }, maxResponseJsonBytes);
      return;
    }

    if (requestUrl.pathname === "/api/v1/host/apps/obsidian/install") {
      if (request.method !== "POST") {
        writeError(response, 405, "bad_request", "Method not allowed.", maxJsonBytes, { Allow: "POST" });
        return;
      }
      if (requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "Host application install requests do not accept a body.", maxJsonBytes);
        return;
      }
      const installAccess = auth.authorizeOperation(request, "host-app.install", true);
      if (!installAccess.allowed) {
        writeAuthorizationError(response, installAccess.reason, maxJsonBytes);
        return;
      }
      writeJson(response, 202, hostApps.installObsidian(), maxResponseJsonBytes, { "Cache-Control": "no-store" });
      return;
    }
    if (requestUrl.pathname === "/api/v1/host/fs/open") {
      if (request.method !== "POST") {
        if (requestHasBody(request)) request.resume();
        writeError(response, 405, "bad_request", "Method not allowed.", maxJsonBytes, { Allow: "POST" });
        return;
      }
      const fileAccess = auth.authorizeOperation(request, "host-fs.open", true);
      if (!fileAccess.allowed) {
        request.resume();
        writeAuthorizationError(response, fileAccess.reason, maxJsonBytes);
        return;
      }
      try {
        const action = await readHostFileAction(request, maxJsonBytes);
        await performHostFileAction(action.path, action.action);
        writeJson(response, 200, { ok: true }, maxResponseJsonBytes, { "Cache-Control": "no-store" });
      } catch (error) {
        if (!request.readableEnded) request.resume();
        if (error instanceof HostFileActionError) {
          const code = error.code === "not_found" ? "not_found" : error.code === "bad_request" ? "bad_request" : "internal_error";
          writeError(response, error.status, code, error.message, maxJsonBytes);
        } else {
          writeError(response, 500, "internal_error", "The local file action failed.", maxJsonBytes);
        }
      }
      return;
    }
    if (requestUrl.pathname === "/api/v1/host/hermes-agent/update") {
      if (request.method !== "POST") {
        writeError(response, 405, "bad_request", "Method not allowed.", maxJsonBytes, { Allow: "POST" });
        return;
      }
      if (requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "Hermes Agent update requests do not accept a body.", maxJsonBytes);
        return;
      }
      const updateAccess = auth.authorizeOperation(request, "hermes-agent.update", true);
      if (!updateAccess.allowed) {
        writeAuthorizationError(response, updateAccess.reason, maxJsonBytes);
        return;
      }
      writeJson(response, 202, hermesAgentUpdate.startUpdate(), maxResponseJsonBytes, { "Cache-Control": "no-store" });
      return;
    }
    if (requestUrl.pathname === "/api/v1/host/hermes-agent/check") {
      if (request.method !== "POST") {
        writeError(response, 405, "bad_request", "Method not allowed.", maxJsonBytes, { Allow: "POST" });
        return;
      }
      if (requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "Hermes Agent check requests do not accept a body.", maxJsonBytes);
        return;
      }
      const checkAccess = auth.authorizeOperation(request, "hermes-agent.update", true);
      if (!checkAccess.allowed) {
        writeAuthorizationError(response, checkAccess.reason, maxJsonBytes);
        return;
      }
      writeJson(response, 200, await hermesAgentUpdate.refresh({ force: true }), maxResponseJsonBytes, { "Cache-Control": "no-store" });
      return;
    }

    if (isModelsHttpPath(requestUrl.pathname)) {
      const refresh = request.method === "POST" && requestUrl.pathname === OFFICE_MODELS_REFRESH_PATH;
      const localCliSync = request.method === "POST" && requestUrl.pathname === OFFICE_MODELS_LOCAL_CLI_SYNC_PATH;
      const access = auth.authorizeOperation(
        request,
        localCliSync ? "local-model-providers.sync" : refresh ? "chat.message.send" : "state.read",
        refresh || localCliSync,
      );
      if (!access.allowed) {
        request.resume();
        writeAuthorizationError(response, access.reason, maxJsonBytes);
        return;
      }
      if (requestHasBody(request)) {
        request.resume();
        writeError(response, 413, "bad_request", "Model catalog requests do not accept a body.", maxJsonBytes);
        return;
      }
      const result = await routeModelsHttp(
        request,
        requestUrl,
        runtimeSource?.models === undefined ? undefined : runtimeSource.models(),
      );
      writeJson(response, result.status, result.body, maxResponseJsonBytes, result.headers ?? {});
      return;
    }

    if (isProfilesHttpPath(requestUrl.pathname)) {
      const access = auth.authorizeOperation(request, profilesOperation(request.method), isProfilesMutation(request.method));
      if (!access.allowed) { request.resume(); writeAuthorizationError(response, access.reason, maxJsonBytes); return; }
      const acceptsBody = request.method === "POST" && requestUrl.pathname === "/api/v1/profiles";
      if (!acceptsBody && requestHasBody(request)) {
        request.resume();
        response.setHeader("Connection", "close");
        writeError(response, 413, "bad_request", "This profiles request does not accept a body.", maxJsonBytes);
        return;
      }
      await handleProfilesHttp(request, response, requestUrl, runtimeSource, maxJsonBytes, maxResponseJsonBytes);
      return;
    }

    if (isSessionResourcePath(requestUrl.pathname)) {
      const isBulkDelete = requestUrl.pathname === SESSION_BULK_DELETE_PATH;
      const acceptsBody = isBulkDelete && request.method === "POST";
      if (!acceptsBody && requestHasBody(request)) {
        request.resume();
        response.setHeader("Connection", "close");
        writeError(response, 413, "bad_request", "This session request does not accept a body.", maxJsonBytes);
        return;
      }
      const expectedMethod = isBulkDelete ? "POST" : "DELETE";
      if (request.method !== expectedMethod) {
        if (requestHasBody(request)) request.resume();
        writeError(response, 405, "bad_request", `Only ${expectedMethod} is supported for this session route.`, maxJsonBytes, { Allow: expectedMethod });
        return;
      }
      const deleteAccess = auth.authorizeOperation(request, "chat.session.archive", true);
      if (!deleteAccess.allowed) {
        writeAuthorizationError(response, deleteAccess.reason, maxJsonBytes);
        return;
      }
      await handleSessionDelete(request, response, requestUrl, runtimeSource, maxJsonBytes, maxResponseJsonBytes);
      return;
    }


    if (requestHasBody(request)) {
      request.resume();
      response.setHeader("Connection", "close");
      writeError(response, 413, "bad_request", "Request bodies are not accepted.", maxJsonBytes);
      return;
    }

    if (
      staticWeb !== undefined
      && (request.method === "GET" || request.method === "HEAD")
      && !isApiPath(requestUrl.pathname)
    ) {
      try {
        const asset = await staticWeb.read(requestUrl.pathname);
        if (asset === undefined) {
          writeError(response, 404, "not_found", "Web asset not found.", maxJsonBytes);
        } else {
          writeStaticWebAsset(response, request.method, asset);
        }
      } catch {
        writeError(response, 500, "internal_error", "Web application is unavailable.", maxJsonBytes);
      }
      return;
    }

    if (request.method !== "GET") {
      writeError(response, 405, "bad_request", "Method not allowed.", maxJsonBytes, {
        Allow: "GET, OPTIONS",
      });
      return;
    }

    if (requestUrl.pathname === "/api/v1/health") {
      const runtime = runtimeSource?.status() ?? createDemoRuntimeStatus();
      writeJson(
        response,
        200,
        {
          ok: true,
          protocolVersion: OFFICE_PROTOCOL_VERSION,
          runtime: runtime.state,
        },
        maxResponseJsonBytes,
      );
      return;
    }

    const readAccess = auth.authorizeOperation(request, "state.read", false);
    if (!readAccess.allowed) {
      writeAuthorizationError(response, readAccess.reason, maxJsonBytes);
      return;
    }
    const authenticatedSession = readAccess.session;

    if (requestUrl.pathname === "/api/v1/audit") {
      const auditAccess = auth.authorizeOperation(request, "audit.read", false);
      const audit = auditAccess.allowed ? auth.readAudit(auditAccess.session) : undefined;
      if (audit === undefined) writeError(response, 403, "forbidden", "Owner access is required.", maxJsonBytes);
      else writeJson(response, 200, audit, maxResponseJsonBytes);
      return;
    }

    // Remote-device management routes are local-owner only.
    if (requestUrl.pathname === "/api/v1/devices") {
      const deviceAccess = auth.authorizeOperation(request, "device.revoke", false);
      const devices = deviceAccess.allowed ? auth.listDevices(deviceAccess.session) : undefined;
      if (devices === undefined) writeError(response, 403, "forbidden", "Verified local owner access is required.", maxJsonBytes);
      else writeJson(response, 200, devices, maxResponseJsonBytes);
      return;
    }

    if (requestUrl.pathname === "/api/v1/host/remote") {
      const config = auth.remoteConfig(authenticatedSession);
      if (config === undefined) writeError(response, 403, "forbidden", "Verified local desktop owner access is required.", maxJsonBytes);
      else writeJson(response, 200, config, maxResponseJsonBytes);
      return;
    }

    if (requestUrl.pathname === "/api/v1/host/apps/obsidian") {
      writeJson(response, 200, hostApps.obsidianStatus(), maxResponseJsonBytes, { "Cache-Control": "no-store" });
      return;
    }
    if (requestUrl.pathname === "/api/v1/host/fs/dirs") {
      const fsAccess = auth.authorizeOperation(request, "host-fs.read", false);
      if (!fsAccess.allowed) {
        writeAuthorizationError(response, fsAccess.reason, maxJsonBytes);
        return;
      }
      const listing = await listHostDirectories(requestUrl.searchParams.get("path"));
      writeJson(response, 200, listing, maxResponseJsonBytes, { "Cache-Control": "no-store" });
      return;
    }
    if (requestUrl.pathname === "/api/v1/host/apps/obsidian/vaults") {
      const vaultAccess = auth.authorizeOperation(request, "obsidian.vault.read", false);
      if (!vaultAccess.allowed) {
        writeAuthorizationError(response, vaultAccess.reason, maxJsonBytes);
        return;
      }
      writeJson(response, 200, { vaults: await obsidianVaults.listVaults() }, maxResponseJsonBytes, { "Cache-Control": "no-store" });
      return;
    }
    if (requestUrl.pathname === "/api/v1/host/apps/obsidian/graph") {
      const vaultAccess = auth.authorizeOperation(request, "obsidian.vault.read", false);
      if (!vaultAccess.allowed) {
        writeAuthorizationError(response, vaultAccess.reason, maxJsonBytes);
        return;
      }
      const vaultId = requestUrl.searchParams.get("vault") ?? "";
      const graph = await obsidianVaults.graph(vaultId);
      if (graph === undefined) writeError(response, 404, "not_found", "Registered Obsidian vault was not found.", maxJsonBytes);
      else writeJson(response, 200, graph, maxResponseJsonBytes, { "Cache-Control": "no-store" });
      return;
    }
    if (requestUrl.pathname === "/api/v1/host/hermes-agent") {
      writeJson(response, 200, hermesAgentUpdate.status(), maxResponseJsonBytes, { "Cache-Control": "no-store" });
      return;
    }


    if (requestUrl.pathname === "/api/v1/inventory") {
      const result = await routeInventoryHttp(runtimeSource, requestUrl);
      writeJson(response, result.status, result.body, maxResponseJsonBytes);
      return;
    }

    if (requestUrl.pathname === "/api/v1/stats/token-usage") {
      if (tokenUsage === undefined) {
        writeJson(response, 200, emptyTokenUsageQuery(requestUrl), maxResponseJsonBytes);
        return;
      }
      try {
        const days = parseTokenUsageDays(requestUrl);
        const body = await tokenUsage.query(days);
        writeJson(response, 200, body, maxResponseJsonBytes);
      } catch (error) {
        if (error instanceof TokenUsageHttpInputError) {
          writeError(response, 400, "bad_request", error.message, maxJsonBytes);
          return;
        }
        writeError(response, 500, "internal_error", "Token usage is unavailable.", maxJsonBytes);
      }
      return;
    }

    if (requestUrl.pathname === "/api/v1/stats/usage") {
      const profile = requestUrl.searchParams.get("profile") ?? "default";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
        writeError(response, 400, "bad_request", "profile is invalid.", maxJsonBytes);
        return;
      }
      const daysRaw = requestUrl.searchParams.get("days");
      const days = daysRaw === null || daysRaw === ""
        ? 30
        : /^\d+$/.test(daysRaw) ? Number(daysRaw) : Number.NaN;
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        writeError(response, 400, "bad_request", "days must be an integer from 1 to 90.", maxJsonBytes);
        return;
      }
      try {
        const stats = await usageTelemetry.query(profile, days);
        writeJson(response, 200, stats, maxResponseJsonBytes);
      } catch {
        writeError(response, 500, "internal_error", "Usage statistics are unavailable.", maxJsonBytes);
      }
      return;
    }

    const historyMatch = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(requestUrl.pathname);
    if (historyMatch !== null) {
      if (runtimeSource === undefined) {
        writeError(response, 503, "runtime_unavailable", "Hermes runtime is unavailable.", maxJsonBytes);
        return;
      }
      let sessionId: string;
      try { sessionId = decodeURIComponent(historyMatch[1]!); }
      catch { writeError(response, 400, "bad_request", "Session identifier is malformed.", maxJsonBytes); return; }
      try {
        const history = await chatUpstreamHub!.readStableHistory(async () => await fetchOfficeHistoryPage(
          runtimeSource.chat(), requestUrl, sessionId, maxResponseJsonBytes,
        ));
        writeJson(response, 200, history, maxResponseJsonBytes);
      } catch (error) {
        if (error instanceof HistoryHttpInputError) {
          writeError(response, 400, "bad_request", error.message, maxJsonBytes);
          return;
        }
        writeError(response, 502, "runtime_unavailable", "Hermes history is unavailable.", maxJsonBytes);
      }
      return;
    }

    if (requestUrl.pathname === "/api/v1/snapshot") {
      const snapshot = runtimeSource === undefined
        ? createDemoSnapshot()
        : await runtimeSource.snapshot().catch(() => createDemoSnapshot());
      writeJson(response, 200, {
        ...snapshot,
        capabilities: { ...snapshot.capabilities, access: auth.effectiveAccess(authenticatedSession) },
      }, maxResponseJsonBytes);
      return;
    }

    writeError(response, 404, "not_found", "Route not found.", maxJsonBytes);
  });

  httpServer.requestTimeout = 15_000;
  httpServer.headersTimeout = 10_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 64;

  httpServer.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const requestUrl = parseRequestUrl(request.url);
    const isEvents = requestUrl?.pathname === "/api/v1/events";
    const isChat = requestUrl?.pathname === "/api/v1/chat";
    if (!isEvents && !isChat) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const origin = request.headers.origin;
    const allowedOrigin = origin !== undefined ? allowedCorsOrigin(origin, originAllowlist) : undefined;
    if (origin === undefined || allowedOrigin === undefined) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    const authenticatedSession = auth.authenticate(request);
    if (authenticatedSession === undefined) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const targetServer = isChat ? chatWebSocketServer : websocketServer;
    if (targetServer.clients.size >= maxWebSocketClients) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }

    targetServer.handleUpgrade(request, socket, head, (websocket) => {
      (isChat ? chatSocketPrincipals : eventSocketPrincipals).set(websocket, authenticatedSession.principal.id);
      if (isChat) chatSocketSessions.set(websocket, authenticatedSession);
      else eventSocketSessions.set(websocket, authenticatedSession);
      if (isChat) chatSocketAuthGuards.set(websocket, createChatSocketAuthGuard(auth, request, authenticatedSession));
      const expiryDelay = Math.max(1, Date.parse(authenticatedSession.expiresAt) - Date.now());
      const expiryTimer = setTimeout(() => {
        if (isChat) invalidateChatSocket(websocket, chatSocketAuthGuards);
        websocket.close(1008, "Session expired");
      }, expiryDelay);
      websocket.once("close", () => clearTimeout(expiryTimer));
      targetServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (websocket) => {
    websocket.on("error", () => {
      // Errors are connection-local; avoid reflecting details to clients.
    });
    websocket.on("message", () => {
      websocket.close(1008, "Event stream is server-to-client only");
    });

    const event = makeEvent(
      ++sequence,
      "runtime.status",
      runtimeSource?.status() ?? createDemoRuntimeStatus(),
    );
    sendBoundedEvent(websocket, event, maxEventBytes);
  });

  chatWebSocketServer.on("connection", (client) => {
    if (runtimeSource === undefined || chatUpstreamHub === undefined) { client.close(1013, "Hermes runtime unavailable"); return; }
    const officeSession = chatSocketSessions.get(client);
    const authGuard = chatSocketAuthGuards.get(client);
    if (officeSession === undefined || authGuard === undefined) { client.close(1008, "Studio session unavailable"); return; }
    handleOfficeChatConnection(client, {
      auth, officeSession, runtimeSource, maxJsonBytes: maxChatJsonBytes, deviceLimiter: chatDeviceLimiter, sessionCoordinator: chatSessionCoordinator, chatHub: chatUpstreamHub,
      usageTelemetry,
      sessionIsActive: authGuard.isActive, invalidationSignal: authGuard.signal,
    });
  });

  return {
    host,
    port,
    originAllowlist,
    listen: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError);
          const address = httpServer.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Office Server did not receive a TCP address."));
            return;
          }
          for (const origin of listenerOrigins(address)) originAllowlist.add(origin);
          resolve(address);
        });
      }),
    close: () => {
      if (closeFlight !== undefined) return closeFlight;
      unsubscribeRuntimeStatus?.();
      const persistenceClose = Promise.allSettled([
        tokenUsage?.flush().catch(() => undefined),
        usageTelemetry.flush().catch(() => undefined),
        auth.flushRegistryWrites(),
      ]).then(() => undefined);
      const hostManagerClose = Promise.allSettled([
        hostApps.close(),
        hermesAgentUpdate.close(),
      ]).then(() => undefined);
      const runtimeClose = runtimeSource?.close();
      const transportClose = Promise.all([
        closeWebSocketServer(websocketServer, TRANSPORT_CLOSE_GRACE_MS),
        closeWebSocketServer(chatWebSocketServer, TRANSPORT_CLOSE_GRACE_MS),
        closeHttpServer(httpServer, TRANSPORT_CLOSE_GRACE_MS),
      ]).then(() => undefined);
      const flight = Promise.allSettled([
        transportClose,
        settleBestEffort(chatUpstreamHub?.close(), SHUTDOWN_PERSISTENCE_GRACE_MS),
        settleBestEffort(persistenceClose, SHUTDOWN_PERSISTENCE_GRACE_MS),
        settleBestEffort(hostManagerClose, SHUTDOWN_MANAGER_GRACE_MS),
        settleBestEffort(runtimeClose, SHUTDOWN_RUNTIME_GRACE_MS),
      ]).then(() => {
        secretTransfers.clear();
      });
      closeFlight = flight;
      return flight;
    },
    broadcast: <T>(topic: EventTopic, payload: T, aggregateId?: string): boolean => {
      const event = makeEvent(++sequence, topic, payload, aggregateId);
      let sent = false;
      for (const client of websocketServer.clients) {
        sent = sendBoundedEvent(client, event, maxEventBytes) || sent;
      }
      return sent;
    },
  };
}

function settleBestEffort(operation: Promise<unknown> | undefined, timeoutMs: number): Promise<void> {
  if (operation === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    operation.then(finish, finish);
  });
}

function closeWebSocketServer(server: WebSocketServer, graceMs: number): Promise<void> {
  for (const client of server.clients) client.close(1001, "Server shutting down");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(settlementTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      for (const client of server.clients) client.terminate();
    }, graceMs);
    const settlementTimer = setTimeout(finish, graceMs + 250);
    try { server.close(finish); } catch { finish(); }
  });
}

function closeHttpServer(server: HttpServer, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(settlementTimer);
      resolve();
    };
    const forceTimer = setTimeout(() => server.closeAllConnections(), graceMs);
    const settlementTimer = setTimeout(finish, graceMs + 250);
    try {
      server.close(() => finish());
      server.closeIdleConnections();
    } catch {
      finish();
    }
  });
}

class TokenUsageHttpInputError extends Error {}

function parseTokenUsageDays(requestUrl: URL): number {
  const allowed = new Set(["days"]);
  const seen = new Set<string>();
  for (const [key] of requestUrl.searchParams) {
    if (!allowed.has(key) || seen.has(key)) throw new TokenUsageHttpInputError("Token usage query parameters are invalid.");
    seen.add(key);
  }
  const raw = requestUrl.searchParams.get("days");
  if (raw === null) return 30;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
    throw new TokenUsageHttpInputError("Token usage days must be between 1 and 90.");
  }
  return parsed;
}

function emptyTokenUsageQuery(requestUrl: URL) {
  let days = 30;
  try { days = parseTokenUsageDays(requestUrl); } catch { days = 30; }
  return buildTokenUsageQuery([], days, Date.now());
}
