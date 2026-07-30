import { useEffect, useMemo } from "preact/hooks";
import {
  activeSurface,
  closeSettingsModal,
  selectedProfile,
  settingsModalOpen,
  settingsTab,
} from "../store";
import { t } from "../i18n";
import type { SettingsTab } from "../domain";
import { appModalSizes, createModalResizeHandlers, getAppModalSize, shouldIgnoreModalOutsideClose } from "../app-modal-layout";
import { LiveSettings } from "./live-settings";
import { useMobileOverlay } from "./use-mobile-overlay";
import { useModalOutsideClose } from "./use-modal-outside-close";
import { CloseIcon } from "./icons";
import { persistUiNavPreferences } from "../ui-nav-prefs";

export function SettingsModal() {
  const open = settingsModalOpen.value;
  const tab = settingsTab.value === "host" ? "host" : "global";
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open,
    onClose: closeSettingsModal,
    viewport: "(min-width: 0px)",
  });
  const _sizes = appModalSizes.value;
  const modalSize = getAppModalSize("app-settings");
  const resize = useMemo(() => createModalResizeHandlers("app-settings"), []);
  useEffect(() => () => resize.dispose(), [resize]);
  const outsideClose = useModalOutsideClose(closeSettingsModal);
  if (!open) return null;

  const setTab = (next: SettingsTab) => {
    const resolved = next === "host" ? "host" : "global";
    settingsTab.value = resolved;
    persistUiNavPreferences({
      surface: activeSurface.value,
      settingsTab: resolved,
      selectedProfileId: selectedProfile.value?.id ?? "",
    });
  };

  return (
    <div
      class="profile-settings-modal-layer settings-modal-layer"
      data-modal-affordance="true"
      role="presentation"
      {...outsideClose}
    >
      <button
        class="profile-settings-modal-scrim"
        type="button"
        aria-label={t("common.close")}
        onClick={() => {
          if (!shouldIgnoreModalOutsideClose()) closeSettingsModal();
        }}
      />
      <section
        ref={overlay.ref}
        class="profile-settings-modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        aria-describedby="settings-modal-description"
        tabIndex={-1}
        style={{ width: `${modalSize.width}px`, height: `${modalSize.height}px` }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="profile-settings-modal-head settings-modal-head">
          <div class="profile-settings-modal-identity">
            <div class="profile-settings-modal-copy">
              <div class="profile-settings-modal-title-row">
                <h2 id="settings-modal-title">{t("settings.modalTitle")}</h2>
              </div>
              <p id="settings-modal-description" class="settings-modal-description">{t("settings.modalLead")}</p>
            </div>
          </div>
          <button
            type="button"
            class="profile-settings-modal-close"
            data-mobile-overlay-initial-focus
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeSettingsModal();
            }}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <CloseIcon width={18} height={18} />
          </button>
        </header>
        <div class="profile-settings-modal-body">
          <LiveSettings
            key="settings-global-host-modal"
            profileId={null}
            scope="global-host"
            initialTab={tab}
            activeTab={tab}
            showAccessAudit
            showHostAdmin
            onTabChange={setTab}
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
