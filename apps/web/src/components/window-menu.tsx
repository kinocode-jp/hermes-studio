import { useEffect, useRef, useState } from "preact/hooks";
import { activeSurface, navigateToSurface } from "../store";
import { t } from "../i18n";
import { officeWindowOpen, setOfficeWindowOpen } from "../office-window";
import { MenuIcon } from "./icons";

export function WindowMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [open]);

  const showOffice = () => {
    setOfficeWindowOpen(true);
    navigateToSurface("office");
    setOpen(false);
  };

  return (
    <div class="window-menu" ref={root}>
      <button
        class={`quiet-button window-menu-trigger ${open ? "is-open" : ""}`}
        type="button"
        aria-label={t("app.windows")}
        title={t("app.windows")}
        aria-expanded={open}
        aria-controls="window-menu-panel"
        onClick={() => setOpen((current) => !current)}
      ><MenuIcon width={18} height={18} /></button>
      {open && (
        <div id="window-menu-panel" class="window-menu-panel" role="menu" aria-label={t("app.windows")}>
          <p>{t("app.windowsKicker")}</p>
          <button type="button" role="menuitem" class={activeSurface.value === "office" && officeWindowOpen.value ? "is-active" : ""} onClick={showOffice}>
            <span aria-hidden="true">{officeWindowOpen.value ? "✓" : "＋"}</span>
            {officeWindowOpen.value ? t("app.officeOpen") : t("app.addOffice")}
          </button>
          {officeWindowOpen.value && (
            <button type="button" role="menuitem" onClick={() => { setOfficeWindowOpen(false); setOpen(false); }}>
              <span aria-hidden="true">×</span>{t("app.removeOffice")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
