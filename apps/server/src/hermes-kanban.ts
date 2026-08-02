import { redactSecrets } from "./secret-scrubber.js";

const KANBAN_PREFIX = "/api/plugins/kanban";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_CARDS = 2_000;
const MAX_COMMENTS = 2_000;

const READ_STATUSES = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "archived",
] as const;

// Hermes 0.18.2 refuses direct `running` writes (dispatcher-owned) and its
// current PATCH route does not implement direct `review` transitions.
const WRITE_STATUSES = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "blocked",
  "done",
  "archived",
] as const;

export type HermesKanbanStatus = (typeof READ_STATUSES)[number];
export type HermesKanbanWritableStatus = (typeof WRITE_STATUSES)[number];

export interface SafeKanbanCard {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: HermesKanbanStatus;
  priority: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  latestSummary: string | null;
  commentCount: number;
}

export interface SafeKanbanColumn {
  status: HermesKanbanStatus;
  cards: SafeKanbanCard[];
}

export interface SafeKanbanBoard {
  board: string | null;
  columns: SafeKanbanColumn[];
  assignees: string[];
  latestEventId: number;
  serverTime: number;
}

export interface SafeKanbanComment {
  id: number;
  cardId: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface SafeKanbanCardDetail {
  card: SafeKanbanCard;
  comments: SafeKanbanComment[];
}

export interface CreateKanbanCardInput {
  title: string;
  body?: string | null;
  assignee?: string | null;
  priority?: number;
  triage?: boolean;
}

export interface UpdateKanbanCardInput {
  status?: HermesKanbanWritableStatus;
  assignee?: string | null;
}

export interface HermesKanbanRequest {
  method: "GET" | "PATCH" | "POST";
  path: `/${string}`;
  body?: Readonly<Record<string, unknown>>;
}

export type HermesKanbanRequester = (request: HermesKanbanRequest) => Promise<unknown>;

export interface HermesKanbanAdapterOptions {
  request: HermesKanbanRequester;
  listAllowedProfiles: () => readonly string[] | Promise<readonly string[]>;
}

export interface HermesKanbanHttpOptions {
  baseUrl: string;
  sessionToken: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class KanbanValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KanbanValidationError";
    this.code = code;
  }
}

export class HermesKanbanUpstreamError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "HermesKanbanUpstreamError";
    if (status !== undefined) this.status = status;
  }
}

/** A non-idempotent Kanban POST may have committed before its reply was lost. */
export class HermesKanbanCommitUnconfirmedError extends Error {
  constructor() {
    super("Hermes may have committed this Kanban change; refresh before retrying.");
    this.name = "HermesKanbanCommitUnconfirmedError";
  }
}

export class HermesKanbanAdapter {
  readonly #request: HermesKanbanRequester;
  readonly #listAllowedProfiles: HermesKanbanAdapterOptions["listAllowedProfiles"];

  constructor(options: HermesKanbanAdapterOptions) {
    this.#request = options.request;
    this.#listAllowedProfiles = options.listAllowedProfiles;
  }

  async getBoard(options: { board?: string; includeArchived?: boolean } = {}): Promise<SafeKanbanBoard> {
    const board = optionalBoard(options.board);
    const path = withQuery(`${KANBAN_PREFIX}/board`, {
      board,
      include_archived: options.includeArchived === true ? "true" : undefined,
    });
    const raw = await this.#request({ method: "GET", path });
    return parseBoard(raw, board);
  }

