import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import {
  appendStudioDefaultDelegationTurnInstruction,
  appendStudioFollowUpTurnInstruction,
  stripStudioFollowUpTurnInstruction,
} from "./office-agent-behavior.js";
import { CHAT_PROMPT_MAX_UTF8_BYTES, isGlobalContextWithinBudget } from "@hermes-studio/protocol";
import { redactSecrets } from "./secret-scrubber.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const SLASH_TIMEOUT_MS = 180_000;
const SESSION_START_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const DEFAULT_MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 128 * 1024;
const ALLOWED_SLASH_COMMANDS = new Set([
  "/model",
  "/help",
  "/status",
  "/compact",
  "/skills",
  "/memory",
  "/undo",
  "/reasoning",
]);
const MAX_HISTORY_OFFSET = 100_000_000;
const MAX_OPAQUE_SOURCE_ID_BYTES = 2_048;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STUDIO_MODEL_SLASH_PATTERN = /^\/model\s+[A-Za-z0-9][A-Za-z0-9_./:+@-]{0,255}(?:\s+--provider\s+[A-Za-z0-9][A-Za-z0-9_./:-]{0,127})?\s+--session$/;
const STUDIO_REASONING_SLASH_PATTERN = /^\/reasoning\s+(?:default|none|minimal|low|medium|high|xhigh|max|ultra)$/;
const SAFE_REASONING_EFFORTS = new Set(["", "default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const MINIMAL_PARTIAL_DELEGATION_CATALOG = JSON.stringify({
  version: 1,
  catalogStatus: "partial",
  usableFor: ["main", "subagent"],
  coverage: "profile-scoped live provider catalogs",
  truncated: true,
});
const MINIMAL_UNAVAILABLE_DELEGATION_CATALOG = JSON.stringify({
  version: 1,
  catalogStatus: "unavailable",
  usableFor: ["main", "subagent"],
  coverage: "profile-scoped live provider catalogs",
});

export const HERMES_CHAT_METHODS = [
  "session.create",
  "session.resume",
  "session.close",
  "prompt.submit",
  "session.interrupt",
  "session.steer",
  "clarify.respond",
  "approval.respond",
  "slash.exec",
  "complete.slash",
] as const;

export type HermesChatMethod = (typeof HERMES_CHAT_METHODS)[number];

export interface HermesChatTransportOptions {
  /** Credential-free loopback origin of the internally managed Hermes server. */
  baseUrl: string | URL;
  /** Process-private Hermes dashboard token. It is only used by this module. */
  sessionToken: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
  maxHistoryBytes?: number;
  maxTextBytes?: number;
}

export interface HermesChatRequest {
  method: HermesChatMethod;
  params?: Record<string, unknown>;
}

export interface HermesChatResult {
  method: HermesChatMethod;
  value: Record<string, boolean | number | string | null>;
}

export interface HermesChatInternalRequestOptions {
  /** Trusted Office-owned system context for a brand-new session only. */
  sessionCreateSystemSeed?: string;
  /** Trusted Studio default-Profile specialist-handoff gate for one prompt. */
  studioDefaultDelegationTurn?: true;
  /** Bounded, secret-free Profile model DTOs resolved by Studio Server. */
  studioDefaultDelegationModelCatalog?: string;
  /** Trusted Studio response-format reinforcement for one ordinary prompt. */
  studioFollowUpTurn?: true;
}

export interface HermesChatEvent {
  type: string;
  sessionId?: string;
  profile?: string;
  payload: Record<string, boolean | number | string | string[] | null>;
}

export interface HermesChatConnection {
  request(request: HermesChatRequest, internal?: HermesChatInternalRequestOptions): Promise<HermesChatResult>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export interface HermesHistoryRequest {
  sessionId: string;
  profile: string;
  limit?: number;
  offset?: number;
}

export interface HermesHistorySummary {
  sessionId: string;
  total: number;
}

export type HermesHistoryRole = "assistant" | "system" | "tool" | "user";

export interface HermesHistoryMessageDto {
  index: number;
  role: HermesHistoryRole;
  text: string;
  timestamp?: string;
  toolName?: string;
  redacted?: boolean;
}

export interface HermesHistoryDto {
  sessionId: string;
  profile: string;
  messages: HermesHistoryMessageDto[];
  pagination: {
    limit: number;
    offset: number;
    /** Number of rows returned on the Hermes wire before normalization. */
    returned: number;
    /** Number of rows that passed the secret-safe Office normalizer. */
    normalizedReturned: number;
    /** Malformed wire rows excluded by the normalizer. */
    dropped: number;
  };
}

export interface HermesChatTransport {
  connect(onEvent: (event: HermesChatEvent) => void, onClosed?: () => void): Promise<HermesChatConnection>;
  inspectHistory(request: Pick<HermesHistoryRequest, "sessionId" | "profile">): Promise<HermesHistorySummary>;
  fetchHistory(request: HermesHistoryRequest): Promise<HermesHistoryDto>;
}

export class HermesChatTransportError extends Error {
  readonly code:
    | "backend_closed"
    | "backend_rejected"
    | "connection_failed"
    | "invalid_request"
    | "response_too_large"
    | "timed_out";
  readonly rpcCode?: number;

