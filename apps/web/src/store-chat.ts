import type { ChatGatewayEvent, ChatHistoryResult, ChatPromptResult, ChatSlashResult, ChatTarget } from "./chat-api";
import type { ApprovalChoice, ChatConnectionState, ChatMessage, ChatOperationEvidence, ChatSession } from "./domain";
import { boundedOperationEvidence, interruptChatRun, steerChatRun } from "./chat-run-actions";
import { canSubmitChatPrompt, isChatRunActive } from "./session-runtime";
import { sessionNeedsCardSeed } from "./kanban-ask";
import {
  reconcileChatSessionConnecting,
  reconcileChatSessionDisconnected,
  reconcileChatSessionError,
  reconcileChatSessionQueued,
  reconcileChatSessionReady,
  type ChatSessionReadyRuntime,
} from "./chat-session-reconciliation";
import { nextChatTimelineSequence, nowTimestamp } from "./chat-store-utils";
import { modelSlashCommand, resolvedCreateModelPrefs } from "./chat-model-prefs";
import { summarizePromptForEvidence } from "./chat-attachments";
import { buildFollowUpSuggestions, extractAgentFollowUpSuggestions } from "./chat-suggestions";
import { boundedTranscriptSuffix } from "./live-transcript";
import { officeMessage, officeRuntimeMessage, type RuntimeMessage, locale } from "./i18n";
import { reduceChatGatewayEvent } from "./chat-gateway-reducer";
import { isCommitUnconfirmedRpcError } from "./chat-rpc-results";
import { isStudioSlashCommand } from "./slash-commands";
import {
  chatSocketState,
  officeRuntimeHooks,
  sessions,
} from "./store-state";

export { reduceChatGatewayEvent } from "./chat-gateway-reducer";

export function sendMessage(sessionId: string, body: string): boolean | Promise<boolean> {
  const trimmed = body.trim();
  if (!trimmed) return false;
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session || !canSubmitChatPrompt(session)) return false;
  // Slash commands must not reach the LLM as chat text: the web gateway
  // treats prompt.submit purely as a message, so every /command goes through
  // the slash.exec RPC (parity with the Hermes TUI slash path).
  if (isStudioSlashCommand(trimmed) && session.remoteKind !== "demo") {
    const command = /^\/model\b/.test(trimmed) && !/(?:^|\s)--session(?:\s|$)/.test(trimmed)
      ? `${trimmed} --session`
      : trimmed;
    // A staged picker change has already updated the visible prefs optimistically.
    // Restore its authoritative baseline before a manual /model replaces it so
    // an explicitly rejected command cannot leave Studio claiming a model that
    // Hermes never accepted.
    if (/^\/model\b/.test(command) && session.pendingModelChange) cancelSessionModelChange(sessionId);
    return runSlashCommand(sessionId, command);
  }
  // A staged model switch is applied right before the next real prompt.
  const pending = session.pendingModelChange;
  if (pending) {
    return applyPendingModelChange(sessionId, pending).then((applied) => {
      if (!applied) return false;
      return submitPromptNow(sessionId, trimmed);
    });
  }
  return submitPromptNow(sessionId, trimmed);
}

/**
 * Execute a slash command via slash.exec. The command and its output appear
 * in the transcript as local user/tool messages (they are not part of the
 * durable Hermes conversation, mirroring how the TUI shows slash output).
 */
