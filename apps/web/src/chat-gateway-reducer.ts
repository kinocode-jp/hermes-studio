import type { ChatGatewayEvent } from "./chat-api";
import type { ChatPendingInteraction, ChatSession } from "./domain";
import { isChatRunActive, mergeGatewayStatusUpdate } from "./session-runtime";
import { approvalChoices, gatewayMessageId, nextChatTimelineSequence, nowTimestamp, stringArray, stringValue } from "./chat-store-utils";
import { appendLiveDelta, appendLiveMessage, replaceLiveMessages, type TranscriptChange } from "./live-transcript";
import { officeMessage, upstreamMessage, locale } from "./i18n";
import { buildFollowUpSuggestions, extractAgentFollowUpSuggestions } from "./chat-suggestions";
import { officeSnapshot } from "./store-state";
import { advanceSequence, finitePositiveSequence, sequenceFromOpaqueId } from "./chat-event-ledger";

export function reduceChatGatewayEvent(
  session: ChatSession,
  event: ChatGatewayEvent,
  onTranscriptLimit?: (reason: Extract<TranscriptChange, { status: "resync-required" }>["reason"]) => void,
): ChatSession {
  if (session.liveSessionId && event.liveSessionId !== session.liveSessionId) return session;
  const eventId = stringValue(event.payload?.eventId);
  const correlationEpoch = stringValue(event.payload?.correlationEpoch)
    ?? stringValue(event.payload?.correlation_epoch);
  if (correlationEpoch !== undefined && session.chatCorrelationEpoch !== undefined
    && correlationEpoch !== session.chatCorrelationEpoch) return session;
  const eventSequence = finitePositiveSequence(event.payload?.eventSequence)
    ?? finitePositiveSequence(event.payload?.event_sequence)
    ?? sequenceFromOpaqueId(eventId, "event");
  if (eventSequence !== undefined && session.processedChatEventSequence !== undefined
    && eventSequence <= session.processedChatEventSequence) return session;
  const reduced = reduceUnseenChatGatewayEvent(session, event, onTranscriptLimit);
  if (correlationEpoch === undefined && eventSequence === undefined) return reduced;
  return {
    ...reduced,
    chatCorrelationEpoch: reduced.chatCorrelationEpoch ?? correlationEpoch,
    processedChatEventSequence: advanceSequence(reduced.processedChatEventSequence, eventSequence),
  };
}

