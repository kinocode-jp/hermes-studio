import type { ChatSession, WorkTask } from "./domain";
import { t } from "./i18n";
import { isChatPromptWithinBudget } from "@hermes-studio/protocol";

/** Soft cap for the auto seed prompt (user message). */
export const CARD_SEED_MAX_CHARS = 6_000;
const BODY_MAX_CHARS = 3_500;

export type CardAskSeedInput = {
  id: string;
  title: string;
  status: string;
  assigneeId: string;
  body?: string | undefined;
  latestSummary?: string | undefined;
};

/**
 * Build the one-shot user prompt that introduces a Kanban card to the assignee chat.
 * Pure: safe for unit tests without store side effects.
 */
export function buildCardAskSeedPrompt(task: CardAskSeedInput): string {
  const cardBody = (task.body?.trim() || task.latestSummary?.trim() || t("kanban.askSeed.emptyBody"));
  const truncatedBody = cardBody.length > BODY_MAX_CHARS
    ? `${cardBody.slice(0, BODY_MAX_CHARS)}…`
    : cardBody;
  const text = t("kanban.askSeed.prompt", {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assigneeId,
    body: truncatedBody,
  });
  if (text.length <= CARD_SEED_MAX_CHARS) return text;
  return `${text.slice(0, CARD_SEED_MAX_CHARS - 1)}…`;
}

/** Add one-shot card context and validate the exact prompt sent over chat RPC. */
export function buildCardSeededUserPrompt(
  cardContext: string,
  userPrompt: string,
): string | { error: "payload-too-large" } {
  const outbound = `${cardContext}

--- ${t("kanban.askSeed.userQuestion")} ---
${userPrompt}`;
  return isChatPromptWithinBudget(outbound) ? outbound : { error: "payload-too-large" };
}

export function findCardAskSession(
  allSessions: readonly ChatSession[],
  cardId: string,
  assigneeId: string,
): ChatSession | undefined {
  return allSessions.find(
    (session) => session.sourceCardId === cardId && session.profileId === assigneeId,
  );
}

export function sessionNeedsCardSeed(session: ChatSession): boolean {
  return Boolean(session.sourceCardId)
    && session.sourceCardSeeded !== true
    // Local slash output is a tool message but is not a user-authored turn and
    // must not consume the card context before the first real question.
    && !session.messages.some((message) => message.from === "user" || message.from === "agent");
}

export function cardAskSeedInputFromTask(task: WorkTask & { assigneeId: string }): CardAskSeedInput {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assigneeId: task.assigneeId,
    ...(task.body !== undefined ? { body: task.body } : {}),
    ...(task.latestSummary !== undefined ? { latestSummary: task.latestSummary } : {}),
  };
}