async function runSlashCommand(sessionId: string, command: string): Promise<boolean> {
  const session = sessions.value.find((item) => item.id === sessionId);
  if (session?.remoteKind === "demo") return true;
  if (!session || session.slashPending) return false;
  const operationId = crypto.randomUUID();
  updateChatSession(sessionId, (item) => ({
    ...item,
    slashPending: true,
    slashOperationId: operationId,
    operationEvidence: boundedOperationEvidence([
      ...(item.operationEvidence ?? []),
      {
        id: operationId,
        timelineSequence: nextChatTimelineSequence(item),
        kind: "prompt",
        body: command,
        at: nowTimestamp(),
        state: "pending",
      },
    ]),
  }));
  try {
    let result = await officeRuntimeHooks.execSlashCommand(sessionId, command);
    if (result.status === "confirm-required") {
      const confirmation = result.confirmMessage || result.warning || result.notice
        || "This model has unusually high known pricing. Continue?";
      if (typeof globalThis.confirm !== "function" || !globalThis.confirm(confirmation)) {
        appendSlashOutput(sessionId, operationId, result);
        updatePromptOperation(sessionId, operationId, {
          status: "rejected",
          message: confirmation.slice(0, 500),
        });
        return false;
      }
      result = await officeRuntimeHooks.execSlashCommand(sessionId, command, true);
    }
    appendSlashOutput(sessionId, operationId, result);
    if (result.action === "prefill" && result.message) {
      updateChatSession(sessionId, (item) => ({
        ...item,
        composerPrefill: { id: operationId, text: result.message! },
      }));
    }
    if (result.status === "confirm-required") {
      updatePromptOperation(sessionId, operationId, {
        status: "rejected",
        message: (result.warning || result.notice || "This command requires confirmation.").slice(0, 500),
      });
      return false;
    }
    applySlashSessionPrefs(sessionId, command, result.key, result.value);
    updatePromptOperation(sessionId, operationId, { status: "accepted" });
    return true;
  } catch (reason) {
    const unconfirmed = isCommitUnconfirmedRpcError(reason);
    updatePromptOperation(sessionId, operationId, {
      status: unconfirmed ? "unconfirmed" : "rejected",
      message: reason instanceof Error ? reason.message : "Slash command failed.",
    });
    // The command may already have mutated Hermes. Clearing the submitted
    // composer prevents a retained /undo or /compact from being replayed while
    // the evidence ledger keeps the uncertain outcome visible.
    return unconfirmed;
  } finally {
    updateChatSession(sessionId, (item) => item.slashOperationId === operationId
      ? { ...item, slashPending: false, slashOperationId: undefined }
      : item);
  }
}

function appendSlashOutput(sessionId: string, operationId: string, result: ChatSlashResult): void {
  const output = [result.notice, result.output, result.warning]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n")
    .trim();
  if (!output) return;
  updateChatSession(sessionId, (item) => ({
    ...item,
    messages: [...item.messages, {
      id: `slash-${operationId}`,
      timelineSequence: nextChatTimelineSequence(item),
      from: "tool" as const,
      body: output,
      at: nowTimestamp(),
      status: "complete" as const,
    }],
  }));
}