function reduceUnseenChatGatewayEvent(
  session: ChatSession,
  event: ChatGatewayEvent,
  onTranscriptLimit?: (reason: Extract<TranscriptChange, { status: "resync-required" }>["reason"]) => void,
): ChatSession {
  const payload = event.payload ?? {};
  if (event.type === "approval.expired") {
    const approvalId = stringValue(payload.approvalId) ?? stringValue(payload.approval_id);
    if (session.pendingInteraction?.kind !== "approval" || session.pendingInteraction.approvalId !== approvalId) return session;
    return {
      ...session,
      status: session.status === "waiting" ? "streaming" : session.status,
      pendingInteraction: undefined,
    };
  }
  if (event.type === "clarify.expired") {
    const requestId = stringValue(payload.requestId) ?? stringValue(payload.request_id);
    if (session.pendingInteraction?.kind !== "clarify" || session.pendingInteraction.requestId !== requestId) return session;
    return {
      ...session,
      status: session.status === "waiting" ? "streaming" : session.status,
      pendingInteraction: undefined,
    };
  }
  if (event.type === "clarify.request") {
    const requestId = stringValue(payload.requestId) ?? stringValue(payload.request_id);
    const question = stringValue(payload.question);
    if (!requestId || !question) return session;
    return withPendingInteraction(session, {
      id: `clarify:${requestId}`,
      kind: "clarify",
      requestId,
      question,
      choices: stringArray(payload.choices),
      submitting: false
    });
  }
  if (event.type === "approval.request") {
    const approvalId = stringValue(payload.approvalId) ?? stringValue(payload.approval_id);
    const command = stringValue(payload.command);
    const description = stringValue(payload.description);
    const allowPermanent = (payload.allowPermanent === true || payload.allow_permanent === true)
      && officeSnapshot.value?.capabilities.access.allowedOperations.includes("chat.approval.permanent") === true;
    const choices = approvalChoices(payload.choices, allowPermanent);
    if (!approvalId || choices.length === 0) return session;
    return withPendingInteraction(session, {
      id: `approval:${approvalId}`,
      kind: "approval",
      approvalId,
      ...(command ? { command } : {}),
      ...(description ? { description } : {}),
      choices,
      allowPermanent,
      submitting: false
    });
  }
  if (event.type === "message.start") {
    // Upstream message ids are not guaranteed to be unique across turns (and
    // Hermes commonly omits them). A transcript id is UI identity, so never
    // reuse a completed row's id for a new chronological event.
    const sourceMessageId = gatewayMessageId(payload);
    const runId = stringValue(payload.runId) ?? stringValue(payload.run_id);
    const runServerSequence = gatewayRunServerSequence(payload, runId);
    if (isStaleGatewayRun(session, runId, runServerSequence)) return session;
    const activeMessageId = currentStreamingAgentMessageId(session);
    if (activeMessageId !== undefined || (session.chatRunStarted === true && session.status !== "ready")) {
      // Start frames may be replayed during transport recovery. While an
      // assistant run is open there is no valid second chronological start.
      // Keep run identity after interim bubbles seal so a replay cannot create
      // another row or advance the run counter.
      const claimedSource = session.chatRunSourceMessageId
        ?? session.streamingSourceMessageId
        ?? sourceMessageId;
      return {
        ...session,
        chatRunStarted: true,
        chatRunId: session.chatRunId ?? runId,
        chatRunServerSequence: session.chatRunServerSequence ?? runServerSequence,
        chatRunSourceMessageId: claimedSource,
        ...(activeMessageId !== undefined && session.streamingSourceMessageId === undefined
          ? { streamingSourceMessageId: claimedSource }
          : {}),
      };
    }
    const messageId = uniqueTranscriptMessageId(
      session.messages,
      sourceMessageId ?? `stream-${event.liveSessionId}`,
    );
    const change = appendLiveMessage(session.messages, {
      id: messageId,
      timelineSequence: nextChatTimelineSequence(session),
      from: "agent",
      body: "",
      at: nowTimestamp(),
      status: "streaming",
    });
    return withTranscriptChange(session, change, onTranscriptLimit, {
      ...session,
      status: "streaming",
      streamingMessageId: messageId,
      streamingSourceMessageId: sourceMessageId,
      interimMessageIds: undefined,
      ...beginChatRun(session, sourceMessageId, runId, runServerSequence),
    });
  }
  if (event.type === "message.delta") {
    const delta = stringValue(payload.text) ?? stringValue(payload.delta) ?? "";
    if (!delta) return session;
    const explicitMessageId = gatewayMessageId(payload);
    const runId = stringValue(payload.runId) ?? stringValue(payload.run_id);
    const runServerSequence = gatewayRunServerSequence(payload, runId);
    if (isStaleGatewayRun(session, runId, runServerSequence)) return session;
    if (hasConflictingActiveAgentSource(session, explicitMessageId)) return session;
    const activeMessageId = activeAgentMessageId(session, explicitMessageId);
    const messageId = activeMessageId ?? uniqueTranscriptMessageId(
      session.messages,
      explicitMessageId ?? `stream-${event.liveSessionId}`,
    );
    const change = activeMessageId
      ? appendLiveDelta(session.messages, messageId, delta)
      : appendLiveMessage(session.messages, {
          id: messageId,
          timelineSequence: nextChatTimelineSequence(session),
          from: "agent",
          body: delta,
          at: nowTimestamp(),
          status: "streaming",
        });
    return withTranscriptChange(session, change, onTranscriptLimit, {
      ...session,
      status: "streaming",
      streamingMessageId: messageId,
      streamingSourceMessageId: explicitMessageId
        ?? (messageId === session.streamingMessageId ? session.streamingSourceMessageId : undefined),
      ...beginChatRun(session, explicitMessageId, runId, runServerSequence),
    });
  }
  if (event.type === "message.interim") {
    // Hermes seals mid-turn assistant commentary (text alongside tools, or a
    // verify-on-stop candidate) so the later message.complete can replace only
    // the open streaming bubble. Without this, Studio loses the provisional
    // reply when the final text is shorter or empty.
    const interimText = stringValue(payload.text) ?? stringValue(payload.delta) ?? "";
    if (!interimText.trim()) return session;
    const explicitMessageId = gatewayMessageId(payload);
    const runId = stringValue(payload.runId) ?? stringValue(payload.run_id);
    const runServerSequence = gatewayRunServerSequence(payload, runId);
    if (isStaleGatewayRun(session, runId, runServerSequence)) return session;
    if (hasConflictingActiveAgentSource(session, explicitMessageId)) return session;
    const activeMessageId = activeAgentMessageId(session, explicitMessageId);
    const messageId = activeMessageId ?? uniqueTranscriptMessageId(
      session.messages,
      explicitMessageId ?? `interim-${event.liveSessionId}`,
    );
    const sealed = activeMessageId
      ? session.messages.map((message) => message.id === messageId
        ? { ...message, body: interimText, status: "complete" as const }
        : message)
      : [...session.messages, {
          id: messageId,
          timelineSequence: nextChatTimelineSequence(session),
          from: "agent" as const,
          body: interimText,
          at: nowTimestamp(),
          status: "complete" as const,
        }];
    const change = replaceLiveMessages(session.messages, sealed, new Set([messageId]));
    return withTranscriptChange(session, change, onTranscriptLimit, {
      ...session,
      status: "streaming",
      // A sealed interim ends the current stream bubble; later deltas open a new one.
      streamingMessageId: undefined,
      streamingSourceMessageId: undefined,
      interimMessageIds: appendUniqueId(session.interimMessageIds, messageId),
      ...beginChatRun(session, explicitMessageId, runId, runServerSequence),
    });
  }
  if (event.type === "message.complete") {
    const explicitMessageId = gatewayMessageId(payload);
    const runId = stringValue(payload.runId) ?? stringValue(payload.run_id);
    const runServerSequence = gatewayRunServerSequence(payload, runId);
    if (isStaleGatewayRun(session, runId, runServerSequence)) return session;
    if (hasConflictingActiveAgentSource(session, explicitMessageId)) return session;
    // A terminal frame may repeat an id from an older turn. Only the current
    // open assistant row is eligible for replacement; otherwise completion is
    // a new event appended at the end of the transcript.
    const messageId = activeAgentMessageId(session, explicitMessageId);
    const completeText = stringValue(payload.text);
    const streamedText = messageId
      ? session.messages.find((message) => message.id === messageId)?.body ?? ""
      : "";
    const sourceText = completeText || streamedText;
    // A terminal frame with no text and no open stream only finishes the run.
    // Sealed interim bubbles must remain visible rather than being replaced by
    // an empty complete message.
    if (!sourceText.trim() && messageId === undefined) {
      return {
        ...session,
        status: "ready",
        streamingMessageId: undefined,
        streamingSourceMessageId: undefined,
        interimMessageIds: undefined,
        chatRunStarted: undefined,
        chatRunId: undefined,
        chatRunServerSequence: undefined,
        completedChatRunServerSequence: advanceSequence(
          session.completedChatRunServerSequence,
          runServerSequence ?? session.chatRunServerSequence,
        ),
        chatRunSourceMessageId: undefined,
        pendingInteraction: undefined,
        interruptPending: false,
        interruptOperationId: undefined,
        messages: session.messages.map((message) => message.status === "streaming"
          ? { ...message, status: "complete" as const }
          : message),
        followUpSuggestions: (() => {
          const latestAgent = [...session.messages].reverse()
            .find((message) => message.from === "agent" && message.body.trim());
          return latestAgent?.body.trim()
            ? buildFollowUpSuggestions(latestAgent.body, locale.value)
            : session.followUpSuggestions;
        })(),
      };
    }
    const parsedReply = extractAgentFollowUpSuggestions(sourceText);
    const visibleText = parsedReply.body;
    // A terminal frame can be delivered more than once. Once a run is ready,
    // an identical completed reply is a replay, not a new chronological row.
    if (messageId === undefined && session.status === "ready"
      && hasCompletedAgentMessage(session, explicitMessageId, visibleText)) {
      return session;
    }
    const resolvedMessageId = messageId ?? uniqueTranscriptMessageId(
      session.messages,
      explicitMessageId ?? `complete-${event.liveSessionId}`,
    );
    const exists = session.messages.some((message) => message.id === resolvedMessageId);
    // When the final text matches a sealed interim bubble, keep that bubble and
    // only close any remaining open stream instead of duplicating the reply.
    const currentInterimIds = new Set(session.interimMessageIds ?? []);
    const matchingInterim = !exists && visibleText.trim() && currentInterimIds.size > 0
      ? [...session.messages].reverse().find((message) => (
        message.from === "agent"
        && message.status === "complete"
        && currentInterimIds.has(message.id)
        && message.body.trim() === visibleText.trim()
      ))
      : undefined;
    const replacements = matchingInterim
      ? session.messages.map((message) => message.status === "streaming" ? { ...message, status: "complete" as const } : message)
      : exists
        ? session.messages.map((message) => message.id === resolvedMessageId
          ? { ...message, body: visibleText, status: "complete" as const }
          : message.status === "streaming" ? { ...message, status: "complete" as const } : message)
        : [...session.messages.map((message) => message.status === "streaming" ? { ...message, status: "complete" as const } : message),
          ...(visibleText ? [{
            id: resolvedMessageId,
            timelineSequence: nextChatTimelineSequence(session),
            from: "agent" as const,
            body: visibleText,
            at: nowTimestamp(),
            status: "complete" as const,
          }] : [])];
    const preserveIds = new Set<string>([
      ...(matchingInterim ? [matchingInterim.id] : []),
      ...(!matchingInterim && visibleText ? [resolvedMessageId] : []),
    ]);
    const change = replaceLiveMessages(session.messages, replacements, preserveIds);
    const completedBody = matchingInterim?.body
      ?? replacements.find((message) => message.id === resolvedMessageId)?.body
      ?? visibleText
      ?? "";
    return withTranscriptChange(session, change, onTranscriptLimit, {
      ...session,
      status: "ready",
      streamingMessageId: undefined,
      streamingSourceMessageId: undefined,
      interimMessageIds: undefined,
      chatRunStarted: undefined,
      chatRunId: undefined,
      chatRunServerSequence: undefined,
      completedChatRunServerSequence: advanceSequence(
        session.completedChatRunServerSequence,
        runServerSequence ?? session.chatRunServerSequence,
      ),
      chatRunSourceMessageId: undefined,
      pendingInteraction: undefined,
      interruptPending: false,
      interruptOperationId: undefined,
      followUpSuggestions: parsedReply.suggestions.length > 0
        ? parsedReply.suggestions
        : completedBody.trim()
          ? buildFollowUpSuggestions(completedBody, locale.value)
          : undefined,
    });
  }
  if (event.type === "status.update") {
    return isChatRunActive(session) ? mergeGatewayStatusUpdate(session, payload) : session;
  }
  if (event.type === "session.info") {
    // session.info is an uncorrelated observation and may predate this interrupt.
    // Only merge descriptive session fields. Its running/status observation must
    // not finish a newer interrupt or run in the local state machine.
    const model = stringValue(payload.model);
    const provider = stringValue(payload.provider);
    const reasoningEffort = stringValue(payload.reasoningEffort) ?? stringValue(payload.reasoning_effort);
    if (!model && !provider && !reasoningEffort) return session;
    return {
      ...session,
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  if (event.type.startsWith("tool.")) {
    const toolRunId = stringValue(payload.runId) ?? stringValue(payload.run_id);
    const toolRunServerSequence = gatewayRunServerSequence(payload, toolRunId);
    if (isStaleGatewayRun(session, toolRunId, toolRunServerSequence)) return session;
    const correlatedToolId = stringValue(payload.toolOccurrenceId) ?? stringValue(payload.tool_occurrence_id);
    const upstreamToolId = stringValue(payload.toolId) ?? stringValue(payload.tool_id);
    const explicitToolId = correlatedToolId ?? upstreamToolId;
    const sourceToolId = explicitToolId ?? `tool-${event.liveSessionId}`;
    const name = stringValue(payload.name);
    const detail = stringValue(payload.summary) ?? stringValue(payload.status);
    const phase = event.type === "tool.complete" ? "complete" as const : "running" as const;
    const status = phase === "complete" ? "complete" as const : "streaming" as const;
    const body = detail ? `${name ?? "Tool"}: ${detail}` : "";
    const presentation = detail ? undefined : { kind: "tool-fallback" as const, ...(name ? { name } : {}), phase };
    const runClaim = toolRunId === undefined ? undefined : claimGatewayRun(session, toolRunId, toolRunServerSequence);
    const runSequence = runClaim?.chatRunSequence ?? session.chatRunSequence ?? 0;
    const latestBinding = findToolBinding(session.toolMessageBindings, runSequence, sourceToolId);
    // An upstream id is one occurrence identity within a run. When the
    // upstream omits ids, however, every start is the only available occurrence
    // boundary. Allocate it independently even when another anonymous tool is
    // still running; later anonymous progress/complete frames bind to the most
    // recently started open occurrence.
    const binding = explicitToolId === undefined
      && event.type === "tool.start"
      ? undefined
      : latestBinding;
    const boundIndex = binding === undefined
      ? -1
      : session.messages.findIndex((message) => message.id === binding.messageId && message.from === "tool");
    const boundMessage = boundIndex < 0 ? undefined : session.messages[boundIndex];
    // An explicit source id identifies at most one tool occurrence within one
    // run. Anonymous starts are split unconditionally above. Repeated
    // progress/complete events after an occurrence sealed remain idempotent.
    if (boundMessage?.status !== "streaming" && binding !== undefined) return session;
    // After a terminal/reset fence, an unmatched completion is stale. A real
    // tool call always has a start/progress event that establishes its binding.
    if (binding === undefined && event.type === "tool.complete" && session.status === "ready") return session;
    const reuseBoundMessage = boundMessage?.status === "streaming";
    const toolId = reuseBoundMessage
      ? boundMessage.id
      : uniqueTranscriptMessageId(session.messages, sourceToolId);
    const replacements = reuseBoundMessage
      ? session.messages.map((message, currentIndex) => currentIndex === boundIndex ? { ...message, body, presentation, status } : message)
      : [...session.messages, {
          id: toolId,
          timelineSequence: nextChatTimelineSequence(session),
          from: "tool" as const,
          body,
          presentation,
          at: nowTimestamp(),
          status,
        }];
    const change = replaceLiveMessages(session.messages, replacements, new Set([toolId]));
    return withTranscriptChange(session, change, onTranscriptLimit, {
      ...session,
      status: event.type === "tool.complete" ? session.status : "streaming",
      ...(runClaim ?? {}),
      toolMessageBindings: reuseBoundMessage
        ? session.toolMessageBindings
        : bindToolMessage(session.toolMessageBindings, runSequence, sourceToolId, toolId),
    });
  }
  if (event.type === "error") {
    const upstreamText = stringValue(payload.message);
    return {
      ...session,
      status: "ready",
      errorMessage: upstreamText ? upstreamMessage(upstreamText) : officeMessage("runtime.chat.hermesGenericError"),
      streamingMessageId: undefined,
      streamingSourceMessageId: undefined,
      interimMessageIds: undefined,
      chatRunStarted: undefined,
      chatRunId: undefined,
      chatRunServerSequence: undefined,
      completedChatRunServerSequence: advanceSequence(
        session.completedChatRunServerSequence,
        session.chatRunServerSequence,
      ),
      chatRunSourceMessageId: undefined,
      chatRunSequence: undefined,
      toolMessageBindings: undefined,
      pendingInteraction: undefined,
      interruptPending: false,
      interruptOperationId: undefined,
      messages: session.messages.map((item) => item.status === "streaming" ? { ...item, status: "failed" } : item)
    };
  }
  return session;
}

function currentStreamingAgentMessageId(session: ChatSession): string | undefined {
  const messageId = session.streamingMessageId;
  if (messageId === undefined) return undefined;
  return session.messages.some((message) => (
    message.id === messageId
    && message.from === "agent"
    && message.status === "streaming"
  )) ? messageId : undefined;
}

function beginChatRun(
  session: ChatSession,
  sourceMessageId: string | undefined,
  runId: string | undefined,
  runServerSequence: number | undefined,
): Pick<
  ChatSession,
  "chatRunStarted" | "chatRunId" | "chatRunServerSequence" | "chatRunSourceMessageId" | "chatRunSequence"
> {
  const alreadyStarted = session.chatRunStarted === true;
  const alreadyCounted = alreadyStarted || (session.chatRunId !== undefined
    && (runId === undefined || session.chatRunId === runId));
  return {
    chatRunStarted: true,
    chatRunId: session.chatRunId ?? runId,
    chatRunServerSequence: session.chatRunServerSequence ?? runServerSequence,
    chatRunSourceMessageId: session.chatRunSourceMessageId
      ?? session.streamingSourceMessageId
      ?? sourceMessageId,
    chatRunSequence: alreadyCounted
      ? session.chatRunSequence ?? 1
      : (session.chatRunSequence ?? 0) + 1,
  };
}

function claimGatewayRun(
  session: ChatSession,
  runId: string,
  runServerSequence: number | undefined,
): Pick<ChatSession, "chatRunId" | "chatRunServerSequence" | "chatRunSequence"> {
  const alreadyCounted = session.chatRunId === runId;
  return {
    chatRunId: runId,
    chatRunServerSequence: alreadyCounted
      ? session.chatRunServerSequence ?? runServerSequence
      : runServerSequence,
    chatRunSequence: alreadyCounted
      ? session.chatRunSequence ?? 1
      : (session.chatRunSequence ?? 0) + 1,
  };
}

function isStaleGatewayRun(
  session: ChatSession,
  runId: string | undefined,
  runServerSequence: number | undefined,
): boolean {
  if (runServerSequence !== undefined) {
    if (session.chatRunServerSequence !== undefined) {
      return session.chatRunServerSequence !== runServerSequence;
    }
    if (session.completedChatRunServerSequence !== undefined) {
      return runServerSequence <= session.completedChatRunServerSequence;
    }
  }
  if (runId === undefined) return false;
  return session.chatRunId !== undefined && session.chatRunId !== runId;
}

function gatewayRunServerSequence(payload: Record<string, unknown>, runId: string | undefined): number | undefined {
  return finitePositiveSequence(payload.runSequence)
    ?? finitePositiveSequence(payload.run_sequence)
    ?? sequenceFromOpaqueId(runId, "run");
}

function activeAgentMessageId(session: ChatSession, sourceMessageId?: string): string | undefined {
  const messageId = session.streamingMessageId;
  const activeSourceMessageId = session.streamingSourceMessageId ?? session.chatRunSourceMessageId;
  if (messageId && session.messages.some((message) => (
    message.id === messageId
    && message.from === "agent"
    && message.status === "streaming"
  )) && (
    sourceMessageId === undefined
    || activeSourceMessageId === sourceMessageId
    || activeSourceMessageId === undefined
  )) return messageId;
  if (!sourceMessageId) return undefined;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index]!;
    if (message.from !== "agent" || message.status !== "streaming") continue;
    if (messageIdMatchesSource(message.id, sourceMessageId)) return message.id;
  }
  return undefined;
}

