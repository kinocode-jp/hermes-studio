import { signal, type Signal } from "@preact/signals";

const STORAGE_KEY = "hermes-studio.profile-avatars.v1";
const ORDINAL_STORAGE_KEY = "hermes-studio.profile-avatar-ordinals.v1";
const CUSTOM_IMAGE_LIMIT = 1_500_000;
const DATABASE_NAME = "hermes-studio-assets";
/** @deprecated Pre-rebrand IndexedDB name; dual-opened for custom avatar migration. */
const LEGACY_DATABASE_NAME = "hermes-office-assets";
const DATABASE_STORE = "profile-avatars";
export const DEFAULT_CHARACTER_COUNT = 6;

export type ProfileAvatar =
  | { kind: "creature"; index: number }
  | { kind: "custom"; dataUrl: string };
export type AvatarMap = Record<string, ProfileAvatar>;
export type AvatarOrdinalMap = Record<string, number>;
export interface StoredCustomAvatar { profileId: string; dataUrl: string }

export interface AvatarAssetStore {
  load(legacy: Readonly<AvatarMap>): Promise<unknown[]>;
  put(profileId: string, dataUrl: string): Promise<void>;
  delete(profileId: string): Promise<void>;
}

/** Preserves relative roster slots until a complete authoritative reconciliation. */
export class AvatarOrdinalPreferences {
  #ordinals: Map<string, number>;
  readonly #persist: (ordinals: AvatarOrdinalMap) => void;

  constructor(initial: AvatarOrdinalMap = {}, persist: (ordinals: AvatarOrdinalMap) => void = () => undefined) {
    this.#ordinals = new Map(Object.entries(normalizeAvatarOrdinals(initial)));
    this.#persist = persist;
  }

