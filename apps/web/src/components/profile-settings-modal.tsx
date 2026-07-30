import { useEffect, useMemo, useState } from "preact/hooks";
import {
  closeProfileSettingsModal,
  profileList,
  profileSettingsModalId,
  profileSettingsModalTab,
} from "../store";
import { t } from "../i18n";
import { appModalSizes, createModalResizeHandlers, getAppModalSize, shouldIgnoreModalOutsideClose } from "../app-modal-layout";
import { CharacterPortrait } from "./character-portrait";
import { LiveSettings } from "./live-settings";
import { useMobileOverlay } from "./use-mobile-overlay";
import { useModalOutsideClose } from "./use-modal-outside-close";
import { CloseIcon } from "./icons";
import {
  profileDisplayName,
  profileStoredDisplayName,
  setProfileDisplayName,
} from "../profile-names";

export function ProfileSettingsModal() {
  const profile = profileList.value.find((item) => item.id === profileSettingsModalId.value);
  const open = profileSettingsModalId.value !== null && profile !== undefined;
  const tab = profileSettingsModalTab.value;
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open,
    onClose: closeProfileSettingsModal,
    viewport: "(min-width: 0px)",
  });

  const _sizes = appModalSizes.value;
  const modalSize = getAppModalSize("profile-settings");
  const resize = useMemo(() => createModalResizeHandlers("profile-settings"), []);
  useEffect(() => () => resize.dispose(), [resize]);
  const outsideClose = useModalOutsideClose(closeProfileSettingsModal);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  useEffect(() => {
    if (!profile) return;
    setEditingName(false);
    setNameDraft(profileStoredDisplayName(profile.id, profileDisplayName(profile)));
  }, [profile?.id]);

  if (!open || !profile) return null;
  const name = profileDisplayName(profile);

  const saveName = () => {
    setProfileDisplayName(profile.id, nameDraft);
    setEditingName(false);
  };

  return (
    <div class="profile-settings-modal-layer" data-modal-affordance="true" role="presentation" {...outsideClose}>
      <button class="profile-settings-modal-scrim" type="button" aria-label={t("common.close")} onClick={() => { if (!shouldIgnoreModalOutsideClose()) closeProfileSettingsModal(); }} />
      <section
        ref={overlay.ref}
        class="profile-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-settings-modal-title"
        tabIndex={-1}
        style={{ width: `${modalSize.width}px`, height: `${modalSize.height}px` }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="profile-settings-modal-head">
          <div class="profile-settings-modal-identity">
            <CharacterPortrait profileId={profile.id} profileName={name} class="character-portrait--modal" decorative />
            <div class="profile-settings-modal-copy">
              <span>{t("profile.settings")}</span>
              {editingName ? (
                <form
                  class="profile-settings-name-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveName();
                  }}
                >
                  <label>
                    <span class="visually-hidden">{t("profile.displayName")}</span>
                    <input
                      autoFocus
                      type="text"
                      value={nameDraft}
                      maxLength={40}
                      placeholder={profile.name}
                      onInput={(event) => setNameDraft(event.currentTarget.value)}
                    />
                  </label>
                  <div>
                    <button type="submit">{t("profile.saveName")}</button>
                    <button type="button" onClick={() => setEditingName(false)}>{t("common.cancel")}</button>
                  </div>
                </form>
              ) : (
                <div class="profile-settings-modal-title-row">
                  <h2 id="profile-settings-modal-title" title={name}>{name}</h2>
                  <button
                    type="button"
                    class="profile-name-edit"
                    title={t("profile.editName")}
                    aria-label={t("profile.editName")}
                    onClick={() => {
                      setNameDraft(profileStoredDisplayName(profile.id, name));
                      setEditingName(true);
                    }}
                  >
                    ✎
                  </button>
                </div>
              )}
              <small>{profile.id}</small>
            </div>
          </div>
          <button
            type="button"
            class="profile-settings-modal-close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeProfileSettingsModal();
            }}
            aria-label={t("common.close")}
            title={t("common.close")}
          ><CloseIcon width={18} height={18} /></button>
        </header>
        <div class="profile-settings-modal-body">
          <LiveSettings
            profileId={profile.id}
            profileLabel={name}
            scope="profile"
            initialTab={tab}
            activeTab={tab}
            onTabChange={(next) => {
              if (next === "global" || next === "host") return;
              profileSettingsModalTab.value = next;
            }}
          />
        </div>
      
        {resize.handles.map((handle) => (
          <div
            key={handle.edge}
            class={`app-modal-resize ${handle.className}`}
            role="separator"
            aria-label={t("common.resizeModal")}
            title={t("common.resizeModal")}
            onPointerDown={resize.begin(handle.edge)}
          />
        ))}
</section>
    </div>
  );
}