  async getCard(cardId: string, options: { board?: string } = {}): Promise<SafeKanbanCardDetail> {
    const id = validCardId(cardId);
    const board = optionalBoard(options.board);
    const path = withQuery(`${KANBAN_PREFIX}/tasks/${encodeURIComponent(id)}`, { board });
    const raw = record(await this.#request({ method: "GET", path }), "card detail");
    const commentsRaw = array(raw.comments, "comments", MAX_COMMENTS);
    const card = parseCard(raw.task);
    const comments = commentsRaw.map(parseComment);
    if (card.id !== id || comments.some((comment) => comment.cardId !== id)) {
      throw new HermesKanbanUpstreamError("Hermes Kanban returned mismatched card detail.");
    }
    return {
      card,
      comments,
    };
  }

  async createCard(input: CreateKanbanCardInput, options: { board?: string } = {}): Promise<SafeKanbanCard> {
    const body: Record<string, unknown> = {
      title: boundedText(input.title, "title", 1, 240),
      workspace_kind: "scratch",
    };
    if (input.body !== undefined) body.body = optionalText(input.body, "body", 32_000);
    if (input.assignee !== undefined && input.assignee !== null) {
      body.assignee = await this.#allowedProfile(input.assignee);
    }
    if (input.priority !== undefined) body.priority = boundedInteger(input.priority, "priority", -100, 100);
    if (input.triage !== undefined) body.triage = boolean(input.triage, "triage");
    assertRequestSize(body);

    const board = optionalBoard(options.board);
    const response = await this.#request({
      method: "POST",
      path: withQuery(`${KANBAN_PREFIX}/tasks`, { board }),
      body,
    });
    try {
      const raw = record(response, "create result");
      return parseCard(raw.task);
    } catch (error) {
      if (error instanceof HermesKanbanCommitUnconfirmedError) throw error;
      throw commitUnconfirmed();
    }
  }

  async updateCard(
    cardId: string,
    input: UpdateKanbanCardInput,
    options: { board?: string } = {},
  ): Promise<SafeKanbanCard> {
    const id = validCardId(cardId);
    const keys = Object.keys(input);
    if (keys.length === 0 || keys.some((key) => key !== "status" && key !== "assignee")) {
      throw new KanbanValidationError("INVALID_PATCH", "A status or assignee update is required.");
    }
    const body: Record<string, unknown> = {};
    if (input.status !== undefined) body.status = writableStatus(input.status);
    if (input.assignee !== undefined) {
      body.assignee = input.assignee === null ? "" : await this.#allowedProfile(input.assignee);
    }
    assertRequestSize(body);

    const board = optionalBoard(options.board);
    const raw = record(await this.#request({
      method: "PATCH",
      path: withQuery(`${KANBAN_PREFIX}/tasks/${encodeURIComponent(id)}`, { board }),
      body,
    }), "update result");
    return parseCard(raw.task);
  }

  async setStatus(
    cardId: string,
    status: HermesKanbanWritableStatus,
    options: { board?: string } = {},
  ): Promise<SafeKanbanCard> {
    return await this.updateCard(cardId, { status }, options);
  }

  async setAssignee(
    cardId: string,
    assignee: string | null,
    options: { board?: string } = {},
  ): Promise<SafeKanbanCard> {
    return await this.updateCard(cardId, { assignee }, options);
  }

  async addComment(
    cardId: string,
    comment: string,
    options: { board?: string } = {},
  ): Promise<void> {
    const id = validCardId(cardId);
    const body = { body: boundedText(comment, "comment", 1, 16_000), author: "hermes-studio" };
    assertRequestSize(body);
    const board = optionalBoard(options.board);
    const response = await this.#request({
      method: "POST",
      path: withQuery(`${KANBAN_PREFIX}/tasks/${encodeURIComponent(id)}/comments`, { board }),
      body,
    });
    try {
      const raw = record(response, "comment result");
      if (raw.ok !== true) throw new HermesKanbanUpstreamError("Hermes did not confirm the comment.");
    } catch (error) {
      if (error instanceof HermesKanbanCommitUnconfirmedError) throw error;
      throw commitUnconfirmed();
    }
  }

  async #allowedProfile(value: string): Promise<string> {
    const profile = validProfile(value);
    const allowed = await this.#listAllowedProfiles();
    if (allowed.length > 1_000 || !allowed.includes(profile)) {
      throw new KanbanValidationError("UNKNOWN_PROFILE", "The selected profile is not available.");
    }
    return profile;
  }
}

