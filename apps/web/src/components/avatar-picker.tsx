import { useEffect, useRef, useState, useMemo } from "preact/hooks";
import { avatarForProfile, beginCustomAvatarChange, DEFAULT_CHARACTER_COUNT, isAvatarChangeCurrent, resetProfileAvatar, setCreatureAvatar, setCustomAvatar } from "../avatar-preferences";
import { CharacterPortrait } from "./character-portrait";
import { InfoTip } from "./info-tip";
import { CloseIcon, ResetIcon, UploadIcon } from "./icons";
import { t } from "../i18n";
import { appModalSizes, createModalResizeHandlers, getAppModalSize } from "../app-modal-layout";
import { canRestoreModalFocus, isTopmostModal, registerModal } from "../modal-layer";
import { useModalOutsideClose } from "./use-modal-outside-close";

type AvatarPickerProps = {
  profileId: string;
  profileName: string;
  onClose: () => void;
};

const MAX_FILE_BYTES = 1_000_000;
const AVATAR_PICKER_FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"]):not([disabled])';

type AvatarPickerTabEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">;

export function containAvatarPickerTabFocus(dialog: HTMLElement, event: AvatarPickerTabEvent, activeElement: Element | null): boolean {
  if (event.key !== "Tab") return false;
  const controls = [...dialog.querySelectorAll<HTMLElement>(AVATAR_PICKER_FOCUSABLE)];
  if (controls.length === 0) {
    event.preventDefault();
    dialog.focus();
    return true;
  }
  const first = controls[0]!;
  const last = controls[controls.length - 1]!;
  if (!activeElement || !controls.includes(activeElement as HTMLElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export function canDismissAvatarPicker(uploading: boolean, resetting: boolean): boolean {
  return !uploading && !resetting;
}

export function AvatarPicker({ profileId, profileName, onClose }: AvatarPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const selected = avatarForProfile(profileId);
  const busy = !canDismissAvatarPicker(uploading, resetting);
  const outsideClose = useModalOutsideClose(() => { if (!busy) onClose(); });
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const unregister = dialog ? registerModal(dialog) : undefined;
    if (closeButtonRef.current) closeButtonRef.current.focus();
    else dialog?.querySelector<HTMLElement>(AVATAR_PICKER_FOCUSABLE)?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      const currentDialog = dialogRef.current;
      if (!currentDialog || !isTopmostModal(currentDialog)) return;
      if (event.key === "Escape") { event.preventDefault(); if (!busyRef.current) onCloseRef.current(); return; }
      containAvatarPickerTabFocus(currentDialog, event, document.activeElement);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { unregister?.(); document.removeEventListener("keydown", handleKeyDown); if (canRestoreModalFocus(previousFocus)) previousFocus?.focus(); };
  }, []);

  const _avatarSizes = appModalSizes.value;
  const modalSize = getAppModalSize("avatar-picker");
  const resize = useMemo(() => createModalResizeHandlers("avatar-picker"), []);
  useEffect(() => () => resize.dispose(), [resize]);

  async function loadCustomImage(file?: File): Promise<void> {
    setError(null);
    if (!file || file.size > MAX_FILE_BYTES || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      setError(t("avatar.invalid"));
      return;
    }
    const generation = beginCustomAvatarChange(profileId);
    setUploading(true);
    try {
      const dataUrl = await readFile(file);
      if (await setCustomAvatar(profileId, dataUrl, generation)) onClose();
      else if (isAvatarChangeCurrent(profileId, generation)) setError(t("avatar.saveFailed"));
    } catch {
      setError(t("avatar.invalid"));
    } finally {
      setUploading(false);
    }
  }

  async function resetAvatar(): Promise<void> {
    setError(null);
    setResetting(true);
    try {
      if (await resetProfileAvatar(profileId)) onClose();
      else setError(t("avatar.resetFailed"));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div class="avatar-picker-backdrop" role="presentation" {...outsideClose}>
      <section
        ref={dialogRef}
        class="avatar-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-picker-title"
        aria-describedby="avatar-picker-description"
        tabIndex={-1}
        style={{ width: `${modalSize.width}px`, height: `${modalSize.height}px` }}
      >
        <header>
          <div>
            <small>{t("avatar.kicker")}</small>
            <div class="heading-info-group">
              <h3 id="avatar-picker-title">{t("avatar.title", { name: profileName })}</h3>
              <InfoTip text={`${t("avatar.description")} ${t("avatar.note")}`} align="end" />
            </div>
          </div>
          <button ref={closeButtonRef} type="button" disabled={busy} onClick={onClose} aria-label={t("common.close")} title={t("common.close")}><CloseIcon /></button>
        </header>
        <p id="avatar-picker-description" class="visually-hidden">{t("avatar.description")}</p>
        <div class="avatar-choice-grid">
          {Array.from({ length: DEFAULT_CHARACTER_COUNT }, (_, index) => (
            <button
              key={index}
              type="button"
              class={selected.kind === "creature" && selected.index === index ? "is-selected" : ""}
              disabled={uploading || resetting}
              aria-label={t("avatar.creature", { number: index + 1 })}
              title={t("avatar.creature", { number: index + 1 })}
              aria-pressed={selected.kind === "creature" && selected.index === index}
              onClick={() => { setCreatureAvatar(profileId, index); onClose(); }}
            >
              <CharacterPortrait
                profileId={profileId}
                profileName={t("avatar.creature", { number: index + 1 })}
                characterIndex={index}
                decorative
              />
            </button>
          ))}
        </div>
        <div class="avatar-picker-actions">
          <input ref={inputRef} type="file" hidden aria-hidden="true" tabIndex={-1} disabled={uploading || resetting} accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void loadCustomImage(file); }} />
          <button type="button" class="avatar-upload-button" disabled={uploading || resetting} onClick={() => inputRef.current?.click()} aria-label={t("avatar.upload")} title={t("avatar.upload")}><UploadIcon /></button>
          <button type="button" class="avatar-reset-button" aria-busy={resetting} disabled={uploading || resetting} onClick={() => void resetAvatar()} aria-label={resetting ? t("avatar.resetting") : t("avatar.reset")} title={resetting ? t("avatar.resetting") : t("avatar.reset")}><ResetIcon /></button>
        </div>
        {error && <p class="avatar-picker-error" role="alert">{error}</p>}
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

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("invalid image"));
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(file);
  });
}
