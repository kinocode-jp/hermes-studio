import { useMemo, useState } from "preact/hooks";
import { t } from "../i18n";
import { profileDisplayName, profileSecondaryName } from "../profile-names";
import { createHermesProfile, deleteHermesProfile, isValidProfileName, ProfileCreateCommitUnconfirmedError } from "../profiles-api";
import { requestInventorySnapshotRefresh } from "../inventory";
import { invalidateSettingsPrefetch } from "../settings-prefetch";
import { officeConnection, openProfileSettingsModal, profileList, selectProfile } from "../store";
import { createProfileSession } from "./profile-panel";
import { CharacterPortrait } from "./character-portrait";
import { ChatIcon, SettingsIcon, TrashIcon } from "./icons";
import { StatusPill } from "./status-pill";

export function ProfilesPanel() {
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = officeConnection.value.source === "server" && officeConnection.value.runtime === "ready";

  const profiles = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = profileList.value;
    if (!needle) return list;
    return list.filter((profile) =>
      profile.id.toLowerCase().includes(needle)
      || profileDisplayName(profile).toLowerCase().includes(needle)
      || profileSecondaryName(profile).toLowerCase().includes(needle));
  }, [query, profileList.value]);

  const submitCreate = async (event: Event) => {
    event.preventDefault();
    const name = draftName.trim();
    if (busy) return;
    if (!isValidProfileName(name)) {
      setError(t("profilesPanel.nameInvalid"));
      return;
    }
    if (profileList.value.some((profile) => profile.id === name)) {
      setError(t("profilesPanel.nameTaken"));
      return;
    }
    setBusy("create");
    setError(null);
    try {
      await createHermesProfile(name);
      invalidateSettingsPrefetch(name);
      setDraftName("");
      setCreateOpen(false);
      await requestInventorySnapshotRefresh();
    } catch (error) {
      if (error instanceof ProfileCreateCommitUnconfirmedError) {
        invalidateSettingsPrefetch(name);
        await requestInventorySnapshotRefresh();
        if (profileList.value.some((profile) => profile.id === name)) {
          setDraftName("");
          setCreateOpen(false);
        } else {
          setError(t("profilesPanel.createFailed"));
        }
      } else {
        setError(t("profilesPanel.createFailed"));
      }
    } finally {
      setBusy(null);
    }
  };

  const removeProfile = async (profileId: string) => {
    if (busy) return;
    if (!window.confirm(t("profilesPanel.deleteConfirm", { name: profileId }))) return;
    setBusy(profileId);
    setError(null);
    try {
      await deleteHermesProfile(profileId);
      invalidateSettingsPrefetch(profileId);
      await requestInventorySnapshotRefresh();
    } catch {
      setError(t("profilesPanel.deleteFailed", { name: profileId }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section class="profiles-panel" aria-label={t("dashboard.panel.profiles")}>
      <header class="profiles-panel-toolbar">
        <input
          type="search"
          class="profiles-panel-search"
          placeholder={t("profilesPanel.search")}
          aria-label={t("profilesPanel.search")}
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button
          type="button"
          class="primary-button profiles-panel-add"
          disabled={!live || busy !== null}
          title={live ? t("profilesPanel.add") : t("profilesPanel.liveOnly")}
          aria-label={t("profilesPanel.add")}
          aria-expanded={createOpen}
          onClick={() => { setCreateOpen((current) => !current); setError(null); }}
        >＋</button>
      </header>
      {createOpen && (
        <form class="profiles-panel-create" onSubmit={(event) => void submitCreate(event)}>
          <input
            value={draftName}
            placeholder={t("profilesPanel.namePlaceholder")}
            aria-label={t("profilesPanel.nameLabel")}
            maxLength={64}
            disabled={busy !== null}
            onInput={(event) => setDraftName(event.currentTarget.value)}
          />
          <button type="submit" class="primary-button" disabled={busy !== null || draftName.trim().length === 0}>
            {busy === "create" ? t("profilesPanel.creating") : t("profilesPanel.create")}
          </button>
        </form>
      )}
      {error && <p class="profiles-panel-error" role="alert">{error}</p>}
      <div class="profiles-panel-list" role="list">
        {profiles.length === 0 && <p class="profiles-panel-empty">{t("profilesPanel.empty")}</p>}
        {profiles.map((profile) => {
          const displayName = profileDisplayName(profile);
          const secondaryName = profileSecondaryName(profile);
          return (
            <div class="profiles-panel-row" role="listitem" key={profile.id}>
              <button
                type="button"
                class="profiles-panel-main"
                title={t("profilesPanel.openChat", { name: displayName })}
                onClick={() => {
                  selectProfile(profile.id, { openDetail: false });
                  createProfileSession(profile.id);
                }}
              >
                <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--sidebar" decorative />
                <span class="profiles-panel-copy">
                  <b>{displayName}</b>
                  <small>{secondaryName || profile.id}</small>
                </span>
                <span class="profiles-panel-meta">
                  {profile.taskCount > 0 && <small>{t("profilesPanel.taskCount", { count: profile.taskCount })}</small>}
                  <StatusPill status={profile.status} />
                </span>
              </button>
              <button
                type="button"
                class="icon-button"
                aria-label={t("profilesPanel.openChat", { name: displayName })}
                title={t("profilesPanel.openChat", { name: displayName })}
                onClick={() => {
                  selectProfile(profile.id, { openDetail: false });
                  createProfileSession(profile.id);
                }}
              ><ChatIcon width={15} height={15} /></button>
              <button
                type="button"
                class="icon-button"
                aria-label={t("profilesPanel.settings", { name: displayName })}
                title={t("profilesPanel.settings", { name: displayName })}
                onClick={() => openProfileSettingsModal(profile.id)}
              ><SettingsIcon width={15} height={15} /></button>
              <button
                type="button"
                class="icon-button profiles-panel-delete"
                disabled={!live || busy !== null || profile.id === "default"}
                aria-label={t("profilesPanel.delete", { name: displayName })}
                title={profile.id === "default" ? t("profilesPanel.defaultUndeletable") : t("profilesPanel.delete", { name: displayName })}
                onClick={() => void removeProfile(profile.id)}
              ><TrashIcon width={15} height={15} /></button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