function submitPromptNow(sessionId: string, trimmed: string): boolean | Promise<boolean> {
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session) return false;
  const operationId = crypto.randomUUID();
  const evidenceBody = summarizePromptForEvidence(trimmed);
  sessions.value = sessions.value.map((item) =>
    item.id === sessionId
      ? {
          ...item,
          status: "streaming",
          errorMessage: undefined,
          followUpSuggestions: undefined,
          ...(item.remoteKind === "demo" ? {
            messages: [...item.messages, {
              id: `prompt-${operationId}`,
              timelineSequence: nextChatTimelineSequence(item),
              from: "user" as const,
              body: evidenceBody,
              at: nowTimestamp(),
            }],
          } : {
            operationEvidence: boundedOperationEvidence([
              ...(item.operationEvidence ?? []),
              {
                id: operationId,
                timelineSequence: nextChatTimelineSequence(item),
                kind: "prompt",
                body: evidenceBody,
                at: nowTimestamp(),
                state: "pending",
              },
            ]),
          })
        }
      : item
  );
  if (session.remoteKind === "demo") {
    // Demo: echo a short agent reply so follow-up chips can be exercised offline.
    window.setTimeout(() => {
      updateChatSession(sessionId, (item) => {
        if (item.id !== sessionId) return item;
        const reply = locale.value === "en"
          ? `Got it.\n\nReceived: ${trimmed.slice(0, 200)}\n\nShall we continue?`
          : `了解しました。\n\n受信: ${trimmed.slice(0, 200)}\n\n次に進めますか？`;
        return {
          ...item,
          status: "ready",
          messages: [
            ...item.messages,
            {
              id: `agent-${operationId}`,
              timelineSequence: nextChatTimelineSequence(item),
              from: "agent" as const,
              body: reply,
              at: nowTimestamp(),
              status: "complete" as const,
            },
          ],
          followUpSuggestions: buildFollowUpSuggestions(reply, locale.value),
        };
      });
    }, 350);
    return true;
  }
  const submission = officeRuntimeHooks.submitChatPrompt(sessionId, trimmed, operationId);
  if (submission === undefined) {
    updatePromptOperation(sessionId, operationId, { status: "accepted" });
    return true;
  }
  return submission.then((result) => {
    updatePromptOperation(sessionId, operationId, result);
    // A commit-unconfirmed response is intentionally not replayed: Hermes may
    // already have the prompt, so clearing the composer is the safer outcome.
    return result.status !== "rejected";
  }, (reason) => {
    updatePromptOperation(sessionId, operationId, {
      status: "unconfirmed",
      message: reason instanceof Error ? reason.message : "Prompt submission could not be confirmed.",
    });
    return true;
  });
}

export function applySessionModelPrefs(
  sessionId: string,
  provider: string,
  model: string,
  reasoningEffort = "",
): void {
  updateChatSession(sessionId, (session) => ({
    ...session,
    ...(provider ? { provider } : { provider: undefined }),
    ...(model ? { model } : { model: undefined }),
    ...(reasoningEffort ? { reasoningEffort } : { reasoningEffort: undefined }),
  }));
}

/**
 * Stage a mid-session model switch. The /model command is not sent now; it is
 * flushed by sendMessage right before the next outbound prompt. Re-picking the
 * model that was active before the first staged change cancels the pending
 * switch. Repeated picks keep only the latest selection.
 */
export function stageSessionModelChange(
  sessionId: string,
  provider: string,
  model: string,
  reasoningEffort = "",
): void {
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session) return;
  if (session.pendingModelChange?.applying) return;
  const previousPending = session.pendingModelChange;
  const baseline = previousPending?.modelApplied
    ? {
        // /model committed but its /reasoning follow-up did not. The current
        // provider/model is authoritative; the old reasoning baseline is the
        // last value Hermes actually accepted.
        provider: session.provider,
        model: session.model,
        reasoningEffort: previousPending.baseline.reasoningEffort,
      }
    : previousPending?.baseline ?? {
        provider: session.provider,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
      };
  applySessionModelPrefs(sessionId, provider, model, reasoningEffort);
  const backToBaseline = (baseline.model ?? "") === model
    && (baseline.provider ?? "") === provider
    && (baseline.reasoningEffort ?? "") === (reasoningEffort || "");
  if (backToBaseline) {
    updateChatSession(sessionId, (item) => ({ ...item, pendingModelChange: undefined }));
    return;
  }
  const command = modelSlashCommand({ provider, model, reasoningEffort });
  if (!command) {
    updateChatSession(sessionId, (item) => ({ ...item, pendingModelChange: undefined }));
    return;
  }
  updateChatSession(sessionId, (item) => ({
    ...item,
    pendingModelChange: {
      command,
      ...(reasoningEffort
        ? { reasoningCommand: `/reasoning ${reasoningEffort}` }
        : (baseline.reasoningEffort ? { reasoningCommand: "/reasoning default" } : {})),
      model,
      baseline,
    },
  }));
}

