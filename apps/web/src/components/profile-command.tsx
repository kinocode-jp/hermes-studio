import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { profileList, selectProfile } from "../store";
import { CharacterPortrait } from "./character-portrait";
import { StatusPill } from "./status-pill";
import { canRestoreModalFocus, hasOpenModal, isTopmostModal, registerModal } from "../modal-layer";
import { profileDisplayName, profileSecondaryName } from "../profile-names";

export function ProfileCommand() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return profileList.value;
    return profileList.value.filter((profile) => `${profileDisplayName(profile)} ${profile.name}`.toLocaleLowerCase().includes(normalized));
  }, [query, profileList.value]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        if (!open && hasOpenModal()) return;
        setOpen((current) => {
          if (!current) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          return !current;
        });
      } else if (event.key === "Escape" && open && isTopmostModal(dialog.current)) {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const unregister = dialog.current ? registerModal(dialog.current) : undefined;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => input.current?.focus());
    return () => { unregister?.(); if (canRestoreModalFocus(previousFocus.current)) previousFocus.current?.focus(); };
  }, [open]);

  const openCommand = () => {
    if (hasOpenModal()) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  };

  const trapFocus = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !isTopmostModal(dialog.current)) return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])') ?? [])];
    if (controls.length === 0) return;
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const choose = (index: number) => {
    const profile = matches[index];
    if (!profile) return;
    selectProfile(profile.id);
    setOpen(false);
  };

  return (
    <>
      <button class="quiet-button profile-command-trigger" type="button" aria-label={t("command.open")} title={t("command.open")} onClick={openCommand}>⌘</button>
      {open && (
        <div class="profile-command-layer" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section ref={dialog} class="profile-command" role="dialog" aria-modal="true" aria-labelledby="profile-command-title" onKeyDown={trapFocus}>
            <header>
              <div><span>{t("command.kicker")}</span><h2 id="profile-command-title">{t("command.title")}</h2></div>
              <kbd>Esc</kbd>
            </header>
            <input
              ref={input}
              type="search"
              value={query}
              placeholder={t("command.placeholder")}
              aria-label={t("command.placeholder")}
              aria-controls="profile-command-results"
              aria-activedescendant={matches[activeIndex] ? `profile-command-option-${activeIndex}` : undefined}
              onInput={(event) => { setQuery(event.currentTarget.value); setActiveIndex(0); }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => Math.min(matches.length - 1, current + 1)); }
                if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => Math.max(0, current - 1)); }
                if (event.key === "Enter") { event.preventDefault(); choose(activeIndex); }
              }}
            />
            <div id="profile-command-results" class="profile-command-list" role="listbox" aria-label={t("command.results")}>
              {matches.map((profile, index) => (
                <button
                  key={profile.id}
                  type="button"
                  role="option"
                  id={`profile-command-option-${index}`}
                  aria-selected={index === activeIndex}
                  class={index === activeIndex ? "is-active" : ""}
                  onPointerMove={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
              >
                  <CharacterPortrait profileId={profile.id} profileName={profileDisplayName(profile)} class="character-portrait--command" decorative />
                  <span><b>{profileDisplayName(profile)}</b><small>{[profileSecondaryName(profile), `${profile.sessions} ${t("office.chats")}`].filter(Boolean).join(" · ")}</small></span>
                  <StatusPill status={profile.status} />
                </button>
              ))}
              {matches.length === 0 && <p>{t("command.empty")}</p>}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
