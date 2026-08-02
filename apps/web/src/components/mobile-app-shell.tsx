import { useEffect, useMemo, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { locale, localizeRuntimeMessage, setLocale, t } from "../i18n";
import type { ProfileProject } from "../settings-api";
import { loadProfileProjects } from "../settings-api";
import { profileDisplayName } from "../profile-names";
import {
  activeSessionId,
  closeSession,
  createSession,
  officeConnection,
  openProfileSettingsModal,
  openSettingsModal,
  profileList,
  mobileWorkspaceOpen,
  sessions,
} from "../store";
import { profileProjectsRevision } from "../profile-project-revision";
import { AppearanceSettings } from "./appearance-settings";
import { ChatPane } from "./chat-pane";
import {
  BoardIcon,
  ChatIcon,
  FolderIcon,
  GroupIcon,
  HomeIcon,
  MenuIcon,
  PlusIcon,
  ScheduleIcon,
  SettingsIcon,
  UsersIcon,
} from "./icons";
import { KanbanBoard } from "./kanban-board";
import { OfficeScene } from "./office-scene";
import { ProfileChatModal } from "./profile-chat-modal";
import { ProfilesPanel } from "./profiles-panel";
import { ProfileSettingsModal } from "./profile-settings-modal";
import { ScheduledSessionsPanel } from "./scheduled-sessions-panel";
import { SettingsModal } from "./settings-modal";
import { TeamsPanel } from "./teams-panel";

type MobilePrimaryPage = "chat" | "kanban" | "profiles" | "projects" | "more";
type MobileMorePage = "menu" | "studio" | "teams" | "scheduled";

type ProjectRow = {
  profileId: string;
  profileName: string;
  project: ProfileProject;
  active: boolean;
};

const primaryTabs: Array<{
  id: MobilePrimaryPage;
  label: string;
  icon: typeof ChatIcon;
}> = [
  { id: "chat", label: "新規会話", icon: ChatIcon },
  { id: "kanban", label: "カンバン", icon: BoardIcon },
  { id: "profiles", label: "プロフィール", icon: GroupIcon },
  { id: "projects", label: "プロジェクト", icon: FolderIcon },
  { id: "more", label: "その他", icon: MenuIcon },
];

export function MobileAppShell() {
  const [page, setPage] = useState<MobilePrimaryPage>("chat");
  const [morePage, setMorePage] = useState<MobileMorePage>("menu");
  const [chatNote, setChatNote] = useState("");
  const connection = officeConnection.value;
  const workspaceRequested = mobileWorkspaceOpen.value;
  const activeSession = sessions.value.find((session) => session.id === activeSessionId.value);
  const activeProfile = activeSession
    ? profileList.value.find((profile) => profile.id === activeSession.profileId)
    : undefined;
  const pageTitle = page === "chat" ? "会話"
    : page === "kanban" ? "カンバン"
      : page === "profiles" ? "プロフィール"
        : page === "projects" ? "プロジェクト"
          : morePage === "studio" ? "スタジオ"
            : morePage === "teams" ? "チーム"
              : morePage === "scheduled" ? "スケジュール"
                : "その他";

  useEffect(() => {
    if (workspaceRequested && activeSessionId.value) setPage("chat");
  }, [workspaceRequested, activeSessionId.value]);

  const startDefaultChat = () => {
    setPage("chat");
    setMorePage("menu");
    const profile = profileList.value.find((item) => item.id === "default");
    if (!profile) {
      setChatNote("デフォルトプロファイルを読み込めませんでした。");
      return;
    }
    const sessionId = createSession(profile.id);
    setChatNote(sessionId ? "" : "新しい会話を開始できませんでした。接続状態を確認してください。");
  };

  const activateTab = (tab: MobilePrimaryPage) => {
    if (tab === "chat") {
      startDefaultChat();
      return;
    }
    setPage(tab);
    if (tab === "more") setMorePage("menu");
  };

  return (
    <div class="app-shell mobile-app-shell">
      <header class="mobile-app-header">
        <div class="mobile-app-heading">
          <img src="/hermes-studio-icon.png" alt="" aria-hidden="true" />
          <div>
            <small>Hermes</small>
            <h1>{pageTitle}</h1>
          </div>
        </div>
        <span
          class={`mobile-connection-state runtime-${connection.state}`}
          role="status"
          aria-label={localizeRuntimeMessage(connection.message)}
          title={localizeRuntimeMessage(connection.message)}
        ><i aria-hidden="true" /></span>
      </header>

      <main class={`mobile-page-stage mobile-page-stage--${page}`}>
        {page === "chat" && (
          activeSession && activeProfile
            ? <ChatPane session={activeSession} profile={activeProfile} onClosePane={() => closeSession(activeSession.id)} />
            : (
              <MobileEmptyState icon={<ChatIcon />} title="新しい会話を始める">
                <p>デフォルトプロファイルとの会話を開きます。</p>
                {chatNote && <p class="mobile-page-error" role="alert">{chatNote}</p>}
                <button type="button" class="primary-button" onClick={startDefaultChat}>
                  <PlusIcon />
                  <span>新規会話</span>
                </button>
              </MobileEmptyState>
            )
        )}
        {page === "kanban" && <KanbanBoard />}
        {page === "profiles" && <ProfilesPanel />}
        {page === "projects" && <MobileProjectsPage />}
        {page === "more" && (
          <MobileMoreArea page={morePage} onPageChange={setMorePage} />
        )}
      </main>

      <nav class="mobile-bottom-tabs" aria-label="スマートフォン用メインメニュー">
        {primaryTabs.map((tab) => {
          const selected = page === tab.id;
          const TabIcon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              class={selected ? "is-active" : ""}
              aria-label={tab.label}
              title={tab.label}
              aria-current={selected ? "page" : undefined}
              onClick={() => activateTab(tab.id)}
            >
              <span class="mobile-tab-icon" aria-hidden="true">
                <TabIcon />
                {tab.id === "chat" && <PlusIcon class="mobile-tab-plus" />}
              </span>
            </button>
          );
        })}
      </nav>
      <ProfileSettingsModal />
      <SettingsModal />
      <ProfileChatModal />
    </div>
  );
}