/** Cancel a staged model switch and restore the pre-change session prefs. */
export function cancelSessionModelChange(sessionId: string): void {
  const session = sessions.value.find((item) => item.id === sessionId);
  const pending = session?.pendingModelChange;
  if (!session || !pending || pending.applying) return;
  if (pending.modelApplied) {
    // The model already changed authoritatively; cancel only the unapplied
    // reasoning follow-up so the UI cannot claim that Hermes rolled back.
    applySessionModelPrefs(
      sessionId,
      session.provider ?? "",
      session.model ?? "",
      pending.baseline.reasoningEffort ?? "",
    );
  } else {
    applySessionModelPrefs(
      sessionId,
      pending.baseline.provider ?? "",
      pending.baseline.model ?? "",
      pending.baseline.reasoningEffort ?? "",
    );
  }
  updateChatSession(sessionId, (item) => ({ ...item, pendingModelChange: undefined }));
}

export function clearFollowUpSuggestions(sessionId: string): void {
  updateChatSession(sessionId, (session) => (
    session.followUpSuggestions ? { ...session, followUpSuggestions: undefined } : session
  ));
}

export function consumeChatComposerPrefill(sessionId: string, prefillId: string): void {
  updateChatSession(sessionId, (session) => session.composerPrefill?.id === prefillId
    ? { ...session, composerPrefill: undefined }
    : session);
}

export function refreshFollowUpSuggestions(sessionId: string): void {
  updateChatSession(sessionId, (session) => {
    if (isChatRunActive(session) || session.status !== "ready") return session;
    const lastAgent = [...session.messages].reverse().find((message) => message.from === "agent" && message.status !== "streaming");
    if (!lastAgent?.body.trim()) return session;
    return { ...session, followUpSuggestions: buildFollowUpSuggestions(lastAgent.body, locale.value) };
  });
}

export async function steerSession(sessionId: string, body: string): Promise<boolean> {
  return steerChatRun(sessions, officeRuntimeHooks.steerChatSession, sessionId, body);
}

export async function interruptSession(sessionId: string): Promise<boolean> {
  return await interruptChatRun(sessions, officeRuntimeHooks.interruptChatSession, sessionId);
}

export async function respondToClarification(sessionId: string, answer: string): Promise<void> {
  const trimmed = answer.trim();
  const session = sessions.value.find((item) => item.id === sessionId);
  const pending = session?.pendingInteraction;
  if (!trimmed || session?.connectionState !== "ready" || pending?.kind !== "clarify" || pending.submitting) return;
  markInteractionSubmitting(sessionId, pending.id);
  try {
    await officeRuntimeHooks.respondClarify(sessionId, pending.requestId, trimmed);
    clearInteraction(sessionId, pending.id);
  } catch {
    failInteraction(sessionId, pending.id, officeMessage("runtime.chat.answerFailed"));
  }
}

export async function respondToApproval(sessionId: string, choice: ApprovalChoice): Promise<void> {
  const session = sessions.value.find((item) => item.id === sessionId);
  const pending = session?.pendingInteraction;
  if (session?.connectionState !== "ready" || pending?.kind !== "approval" || pending.submitting) return;
  if (!pending.choices.includes(choice) || (choice === "always" && !pending.allowPermanent)) return;
  markInteractionSubmitting(sessionId, pending.id);
  try {
    await officeRuntimeHooks.respondApproval(sessionId, pending.approvalId, choice);
    clearInteraction(sessionId, pending.id);
  } catch {
    failInteraction(sessionId, pending.id, officeMessage("runtime.chat.approvalFailed"));
  }
}

export function reconnectChatSession(sessionId: string): void {
  const session = sessions.value.find((item) => item.id === sessionId);
  const target = session ? chatTarget(session) : undefined;
  if (target) officeRuntimeHooks.ensureChatSession(target);
}

export function setChatSocketState(state: ChatConnectionState, message = ""): void {
  chatSocketState.value = { state, message: message ? officeRuntimeMessage(message) : officeMessage("runtime.chat.waiting") };
}