  register(profileIds: readonly string[]): void {
    let changed = false;
    for (const profileId of profileIds) {
      const key = normalizedProfileId(profileId);
      if (!key || this.#ordinals.has(key)) continue;
      this.#ordinals.set(key, this.#ordinals.size);
      changed = true;
    }
    if (changed) this.#persist(this.#snapshot());
  }

  /** Reconciles only after Studio has observed one complete authoritative roster. */
  reconcile(profileIds: readonly string[]): void {
    const current = uniqueProfileIds(profileIds);
    const currentSet = new Set(current);
    const retained = [...this.#ordinals]
      .sort((left, right) => left[1] - right[1])
      .map(([profileId]) => profileId)
      .filter((profileId) => currentSet.has(profileId));
    const retainedSet = new Set(retained);
    const ordered = [...retained, ...current.filter((profileId) => !retainedSet.has(profileId))];
    const next = new Map(ordered.map((profileId, ordinal) => [profileId, ordinal] as const));
    if (mapsEqual(this.#ordinals, next)) return;
    this.#ordinals = next;
    this.#persist(this.#snapshot());
  }

  ordinal(profileId: string): number {
    const key = normalizedProfileId(profileId);
    if (!key) return DEFAULT_CHARACTER_COUNT - 1;
    this.register([key]);
    return this.#ordinals.get(key)!;
  }

  #snapshot(): AvatarOrdinalMap {
    return safeRecord(this.#ordinals);
  }
}

export class AvatarPreferences {
  readonly avatars: Signal<AvatarMap>;
  readonly #store: AvatarAssetStore;
  readonly #persist: (avatars: AvatarMap) => void;
  readonly #generations = new Map<string, number>();
  readonly #mutationTails = new Map<string, Promise<void>>();

  constructor(initial: AvatarMap, store: AvatarAssetStore, persist: (avatars: AvatarMap) => void = () => undefined) {
    this.avatars = signal(copyAvatarMap(initial));
    this.#store = store;
    this.#persist = persist;
  }

  begin(profileId: string): number {
    if (!profileId) return 0;
    const generation = (this.#generations.get(profileId) ?? 0) + 1;
    this.#generations.set(profileId, generation);
    return generation;
  }

  isCurrent(profileId: string, generation: number): boolean {
    return generation > 0 && this.#generations.get(profileId) === generation;
  }

  setCreature(profileId: string, index: number): void {
    if (!profileId || !Number.isInteger(index) || index < 0 || index >= DEFAULT_CHARACTER_COUNT) return;
    this.begin(profileId);
    this.#update(profileId, { kind: "creature", index });
    void this.#enqueue(profileId, async () => await this.#store.delete(profileId)).catch(() => undefined);
  }

  async setCustom(profileId: string, dataUrl: string, startedGeneration?: number): Promise<boolean> {
    if (!profileId || !isSafeImageDataUrl(dataUrl) || dataUrl.length > CUSTOM_IMAGE_LIMIT) return false;
    const generation = startedGeneration ?? this.begin(profileId);
    if (generation === 0 || this.#generations.get(profileId) !== generation) return false;
    try {
      await this.#enqueue(profileId, async () => await this.#store.put(profileId, dataUrl));
    } catch {
      return false;
    }
    if (this.#generations.get(profileId) !== generation) return false;
    this.#update(profileId, { kind: "custom", dataUrl });
    return true;
  }

  async reset(profileId: string): Promise<boolean> {
    if (!profileId) return false;
    const generation = this.begin(profileId);
    try {
      await this.#enqueue(profileId, async () => await this.#store.delete(profileId));
    } catch {
      return false;
    }
    if (!this.isCurrent(profileId, generation)) return false;
    const next = copyAvatarMap(this.avatars.value);
    delete next[profileId];
    this.avatars.value = next;
    this.#persist(next);
    return true;
  }

  async hydrate(): Promise<void> {
    let records: unknown[];
    try {
      records = await this.#store.load(this.avatars.value);
    } catch {
      return;
    }
    const next = copyAvatarMap(this.avatars.value);
    for (const record of records) {
      if (!isStoredCustomAvatar(record)) continue;
      if (!record.profileId || this.#generations.has(record.profileId)) continue;
      if (ownValue(next, record.profileId)?.kind === "creature") continue;
      if (record.dataUrl.length <= CUSTOM_IMAGE_LIMIT && isSafeImageDataUrl(record.dataUrl)) {
        setOwnValue<ProfileAvatar>(next, record.profileId, { kind: "custom", dataUrl: record.dataUrl });
      }
    }
    this.avatars.value = next;
    this.#persist(next);
  }

  async whenIdle(profileId: string): Promise<void> {
    await this.#mutationTails.get(profileId);
  }

  #update(profileId: string, avatar: ProfileAvatar): void {
    const next = copyAvatarMap(this.avatars.value);
    setOwnValue(next, profileId, avatar);
    this.avatars.value = next;
    this.#persist(next);
  }

  async #enqueue<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(profileId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#mutationTails.set(profileId, tail);
    try {
      return await result;
    } finally {
      if (this.#mutationTails.get(profileId) === tail) this.#mutationTails.delete(profileId);
    }
  }
}

export function defaultAvatarOrdinal(profileId: string): number {
  return defaultAvatarAssignments.ordinal(profileId);
}

export function defaultAvatarIndex(profileId: string): number {
  return defaultAvatarOrdinal(profileId) % DEFAULT_CHARACTER_COUNT;
}

export function registerDefaultAvatarProfiles(profileIds: readonly string[]): void {
  defaultAvatarAssignments.register(profileIds);
}

export function reconcileDefaultAvatarProfiles(profileIds: readonly string[]): void {
  defaultAvatarAssignments.reconcile(profileIds);
}

function normalizedProfileId(profileId: string): string {
  return profileId.trim();
}

/** Compacts malformed, duplicate, or sparse persisted slots into one safe first-seen sequence. */
export function normalizeAvatarOrdinals(value: unknown): AvatarOrdinalMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidates: Array<{ key: string; ordinal: number; order: number }> = [];
  const seen = new Set<string>();
  for (const [order, [profileId, ordinal]] of Object.entries(value).entries()) {
    const key = normalizedProfileId(profileId);
    if (!key || seen.has(key) || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0) continue;
    seen.add(key);
    candidates.push({ key, ordinal, order });
  }
  candidates.sort((left, right) => left.ordinal - right.ordinal || left.order - right.order);
  return safeRecord(candidates.map((candidate, ordinal) => [candidate.key, ordinal] as const));
}

export function avatarForProfile(profileId: string): ProfileAvatar {
  return ownValue(profileAvatars.value, profileId) ?? { kind: "creature", index: defaultAvatarIndex(profileId) };
}

export function beginCustomAvatarChange(profileId: string): number {
  return avatarPreferences.begin(profileId);
}

export function isAvatarChangeCurrent(profileId: string, generation: number): boolean {
  return avatarPreferences.isCurrent(profileId, generation);
}

export function setCreatureAvatar(profileId: string, index: number): void {
  avatarPreferences.setCreature(profileId, index);
}

export async function setCustomAvatar(profileId: string, dataUrl: string, startedGeneration?: number): Promise<boolean> {
  return await avatarPreferences.setCustom(profileId, dataUrl, startedGeneration);
}

export async function resetProfileAvatar(profileId: string): Promise<boolean> {
  return await avatarPreferences.reset(profileId);
}

export function isSafeImageDataUrl(value: string): boolean {
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value);
}

function readStoredAvatars(): AvatarMap {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? globalThis.localStorage?.getItem("hermes-office.profile-avatars.v1");
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const avatars: AvatarMap = safeRecord();
    for (const [profileId, value] of Object.entries(parsed)) {
      if (!profileId || !value || typeof value !== "object") continue;
      const avatar = value as Partial<ProfileAvatar>;
      if (avatar.kind === "creature" && Number.isInteger(avatar.index) && Number(avatar.index) >= 0) {
        avatars[profileId] = { kind: "creature", index: Number(avatar.index) % DEFAULT_CHARACTER_COUNT };
      } else if (avatar.kind === "custom" && typeof avatar.dataUrl === "string" && avatar.dataUrl.length <= CUSTOM_IMAGE_LIMIT && isSafeImageDataUrl(avatar.dataUrl)) {
        avatars[profileId] = { kind: "custom", dataUrl: avatar.dataUrl };
      }
    }
    return avatars;
  } catch {
    return {};
  }
}

function persist(avatars: AvatarMap): void {
  try {
    const compact = safeRecord(Object.entries(avatars).filter((entry): entry is [string, { kind: "creature"; index: number }] => entry[1].kind === "creature"));
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(compact));
  } catch {
    // In-memory preferences remain usable when localStorage is blocked.
  }
}

function readStoredOrdinals(): AvatarOrdinalMap {
  try {
    const raw = globalThis.localStorage?.getItem(ORDINAL_STORAGE_KEY) ?? globalThis.localStorage?.getItem("hermes-office.profile-avatar-ordinals.v1");
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    const ordinals = normalizeAvatarOrdinals(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(ordinals)) persistOrdinals(ordinals);
    return ordinals;
  } catch {
    return {};
  }
}

function persistOrdinals(ordinals: AvatarOrdinalMap): void {
  try { globalThis.localStorage?.setItem(ORDINAL_STORAGE_KEY, JSON.stringify(ordinals)); }
  catch { /* First-seen assignments remain stable for this page session. */ }
}

class IndexedDbAvatarStore implements AvatarAssetStore {
  async load(legacy: Readonly<AvatarMap>): Promise<unknown[]> {
    const primary = await withAvatarStore("readwrite", async (store) => {
      for (const [profileId, avatar] of Object.entries(legacy)) {
        if (avatar.kind === "custom") await requestResult(store.put({ profileId, dataUrl: avatar.dataUrl }));
      }
      return await requestResult<unknown[]>(store.getAll());
    }) ?? [];
    if (primary.length > 0) return primary;
    // Dual-read pre-rebrand IndexedDB (hermes-office-assets) and copy forward once.
    const fromLegacy = await readLegacyAvatarDatabase();
    if (fromLegacy.length === 0) return primary;
    await withAvatarStore("readwrite", async (store) => {
      for (const row of fromLegacy) {
        if (isStoredCustomAvatar(row)) await requestResult(store.put(row));
      }
      return true;
    });
    return fromLegacy;
  }

  async put(profileId: string, dataUrl: string): Promise<void> {
    const saved = await withAvatarStore("readwrite", async (store) => {
      await requestResult(store.put({ profileId, dataUrl }));
      return true;
    });
    if (saved !== true) throw new Error("avatar storage unavailable");
  }

  async delete(profileId: string): Promise<void> {
    const deleted = await withAvatarStore("readwrite", async (store) => {
      await requestResult(store.delete(profileId));
      return true;
    });
    if (deleted !== true) throw new Error("avatar storage unavailable");
  }
}

function isStoredCustomAvatar(value: unknown): value is StoredCustomAvatar {
  return typeof value === "object" && value !== null
    && typeof (value as { profileId?: unknown }).profileId === "string"
    && typeof (value as { dataUrl?: unknown }).dataUrl === "string";
}

const initialAvatars = readStoredAvatars();
const defaultAvatarAssignments = new AvatarOrdinalPreferences(readStoredOrdinals(), persistOrdinals);
const avatarPreferences = new AvatarPreferences(initialAvatars, new IndexedDbAvatarStore(), persist);
export const profileAvatars = avatarPreferences.avatars;
void avatarPreferences.hydrate();

async function withAvatarStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => Promise<T>): Promise<T | undefined> {
  const database = await openAvatarDatabase();
  if (!database) return undefined;
  try {
    const transaction = database.transaction(DATABASE_STORE, mode);
    const completed = transactionCompletion(transaction);
    try {
      const result = await operation(transaction.objectStore(DATABASE_STORE));
      await completed;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* The transaction may already be inactive. */ }
      await completed.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

function openAvatarDatabase(): Promise<IDBDatabase | undefined> {
  return openNamedAvatarDatabase(DATABASE_NAME);
}

function openNamedAvatarDatabase(name: string): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (database?: IDBDatabase): void => {
      if (settled) { database?.close(); return; }
      settled = true;
      resolve(database);
    };
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DATABASE_STORE)) {
        request.result.createObjectStore(DATABASE_STORE, { keyPath: "profileId" });
      }
    };
    request.onsuccess = () => finish(request.result);
    request.onerror = () => finish();
    request.onblocked = () => finish();
  });
}

/** Best-effort dual-read of pre-rebrand custom avatar rows. */
async function readLegacyAvatarDatabase(): Promise<unknown[]> {
  const database = await openNamedAvatarDatabase(LEGACY_DATABASE_NAME);
  if (!database) return [];
  try {
    if (!database.objectStoreNames.contains(DATABASE_STORE)) return [];
    const transaction = database.transaction(DATABASE_STORE, "readonly");
    const completed = transactionCompletion(transaction);
    const rows = await requestResult<unknown[]>(transaction.objectStore(DATABASE_STORE).getAll());
    await completed;
    return rows;
  } catch {
    return [];
  } finally {
    database.close();
  }
}

function requestResult<T = IDBValidKey>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("avatar storage failed"));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("avatar transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("avatar transaction aborted"));
  });
}

function uniqueProfileIds(profileIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const profileId of profileIds) {
    const key = normalizedProfileId(profileId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function mapsEqual(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function safeRecord<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
  return record;
}

function copyAvatarMap(avatars: Readonly<AvatarMap>): AvatarMap {
  return safeRecord(Object.entries(avatars));
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
}
