import { signal, type Signal } from "@preact/signals";
import type { ChatAttachment } from "./chat-attachments";

export type ChatComposerState = {
  draft: string;
  attachments: ChatAttachment[];
};

type StateUpdater<T> = T | ((current: T) => T);

const composerStates = new Map<string, Signal<ChatComposerState>>();

export function chatComposerState(sessionId: string): Signal<ChatComposerState> {
  const existing = composerStates.get(sessionId);
  if (existing) return existing;
  const created = signal<ChatComposerState>({ draft: "", attachments: [] });
  composerStates.set(sessionId, created);
  return created;
}

export function setChatComposerDraft(sessionId: string, updater: StateUpdater<string>): void {
  const state = chatComposerState(sessionId);
  const draft = typeof updater === "function" ? updater(state.value.draft) : updater;
  if (draft === state.value.draft) return;
  state.value = { ...state.value, draft };
}

export function setChatComposerAttachments(sessionId: string, updater: StateUpdater<ChatAttachment[]>): void {
  const state = chatComposerState(sessionId);
  const attachments = typeof updater === "function" ? updater(state.value.attachments) : updater;
  if (attachments === state.value.attachments) return;
  state.value = { ...state.value, attachments };
}

/** Clear only the exact composer values represented by the acknowledged request. */
export function clearAcknowledgedChatComposer(
  sessionId: string,
  submitted: ChatComposerState,
): boolean {
  const state = chatComposerState(sessionId);
  if (state.value !== submitted) return false;
  state.value = { draft: "", attachments: [] };
  return true;
}

export function clearChatComposerState(sessionId: string): void {
  const state = composerStates.get(sessionId);
  if (state) state.value = { draft: "", attachments: [] };
  composerStates.delete(sessionId);
}

export function clearAllChatComposerStates(): void {
  for (const state of composerStates.values()) {
    state.value = { draft: "", attachments: [] };
  }
  composerStates.clear();
}