function MobileMoreArea({ page, onPageChange }: {
  page: MobileMorePage;
  onPageChange: (page: MobileMorePage) => void;
}) {
  if (page === "studio") return <OfficeScene profiles={profileList.value} />;
  if (page === "teams") return <TeamsPanel />;
  if (page === "scheduled") return <ScheduledSessionsPanel />;

  const items: Array<{
    id: Exclude<MobileMorePage, "menu"> | "settings";
    label: string;
    detail: string;
    icon: typeof HomeIcon;
  }> = [
    { id: "studio", label: "スタジオ", detail: "プロファイルの稼働状況", icon: HomeIcon },
    { id: "teams", label: "チーム", detail: "チームと共有設定", icon: UsersIcon },
    { id: "scheduled", label: "スケジュール", detail: "定期実行と履歴", icon: ScheduleIcon },
    { id: "settings", label: "設定", detail: "Hermes Studioの設定", icon: SettingsIcon },
  ];

  return (
    <section class="mobile-more-page" aria-label="その他のメニュー">
      <div class="mobile-menu-list">
        {items.map((item) => {
          const ItemIcon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === "settings") openSettingsModal();
                else onPageChange(item.id);
              }}
            >
              <span aria-hidden="true"><ItemIcon /></span>
              <b>{item.label}</b>
              <small>{item.detail}</small>
            </button>
          );
        })}
      </div>
      <div class="mobile-menu-utilities">
        <AppearanceSettings />
        <button
          type="button"
          class="quiet-button"
          onClick={() => setLocale(locale.value === "ja" ? "en" : "ja")}
        >
          {locale.value === "ja" ? "English" : "日本語"}
        </button>
      </div>
    </section>
  );
}

function MobileProjectsPage() {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const profiles = profileList.value;
  const profileKey = profiles.map((profile) => profile.id).join("|");
  const revision = profileProjectsRevision.value;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void Promise.all(profiles.map(async (profile) => {
      try {
        const result = await loadProfileProjects(profile.id);
        return result.projects.map((project) => ({
          profileId: profile.id,
          profileName: profileDisplayName(profile),
          project,
          active: result.activeId === project.id,
        } satisfies ProjectRow));
      } catch {
        if (!cancelled) setFailed(true);
        return [];
      }
    })).then((groups) => {
      if (cancelled) return;
      setRows(groups.flat().sort((left, right) =>
        Number(right.active) - Number(left.active)
        || (left.project.archived === right.project.archived
          ? left.project.name.localeCompare(right.project.name)
          : Number(left.project.archived) - Number(right.project.archived))
      ));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [profileKey, revision]);

  const visibleRows = useMemo(() => rows.filter((row) => !row.project.archived), [rows]);

  return (
    <section class="mobile-projects-page" aria-label="プロジェクト">
      <div class="mobile-projects-toolbar">
        <p>プロファイルごとに紐づいたプロジェクトです。</p>
        <button
          type="button"
          class="primary-button"
          disabled={profiles.length === 0}
          onClick={() => openProfileSettingsModal(profiles.find((profile) => profile.id === "default")?.id ?? profiles[0]!.id, "project")}
        >管理</button>
      </div>
      {loading && <p class="mobile-page-note">{t("settings.projects.loading")}</p>}
      {failed && <p class="mobile-page-error" role="alert">{t("sidebar.projectsLoadFailed")}</p>}
      {!loading && visibleRows.length === 0 && <p class="mobile-page-note">{t("settings.projects.empty")}</p>}
      <div class="mobile-project-list">
        {visibleRows.map((row) => (
          <button
            key={`${row.profileId}:${row.project.id}`}
            type="button"
            class={row.active ? "is-active" : ""}
            onClick={() => openProfileSettingsModal(row.profileId, "project")}
          >
            <span class="mobile-project-mark" style={row.project.color ? { "--project-color": row.project.color } : undefined} aria-hidden="true">
              {row.project.icon || <FolderIcon />}
            </span>
            <span class="mobile-project-copy">
              <b>{row.project.name}</b>
              <small>{row.profileName} · {row.project.folders.length}フォルダ</small>
            </span>
            {row.active && <em>使用中</em>}
          </button>
        ))}
      </div>
    </section>
  );
}

function MobileEmptyState({ icon, title, children }: {
  icon: ComponentChildren;
  title: string;
  children: ComponentChildren;
}) {
  return (
    <section class="mobile-empty-state">
      <span aria-hidden="true">{icon}</span>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
