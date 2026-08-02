import { computed, signal } from "@preact/signals";
import type { ChatPromptResult, ChatSessionDeleteResult, ChatSessionEnsureOptions, ChatSlashResult, ChatSteerResult, ChatTarget } from "./chat-api";
import type {
  ApprovalChoice,
  ChatConnectionState,
  ChatSession,
  InspectorTab,
  OfficeAccess,
  OfficeConnection,
  OfficeSnapshot,
  OfficeSnapshotRequestIdentity,
  Profile,
  SettingsTab,
  Surface,
} from "./domain";
import { officeMessage, type RuntimeMessage } from "./i18n";

import {
  restoredActiveSurface,
  restoredSelectedProfileId,
  restoredSettingsTab,
} from "./ui-nav-prefs";
import { isScheduledSessionHidden } from "./scheduled-sessions";

export const profileList = signal<Profile[]>([]);
export const sessions = signal<ChatSession[]>([]);
export const activeSurface = signal<Surface>(restoredActiveSurface);
export const inspectorTab = signal<InspectorTab>("chat");
export const settingsTab = signal<SettingsTab>(restoredSettingsTab);
export const selectedProfileId = signal(restoredSelectedProfileId);
export const openSessionIds = signal<string[]>([]);
export const activeSessionId = signal("");
export const mobileInspectorOpen = signal(false);
export const mobileWorkspaceOpen = signal(false);
/** True while a sidebar chat session is being dragged for workspace drop. */
export const workspaceSessionDropPreview = signal(false);
/** Preferred chat dock edge while dragging a session (top/right/bottom/left). */
export const workspaceSessionDropPlacement = signal<"top" | "right" | "bottom" | "left" | null>(null);
export const profileSettingsModalId = signal<string | null>(null);
export const profileSettingsModalTab = signal<SettingsTab>("soul");
export const settingsModalOpen = signal(false);
export const profileChatModalId = signal<string | null>(null);
export const profileChatModalPaneIds = signal<string[]>([]);
/** Most recently interacted-with conversation pane inside the profile chat modal. */
export const profileChatModalActivePaneId = signal("");
/** Chat sessions rendered inside another modal (currently Kanban task detail). */
export const embeddedChatSessionIds = signal<string[]>([]);
/** Server-default live lease bounds; visible panes are not limited by these. */
export const MAX_LIVE_CHAT_SESSIONS = 16;
export const MAX_LIVE_CHAT_SESSIONS_PER_PROFILE = 8;
export const chatSocketState = signal<{ state: ChatConnectionState; message: RuntimeMessage }>({
  state: "disconnected",
  message: officeMessage("runtime.chat.waiting")
});
export const officeSnapshot = signal<OfficeSnapshot | undefined>(undefined);
export const officeAccess = signal<OfficeAccess>({
  state: "checking",
  serverUrl: "",
  message: officeMessage("runtime.office.checking")
});
export const officeConnection = signal<OfficeConnection>({
  state: "connecting",
  source: "server",
  serverUrl: "",
  eventStream: "closed",
  message: officeMessage("runtime.office.checking")
});
export const selectedProfile = computed(() =>
  profileList.value.find((profile) => profile.id === selectedProfileId.value)
);
export const selectedProfileSessions = computed(() =>
  sessions.value.filter((session) => session.profileId === selectedProfileId.value && !isScheduledSessionHidden(session))
);

export const officeRuntimeHooks = {
  retryOfficeConnection: () => {},
  ensureChatSession: (_target: ChatTarget, _options?: ChatSessionEnsureOptions) => {},
  releaseChatSession: (_clientSessionId: string) => {},
  deleteChatSession: (async (_clientSessionId: string) => ({ status: "deleted" })) as (
    clientSessionId: string
  ) => Promise<ChatSessionDeleteResult>,
  submitChatPrompt: (async () => ({ status: "rejected", message: "Chat runtime is not registered." })) as (
    clientSessionId: string, text: string, operationId: string
  ) => Promise<ChatPromptResult> | void,
  steerChatSession: (async () => { throw new Error("Chat runtime is not registered."); }) as (
    clientSessionId: string, text: string
  ) => Promise<ChatSteerResult>,
  execSlashCommand: (async () => { throw new Error("Chat runtime is not registered."); }) as (
    clientSessionId: string, command: string, confirmExpensiveModel?: boolean
  ) => Promise<ChatSlashResult>,
  completeSlashCommand: (async () => [] as import("./chat-api").SlashCompletionItem[]) as (
    text: string
  ) => Promise<import("./chat-api").SlashCompletionItem[]>,
  interruptChatSession: ((_clientSessionId: string) => {}) as (clientSessionId: string) => Promise<void> | void,
  respondClarify: async (_clientSessionId: string, _requestId: string, _answer: string) => {},
  respondApproval: async (_clientSessionId: string, _approvalId: string, _choice: ApprovalChoice) => {},
};

export let runtimeDataSource: "none" | "demo" | "live" = "none";
export let latestOfficeSnapshotIdentity: OfficeSnapshotRequestIdentity | undefined;

export function setRuntimeDataSource(value: "none" | "demo" | "live"): void {
  runtimeDataSource = value;
}
export function setLatestOfficeSnapshotIdentity(value: OfficeSnapshotRequestIdentity | undefined): void {
  latestOfficeSnapshotIdentity = value;
}