  constructor(
    code: HermesChatTransportError["code"],
    message: string,
    rpcCode?: number,
  ) {
    super(message);
    this.name = "HermesChatTransportError";
    this.code = code;
    if (rpcCode !== undefined) this.rpcCode = rpcCode;
  }
}

export function createHermesChatTransport(
  options: HermesChatTransportOptions,
): HermesChatTransport {
  const config = normalizeOptions(options);
  return {
    connect: async (onEvent, onClosed) => await openConnection(config, onEvent, onClosed),
    inspectHistory: async (request) => await inspectHistory(config, request),
    fetchHistory: async (request) => await fetchHistory(config, request),
  };
}

/**
 * Compose trusted Studio prompt suffixes within the actual JSON-RPC frame
 * budget. Every prompt reserves the same default-gate/minimal-catalog/footer
 * envelope, so maximum user input does not vary by Profile. Full catalog data
 * is opportunistic and degrades to an explicit bounded header first.
 */
export function composeStudioPromptForWire(
  text: string,
  sessionId: string,
  internal: Pick<HermesChatInternalRequestOptions,
    "studioDefaultDelegationTurn" | "studioDefaultDelegationModelCatalog" | "studioFollowUpTurn"> | undefined,
  maxFrameBytes: number,
): string {
  if (internal?.studioDefaultDelegationModelCatalog !== undefined
    && internal.studioDefaultDelegationTurn !== true) {
    throw publicError("invalid_request", "Studio model catalog context requires the default delegation gate.");
  }
  const suppliedCatalog = internal?.studioDefaultDelegationModelCatalog === undefined
    ? undefined
    : requiredDelegationCatalog(internal.studioDefaultDelegationModelCatalog);
  const minimalCatalog = minimalDelegationCatalog(suppliedCatalog);
  const reserved = appendStudioFollowUpTurnInstruction(
    appendStudioDefaultDelegationTurnInstruction(text, minimalCatalog),
  );
  if (!promptFitsWire(sessionId, reserved, maxFrameBytes)) {
    throw publicError("invalid_request", "Prompt is too large for the Studio conversation context budget.");
  }
  if (internal?.studioDefaultDelegationTurn === true) {
    const withRequestedFollowUp = (value: string): string => internal.studioFollowUpTurn === true
      ? appendStudioFollowUpTurnInstruction(value)
      : value;
    const full = withRequestedFollowUp(
      appendStudioDefaultDelegationTurnInstruction(text, suppliedCatalog ?? minimalCatalog),
    );
    const minimal = withRequestedFollowUp(
      appendStudioDefaultDelegationTurnInstruction(text, minimalCatalog),
    );
    return promptFitsWire(sessionId, full, maxFrameBytes) ? full : minimal;
  }
  return internal?.studioFollowUpTurn === true
    ? appendStudioFollowUpTurnInstruction(text)
    : text;
}

interface NormalizedOptions {
  baseUrl: URL;
  sessionToken: string;
  timeoutMs: number;
  maxFrameBytes: number;
  maxHistoryBytes: number;
  maxTextBytes: number;
}

interface PendingRequest {
  method: HermesChatMethod;
  resolve: (value: HermesChatResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

async function openConnection(
  config: NormalizedOptions,
  onEvent: (event: HermesChatEvent) => void,
  onClosed?: () => void,
): Promise<HermesChatConnection> {
  const target = new URL("/api/ws", config.baseUrl);
  target.protocol = "ws:";
  target.searchParams.set("token", config.sessionToken);

  const websocket = new WebSocket(target, {
    maxPayload: config.maxFrameBytes,
    perMessageDeflate: false,
    handshakeTimeout: config.timeoutMs,
  });
  let closed = false;
  let sequence = 0;
  const pending = new Map<number, PendingRequest>();

  const failPending = (error: Error): void => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    try { onClosed?.(); } catch { /* A lifecycle listener cannot break transport cleanup. */ }
  };

  websocket.on("message", (data, isBinary) => {
    if (isBinary || byteLength(data) > config.maxFrameBytes) {
      websocket.close(1009, "Frame too large");
      failPending(publicError("response_too_large", "Hermes chat response was too large."));
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      websocket.close(1007, "Invalid JSON");
      failPending(publicError("backend_rejected", "Hermes returned an invalid chat response."));
      return;
    }
    if (!isRecord(frame) || frame.jsonrpc !== "2.0") return;
    if (frame.method === "event") {
      const event = normalizeEvent(frame.params, config.maxTextBytes);
      if (event !== undefined) {
        try { onEvent(event); } catch { /* A UI listener cannot break transport state. */ }
      }
      return;
    }
    if (typeof frame.id !== "number") return;
    const item = pending.get(frame.id);
    if (item === undefined) return;
    pending.delete(frame.id);
    clearTimeout(item.timer);
    if (isRecord(frame.error)) {
      const rpcCode = finiteNumber(frame.error.code);
      item.reject(publicRpcError(rpcCode));
      return;
    }
    try {
      item.resolve({ method: item.method, value: normalizeRpcResult(item.method, frame.result) });
    } catch (error) {
      item.reject(error instanceof Error ? error : publicError("backend_rejected", "Hermes returned an invalid chat response."));
    }
  });
  websocket.on("close", () => failPending(publicError("backend_closed", "Hermes chat connection closed.")));
  websocket.on("error", () => failPending(publicError("backend_closed", "Hermes chat connection failed.")));

  // Install frame handlers before awaiting `open`: Hermes emits gateway.ready
  // immediately after accepting the socket, and a fast loopback backend can
  // otherwise deliver that first event in the gap between open and listener setup.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      websocket.terminate();
      reject(publicError("timed_out", "Hermes chat connection timed out."));
    }, config.timeoutMs);
    timer.unref();
    const opened = () => {
      clearTimeout(timer);
      resolve();
    };
    websocket.once("open", opened);
    websocket.once("error", () => {
      clearTimeout(timer);
      reject(publicError("connection_failed", "Unable to connect to Hermes chat."));
    });
    // A loopback Hermes server can complete its handshake before the async
    // connection setup reaches this listener. In that case no later `open`
    // event will arrive, leaving the Office chat gateway permanently pending.
    if (websocket.readyState === WebSocket.OPEN) opened();
  });

  return {
    get closed() { return closed || websocket.readyState >= WebSocket.CLOSING; },
    request: async (request, internal) => {
      if (closed || websocket.readyState !== WebSocket.OPEN) {
        throw publicError("backend_closed", "Hermes chat connection is not open.");
      }
      const method = assertAllowedMethod(request.method);
      const params = validateParams(method, request.params ?? {}, config.maxTextBytes);
      if (internal?.sessionCreateSystemSeed !== undefined) {
        if (method !== "session.create") throw publicError("invalid_request", "Session context can only seed a new chat.");
        const content = requiredGlobalContext(internal.sessionCreateSystemSeed);
        params.messages = [{ role: "system", content }];
      }
      if (method === "prompt.submit" && typeof params.text === "string") {
        params.text = composeStudioPromptForWire(
          params.text,
          String(params.session_id),
          internal,
          config.maxFrameBytes,
        );
      } else if (internal?.studioDefaultDelegationTurn === true
        || internal?.studioDefaultDelegationModelCatalog !== undefined
        || internal?.studioFollowUpTurn === true) {
        throw publicError("invalid_request", "Studio prompt context can only reinforce a prompt.");
      }
      const id = ++sequence;
      const wire = upstreamWireRequest(method, params);
      const serialized = JSON.stringify({ jsonrpc: "2.0", id, method: wire.method, params: wire.params });
      if (Buffer.byteLength(serialized) > config.maxFrameBytes) {
        throw publicError("invalid_request", "Chat request is too large.");
      }
      return await new Promise<HermesChatResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(publicError("timed_out", "Hermes chat request timed out."));
        }, method === "slash.exec"
          ? Math.max(config.timeoutMs, SLASH_TIMEOUT_MS)
          : method === "session.create" || method === "session.resume"
            ? Math.max(config.timeoutMs, SESSION_START_TIMEOUT_MS)
            : config.timeoutMs);
        timer.unref();
        pending.set(id, { method, resolve, reject, timer });
        websocket.send(serialized, (error) => {
          if (error == null) return;
          const item = pending.get(id);
          if (item === undefined) return;
          pending.delete(id);
          clearTimeout(item.timer);
          item.reject(publicError("backend_closed", "Hermes chat request could not be sent."));
        });
      });
    },
    close: async () => {
      if (websocket.readyState === WebSocket.CLOSED) { failPending(publicError("backend_closed", "Hermes chat connection closed.")); return; }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { websocket.terminate(); resolve(); }, 1_000);
        timer.unref();
        websocket.once("close", () => { clearTimeout(timer); resolve(); });
        websocket.close(1000, "Office chat closed");
      });
    },
  };
}

