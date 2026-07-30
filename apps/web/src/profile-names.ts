import { signal } from "@preact/signals";

const STORAGE_KEY = "hermes-studio:profile-display-names:v1";
/** Pre-rebrand and older ja-only keys (dual-read, write only STORAGE_KEY). */
const LEGACY_STORAGE_KEYS = [
  "hermes-office:profile-display-names:v1",
  "hermes-studio:profile-names-ja:v1",
  "hermes-office:profile-names-ja:v1",
] as const;

/** Japanese display names for Hermes profiles named after Pokémon. */
export const POKEMON_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  alakazam: "フーディン",
  blastoise: "カメックス",
  chansey: "ラッキー",
  charizard: "リザードン",
  clefairy: "ピッピ",
  cramorant: "ウッウ",
  ditto: "メタモン",
  dragonite: "カイリュー",
  eevee: "イーブイ",
  farfetchd: "カモネギ",
  gastly: "ゴース",
  gengar: "ゲンガー",
  haunter: "ゴースト",
  kangaskhan: "ガルーラ",
  lapras: "ラプラス",
  machamp: "カイリキー",
  magnemite: "コイル",
  mamoswine: "マンムー",
  meowth: "ニャース",
  pikachu: "ピカチュウ",
  porygon: "ポリゴン",
  psyduck: "コダック",
  scyther: "ストライク",
  starmie: "スターミー",
  venusaur: "フシギバナ",
};

export type ProfileNameSource = {
  id: string;
  name: string;
  /** Preferred local display alias. */
  displayName?: string | undefined;
  /** @deprecated Prefer displayName. Kept for demo/data migration. */
  nameJa?: string | undefined;
};

/**
 * Local aliases keyed by profile id.
 * - key absent: never set by user (eligible for Pokémon auto-registration / default)
 * - key present with non-empty string: active display name
 * - key present with empty string: user cleared; do not auto-register again
 *
 * The Hermes profile id (including the reserved "default") is never rewritten.
 * Display names are a client-side overlay only.
 */
const profileDisplayNames = signal<Record<string, string>>(readProfileDisplayNames());

/** Exposed so UI can subscribe to map updates during render. */
export function profileDisplayNameMap(): Readonly<Record<string, string>> {
  return profileDisplayNames.value;
}

export function profileStoredDisplayName(profileId: string, fallback = ""): string {
  if (hasStoredDisplayName(profileId)) return profileDisplayNames.value[profileId] ?? "";
  return fallback;
}

/** @deprecated Use profileStoredDisplayName. */
export function profileJapaneseName(profileId: string, fallback = ""): string {
  return profileStoredDisplayName(profileId, fallback);
}

export function profileDisplayName(profile: ProfileNameSource): string {
  // Always touch the signal so Preact tracks display-name changes even when
  // callers only read this helper (not profileDisplayNameMap directly).
  void profileDisplayNames.value;
  const alias = resolveAlias(profile);
  return alias || profile.name;
}

export function profileSecondaryName(profile: ProfileNameSource): string {
  void profileDisplayNames.value;
  const alias = resolveAlias(profile);
  return alias && alias !== profile.name ? profile.name : "";
}

/**
 * Render profile identifiers found in agent output as a human-readable label
 * while retaining the canonical Hermes profile name for unambiguous reference.
 * Code spans are deliberately preserved: commands and paths must remain
 * copyable verbatim.
 */
export function displayProfileReferences(text: string, profiles: readonly ProfileNameSource[]): string {
  if (!text || profiles.length === 0) return text;
  const references = profiles.flatMap((profile) => {
    const canonical = profile.name.trim() || profile.id.trim();
    const display = profileDisplayName(profile).trim();
    if (!canonical || !display || display === canonical) return [];
    return [
      { identifier: profile.id.trim(), canonical, display },
      ...(profile.name.trim() !== profile.id.trim() ? [{ identifier: profile.name.trim(), canonical, display }] : []),
    ];
  }).filter((reference) => reference.identifier.length > 0)
    .sort((left, right) => right.identifier.length - left.identifier.length);
  if (references.length === 0) return text;

  const byIdentifier = new Map<string, (typeof references)[number]>();
  for (const reference of references) {
    const key = reference.identifier.toLowerCase();
    if (!byIdentifier.has(key)) byIdentifier.set(key, reference);
  }
  const allIdentifiers = [...byIdentifier.values()].map((reference) => escapeRegExp(reference.identifier));
  const bareIdentifiers = [...byIdentifier.values()]
    .filter((reference) => !referenceNeedsSigil(reference.identifier))
    .map((reference) => escapeRegExp(reference.identifier));
  const alternatives = [
    `@(?:${allIdentifiers.join("|")})(?![\\p{L}\\p{N}_-])`,
    ...(bareIdentifiers.length === 0
      ? []
      : [`(?<![\\p{L}\\p{N}_@-])(?:${bareIdentifiers.join("|")})(?![\\p{L}\\p{N}_-])`]),
  ];
  const matcher = new RegExp(alternatives.join("|"), "giu");

  // Keep fenced and inline code untouched so that copied commands stay valid.
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part) => {
    if (part.startsWith("`")) return part;
    return part.replace(matcher, (matched, offset: number, source: string) => {
      const identifier = matched.startsWith("@") ? matched.slice(1) : matched;
      const reference = byIdentifier.get(identifier.toLowerCase());
      if (!reference || isCopySensitiveReference(source, offset, matched.length)) return matched;
      const before = source.slice(0, offset);
      const after = source.slice(offset + matched.length);
      // Do not expand an already formatted "表示名（profile-name）" reference.
      const visibleBefore = before.replace(/[*_~]+$/u, "");
      const visibleAfter = after.replace(/^[*_~]+/u, "");
      if (visibleBefore.endsWith(`${reference.display}（`) && visibleAfter.startsWith("）")) return matched;
      return `${reference.display}（${reference.canonical}）`;
    });
  }).join("");
}

