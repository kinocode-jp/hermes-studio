import { DeviceLogin } from "./components/device-login";
import { AppearanceSettings } from "./components/appearance-settings";
import { ProfileCommand } from "./components/profile-command";
import { ProfileSettingsModal } from "./components/profile-settings-modal";
import { SettingsModal } from "./components/settings-modal";
import { ProfileChatModal } from "./components/profile-chat-modal";
import { DashboardView } from "./components/dashboard-view";
import { SideRail } from "./components/side-rail";
import { locale, localizeRuntimeMessage, setLocale, t } from "./i18n";
import { SettingsIcon } from "./components/icons";
import { sidebarWidth } from "./sidebar-layout";
import { officeAccess, officeConnection, openSessionIds, closeSettingsModal, openSettingsModal, retryStudioServer, settingsModalOpen, settingsTab, workspaceSessionDropPreview } from "./store";
import { activateDashboardContainingPanel } from "./dashboard-actions";

export function App() {
  if (officeAccess.value.state !== "authenticated") return <DeviceLogin />;
  const hasChats = openSessionIds.value.length > 0 || workspaceSessionDropPreview.value;
  const connection = officeConnection.value;
  const connectionLabel = connection.state === "connected"
    ? (connection.eventStream === "open" ? t("connection.live") : t("connection.connected"))
    : connection.state === "demo" ? t("connection.demo")
      : connection.state === "degraded" ? t("connection.degraded")
      : connection.state === "error" ? t("connection.error") : connection.state;
  return (
    <div
      class={`app-shell ${hasChats ? "has-open-workspace" : "is-workspace-empty"} ${workspaceSessionDropPreview.value ? "is-session-drop-preview" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth.value}px` }}
    >
      <header class="topbar" data-mobile-route-chrome>
        <a class="brand" href="#" aria-label={t("app.home")} title={t("app.home")} onClick={(event) => { event.preventDefault(); activateDashboardContainingPanel("studio"); }}>
          <img class="brand-mark" src="/hermes-studio-icon.png" alt="" aria-hidden="true" />
        </a>
        <div
          class={`runtime-status runtime-${connection.state}`}
          role="status"
          aria-label={`${connectionLabel}: ${localizeRuntimeMessage(connection.message)}`}
          title={`${connectionLabel} — ${localizeRuntimeMessage(connection.message)}`}
        >
          <i aria-hidden="true" />
        </div>
        <div class="top-actions">
          <AppearanceSettings />
          <button
            class={`icon-button settings-header-button ${settingsModalOpen.value ? "is-active" : ""}`}
            type="button"
            aria-label={t("nav.settings")}
            title={t("nav.settings")}
            aria-pressed={settingsModalOpen.value}
            onClick={() => {
              if (settingsModalOpen.value) closeSettingsModal();
              else openSettingsModal(settingsTab.value);
            }}
          >
            <SettingsIcon />
          </button>
          <button
            class="quiet-button language-button"
            type="button"
            aria-label={t("language.label")}
            title={t("language.label")}
            onClick={() => setLocale(locale.value === "ja" ? "en" : "ja")}
          >
            <span aria-hidden="true">{locale.value === "ja" ? "A" : "文"}</span>
          </button>
          <ProfileCommand />
        </div>
      </header>

      <SideRail />

      <main class="main-stage main-stage--dashboard">
        {connection.state === "error" && (
          <div class="runtime-error-banner" role="alert">
            <span>{localizeRuntimeMessage(connection.message)}</span>
            <button type="button" onClick={retryStudioServer}>{t("connection.retry")}</button>
          </div>
        )}
        <DashboardView />
      </main>
      <ProfileSettingsModal />
      <SettingsModal />
      <ProfileChatModal />
    </div>
  );
}
