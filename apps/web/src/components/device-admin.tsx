import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { RemoteConfigStatus } from "@hermes-studio/protocol";
import { isLocalOfficeClient } from "../auth-state";
import { fetchRemoteConfigStatus, logoutRemoteDevice, revokeRemoteDevice, DeviceRevokeError, OfficeRemoteConfigError, type DeviceRevokeFailureCode, type RemoteConfigFailureCode } from "../office-api";
import { locale, t, type TranslationKey } from "../i18n";
import { InfoTip } from "./info-tip";
import { CloseIcon, LogOutIcon, RefreshIcon, TrashIcon } from "./icons";
import "./access-audit.css";

const REVOKE_ERROR_KEY: Readonly<Record<DeviceRevokeFailureCode, TranslationKey>> = {
  not_found: "hostAdmin.revokeFailed.notFound",
  forbidden: "hostAdmin.revokeFailed.forbidden",
  unavailable: "hostAdmin.revokeFailed.unavailable",
  unknown: "hostAdmin.revokeFailed.unknown",
};

type LogoutPhase = "idle" | "confirm" | "busy";

export function DeviceAdmin() {
  const isRemote = !isLocalOfficeClient(location);
  const [status, setStatus] = useState<RemoteConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<RemoteConfigFailureCode | null>(null);
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmDevice, setConfirmDevice] = useState<RemoteConfigStatus["devices"][number] | null>(null);
  const [revokeError, setRevokeError] = useState<DeviceRevokeFailureCode | null>(null);
  const [logoutPhase, setLogoutPhase] = useState<LogoutPhase>("idle");
  const [logoutError, setLogoutError] = useState(false);
  const [, setLocaleRevision] = useState(0);
  const generation = useRef(0);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const revokeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const logoutTriggerRef = useRef<HTMLButtonElement | null>(null);
  const logoutCancelRef = useRef<HTMLButtonElement | null>(null);
  const logoutRestoreFocusRef = useRef(false);

  const reload = useCallback(async (showLoading = true) => {
    const currentGeneration = ++generation.current;
    if (showLoading) setLoading(true);
    try {
      const next = await fetchRemoteConfigStatus();
      if (generation.current !== currentGeneration) return;
      setStatus(next);
      setError(null);
    } catch (reason) {
      if (generation.current !== currentGeneration) return;
      if (reason instanceof OfficeRemoteConfigError && (reason.status === 401 || reason.status === 403)) {
        setError("not_allowed");
      } else {
        setError("load_failed");
      }
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const unsubscribe = locale.subscribe(() => setLocaleRevision((value) => value + 1));
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [reload]);

  useEffect(() => {
    if (confirmDevice) cancelButtonRef.current?.focus();
  }, [confirmDevice]);

  useEffect(() => {
    if (!confirmDevice && revokeTriggerRef.current) {
      const trigger = revokeTriggerRef.current;
      revokeTriggerRef.current = null;
      requestAnimationFrame(() => trigger.focus());
    }
  }, [confirmDevice]);

  useEffect(() => {
    if (logoutPhase === "confirm") logoutCancelRef.current?.focus();
  }, [logoutPhase]);

  useEffect(() => {
    if (logoutPhase === "idle" && logoutRestoreFocusRef.current && logoutTriggerRef.current) {
      logoutRestoreFocusRef.current = false;
      const trigger = logoutTriggerRef.current;
      requestAnimationFrame(() => trigger.focus());
    }
  }, [logoutPhase]);

  const askRevoke = useCallback((device: RemoteConfigStatus["devices"][number], trigger: EventTarget | null) => {
    setRevokeError(null);
    revokeTriggerRef.current = trigger instanceof HTMLButtonElement ? trigger : null;
    setConfirmDevice(device);
  }, []);

  const cancelRevoke = useCallback(() => {
    setConfirmDevice(null);
  }, []);

  const revoke = useCallback(async (device: RemoteConfigStatus["devices"][number]) => {
    if (revoking.has(device.id)) return;
    setRevokeError(null);
    setConfirmDevice(null);
    revokeTriggerRef.current = null;
    setRevoking((prev) => new Set([...prev, device.id]));
    try {
      await revokeRemoteDevice(device.id);
      await reload(false);
    } catch (reason) {
      setRevokeError(reason instanceof DeviceRevokeError ? reason.code : "unavailable");
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev);
        next.delete(device.id);
        return next;
      });
    }
  }, [reload, revoking]);

  const beginLogout = useCallback(() => {
    setLogoutError(false);
    logoutRestoreFocusRef.current = true;
    setLogoutPhase("confirm");
  }, []);

  const cancelLogout = useCallback(() => {
    if (logoutPhase === "busy") return;
    setLogoutPhase("idle");
    setLogoutError(false);
  }, [logoutPhase]);

  const confirmLogout = useCallback(async () => {
    if (logoutPhase === "busy") return;
    setLogoutError(false);
    setLogoutPhase("busy");
    try {
      await logoutRemoteDevice();
      location.reload();
    } catch {
      setLogoutError(true);
      setLogoutPhase("confirm");
    }
  }, [logoutPhase]);

  const revokeErrorKey = revokeError ? REVOKE_ERROR_KEY[revokeError] : null;
  // Remote clients only need logout; host config reload is for owners.
  const showReload = !(isRemote && error === "not_allowed");

  return (
    <section class="access-audit device-admin" aria-labelledby="device-admin-title" aria-busy={loading}>
      <header class="access-audit__gate">
        <div class="access-audit__title">
          <div class="heading-info-group">
            <h2 id="device-admin-title">{t("hostAdmin.title")}</h2>
            <InfoTip text={t("hostAdmin.guide")} align="start" side="bottom" />
          </div>
        </div>
        {showReload && (
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            aria-label={loading ? t("audit.loading") : t("hostAdmin.reload")}
            title={loading ? t("audit.loading") : t("hostAdmin.reload")}
          >
            <RefreshIcon />
          </button>
        )}
      </header>

      {isRemote && (
        <div class="access-audit__logout" aria-labelledby="device-logout-title">
          <div class="access-audit__logout-copy">
            <b id="device-logout-title">{t("hostAdmin.logoutTitle")}</b>
            <p>{t("hostAdmin.logoutNote")}</p>
          </div>
          {logoutPhase === "idle" ? (
            <button
              type="button"
              class="access-audit__logout-action"
              ref={logoutTriggerRef}
              onClick={beginLogout}
              aria-label={t("hostAdmin.logout")}
              title={t("hostAdmin.logout")}
            >
              <LogOutIcon />
            </button>
          ) : (
            <div
              class="access-audit__logout-confirm"
              role="group"
              aria-labelledby="logout-confirm-title"
              onKeyDown={(event) => {
                if (event.key === "Escape" && logoutPhase !== "busy") {
                  event.preventDefault();
                  cancelLogout();
                }
              }}
            >
              <b id="logout-confirm-title">{t("hostAdmin.logoutConfirm")}</b>
              <p>{t("hostAdmin.logoutPrompt")}</p>
              <div class="access-audit__logout-actions">
                <button
                  type="button"
                  ref={logoutCancelRef}
                  class="access-audit__logout-action"
                  onClick={cancelLogout}
                  disabled={logoutPhase === "busy"}
                  aria-label={t("hostAdmin.logoutCancel")}
                  title={t("hostAdmin.logoutCancel")}
                >
                  <CloseIcon />
                </button>
                <button
                  type="button"
                  class="access-audit__logout-action is-danger"
                  onClick={() => void confirmLogout()}
                  disabled={logoutPhase === "busy"}
                  aria-busy={logoutPhase === "busy"}
                  aria-label={logoutPhase === "busy" ? t("hostAdmin.loggingOut") : t("hostAdmin.logoutConfirmAction")}
                  title={logoutPhase === "busy" ? t("hostAdmin.loggingOut") : t("hostAdmin.logoutConfirmAction")}
                >
                  <LogOutIcon />
                </button>
              </div>
            </div>
          )}
          {logoutError && (
            <div class="access-audit__message is-error" role="alert">
              <b>{t("hostAdmin.logoutFailed")}</b>
            </div>
          )}
        </div>
      )}

      {error === "not_allowed" ? (
        !isRemote && (
          <div class="access-audit__message is-error" role="alert">
            <b>{t("hostAdmin.notAllowed")}</b>
          </div>
        )
      ) : error === "load_failed" ? (
        <div class="access-audit__message is-error" role="alert">
          <b>{t("hostAdmin.loadFailed")}</b>
        </div>
      ) : status === null ? (
        <div class="access-audit__message">{t("audit.loading")}</div>
      ) : (
        <div class="access-audit__rail">
          <div class="access-audit__current">
            <span>{t("hostAdmin.status")}</span>
            <strong>{status.enabled ? t("hostAdmin.enabled") : t("hostAdmin.disabled")}</strong>
          </div>

          <div class="access-audit__current">
            <span>{t("hostAdmin.proxyHops")}</span>
            <strong>{status.trustedProxyHops}</strong>
          </div>

          <div class="access-audit__rail-head" aria-hidden="true">
            <span>{t("hostAdmin.origins")}</span>
          </div>
          {status.origins.length === 0 ? (
            <div class="access-audit__message">{t("hostAdmin.noOrigins")}</div>
          ) : (
            <ol aria-label={t("hostAdmin.origins")}>
              {status.origins.map((origin) => (
                <li key={origin}><code>{origin}</code></li>
              ))}
            </ol>
          )}

          <div class="access-audit__rail-head" aria-hidden="true">
            <span>{t("hostAdmin.devices")}</span>
          </div>
          {status.devices.length === 0 ? (
            <div class="access-audit__message">{t("hostAdmin.noDevices")}</div>
          ) : (
            <ol aria-label={t("hostAdmin.devices")}>
              {status.devices.map((device) => (
                <li key={device.id} class="access-audit__device">
                  <span>{device.displayName}</span>
                  <span class={device.revokedAt ? "is-error" : "is-local"}>
                    {device.revokedAt ? t("audit.outcome.denied") : device.lastSeenAt ? formatTime(device.lastSeenAt) : t("hostAdmin.neverSeen")}
                  </span>
                  <button
                    type="button"
                    disabled={revoking.has(device.id) || device.revokedAt !== undefined}
                    onClick={(event) => askRevoke(device, event.currentTarget)}
                    aria-label={t("hostAdmin.revokeAria", { name: device.displayName })}
                    title={t("hostAdmin.revokeAria", { name: device.displayName })}
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ol>
          )}

          {confirmDevice && (
            <div
              class="access-audit__message"
              role="group"
              aria-labelledby="revoke-confirm-title"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRevoke();
                }
              }}
            >
              <b id="revoke-confirm-title">{t("hostAdmin.revokeConfirm")}</b>
              <p>{t("hostAdmin.revokePrompt", { name: confirmDevice.displayName })}</p>
              <div class="access-audit__device">
                <button
                  type="button"
                  ref={cancelButtonRef}
                  onClick={cancelRevoke}
                  aria-label={t("hostAdmin.revokeCancel")}
                  title={t("hostAdmin.revokeCancel")}
                >
                  <CloseIcon />
                </button>
                <button
                  type="button"
                  onClick={() => void revoke(confirmDevice)}
                  disabled={revoking.has(confirmDevice.id)}
                  aria-label={revoking.has(confirmDevice.id) ? t("hostAdmin.revoking") : t("hostAdmin.revoke")}
                  title={revoking.has(confirmDevice.id) ? t("hostAdmin.revoking") : t("hostAdmin.revoke")}
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          )}

          {revokeError && revokeErrorKey && (
            <div class="access-audit__message is-error" role="alert">
              <b>{t(revokeErrorKey)}</b>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat(locale.value === "ja" ? "ja-JP" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp)).replaceAll("/", ".");
}