export function setChatHistoryLoading(sessionId: string, resetTranscript = false): void {
  updateChatSession(sessionId, (session) => {
    const migrated = migrateLegacyPromptEvidence(session);
    return {
      ...migrated,
      historyState: "loading",
      ...(resetTranscript ? {
        messages: [],
        streamingMessageId: undefined,
        streamingSourceMessageId: undefined,
        interimMessageIds: undefined,
        chatRunStarted: undefined,
        chatRunId: undefined,
        chatCorrelationEpoch: undefined,
        chatRunServerSequence: undefined,
        completedChatRunServerSequence: undefined,
        processedChatEventSequence: undefined,
        chatRunSourceMessageId: undefined,
        chatRunSequence: undefined,
        toolMessageBindings: undefined,
        historyPartial: false,
        historyNotice: undefined,
      } : {}),
    };
  });
}

export function applyChatHistory(sessionId: string, history: ChatMessage[], resolvedStoredSessionId?: string, result?: ChatHistoryResult): void {
  updateChatSession(sessionId, (session) => {
    const migrated = migrateLegacyPromptEvidence(session);
    const authoredSuggestions = new Map<string, string[]>();
    const visibleHistory = history.map((message) => {
      if (message.from !== "agent") return message;
      const parsed = extractAgentFollowUpSuggestions(message.body);
      if (parsed.suggestions.length > 0) authoredSuggestions.set(message.id, parsed.suggestions);
      return { ...message, body: parsed.body };
    });
    const historyIds = new Set(visibleHistory.map((message) => message.id));
    const localMessages = migrated.messages
      .filter((message) => !historyIds.has(message.id));
    const merged = boundedTranscriptSuffix([...visibleHistory, ...localMessages]);
    const latestAgent = [...merged.messages].reverse()
      .find((message) => message.from === "agent" && message.status !== "streaming");
    const followUpSuggestions = latestAgent === undefined
      ? undefined
      : authoredSuggestions.get(latestAgent.id)
        ?? (!historyIds.has(latestAgent.id) && migrated.followUpSuggestions?.length
          ? migrated.followUpSuggestions
          : latestAgent.body.trim() ? buildFollowUpSuggestions(latestAgent.body, locale.value) : undefined);
    return {
      ...migrated,
      ...(resolvedStoredSessionId ? { storedSessionId: resolvedStoredSessionId, remoteKind: "stored" as const } : {}),
      historyState: "loaded",
      historyPartial: result?.partial === true || merged.truncated, historyNotice: result?.error ? officeRuntimeMessage(result.error) : undefined,
      errorMessage: session.connectionState === "error" ? session.errorMessage : undefined,
      messages: merged.messages,
      followUpSuggestions,
      chatCorrelationEpoch: undefined,
      chatRunServerSequence: undefined,
      completedChatRunServerSequence: undefined,
      processedChatEventSequence: undefined,
    };
  });
}

function updatePromptOperation(sessionId: string, operationId: string, result: ChatPromptResult): void {
  updateChatSession(sessionId, (session) => {
    let found = false;
    const evidence = (session.operationEvidence ?? []).map((operation) => {
      if (operation.id !== operationId || operation.kind !== "prompt" || operation.state !== "pending") return operation;
      found = true;
      return {
        ...operation,
        state: result.status,
        ...(result.status === "accepted" ? { message: undefined } : { message: result.message }),
      };
    });
    if (!found) return session;
    return {
      ...session,
      operationEvidence: evidence,
      ...(result.status === "rejected" || result.status === "unconfirmed" ? { status: "ready" as const } : {}),
    };
  });
}

export function reconcilePromptOperationsWithHistory(local: readonly ChatOperationEvidence[], _history: readonly ChatMessage[]): ChatOperationEvidence[] {
  return boundedOperationEvidence(local);
}

