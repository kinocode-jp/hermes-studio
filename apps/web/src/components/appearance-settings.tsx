import { useEffect, useRef, useState } from "preact/hooks";
import {
  activeFontScale,
  activeTheme,
  fontScales,
  richLinkPreviewsEnabled,
  setFontScale,
  setRichLinkPreviewsEnabled,
  setTheme,
  themes,
  type Theme,
} from "../appearance";
import { t, type TranslationKey } from "../i18n";
import { InfoTip } from "./info-tip";
import { canRestoreModalFocus, hasOpenModal, isTopmostModal, registerModal } from "../modal-layer";
import { resetWorkspaceLayout, setWorkspacePlacement, workspacePlacement, workspacePlacements, type WorkspacePlacement } from "../workspace-layout";

const themeDetailKeys: Record<Theme, TranslationKey> = {
  paper: "appearance.theme.paper",
  mint: "appearance.theme.mint",
  midnight: "appearance.theme.midnight",
};

const themeNames: Record<Theme, string> = {
  paper: "Paper",
  mint: "Mint",
  midnight: "Midnight",
};

export function AppearanceSettings() {
  const [open, setOpen] = useState(false);
  const [layoutAnnouncement, setLayoutAnnouncement] = useState("");
  const panel = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const restoreFocusTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(restoreFocusTimer.current);
    restoreFocusTimer.current = undefined;
    if (!open) return;
    const unregister = panel.current ? registerModal(panel.current) : undefined;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostModal(panel.current)) return;
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
      if (event.key !== "Tab") return;
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])') ?? [])];
      if (controls.length === 0) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      unregister?.();
      window.removeEventListener("keydown", onKeyDown);
      const restoreFocus = previousFocus.current;
      restoreFocusTimer.current = window.setTimeout(() => {
        restoreFocusTimer.current = undefined;
        if (canRestoreModalFocus(restoreFocus)) restoreFocus?.focus();
      }, 0);
    };
  }, [open]);

  return (
    <div class="appearance-control">
      <button
        class={`appearance-trigger ${open ? "is-open" : ""}`}
        type="button"
        aria-label={t("appearance.trigger")}
        title={t("appearance.trigger")}
        aria-expanded={open}
        aria-controls="appearance-panel"
        onClick={() => setOpen((current) => current ? false : hasOpenModal() ? false : true)}
      >
        <span aria-hidden="true">Aa</span>
      </button>

      {open && (
        <>
          <button class="appearance-scrim" data-modal-affordance="true" type="button" aria-label={t("common.close")} onPointerDown={() => setOpen(false)} onClick={() => setOpen(false)} />
          <aside ref={panel} id="appearance-panel" class="appearance-panel" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
            <header>
              <div>
                <p>{t("appearance.kicker")}</p>
                <h2 id="appearance-title">{t("appearance.title")} <span>/ {t("appearance.titleAlt")}</span></h2>
              </div>
              <button type="button" aria-label={t("common.close")} onPointerDown={() => setOpen(false)} onClick={() => setOpen(false)}>×</button>
            </header>

            <section aria-labelledby="theme-heading">
              <div class="appearance-section-title">
                <h3 id="theme-heading">{t("appearance.theme")}</h3>
                <small>{activeTheme.value}</small>
              </div>
              <div class="theme-choices">
                {themes.map((theme) => (
                  <button
                    key={theme}
                    class={`theme-choice theme-choice--${theme} ${activeTheme.value === theme ? "is-active" : ""}`}
                    type="button"
                    aria-pressed={activeTheme.value === theme}
                    onClick={() => setTheme(theme)}
                  >
                    <i aria-hidden="true"><span /><span /><span /></i>
                    <b>{themeNames[theme]}</b>
                    <small>{t(themeDetailKeys[theme])}</small>
                  </button>
                ))}
              </div>
            </section>

            <section aria-labelledby="font-heading">
              <div class="appearance-section-title">
                <div class="heading-info-group">
                  <h3 id="font-heading">{t("appearance.textSize")}</h3>
                  <InfoTip text={t("appearance.hint")} align="start" />
                </div>
                <output>{Math.round(activeFontScale.value * 100)}%</output>
              </div>
              <div class="font-size-choices" role="group" aria-label={t("appearance.textSize")}>
                {fontScales.map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    class={activeFontScale.value === scale ? "is-active" : ""}
                    aria-pressed={activeFontScale.value === scale}
                    onClick={() => setFontScale(scale)}
                  >
                    <span style={{ fontSize: `${scale}em` }}>A</span>
                    <small>{Math.round(scale * 100)}%</small>
                  </button>
                ))}
              </div>
            </section>

            <section aria-labelledby="layout-heading">
              <div class="appearance-section-title">
                <h3 id="layout-heading">{t("appearance.layout")}</h3>
                <small>{placementLabel(workspacePlacement.value)}</small>
              </div>
              <div class="layout-placement-choices" role="group" aria-label={t("appearance.layout")}>
                {workspacePlacements.map((placement) => (
                  <button
                    key={placement}
                    type="button"
                    class={workspacePlacement.value === placement ? "is-active" : ""}
                    aria-pressed={workspacePlacement.value === placement}
                    aria-label={placementLabel(placement)}
                    title={placementLabel(placement)}
                    onClick={() => { setLayoutAnnouncement(""); setWorkspacePlacement(placement); }}
                  ><span aria-hidden="true">{placementGlyph(placement)}</span></button>
                ))}
              </div>
              <button
                class="appearance-reset-layout"
                type="button"
                onClick={() => { resetWorkspaceLayout(); setLayoutAnnouncement(t("appearance.resetDone")); }}
              >{t("appearance.reset")}</button>
              <p class="visually-hidden" aria-live="polite" aria-atomic="true">{layoutAnnouncement}</p>
            </section>

            <section aria-labelledby="link-preview-heading">
              <div class="appearance-section-title">
                <div class="heading-info-group">
                  <h3 id="link-preview-heading">{t("appearance.linkPreviews")}</h3>
                  <InfoTip text={t("appearance.linkPreviewsDetail")} align="start" />
                </div>
                <small>{richLinkPreviewsEnabled.value ? t("common.on") : t("common.off")}</small>
              </div>
              <label class="appearance-toggle-row">
                <span>
                  <b>{t("appearance.linkPreviews")}</b>
                  <small>{t("appearance.linkPreviewsSites")}</small>
                </span>
                <input
                  type="checkbox"
                  checked={richLinkPreviewsEnabled.value}
                  onChange={(event) => setRichLinkPreviewsEnabled(event.currentTarget.checked)}
                />
              </label>
            </section>
          </aside>
        </>
      )}
    </div>
  );
}

function placementLabel(placement: WorkspacePlacement): string {
  const keys: Record<WorkspacePlacement, TranslationKey> = {
    top: "appearance.placement.top",
    right: "appearance.placement.right",
    bottom: "appearance.placement.bottom",
    left: "appearance.placement.left",
  };
  return t(keys[placement]);
}

function placementGlyph(placement: WorkspacePlacement): string {
  return placement === "top" ? "▔" : placement === "right" ? "▕" : placement === "bottom" ? "▁" : "▏";
}
