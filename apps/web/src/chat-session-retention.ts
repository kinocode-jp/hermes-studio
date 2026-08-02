import type { ChatSession } from "./domain";
import { hasPendingChatComposerContent } from "./chat-composer-state";
import { isChatSessionLeaseProtected } from "./session-runtime";

/**
 * A new-chat pane is replaceable only while it is still a truly untouched
 * local placeholder. Remote identity, local evidence, composer content, and
 * in-flight operations all make it a real conversation that must be retained.
 */
export function isReplaceableInitialChatSession(session: ChatSession | undefined): boolean {
  return session?.titlePresentation === "new-chat"
    && session.messages.length === 0
    && (session.operationEvidence?.length ?? 0) === 0
    && session.liveSessionId === undefined
    && session.composerPrefill === undefined
    && session.pendingCardSeed === undefined
    && session.sourceCardId === undefined
    && (session.connectionState === undefined || session.connectionState === "ready")
    && (session.historyState === undefined || session.historyState === "loaded")
    && !isChatSessionLeaseProtected(session)
    && !hasPendingChatComposerContent(session.id);
}

/** Only an untouched, purely local draft may be removed from session state. */
export function isDiscardableUnusedChatDraft(session: ChatSession | undefined): boolean {
  return session !== undefined
    && isReplaceableInitialChatSession(session)
    && session.remoteKind === "draft"
    && session.storedSessionId === undefined;
}