function hasConflictingActiveAgentSource(session: ChatSession, sourceMessageId: string | undefined): boolean {
  const activeSourceMessageId = session.streamingSourceMessageId ?? session.chatRunSourceMessageId;
  if (sourceMessageId === undefined || activeSourceMessageId === undefined
    || activeSourceMessageId === sourceMessageId) return false;
  const messageId = session.streamingMessageId;
  return session.chatRunStarted === true || (messageId !== undefined && session.messages.some((message) => (
    message.id === messageId
    && message.from === "agent"
    && message.status === "streaming"
  )));
}

function uniqueTranscriptMessageId(messages: ChatSession["messages"], preferredId: string): string {
  const used = new Set(messages.map(({ id }) => id));
  if (!used.has(preferredId)) return preferredId;
  for (let occurrence = 2; occurrence <= messages.length + 1; occurrence += 1) {
    const candidate = `${preferredId}#${occurrence}`;
    if (!used.has(candidate)) return candidate;
  }
  // The bounded loop above must always find a free id (there are at most
  // messages.length occupied suffixes), but retain a safe append-only fallback.
  return `${preferredId}#${messages.length + 2}`;
}

function appendUniqueId(ids: string[] | undefined, id: string): string[] {
  return ids?.includes(id) ? ids : [...(ids ?? []), id];
}