function migrateLegacyPromptEvidence(session: ChatSession): ChatSession {
  const legacy = session.messages.flatMap<ChatOperationEvidence>((message): ChatOperationEvidence[] => {
    if (message.promptOperation) return [{
      id: message.promptOperation.id, kind: "prompt" as const, body: message.body, at: message.at,
      timelineSequence: message.timelineSequence,
      state: message.promptOperation.state,
      ...(message.promptOperation.message ? { message: message.promptOperation.message } : {}),
    }];
    return message.kind === "steer"
      ? [{
          id: message.id,
          timelineSequence: message.timelineSequence,
          kind: "steer" as const,
          body: message.body,
          at: message.at,
          state: "accepted" as const,
        }]
      : [];
  });
  if (legacy.length === 0) return session;
  return {
    ...session,
    messages: session.messages.filter((message) => message.promptOperation === undefined && message.kind !== "steer"),
    operationEvidence: boundedOperationEvidence([...(session.operationEvidence ?? []), ...legacy]),
  };
}

export function setChatHistoryError(sessionId: string, message: string): void {
  updateChatSession(sessionId, (session) => ({ ...session, historyState: "error", errorMessage: officeRuntimeMessage(message) }));
}

export function setChatSessionConnecting(sessionId: string): void {
  updateChatSession(sessionId, reconcileChatSessionConnecting);
}

export function setChatSessionQueued(sessionId: string): void {
  updateChatSession(sessionId, reconcileChatSessionQueued);
}

export function setChatSessionReady(sessionId: string, liveSessionId: string, storedSessionId?: string, runtime?: ChatSessionReadyRuntime): void {
  updateChatSession(sessionId, (session) => reconcileChatSessionReady(session, liveSessionId, storedSessionId, runtime));
  tryFlushCardSeed(sessionId);
}

/**
 * Card-ask sessions keep pendingCardSeed as context for the first user-authored
 * message. Studio never auto-sends that context; ChatPane prepends it on submit.
 */
export function tryFlushCardSeed(_sessionId: string): void {
  // Intentionally a no-op: asking an assignee opens a chat, then the user types.
}

/** Consume the one-shot card context after the user sends their first prompt. */
export function pendingCardSeedForPrompt(sessionId: string): string | undefined {
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session || !sessionNeedsCardSeed(session)) return undefined;
  return session.pendingCardSeed?.trim() || undefined;
}

export function consumeCardSeed(sessionId: string, expectedSeed?: string): string | undefined {
  const session = sessions.value.find((item) => item.id === sessionId);
  if (!session || session.sourceCardSeeded === true) return undefined;
  const seed = session.pendingCardSeed?.trim();
  if (!seed || (expectedSeed !== undefined && seed !== expectedSeed)) return undefined;
  updateChatSession(sessionId, (item) => ({
    ...item,
    sourceCardSeeded: true,
    pendingCardSeed: undefined,
  }));
  return seed || undefined;
}

export function setChatSessionDisconnected(sessionId: string): void {
  updateChatSession(sessionId, reconcileChatSessionDisconnected);
}

export function setChatSessionError(sessionId: string, message: string): void {
  updateChatSession(sessionId, (session) => reconcileChatSessionError(session, officeRuntimeMessage(message)));
}

export function applyChatGatewayEvent(sessionId: string, event: ChatGatewayEvent): "resync-required" | void {
  let resyncRequired = false;
  updateChatSession(sessionId, (session) => reduceChatGatewayEvent(session, event, () => { resyncRequired = true; }));
  return resyncRequired ? "resync-required" : undefined;
}

function markInteractionSubmitting(sessionId: string, interactionId: string): void {
  updateChatSession(sessionId, (session) => session.pendingInteraction?.id === interactionId
    ? { ...session, pendingInteraction: { ...session.pendingInteraction, submitting: true, error: undefined } }
    : session);
}

function clearInteraction(sessionId: string, interactionId: string): void {
  updateChatSession(sessionId, (session) => session.pendingInteraction?.id === interactionId
    ? { ...session, status: "streaming", pendingInteraction: undefined }
    : session);
}