export function createHermesKanbanHttpRequester(options: HermesKanbanHttpOptions): HermesKanbanRequester {
  const baseUrl = loopbackOrigin(options.baseUrl);
  const token = boundedText(options.sessionToken, "session token", 32, 4_096);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs === undefined
    ? 5_000
    : boundedInteger(options.timeoutMs, "timeout", 250, 15_000);

  return async (request) => {
    if (!request.path.startsWith(`${KANBAN_PREFIX}/`) && request.path !== `${KANBAN_PREFIX}/board`) {
      throw new KanbanValidationError("INVALID_ROUTE", "Only Hermes Kanban routes are allowed.");
    }
    const target = new URL(request.path, baseUrl);
    if (target.origin !== baseUrl.origin || !target.pathname.startsWith(`${KANBAN_PREFIX}/`)) {
      throw new KanbanValidationError("INVALID_ROUTE", "The Hermes Kanban route is invalid.");
    }
    if (request.body !== undefined) assertRequestSize(request.body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await fetchImpl(target, {
        method: request.method,
        headers: {
          Accept: "application/json",
          "X-Hermes-Session-Token": token,
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        if (request.method === "POST" && ambiguousMutationStatus(response.status)) {
          throw commitUnconfirmed();
        }
        throw new HermesKanbanUpstreamError(`Hermes Kanban request failed (${response.status}).`, response.status);
      }
      const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new HermesKanbanUpstreamError("Hermes Kanban returned invalid JSON.");
      }
    } catch (error) {
      if (error instanceof KanbanValidationError || error instanceof HermesKanbanCommitUnconfirmedError) throw error;
      if (error instanceof HermesKanbanUpstreamError) {
        if (request.method === "POST" && error.status === undefined) throw commitUnconfirmed();
        throw error;
      }
      if (request.method === "POST") throw commitUnconfirmed();
      throw new HermesKanbanUpstreamError("Hermes Kanban is unavailable.");
    } finally {
      clearTimeout(timer);
    }
  };
}

function ambiguousMutationStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function commitUnconfirmed(): HermesKanbanCommitUnconfirmedError {
  return new HermesKanbanCommitUnconfirmedError();
}

function parseBoard(value: unknown, board: string | undefined): SafeKanbanBoard {
  const raw = record(value, "board");
  const columnsRaw = array(raw.columns, "columns", READ_STATUSES.length);
  let cardCount = 0;
  const columns = columnsRaw.map((item): SafeKanbanColumn => {
    const column = record(item, "column");
    const status = readStatus(column.name);
    const cardsRaw = array(column.tasks, "cards", MAX_CARDS);
    cardCount += cardsRaw.length;
    if (cardCount > MAX_CARDS) throw new HermesKanbanUpstreamError("Hermes Kanban board is too large.");
    return { status, cards: cardsRaw.map(parseCard) };
  });
  return {
    board: board ?? null,
    columns,
    assignees: array(raw.assignees, "assignees", 1_000)
      .map((value) => validProfile(string(value, "assignee"))),
    latestEventId: nonNegativeInteger(raw.latest_event_id, "latest event id"),
    serverTime: nonNegativeInteger(raw.now, "server time"),
  };
}

function parseCard(value: unknown): SafeKanbanCard {
  const raw = record(value, "card");
  return {
    id: validCardId(string(raw.id, "card id")),
    title: safeUpstreamText(string(raw.title, "title"), "title", 1, 240),
    body: nullableSafeUpstreamText(raw.body, "body", 32_000),
    assignee: raw.assignee === null || raw.assignee === undefined
      ? null
      : validProfile(string(raw.assignee, "assignee")),
    status: readStatus(raw.status),
    priority: boundedInteger(raw.priority, "priority", -100, 100),
    createdAt: nonNegativeInteger(raw.created_at, "created at"),
    startedAt: nullableNonNegativeInteger(raw.started_at, "started at"),
    completedAt: nullableNonNegativeInteger(raw.completed_at, "completed at"),
    latestSummary: nullableSafeUpstreamText(raw.latest_summary, "latest summary", 16_000),
    commentCount: raw.comment_count === undefined
      ? 0
      : nonNegativeInteger(raw.comment_count, "comment count"),
  };
}

function parseComment(value: unknown): SafeKanbanComment {
  const raw = record(value, "comment");
  return {
    id: nonNegativeInteger(raw.id, "comment id"),
    cardId: validCardId(string(raw.task_id, "comment card id")),
    author: safeUpstreamText(string(raw.author, "comment author"), "comment author", 1, 128),
    body: safeUpstreamText(string(raw.body, "comment body"), "comment body", 1, 16_000),
    createdAt: nonNegativeInteger(raw.created_at, "comment created at"),
  };
}

function withQuery(path: string, query: Record<string, string | undefined>): `/${string}` {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  return `${path}${suffix}` as `/${string}`;
}

function optionalBoard(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const board = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(board)) {
    throw new KanbanValidationError("INVALID_BOARD", "The board identifier is invalid.");
  }
  return board;
}

