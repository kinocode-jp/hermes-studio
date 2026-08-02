import { signal, type Signal } from "@preact/signals";
import type { ChatAttachment } from "./chat-attachments";

export type ChatComposerState = {
  draft: string;
  attachments: ChatAttachment[];
};

type StateUpdater<T> = T | ((current: T) => T);

const composerStates = new Map<string, Signal<ChatComposerState>>();
const composerCoalescences = new Map<string, {
  retainedValue: ChatComposerState;
  provisionalValue: ChatComposerState;
  mergedValue: ChatComposerState;
}>();

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

/**
 * Read whether a session has an unsent composer without allocating state for
 * sessions that have never mounted a composer.
 */
export function hasPendingChatComposerContent(sessionId: string): boolean {
  const state = composerStates.get(sessionId)?.value;
  return state !== undefined && (state.draft.length > 0 || state.attachments.length > 0);
}

/** Move every unsent value from a provisional identity into the retained pane. */
export function coalesceChatComposerState(retainedSessionId: string, provisionalSessionId: string): void {
  if (retainedSessionId === provisionalSessionId) return;
  const retained = composerStates.get(retainedSessionId);
  const provisional = composerStates.get(provisionalSessionId);
  if (!retained && !provisional) return;
  const retainedValue = retained?.value ?? { draft: "", attachments: [] };
  const provisionalValue = provisional?.value ?? { draft: "", attachments: [] };
  const target = retained ?? signal<ChatComposerState>({ draft: "", attachments: [] });
  const merged = {
    draft: mergeComposerDrafts(retainedValue.draft, provisionalValue.draft),
    attachments: mergeComposerAttachments(retainedValue.attachments, provisionalValue.attachments),
  };
  if (!sameComposerValue(retainedValue, merged)) {
    target.value = merged;
    composerCoalescences.set(retainedSessionId, { retainedValue, provisionalValue, mergedValue: merged });
  }
  composerStates.set(retainedSessionId, target);
  if (provisional) provisional.value = { draft: "", attachments: [] };
  composerStates.delete(provisionalSessionId);
  composerCoalescences.delete(provisionalSessionId);
}

function mergeComposerDrafts(retained: string, provisional: string): string {
  if (retained === "" || retained === provisional) return provisional || retained;
  if (provisional === "") return retained;
  return `${retained}\n\n${provisional}`;
}

function mergeComposerAttachments(
  retained: readonly ChatAttachment[],
  provisional: readonly ChatAttachment[],
): ChatAttachment[] {
  const merged: ChatAttachment[] = [];
  const ids = new Set<string>();
  for (const attachment of [...retained, ...provisional]) {
    if (ids.has(attachment.id)) continue;
    ids.add(attachment.id);
    merged.push(attachment);
  }
  return merged;
}

function sameComposerValue(left: ChatComposerState, right: ChatComposerState): boolean {
  return left.draft === right.draft
    && left.attachments.length === right.attachments.length
    && left.attachments.every((attachment, index) => attachment === right.attachments[index]);
}

/** Clear only the exact composer values represented by the acknowledged request. */
export function clearAcknowledgedChatComposer(
  sessionId: string,
  submitted: ChatComposerState,
): boolean {
  const state = chatComposerState(sessionId);
  if (state.value === submitted) {
    state.value = { draft: "", attachments: [] };
    composerCoalescences.delete(sessionId);
    return true;
  }
  const coalescence = composerCoalescences.get(sessionId);
  if (coalescence?.retainedValue !== submitted) return false;
  state.value = removeAcknowledgedComposerContribution(
    state.value,
    submitted,
    coalescence.provisionalValue,
    coalescence.mergedValue,
  );
  composerCoalescences.delete(sessionId);
  return true;
}

function removeAcknowledgedComposerContribution(
  current: ChatComposerState,
  submitted: ChatComposerState,
  provisional: ChatComposerState,
  merged: ChatComposerState,
): ChatComposerState {
  const provisionalAttachmentIds = new Set(provisional.attachments.map((attachment) => attachment.id));
  const submittedOnlyAttachmentIds = new Set(submitted.attachments
    .filter((attachment) => !provisionalAttachmentIds.has(attachment.id))
    .map((attachment) => attachment.id));
  return {
    draft: removeAcknowledgedDraftContribution(current.draft, submitted.draft, provisional.draft, merged.draft),
    attachments: current.attachments.filter((attachment) => !submittedOnlyAttachmentIds.has(attachment.id)),
  };
}

function removeAcknowledgedDraftContribution(
  current: string,
  submitted: string,
  provisional: string,
  merged: string,
): string {
  if (submitted === "") return current;
  if (current === submitted) {
    return merged === submitted ? (provisional === submitted ? "" : provisional) : current;
  }
  const submittedPrefix = `${submitted}\n\n`;
  return current.startsWith(submittedPrefix) ? current.slice(submittedPrefix.length) : current;
}

export function clearChatComposerState(sessionId: string): void {
  const state = composerStates.get(sessionId);
  if (state) state.value = { draft: "", attachments: [] };
  composerStates.delete(sessionId);
  composerCoalescences.delete(sessionId);
}

export function clearAllChatComposerStates(): void {
  for (const state of composerStates.values()) {
    state.value = { draft: "", attachments: [] };
  }
  composerStates.clear();
  composerCoalescences.clear();
}
