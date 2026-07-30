import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ChatModelPreferencePreset,
  ChatModelPreferenceSlot,
  ChatModelPreferencesDocument,
  ChatModelPreferencesSnapshot,
  UpdateChatModelPreferencesRequest,
} from "@hermes-studio/protocol";

const MAX_DOCUMENT_UTF8_BYTES = 64 * 1024;
const MAX_PRESETS = 32;
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REASONING_EFFORTS = new Set([
  "",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export class ChatModelPreferencesError extends Error {
  constructor(
    readonly code: "conflict" | "invalid_request" | "storage_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ChatModelPreferencesError";
  }
}

/** Durable Studio-owned model selection shared by desktop and remote clients. */
export class OfficeChatModelPreferencesStore {
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    if (filePath.trim() === "" || filePath.includes("\0")) {
      throw invalid("Chat model preferences path is invalid.");
    }
    this.#filePath = filePath;
  }

  async read(): Promise<ChatModelPreferencesSnapshot> {
    await this.#queue;
    return await this.#readUnsafe();
  }

  async update(input: UpdateChatModelPreferencesRequest): Promise<ChatModelPreferencesSnapshot> {
    return await this.#mutate(async () => {
      const current = await this.#readUnsafe();
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== current.revision) {
        throw new ChatModelPreferencesError(
          "conflict",
          "Chat model preferences changed; refresh before saving.",
        );
      }
      const document = validateDocument(input.document);
      const next: ChatModelPreferencesSnapshot = {
        revision: current.revision + 1,
        document,
        updatedAt: new Date().toISOString(),
      };
      try {
        await atomicWriteJson(this.#filePath, next);
      } catch {
        throw new ChatModelPreferencesError(
          "storage_unavailable",
          "Chat model preferences could not be saved.",
        );
      }
      return next;
    });
  }

  async #readUnsafe(): Promise<ChatModelPreferencesSnapshot> {
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return defaultSnapshot();
      throw new ChatModelPreferencesError(
        "storage_unavailable",
        "Chat model preferences could not be read.",
      );
    }
    if (Buffer.byteLength(text) > MAX_DOCUMENT_UTF8_BYTES + 4 * 1024) {
      throw new ChatModelPreferencesError(
        "storage_unavailable",
        "Stored chat model preferences are too large.",
      );
    }
    try {
      return validateSnapshot(JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof ChatModelPreferencesError && error.code === "storage_unavailable") throw error;
      throw new ChatModelPreferencesError(
        "storage_unavailable",
        "Stored chat model preferences are invalid.",
      );
    }
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#queue.then(operation, operation);
    this.#queue = pending.then(() => undefined, () => undefined);
    return await pending;
  }
}

export function validateChatModelPreferencesDocument(value: unknown): ChatModelPreferencesDocument {
  return validateDocument(value);
}

function validateSnapshot(value: unknown): ChatModelPreferencesSnapshot {
  if (!isRecord(value)) throw invalid("Stored chat model preferences are invalid.");
  assertOnlyKeys(value, ["revision", "document", "updatedAt"]);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw invalid("Stored chat model preferences revision is invalid.");
  }
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
    throw invalid("Stored chat model preferences timestamp is invalid.");
  }
  return {
    revision: value.revision as number,
    document: validateDocument(value.document),
    updatedAt: value.updatedAt,
  };
}

function validateDocument(value: unknown): ChatModelPreferencesDocument {
  if (!isRecord(value)) throw invalid("Chat model preferences document is invalid.");
  assertOnlyKeys(value, ["main", "sub", "presets", "activePresetId"]);
  if (!Array.isArray(value.presets) || value.presets.length > MAX_PRESETS) {
    throw invalid("Chat model preferences presets are invalid.");
  }
  const presets = value.presets.map((preset, index) => validatePreset(preset, index));
  if (new Set(presets.map((preset) => preset.id)).size !== presets.length) {
    throw invalid("Chat model preference preset ids must be unique.");
  }
  let activePresetId: string | undefined;
  if (value.activePresetId !== undefined) {
    activePresetId = requiredPresetId(value.activePresetId, "activePresetId");
    if (!presets.some((preset) => preset.id === activePresetId)) {
      throw invalid("Active chat model preference preset was not found.");
    }
  }
  const document: ChatModelPreferencesDocument = {
    main: validateSlot(value.main, "main"),
    sub: validateSlot(value.sub, "sub"),
    presets,
    ...(activePresetId === undefined ? {} : { activePresetId }),
  };
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_UTF8_BYTES) {
    throw invalid("Chat model preferences document is too large.");
  }
  return document;
}

function validatePreset(value: unknown, index: number): ChatModelPreferencePreset {
  if (!isRecord(value)) throw invalid(`Chat model preference preset ${index} is invalid.`);
  assertOnlyKeys(value, ["id", "name", "main", "sub"]);
  const name = requiredSafeString(value.name, `presets.${index}.name`, 64, 256);
  if (name === "") throw invalid(`Chat model preference preset ${index} name is invalid.`);
  return {
    id: requiredPresetId(value.id, `presets.${index}.id`),
    name,
    main: validateSlot(value.main, `presets.${index}.main`),
    sub: validateSlot(value.sub, `presets.${index}.sub`),
  };
}

function validateSlot(value: unknown, name: string): ChatModelPreferenceSlot {
  if (!isRecord(value)) throw invalid(`Chat model preference ${name} is invalid.`);
  assertOnlyKeys(value, ["provider", "model", "reasoningEffort"]);
  const reasoningEffort = requiredSafeString(value.reasoningEffort, `${name}.reasoningEffort`, 16, 32);
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw invalid(`Chat model preference ${name} reasoning effort is invalid.`);
  }
  return {
    provider: requiredSafeString(value.provider, `${name}.provider`, 128, 256),
    model: requiredSafeString(value.model, `${name}.model`, 256, 512),
    reasoningEffort,
  };
}

function requiredPresetId(value: unknown, name: string): string {
  if (typeof value !== "string" || !PRESET_ID_PATTERN.test(value) || containsSuspicious(value)) {
    throw invalid(`Chat model preference ${name} is invalid.`);
  }
  return value;
}

function requiredSafeString(value: unknown, name: string, maxChars: number, maxBytes: number): string {
  if (typeof value !== "string"
    || value !== value.trim()
    || value.length > maxChars
    || Buffer.byteLength(value) > maxBytes
    || /[\u0000-\u001f\u007f]/.test(value)
    || containsSuspicious(value)) {
    throw invalid(`Chat model preference ${name} is invalid.`);
  }
  return value;
}

function containsSuspicious(value: string): boolean {
  return /api[_-]?key|secret|token|password|credential|authorization|bearer/i.test(value);
}

function defaultSnapshot(): ChatModelPreferencesSnapshot {
  return {
    revision: 0,
    document: {
      main: { provider: "", model: "", reasoningEffort: "" },
      sub: { provider: "", model: "", reasoningEffort: "" },
      presets: [],
    },
    updatedAt: new Date(0).toISOString(),
  };
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalid("Chat model preferences contain unsupported fields.");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): ChatModelPreferencesError {
  return new ChatModelPreferencesError("invalid_request", message);
}