async function inspectHistory(
  config: NormalizedOptions,
  request: Pick<HermesHistoryRequest, "sessionId" | "profile">,
): Promise<HermesHistorySummary> {
  const first = await fetchHistory(config, { ...request, limit: 1, offset: 0 });
  const target = new URL(`/api/sessions/${encodeURIComponent(first.sessionId)}`, config.baseUrl);
  target.searchParams.set("profile", requiredProfile(request.profile));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref();
  try {
    const response = await fetch(target, {
      headers: { Accept: "application/json", "X-Hermes-Session-Token": config.sessionToken },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw publicError("backend_rejected", response.status === 404 ? "Chat history was not found." : "Hermes rejected the history request.");
    const raw = JSON.parse(await readBoundedText(response, config.maxHistoryBytes)) as unknown;
    if (!isRecord(raw) || !Number.isSafeInteger(raw.message_count) || Number(raw.message_count) < 0 || Number(raw.message_count) > MAX_HISTORY_OFFSET) {
      throw publicError("backend_rejected", "Hermes returned invalid chat history metadata.");
    }
    return { sessionId: first.sessionId, total: Number(raw.message_count) };
  } catch (error) {
    if (error instanceof HermesChatTransportError) throw error;
    if (isAbortError(error)) throw publicError("timed_out", "Chat history request timed out.");
    throw publicError("backend_rejected", "Unable to inspect chat history.");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHistory(
  config: NormalizedOptions,
  request: HermesHistoryRequest,
): Promise<HermesHistoryDto> {
  const sessionId = requiredId(request.sessionId, "sessionId");
  const profile = requiredProfile(request.profile);
  const limit = boundedInteger(request.limit, 200, 1, 500);
  const offset = boundedInteger(request.offset, 0, 0, MAX_HISTORY_OFFSET);
  const target = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, config.baseUrl);
  target.searchParams.set("profile", profile);
  target.searchParams.set("limit", String(limit));
  target.searchParams.set("offset", String(offset));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref();
  try {
    const response = await fetch(target, {
      headers: { Accept: "application/json", "X-Hermes-Session-Token": config.sessionToken },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw publicError("backend_rejected", response.status === 404 ? "Chat history was not found." : "Hermes rejected the history request.");
    const raw = JSON.parse(await readBoundedText(response, config.maxHistoryBytes)) as unknown;
    return normalizeHistory(raw, sessionId, profile, limit, offset, config.maxTextBytes);
  } catch (error) {
    if (error instanceof HermesChatTransportError) throw error;
    if (isAbortError(error)) throw publicError("timed_out", "Chat history request timed out.");
    throw publicError("backend_rejected", "Unable to load chat history.");
  } finally {
    clearTimeout(timer);
  }
}

function validateParams(
  method: HermesChatMethod,
  raw: Record<string, unknown>,
  maxTextBytes: number,
): Record<string, boolean | number | string | Array<{ role: "system"; content: string }>> {
  if (!isRecord(raw)) throw publicError("invalid_request", "Chat parameters must be an object.");
  switch (method) {
    case "session.create": {
      assertOnlyKeys(raw, ["profile", "title", "model", "provider", "reasoning_effort", "fast", "close_on_disconnect", "cols"]);
      return compact({
        profile: optionalProfile(raw.profile),
        title: optionalText(raw.title, "title", 200),
        model: optionalText(raw.model, "model", 200),
        provider: optionalText(raw.provider, "provider", 100),
        reasoning_effort: optionalText(raw.reasoning_effort, "reasoning_effort", 32),
        fast: optionalBoolean(raw.fast, "fast"),
        close_on_disconnect: optionalBoolean(raw.close_on_disconnect, "close_on_disconnect") ?? true,
        cols: optionalInteger(raw.cols, "cols", 20, 400),
        source: "desktop",
      });
    }
    case "session.resume": {
      assertOnlyKeys(raw, ["session_id", "profile", "lazy", "close_on_disconnect", "cols"]);
      return compact({ session_id: requiredId(raw.session_id, "session_id"), profile: optionalProfile(raw.profile), lazy: optionalBoolean(raw.lazy, "lazy"), close_on_disconnect: optionalBoolean(raw.close_on_disconnect, "close_on_disconnect") ?? true, cols: optionalInteger(raw.cols, "cols", 20, 400), source: "desktop" });
    }
    case "session.close":
    case "session.interrupt": {
      assertOnlyKeys(raw, ["session_id"]);
      return { session_id: requiredId(raw.session_id, "session_id") };
    }
    case "prompt.submit":
    case "session.steer": {
      assertOnlyKeys(raw, ["session_id", "text"]);
      return { session_id: requiredId(raw.session_id, "session_id"), text: requiredText(raw.text, "text", maxTextBytes) };
    }
    case "slash.exec": {
      assertOnlyKeys(raw, ["session_id", "command", "confirm_expensive_model"]);
      const command = requiredText(raw.command, "command", Math.min(maxTextBytes, 8_192)).trim();
      const commandName = slashCommandName(command);
      if (commandName === undefined || !ALLOWED_SLASH_COMMANDS.has(commandName) || /[\r\n]/.test(command)) {
        throw publicError("invalid_request", "This slash command is not available in Studio.");
      }
      // A manual /model must never mutate the profile-wide default. Studio's
      // compact picker emits this flag automatically; enforce it at the trust
      // boundary for remote operator sessions as well.
      if (commandName === "/model" && !STUDIO_MODEL_SLASH_PATTERN.test(command)) {
        throw publicError("invalid_request", "Studio model changes must be session-scoped.");
      }
      if (commandName === "/reasoning" && !STUDIO_REASONING_SLASH_PATTERN.test(command)) {
        throw publicError("invalid_request", "Studio reasoning changes require an allowed effort level.");
      }
      if (commandName !== "/model" && commandName !== "/reasoning" && command !== commandName) {
        throw publicError("invalid_request", "Studio slash commands do not accept arguments.");
      }
      const confirmExpensiveModel = optionalBoolean(raw.confirm_expensive_model, "confirm_expensive_model");
      if (confirmExpensiveModel !== undefined && commandName !== "/model") {
        throw publicError("invalid_request", "Model confirmation is only available for /model.");
      }
      return compact({
        session_id: requiredId(raw.session_id, "session_id"),
        command,
        confirm_expensive_model: confirmExpensiveModel,
      });
    }
    case "complete.slash": {
      // Read-only command-name completion; no session required upstream.
      assertOnlyKeys(raw, ["text"]);
      const text = requiredText(raw.text, "text", 200);
      if (!text.startsWith("/")) throw publicError("invalid_request", "Completion text must start with '/'.");
      return { text };
    }
    case "clarify.respond": {
      assertOnlyKeys(raw, ["request_id", "answer"]);
      return {
        request_id: requiredId(raw.request_id, "request_id"),
        // Empty is the upstream's cancellation sentinel. The browser never
        // submits it through the normal UI, but Office uses it to settle an
        // expired clarification instead of hiding a still-blocked prompt.
        answer: clarificationAnswer(raw.answer, Math.min(maxTextBytes, 32 * 1024)),
      };
    }
    case "approval.respond": {
      assertOnlyKeys(raw, ["session_id", "choice"]);
      const choice = requiredText(raw.choice, "choice", 16);
      if (!["always", "deny", "once", "session"].includes(choice)) throw publicError("invalid_request", "Approval choice is invalid.");
      return { session_id: requiredId(raw.session_id, "session_id"), choice };
    }
  }
}

function normalizeRpcResult(method: HermesChatMethod, raw: unknown): Record<string, boolean | number | string | null> {
  const value = isRecord(raw) ? raw : {};
  if (method === "session.create" || method === "session.resume") {
    const info = isRecord(value.info) ? value.info : undefined;
    const model = safePublicText(firstValue(value, ["model"]) ?? firstValue(info ?? {}, ["model"]), 200);
    const provider = safePublicText(firstValue(value, ["provider"]) ?? firstValue(info ?? {}, ["provider"]), 100);
    const reasoningEffort = safeReasoningEffort(
      firstValue(value, ["reasoning_effort", "reasoningEffort", "reasoning"])
        ?? firstValue(info ?? {}, ["reasoning_effort", "reasoningEffort", "reasoning"]),
    );
    return compact({
      liveSessionId: safeId(value.session_id),
      storedSessionId: safeId(value.stored_session_id),
      resumedSessionId: safeId(value.resumed),
      messageCount: finiteNumber(value.message_count),
      running: typeof value.running === "boolean" ? value.running : typeof info?.running === "boolean" ? info.running : undefined,
      status: safePublicText(value.status, 80),
      model,
      provider,
      reasoningEffort,
    });
  }
  if (method === "session.close") {
    if (typeof value.closed !== "boolean") throw publicError("backend_rejected", "Hermes returned an invalid close result.");
    return { closed: value.closed };
  }
  if (method === "prompt.submit") {
    if (value.status !== "streaming") throw publicError("backend_rejected", "Hermes returned an invalid prompt result.");
    return compact({ status: "streaming", taskId: safeId(value.task_id) });
  }
  if (method === "session.interrupt") {
    if (value.status !== "interrupted") throw publicError("backend_rejected", "Hermes returned an invalid interrupt result.");
    return { status: "interrupted" };
  }
  if (method === "approval.respond") {
    if (value.resolved !== true) throw publicError("backend_rejected", "Hermes returned an invalid approval result.");
    return { resolved: true };
  }
  if (method === "clarify.respond") {
    if (value.status !== "ok") throw publicError("backend_rejected", "Hermes returned an invalid clarification result.");
    return { status: "ok" };
  }
  if (method === "slash.exec") {
    if (!isRecord(raw)) throw publicError("backend_rejected", "Hermes returned an invalid slash result.");
    const type = safeEnum(value.type, ["exec", "plugin", "prefill", "send", "skill"]);
    const key = safeEnum(value.key, ["model", "reasoning"]);
    const output = safePublicMultilineText(value.output, 16_000);
    const message = safePublicMultilineText(value.message, 32_000);
    const notice = safePublicMultilineText(value.notice, 4_000);
    const warning = safePublicMultilineText(value.warning, 4_000);
    const confirmMessage = safePublicMultilineText(value.confirm_message, 4_000);
    const confirmRequired = value.confirm_required === true;
    if (output === undefined && message === undefined && notice === undefined && warning === undefined
      && confirmMessage === undefined
      && type === undefined && key === undefined) {
      throw publicError("backend_rejected", "Hermes returned an invalid slash result.");
    }
    return compact({
      status: confirmRequired ? "confirm_required" : "ok",
      output,
      warning,
      confirmMessage,
      type,
      message,
      notice,
      key,
      value: safePublicText(value.value, 300),
    });
  }
  if (method === "complete.slash") {
    // The flat result record cannot carry arrays; serialize the sanitized
    // completion items as JSON (client parses `itemsJson`).
    const rawItems = Array.isArray(value.items) ? value.items : [];
    const items = rawItems.flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const text = safePublicText(record.text, 100);
      const commandName = text === undefined ? undefined : slashCommandName(text);
      if (text === undefined || commandName === undefined || !ALLOWED_SLASH_COMMANDS.has(commandName)) return [];
      return [{
        text,
        display: safePublicText(record.display, 120) ?? text,
        meta: safePublicText(record.meta, 200) ?? "",
      }];
    }).slice(0, 50);
    return { status: "ok", itemsJson: JSON.stringify(items) };
  }
  return compact({ status: safePublicText(value.status, 80), taskId: safeId(value.task_id) });
}

function normalizeEvent(raw: unknown, maxTextBytes: number): HermesChatEvent | undefined {
  if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
  if (raw.type === "secret.request" || raw.type === "secret.expire" || raw.type === "sudo.request" || raw.type === "sudo.expire") return undefined;
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const base = {
    type: raw.type.slice(0, 80),
    ...(safeId(raw.session_id) === undefined ? {} : { sessionId: safeId(raw.session_id)! }),
    ...(safeProfile(raw.profile) === undefined ? {} : { profile: safeProfile(raw.profile)! }),
  };
  if (["message.start", "message.delta", "message.interim", "message.complete", "reasoning.available", "reasoning.delta", "thinking.delta", "background.complete"].includes(raw.type)) {
    // Optional upstream usage counters (never text). Office token-usage stats
    // prefer these over char/4 estimates when present on message.complete.
    const usage = isRecord(payload.usage) ? payload.usage : undefined;
    const messageIds = uniqueOpaqueSourceIds([payload, raw], ["message_id", "messageId"], "message");
    return {
      ...base,
      payload: compact({
        text: sanitizeText(firstString(payload, ["text", "content"]), maxTextBytes),
        messageId: messageIds[0],
        messageIds: messageIds.length === 0 ? undefined : messageIds,
        role: safeEnum(payload.role, ["assistant", "system", "tool", "user"]),
        // Hermes seals mid-turn commentary with message.interim so the final
        // message.complete does not wipe streamed provisional text.
        alreadyStreamed: payload.already_streamed === true || payload.alreadyStreamed === true ? true : undefined,
        responsePreviewed: payload.response_previewed === true || payload.responsePreviewed === true ? true : undefined,
        tokensIn: finiteNonNegativeInt(firstValue(payload, ["tokens_in", "prompt_tokens", "input_tokens"])
          ?? firstValue(usage ?? {}, ["tokens_in", "prompt_tokens", "input_tokens", "input"])),
        tokensOut: finiteNonNegativeInt(firstValue(payload, ["tokens_out", "completion_tokens", "output_tokens"])
          ?? firstValue(usage ?? {}, ["tokens_out", "completion_tokens", "output_tokens", "output"])),
      }),
    };
  }
  if (raw.type === "clarify.request") {
    const requestId = safeId(payload.request_id);
    const question = sanitizeText(firstString(payload, ["question"]), Math.min(maxTextBytes, 16 * 1024));
    if (requestId === undefined || question === undefined) return undefined;
    return { ...base, payload: compact({ requestId, question, choices: safePublicStringArray(payload.choices, 16, 200) }) };
  }
  if (raw.type === "approval.request") {
    return { ...base, payload: compact({ command: sanitizeText(firstString(payload, ["command"]), 8 * 1024), description: sanitizeText(firstString(payload, ["description"]), 2 * 1024), choices: safePublicStringArray(payload.choices, 8, 32), allowPermanent: typeof payload.allow_permanent === "boolean" ? payload.allow_permanent : undefined, smartDenied: payload.smart_denied === true }) };
  }
  if (["tool.start", "tool.generating", "tool.progress", "tool.complete"].includes(raw.type)) {
    const toolIds = uniqueOpaqueSourceIds(
      [payload, raw],
      ["tool_call_id", "call_id", "invocation_id", "tool_id"],
      "tool",
      uniqueOpaqueSourceIds([payload], ["id"], "tool"),
    );
    return { ...base, payload: compact({ toolId: toolIds[0], toolIds: toolIds.length === 0 ? undefined : toolIds, name: safePublicText(firstValue(payload, ["name", "tool_name"]), 120), status: safePublicText(payload.status, 80), summary: sanitizeText(firstString(payload, ["summary"]), 2 * 1024), error: typeof payload.error === "boolean" ? payload.error : undefined, durationSeconds: finiteNumber(payload.duration_s) }) };
  }
  if (raw.type === "status.update") {
    return { ...base, payload: compact({ kind: safePublicText(payload.kind, 80), status: safePublicText(payload.status, 80), message: sanitizeText(firstString(payload, ["message", "text"]), 2 * 1024) }) };
  }
  if (["gateway.ready", "session.info", "error"].includes(raw.type)) {
    const messageIds = raw.type === "error"
      ? uniqueOpaqueSourceIds([payload, raw], ["message_id", "messageId"], "message")
      : [];
    return { ...base, payload: compact({ status: safePublicText(payload.status, 80), message: sanitizeText(firstString(payload, ["message", "text"]), 2 * 1024), model: safePublicText(payload.model, 200), provider: safePublicText(payload.provider, 100), reasoningEffort: safeReasoningEffort(firstValue(payload, ["reasoning_effort", "reasoningEffort", "reasoning"])), running: typeof payload.running === "boolean" ? payload.running : undefined, storedSessionId: safeId(payload.stored_session_id), version: safePublicText(payload.version, 80), taskId: raw.type === "error" ? safeId(firstValue(payload, ["task_id", "taskId"])) : undefined, messageId: messageIds[0], messageIds: messageIds.length === 0 ? undefined : messageIds }) };
  }
  return undefined;
}

function normalizeHistory(raw: unknown, requestedId: string, profile: string, limit: number, offset: number, maxTextBytes: number): HermesHistoryDto {
  if (!isRecord(raw) || !Array.isArray(raw.messages)) throw publicError("backend_rejected", "Hermes returned invalid chat history.");
  if (raw.messages.length > limit) throw publicError("backend_rejected", "Hermes returned invalid chat history pagination.");
  const resolvedId = safeId(raw.session_id) ?? requestedId;
  const messages = raw.messages.flatMap((item, index): HermesHistoryMessageDto[] => {
    if (!isRecord(item) || !isRole(item.role)) return [];
    const timestamp = normalizeTimestamp(item.timestamp);
    if (item.timestamp !== undefined && timestamp === undefined) return [];
    const toolName = safePublicText(item.tool_name, 120);
    if (item.role === "system") return [{ index: offset + index, role: "system", text: "[System message hidden]", redacted: true, ...(timestamp === undefined ? {} : { timestamp }) }];
    if (item.role === "tool") return [{ index: offset + index, role: "tool", text: "[Tool output hidden]", redacted: true, ...(toolName === undefined ? {} : { toolName }), ...(timestamp === undefined ? {} : { timestamp }) }];
    const original = contentText(item.content);
    const visibleOriginal = item.role === "user" ? stripStudioFollowUpTurnInstruction(original) : original;
    const text = sanitizeText(visibleOriginal, maxTextBytes) ?? "";
    const redacted = text !== visibleOriginal;
    return [{ index: offset + index, role: item.role, text, ...(redacted ? { redacted: true } : {}), ...(timestamp === undefined ? {} : { timestamp }) }];
  });
  return {
    sessionId: resolvedId,
    profile,
    messages,
    pagination: {
      limit,
      offset,
      returned: raw.messages.length,
      normalizedReturned: messages.length,
      dropped: raw.messages.length - messages.length,
    },
  };
}

function normalizeOptions(options: HermesChatTransportOptions): NormalizedOptions {
  const baseUrl = options.baseUrl instanceof URL ? new URL(options.baseUrl) : new URL(options.baseUrl);
  if (baseUrl.protocol !== "http:" || baseUrl.username !== "" || baseUrl.password !== "" || baseUrl.pathname !== "/" || baseUrl.search !== "" || baseUrl.hash !== "" || !isLoopback(baseUrl.hostname)) throw new Error("Hermes chat requires a credential-free loopback HTTP origin.");
  if (options.sessionToken.length < 16 || options.sessionToken.length > 512 || options.sessionToken.includes("\0")) throw new Error("Hermes chat token is invalid.");
  return { baseUrl, sessionToken: options.sessionToken, timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60_000), maxFrameBytes: boundedInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 4_096, 1024 * 1024), maxHistoryBytes: boundedInteger(options.maxHistoryBytes, DEFAULT_MAX_HISTORY_BYTES, 4_096, 8 * 1024 * 1024), maxTextBytes: boundedInteger(options.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, 1_024, CHAT_PROMPT_MAX_UTF8_BYTES) };
}

function requiredGlobalContext(value: string): string {
  if (!isGlobalContextWithinBudget(value)) throw publicError("invalid_request", "Session context is too large.");
  return value;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw publicError("response_too_large", "Hermes history response was too large."); }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw publicError("response_too_large", "Hermes history response was too large."); }
    text += decoder.decode(value, { stream: true });
  }
}