function referenceNeedsSigil(identifier: string): boolean {
  return identifier.length <= 2
    || /^(?:a|an|as|at|default|i|in|is|it|no|of|on|or|the|to)$/i.test(identifier);
}

function isCopySensitiveReference(source: string, offset: number, length: number): boolean {
  let start = offset;
  let end = offset + length;
  const delimiter = /[\s()[\]{}"'`<>]/u;
  while (start > 0 && !delimiter.test(source[start - 1]!)) start -= 1;
  while (end < source.length && !delimiter.test(source[end]!)) end += 1;
  const token = source.slice(start, end);
  if (/[\\/=?&#%]/u.test(token)) return true;
  if (/(?:^|[\p{L}\p{N}_-])\.[\p{L}\p{N}_-]/u.test(token)) return true;
  if (/:[\\/\d]/u.test(token) || /[\p{L}\p{N}_-]:[\p{L}\p{N}_-]/u.test(token)) return true;
  return token.startsWith("~");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function setProfileDisplayName(profileId: string, name: string): void {
  const key = profileId.trim();
  if (!key) return;
  const normalized = name.trim().slice(0, 40);
  const next = { ...profileDisplayNames.value, [key]: normalized };
  profileDisplayNames.value = next;
  persistProfileDisplayNames(next);
}

/** Removes any stored preference so auto-registration can run again (tests / reset). */
export function forgetProfileDisplayName(profileId: string): void {
  const key = profileId.trim();
  if (!key || !hasStoredDisplayName(key)) return;
  const next = { ...profileDisplayNames.value };
  delete next[key];
  profileDisplayNames.value = next;
  persistProfileDisplayNames(next);
}

/** @deprecated Use setProfileDisplayName. */
export function setProfileJapaneseName(profileId: string, name: string): void {
  setProfileDisplayName(profileId, name);
}

/**
 * Registers Japanese Pokémon display names for known profile IDs that have never
 * been customized. User-cleared empty aliases are left alone.
 */
export function ensurePokemonDisplayNames(profileIds: readonly string[]): void {
  let changed = false;
  const next = { ...profileDisplayNames.value };
  for (const profileId of profileIds) {
    const key = profileId.trim();
    if (!key || Object.prototype.hasOwnProperty.call(next, key)) continue;
    const pokemonName = pokemonNameFor(key);
    if (!pokemonName) continue;
    next[key] = pokemonName;
    changed = true;
  }
  if (!changed) return;
  profileDisplayNames.value = next;
  persistProfileDisplayNames(next);
}

function hasStoredDisplayName(profileId: string): boolean {
  return Object.prototype.hasOwnProperty.call(profileDisplayNames.value, profileId);
}

/**
 * Resolution order:
 * 1. User-stored alias (including empty = cleared → fall back to Hermes name)
 * 2. Profile-embedded displayName / nameJa
 * 3. Built-in Pokémon Japanese name for id or name
 * 4. Hermes profile name
 */
function resolveAlias(profile: ProfileNameSource): string {
  if (hasStoredDisplayName(profile.id)) {
    return profileDisplayNames.value[profile.id] ?? "";
  }
  const fromProfile = profile.displayName?.trim() || profile.nameJa?.trim() || "";
  if (fromProfile) return fromProfile;
  return pokemonNameFor(profile.id) || pokemonNameFor(profile.name) || "";
}

function pokemonNameFor(value: string): string {
  const key = value.trim().toLowerCase();
  return key ? (POKEMON_DISPLAY_NAMES[key] ?? "") : "";
}

function readProfileDisplayNames(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const primary = parseNameRecord(localStorage.getItem(STORAGE_KEY));
    if (Object.keys(primary).length > 0) return primary;
    for (const key of LEGACY_STORAGE_KEYS) {
      const legacy = parseNameRecord(localStorage.getItem(key));
      if (Object.keys(legacy).length > 0) {
        persistProfileDisplayNames(legacy);
        return legacy;
      }
    }
    return {};
  } catch {
    return {};
  }
}

function parseNameRecord(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => (
    typeof value === "string" && id ? [[id, value.trim().slice(0, 40)]] : []
  )));
}

function persistProfileDisplayNames(names: Record<string, string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // Display-name aliases are local preferences; keep the active UI usable if storage is blocked.
  }
}