function failInteraction(sessionId: string, interactionId: string, error: RuntimeMessage): void {
  updateChatSession(sessionId, (session) => session.pendingInteraction?.id === interactionId
    ? { ...session, pendingInteraction: { ...session.pendingInteraction, submitting: false, error } }
    : session);
}

function chatTarget(session: ChatSession): ChatTarget | undefined {
  if (!session.remoteKind || session.remoteKind === "demo") return undefined;
  // Session effort was set via apply (live allowlist) or createSession from validated prefs.
  const resolved = resolvedCreateModelPrefs({
    provider: session.provider ?? "",
    model: session.model ?? "",
    reasoningEffort: session.reasoningEffort ?? "",
  });
  return {
    clientSessionId: session.id,
    profileId: session.profileId,
    ...(session.storedSessionId ? { storedSessionId: session.storedSessionId } : {}),
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.provider ? { provider: resolved.provider } : {}),
    ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
  };
}

function updateChatSession(sessionId: string, update: (session: ChatSession) => ChatSession): void {
  sessions.value = sessions.value.map((session) => session.id === sessionId ? update(session) : session);
}

async function applyPendingModelChange(
  sessionId: string,
  pending: NonNullable<ChatSession["pendingModelChange"]>,
): Promise<boolean> {
  const current = sessions.value.find((item) => item.id === sessionId)?.pendingModelChange;
  if (current?.command !== pending.command) return false;
  if (current.applying) return false;
  updateChatSession(sessionId, (item) => item.pendingModelChange?.command === pending.command
    ? { ...item, pendingModelChange: { ...item.pendingModelChange, applying: true } }
    : item);
  let applied = pending.modelApplied === true;
  if (!applied) {
    applied = await runSlashCommand(sessionId, pending.command);
    if (applied) {
      updateChatSession(sessionId, (item) => item.pendingModelChange?.command === pending.command
        ? { ...item, pendingModelChange: { ...item.pendingModelChange, modelApplied: true } }
        : item);
    }
  }
  if (applied && pending.reasoningCommand) applied = await runSlashCommand(sessionId, pending.reasoningCommand);
  const settled = sessions.value.find((item) => item.id === sessionId)?.pendingModelChange;
  if (settled?.command !== pending.command || settled.applying !== true) return false;
  if (!applied) {
    updateChatSession(sessionId, (item) => item.pendingModelChange?.command === pending.command
      ? { ...item, pendingModelChange: { ...item.pendingModelChange, applying: false } }
      : item);
    return false;
  }
  updateChatSession(sessionId, (item) => item.pendingModelChange?.command === pending.command
    ? { ...item, pendingModelChange: undefined }
    : item);
  return true;
}

function applySlashSessionPrefs(
  sessionId: string,
  command: string,
  key: "model" | "reasoning" | undefined,
  value: string | undefined,
): void {
  if (key === "reasoning") {
    const resolved = (value ?? /^\/reasoning\s+(\S+)/i.exec(command)?.[1] ?? "").trim().toLowerCase();
    const effort = resolved === "default" ? "" : resolved;
    updateChatSession(sessionId, (session) => ({
      ...session,
      ...(effort ? { reasoningEffort: effort } : { reasoningEffort: undefined }),
    }));
    return;
  }
  if (key !== "model" && !/^\/model\s/i.test(command)) return;
  const match = /^\/model\s+([A-Za-z0-9][A-Za-z0-9_./:+@-]{0,255})(?:\s+--provider\s+([A-Za-z0-9][A-Za-z0-9_./:-]{0,127}))?\s+--session$/i.exec(command);
  if (!match) return;
  const model = value?.trim() || match[1]!;
  const provider = match[2]?.trim();
  updateChatSession(sessionId, (session) => ({
    ...session,
    model,
    ...(provider ? { provider } : {}),
  }));
}
