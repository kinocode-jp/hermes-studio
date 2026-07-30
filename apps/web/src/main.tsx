import { render } from "preact";
import { selectedProfileId, applyChatGatewayEvent, applyChatHistory, applyOfficeSnapshot, installMobileRouteHistory, officeConnection, requireDeviceLogin, registerChatRuntime, registerKanbanRuntime, registerOfficeRetry, refreshKanbanBoard, setOfficeAccessUnavailable, setOfficeAuthenticated, setChatHistoryError, setChatHistoryLoading, setChatSessionConnecting, setChatSessionDisconnected, setChatSessionError, setChatSessionQueued, setChatSessionReady, setChatSocketState, setOfficeConnecting, setOfficeError, setOfficeEventStream } from "./store";
import { App } from "./app";
import { initializeAppearance } from "./appearance";
import { initializeDefaultDashboardChat, installDashboardWiring } from "./dashboard-actions";
import { connectChatApi } from "./chat-api";
import { createKanbanApi } from "./kanban-api";
import { connectOfficeApi } from "./office-api";
import { createTeamsApi, refreshTeams, registerTeamsRuntime } from "./teams-store";
import { isLocalOfficeClient } from "./auth-state";
import { notifyAccessAuditChanged, shouldRefreshAccessAudit } from "./audit-api";
import { initializeI18n } from "./i18n";
import { initializeInventory, registerInventorySnapshotRefresh } from "./inventory";
import { ensureSettingsPrefetch } from "./settings-prefetch";
import { synchronizeChatModelPreferences } from "./chat-model-prefs";
import "./fonts.css";
import "./styles.css";
import "./components/avatar-picker.css";
import "./components/teams-panel.css";
import "./components/profile-groups.css";
import "./appearance.css";

initializeAppearance();
initializeI18n();
installMobileRouteHistory();
installDashboardWiring();
render(<App />, document.getElementById("app")!);

let chatApi: ReturnType<typeof connectChatApi> | undefined;
let authenticatedServicesStarted = false;
let kanbanBackgroundRefreshTimer: number | undefined;
const KANBAN_BACKGROUND_REFRESH_MS = 10_000;

function refreshKanbanInBackground(): void {
  if (document.visibilityState !== "visible" || officeConnection.value.runtime !== "ready") return;
  void refreshKanbanBoard({ background: true });
}

function startAuthenticatedServices(): void {
  if (authenticatedServicesStarted) return;
  authenticatedServicesStarted = true;
  registerKanbanRuntime(createKanbanApi());
  registerTeamsRuntime(createTeamsApi());
  kanbanBackgroundRefreshTimer = window.setInterval(refreshKanbanInBackground, KANBAN_BACKGROUND_REFRESH_MS);
  document.addEventListener("visibilitychange", refreshKanbanInBackground);
  chatApi = connectChatApi({
    onSocketState: setChatSocketState,
    onHistoryLoading: setChatHistoryLoading,
    onHistory: applyChatHistory,
    onHistoryError: setChatHistoryError,
    onSessionConnecting: setChatSessionConnecting,
    onSessionQueued: setChatSessionQueued,
    onSessionReady: setChatSessionReady,
    onSessionDisconnected: setChatSessionDisconnected,
    onSessionError: setChatSessionError,
    onEvent: applyChatGatewayEvent
  });
  registerChatRuntime(chatApi);
}

const officeApi = connectOfficeApi({
  onConnecting: setOfficeConnecting,
  onSnapshot(snapshot, identity) {
    if (!applyOfficeSnapshot(snapshot, identity)) return;
    initializeInventory(snapshot, identity);
    setOfficeAuthenticated(identity.serverUrl);
    startAuthenticatedServices();
    // Do not create the first chat from a stale per-origin local cache. The
    // desktop and Tailnet clients first reconcile through the host-owned copy.
    void synchronizeChatModelPreferences({ migrateLocal: isLocalOfficeClient(location) })
      .then(
        () => initializeDefaultDashboardChat(),
        () => initializeDefaultDashboardChat(),
      );
    if (snapshot.capabilities.runtime.state === "ready") {
      void refreshKanbanBoard();
      void refreshTeams({ acknowledgeErrors: true });
      ensureSettingsPrefetch(selectedProfileId.value || snapshot.profiles[0]?.id || null);
    } else if (!snapshot.capabilities.features.includes("demo")) {
      void refreshTeams({ acknowledgeErrors: true });
    }
  },
  onEventStream: setOfficeEventStream,
  onAuthRequired: requireDeviceLogin,
  onRecoveryUnavailable: (message, serverUrl) => setOfficeError(message, serverUrl, true),
  onError(message, serverUrl) {
    setOfficeError(message, serverUrl);
    if (isLocalOfficeClient(location)) setOfficeAuthenticated(serverUrl);
    // Keep the concrete server/client error when present so snapshot/auth
    // incompatibilities are not remapped to a generic network outage.
    else setOfficeAccessUnavailable(serverUrl, message.trim() || "Studio Serverへ接続できませんでした。ネットワークを確認してください。");
  },
  onEvent(event) {
    if (event.topic === "kanban.changed" || event.topic === "resync.required") void refreshKanbanBoard({ background: true });
    if (event.topic === "access.changed" && shouldRefreshAccessAudit(event.payload)) notifyAccessAuditChanged();
    if (event.topic === "profile.changed"
      && typeof event.payload === "object"
      && event.payload !== null
      && "kind" in event.payload
      && event.payload.kind === "chat-model-preferences") {
      void synchronizeChatModelPreferences().catch(() => undefined);
    }
  }
});
registerOfficeRetry(() => {
  officeApi.retry();
  chatApi?.retry();
});
registerInventorySnapshotRefresh((expected) => officeApi.refresh(expected));

window.addEventListener("beforeunload", () => {
  if (kanbanBackgroundRefreshTimer !== undefined) window.clearInterval(kanbanBackgroundRefreshTimer);
  document.removeEventListener("visibilitychange", refreshKanbanInBackground);
  chatApi?.stop();
  officeApi.stop();
}, { once: true });