function validCardId(value: string): string {
  const id = value.trim();
  if (!/^t_[0-9a-f]{8,64}$/.test(id)) {
    throw new KanbanValidationError("INVALID_CARD_ID", "The card identifier is invalid.");
  }
  return id;
}

function validProfile(value: string): string {
  const profile = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new KanbanValidationError("INVALID_PROFILE", "The profile identifier is invalid.");
  }
  return profile;
}

function readStatus(value: unknown): HermesKanbanStatus {
  const status = string(value, "status");
  if (!(READ_STATUSES as readonly string[]).includes(status)) {
    throw new HermesKanbanUpstreamError("Hermes Kanban returned an unsupported status.");
  }
  return status as HermesKanbanStatus;
}

function writableStatus(value: unknown): HermesKanbanWritableStatus {
  if (typeof value !== "string" || !(WRITE_STATUSES as readonly string[]).includes(value)) {
    throw new KanbanValidationError(
      "UNSUPPORTED_STATUS",
      "That status cannot be set directly by Hermes Studio.",
    );
  }
  return value as HermesKanbanWritableStatus;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HermesKanbanUpstreamError(`Hermes Kanban returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new HermesKanbanUpstreamError(`Hermes Kanban returned invalid ${label}.`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new HermesKanbanUpstreamError(`Hermes Kanban returned an invalid ${label}.`);
  return value;
}

function boundedText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new KanbanValidationError("INVALID_TEXT", `${label} must be text.`);
  const text = value.trim();
  if (text.length < min || text.length > max || text.includes("\0")) {
    throw new KanbanValidationError("INVALID_TEXT", `${label} has an invalid length.`);
  }
  return text;
}

function optionalText(value: string | null, label: string, max: number): string | null {
  return value === null ? null : boundedText(value, label, 0, max);
}

function nullableBoundedText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    throw new HermesKanbanUpstreamError(`Hermes Kanban returned an invalid ${label}.`);
  }
  return value;
}

function safeUpstreamText(value: string, label: string, min: number, max: number): string {
  const text = boundedText(value, label, min, max);
  return redactSecrets(text).value;
}

function nullableSafeUpstreamText(value: unknown, label: string, max: number): string | null {
  const text = nullableBoundedText(value, label, max);
  return text === null ? null : redactSecrets(text).value;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new KanbanValidationError("INVALID_NUMBER", `${label} must be an integer from ${min} to ${max}.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  try {
    return boundedInteger(value, label, 0, Number.MAX_SAFE_INTEGER);
  } catch {
    throw new HermesKanbanUpstreamError(`Hermes Kanban returned an invalid ${label}.`);
  }
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  return value === undefined || value === null ? null : nonNegativeInteger(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new KanbanValidationError("INVALID_BOOLEAN", `${label} must be boolean.`);
  return value;
}

function assertRequestSize(body: Readonly<Record<string, unknown>>): void {
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_REQUEST_BYTES) {
    throw new KanbanValidationError("REQUEST_TOO_LARGE", "The Kanban request is too large.");
  }
}

function loopbackOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KanbanValidationError("INVALID_ORIGIN", "The Hermes URL is invalid.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(host) || url.pathname !== "/") {
    throw new KanbanValidationError("INVALID_ORIGIN", "Hermes Kanban must use a loopback HTTP origin.");
  }
  url.search = "";
  url.hash = "";
  return url;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new HermesKanbanUpstreamError("Hermes Kanban response is too large.");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new HermesKanbanUpstreamError("Hermes Kanban response is too large.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