function messageIdMatchesSource(messageId: string, sourceMessageId: string): boolean {
  return messageId === sourceMessageId || messageId.startsWith(`${sourceMessageId}#`);
}

function hasCompletedAgentMessage(session: ChatSession, sourceMessageId: string | undefined, visibleText: string): boolean {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index]!;
    if (message.from !== "agent" || message.status !== "complete") continue;
    if (sourceMessageId !== undefined && !messageIdMatchesSource(message.id, sourceMessageId)) continue;
    return message.body.trim() === visibleText.trim();
  }
  return false;
}

function findToolBinding(
  bindings: ChatSession["toolMessageBindings"],
  runSequence: number,
  sourceId: string,
): NonNullable<ChatSession["toolMessageBindings"]>[number] | undefined {
  if (!bindings) return undefined;
  for (let index = bindings.length - 1; index >= 0; index -= 1) {
    if (bindings[index]!.runSequence === runSequence && bindings[index]!.sourceId === sourceId) return bindings[index];
  }
  return undefined;
}

function bindToolMessage(
  bindings: ChatSession["toolMessageBindings"],
  runSequence: number,
  sourceId: string,
  messageId: string,
): NonNullable<ChatSession["toolMessageBindings"]> {
  return [...(bindings ?? []), {
    runSequence,
    sourceId,
    messageId,
  }].slice(-128);
}

function withTranscriptChange(
  session: ChatSession,
  change: TranscriptChange,
  onTranscriptLimit: ((reason: Extract<TranscriptChange, { status: "resync-required" }>["reason"]) => void) | undefined,
  next: ChatSession,
): ChatSession {
  if (change.status === "resync-required") {
    onTranscriptLimit?.(change.reason);
    return session;
  }
  return { ...next, messages: change.messages, historyPartial: next.historyPartial === true || change.windowed };
}

function withPendingInteraction(session: ChatSession, interaction: ChatPendingInteraction): ChatSession {
  const current = session.pendingInteraction;
  const pendingInteraction = current?.id === interaction.id
    ? { ...interaction, submitting: current.submitting, error: current.error }
    : interaction;
  return { ...session, status: "waiting", pendingInteraction };
}
