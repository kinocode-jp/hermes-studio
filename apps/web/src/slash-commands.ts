/**
 * Slash-command completion catalog for the composer.
 *
 * The full command list comes from the upstream `complete.slash` RPC (one
 * fetch per app run — the command list is static for a given Hermes install).
 * When the RPC is unavailable, a small static list keeps the popup useful.
 */
import { signal } from "@preact/signals";
import type { SlashCompletionItem } from "./chat-api";
import { officeRuntimeHooks } from "./store-state";

export const FALLBACK_SLASH_COMMANDS: SlashCompletionItem[] = [
  { text: "/model", display: "/model", meta: "" },
  { text: "/help", display: "/help", meta: "" },
  { text: "/status", display: "/status", meta: "" },
  { text: "/compact", display: "/compact", meta: "" },
  { text: "/skills", display: "/skills", meta: "" },
  { text: "/memory", display: "/memory", meta: "" },
  { text: "/undo", display: "/undo", meta: "" },
  { text: "/reasoning", display: "/reasoning", meta: "" },
];

const STUDIO_SLASH_COMMAND_NAMES = new Set(FALLBACK_SLASH_COMMANDS.map((item) => item.text));

export function isStudioSlashCommand(input: string): boolean {
  const name = /^\/[A-Za-z0-9._-]+(?=\s|$)/.exec(input.trim())?.[0]?.toLowerCase();
  return name !== undefined && STUDIO_SLASH_COMMAND_NAMES.has(name);
}

/** Full catalog (fetched with the bare "/" prefix); undefined until loaded. */
const catalog = signal<SlashCompletionItem[] | undefined>(undefined);
let catalogFlight: Promise<void> | undefined;

function ensureCatalog(): void {
  if (catalog.value !== undefined || catalogFlight !== undefined) return;
  catalogFlight = officeRuntimeHooks.completeSlashCommand("/")
    .then((items) => {
      catalog.value = items;
    })
    .catch(() => {
      // Retry on the next composer "/" once the connection recovers.
    })
    .finally(() => {
      catalogFlight = undefined;
    });
}

/**
 * Synchronous, cache-first suggestions for the typed prefix (e.g. "/mo").
 * Triggers the one-shot catalog fetch in the background on first use.
 */
export function slashSuggestionsFor(input: string, limit = 8): SlashCompletionItem[] {
  if (!input.startsWith("/") || input.includes("\n")) return [];
  const head = input.slice(1);
  if (head.includes(" ")) return [];
  ensureCatalog();
  const source = catalog.value && catalog.value.length > 0 ? catalog.value : FALLBACK_SLASH_COMMANDS;
  const needle = head.toLowerCase();
  return source
    .filter((item) => item.text.slice(1).toLowerCase().startsWith(needle))
    .slice(0, limit);
}

/** Reactive dependency helper so components re-render when the catalog loads. */
export function slashCatalogVersion(): number {
  return catalog.value === undefined ? 0 : catalog.value.length;
}

/** Test helper. */
export function resetSlashCatalogForTests(): void {
  catalog.value = undefined;
  catalogFlight = undefined;
}