function sanitizeText(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  // Redact before truncation so a size boundary cannot cut off the closing
  // delimiter of a credential (notably a PEM block) and defeat the matcher.
  return truncateUtf8(redactSecrets(value).value, maxBytes);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part): string[] => {
    if (!isRecord(part)) return [];
    if (!["text", "input_text", "output_text"].includes(String(part.type ?? "text"))) return [];
    return typeof part.text === "string" ? [part.text] : [];
  }).join("\n");
}

function publicRpcError(code: number | undefined): HermesChatTransportError {
  if (code === -32601) return new HermesChatTransportError("backend_rejected", "This Hermes chat capability is unavailable.", code);
  if (code === 4007) return new HermesChatTransportError("backend_rejected", "The Hermes session was not found.", code);
  if (code === 4090) return new HermesChatTransportError("backend_rejected", "Hermes has reached its active session limit.", code);
  return new HermesChatTransportError("backend_rejected", "Hermes rejected the chat request.", code);
}
function publicError(code: HermesChatTransportError["code"], message: string): HermesChatTransportError { return new HermesChatTransportError(code, message); }
function assertAllowedMethod(value: string): HermesChatMethod { if (!(HERMES_CHAT_METHODS as readonly string[]).includes(value)) throw publicError("invalid_request", "Chat method is not allowed."); return value as HermesChatMethod; }
function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void { const allowed = new Set(keys); if (Object.keys(value).some((key) => !allowed.has(key))) throw publicError("invalid_request", "Chat parameters contain unsupported fields."); }
function requiredId(value: unknown, name: string): string { if (typeof value !== "string" || !ID_PATTERN.test(value)) throw publicError("invalid_request", `${name} is invalid.`); return value; }
function safeId(value: unknown): string | undefined { return typeof value === "string" && ID_PATTERN.test(value) ? value : undefined; }
function opaqueSourceId(value: unknown, kind: "message" | "tool"): string | undefined {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_OPAQUE_SOURCE_ID_BYTES) return undefined;
  // UTF-16LE preserves every JavaScript code unit, including unmatched
  // surrogates, so distinct opaque wire ids cannot collapse before hashing.
  const encoded = Buffer.from(value, "utf16le");
  return `${kind}-source-${createHash("sha256").update(encoded).digest("base64url")}`;
}
function uniqueOpaqueSourceIds(
  values: readonly Record<string, unknown>[],
  keys: readonly string[],
  kind: "message" | "tool",
  trailing: readonly string[] = [],
): string[] {
  const ids = new Set<string>();
  for (const key of keys) {
    for (const value of values) {
      const candidate = opaqueSourceId(value[key], kind);
      if (candidate !== undefined) ids.add(candidate);
    }
  }
  for (const candidate of trailing) ids.add(candidate);
  return [...ids];
}
function requiredProfile(value: unknown): string { if (typeof value !== "string" || !PROFILE_PATTERN.test(value)) throw publicError("invalid_request", "profile is invalid."); return value; }
function optionalProfile(value: unknown): string | undefined { return value === undefined ? undefined : requiredProfile(value); }
function safeProfile(value: unknown): string | undefined { return typeof value === "string" && PROFILE_PATTERN.test(value) ? value : undefined; }
function requiredText(value: unknown, name: string, maxBytes: number): string { if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value) > maxBytes || value.includes("\0")) throw publicError("invalid_request", `${name} is invalid.`); return value; }
function requiredDelegationCatalog(value: unknown): string { return requiredText(value, "studioDefaultDelegationModelCatalog", 64 * 1024); }
function minimalDelegationCatalog(value: string | undefined): string {
  if (value === undefined) return MINIMAL_UNAVAILABLE_DELEGATION_CATALOG;
  try {
    const firstLine = value.split("\n", 1)[0];
    const header = firstLine === undefined ? undefined : JSON.parse(firstLine) as unknown;
    if (isRecord(header) && header.catalogStatus === "unavailable") {
      return MINIMAL_UNAVAILABLE_DELEGATION_CATALOG;
    }
    if (isRecord(header) && (header.catalogStatus === "complete" || header.catalogStatus === "partial")) {
      return MINIMAL_PARTIAL_DELEGATION_CATALOG;
    }
  } catch { /* Malformed trusted metadata degrades without exposing diagnostics. */ }
  return MINIMAL_UNAVAILABLE_DELEGATION_CATALOG;
}
function promptFitsWire(sessionId: string, text: string, maxFrameBytes: number): boolean {
  const serialized = JSON.stringify({
    jsonrpc: "2.0",
    // Reserve the largest id representation the process can safely emit.
    id: Number.MAX_SAFE_INTEGER,
    method: "prompt.submit",
    params: { session_id: sessionId, text },
  });
  return Buffer.byteLength(serialized) <= maxFrameBytes;
}
function clarificationAnswer(value: unknown, maxBytes: number): string { if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes || value.includes("\0")) throw publicError("invalid_request", "answer is invalid."); return value; }
function optionalText(value: unknown, name: string, maxChars: number): string | undefined { if (value === undefined) return undefined; if (typeof value !== "string" || value.length > maxChars || value.includes("\0")) throw publicError("invalid_request", `${name} is invalid.`); return value; }
function optionalBoolean(value: unknown, name: string): boolean | undefined { if (value === undefined) return undefined; if (typeof value !== "boolean") throw publicError("invalid_request", `${name} is invalid.`); return value; }
function optionalInteger(value: unknown, name: string, min: number, max: number): number | undefined { if (value === undefined) return undefined; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw publicError("invalid_request", `${name} is invalid.`); return value; }
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.trunc(value))); }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function finiteNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return undefined;
  return Math.floor(value);
}
function safePublicText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return redactSecrets(value).value.slice(0, maxChars).replace(/[\u0000-\u001f\u007f]/g, "");
}
function safePublicMultilineText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return redactSecrets(value).value.slice(0, maxChars)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
function safeEnum(value: unknown, allowed: readonly string[]): string | undefined { return typeof value === "string" && allowed.includes(value) ? value : undefined; }
function safeReasoningEffort(value: unknown): string | undefined { return typeof value === "string" && SAFE_REASONING_EFFORTS.has(value) ? value : undefined; }
function safePublicStringArray(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, maxItems).flatMap((item): string[] => {
    const safe = safePublicText(item, maxChars);
    return safe === undefined ? [] : [safe];
  });
}
function slashCommandName(value: string): string | undefined {
  const match = /^\/[A-Za-z0-9._-]+(?=\s|$)/.exec(value.trim());
  return match?.[0]?.toLowerCase();
}
function upstreamWireRequest(
  method: HermesChatMethod,
  params: Record<string, boolean | number | string | Array<{ role: "system"; content: string }>>,
): { method: string; params: Record<string, unknown> } {
  if (method !== "slash.exec" || typeof params.command !== "string") return { method, params };
  const command = params.command.trim();
  if (/^\/model\s/i.test(command)) {
    return {
      method: "config.set",
      params: {
        session_id: params.session_id,
        key: "model",
        value: command.slice("/model".length).trim(),
        confirm_expensive_model: params.confirm_expensive_model === true,
      },
    };
  }
  if (/^\/reasoning\s/i.test(command)) {
    const effort = command.slice("/reasoning".length).trim();
    return {
      method: "config.set",
      params: {
        session_id: params.session_id,
        key: "reasoning",
        // Hermes clears a session override with an empty config.set value.
        value: effort === "default" ? "" : effort,
      },
    };
  }
  return { method, params };
}
function firstValue(value: Record<string, unknown>, keys: readonly string[]): unknown { for (const key of keys) if (value[key] !== undefined) return value[key]; return undefined; }
function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined { const item = firstValue(value, keys); return typeof item === "string" ? item : undefined; }
function isRole(value: unknown): value is HermesHistoryRole { return value === "assistant" || value === "system" || value === "tool" || value === "user"; }
function normalizeTimestamp(value: unknown): string | undefined { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined; const millis = value < 10_000_000_000 ? value * 1_000 : value; const date = new Date(millis); return Number.isNaN(date.valueOf()) ? undefined : date.toISOString(); }
function truncateUtf8(value: string, maxBytes: number): string { if (Buffer.byteLength(value) <= maxBytes) return value; let end = Math.min(value.length, maxBytes); while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end = Math.floor(end * 0.9); while (end < value.length && Buffer.byteLength(value.slice(0, end + 1)) <= maxBytes) end += 1; return `${value.slice(0, end)}…`; }
function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isLoopback(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"; }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError"; }
function byteLength(value: WebSocket.RawData): number { return Array.isArray(value) ? value.reduce((sum, item) => sum + item.byteLength, 0) : value.byteLength; }
