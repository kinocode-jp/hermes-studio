import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  fetchAccessAudit,
  subscribeAccessAudit,
  type AccessAuditEntry,
  type AccessAuditSnapshot,
} from "../audit-api";
import { locale, t, type TranslationKey } from "../i18n";
import { accessDeviceName } from "../audit-presentation";
import { InfoTip } from "./info-tip";
import { RefreshIcon } from "./icons";
import "./access-audit.css";

const operationLabels: Partial<Record<AccessAuditEntry["operation"], TranslationKey>> = {
  "auth.local": "audit.operation.local",
  "auth.device": "audit.operation.device",
  "auth.logout": "audit.operation.logout",
  "audit.read": "audit.operation.read",
  "chat-model-preferences.update": "audit.operation.chatModelPreferences",
  "local-model-providers.sync": "audit.operation.localModelProviders",
  "host-app.install": "audit.operation.hostAppInstall",
  "host-fs.open": "audit.operation.hostFileOpen",
  "obsidian.vault.read": "audit.operation.obsidianVaultRead",
};

const outcomeLabels: Record<AccessAuditEntry["outcome"], TranslationKey> = {
  allowed: "audit.outcome.allowed",
  denied: "audit.outcome.denied",
  rate_limited: "audit.outcome.rateLimited",
};

export function AccessAudit() {
  const [snapshot, setSnapshot] = useState<AccessAuditSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);

  const reload = useCallback(async (showLoading = true) => {
    const currentGeneration = ++generation.current;
    if (showLoading) setLoading(true);
    try {
      const next = await fetchAccessAudit();
      if (generation.current !== currentGeneration) return;
      setSnapshot(next);
      setError(false);
    } catch {
      if (generation.current === currentGeneration) setError(true);
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const unsubscribe = subscribeAccessAudit(() => void reload(false));
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [reload]);

  const current = snapshot?.currentAccess;
  const accessMode = current?.local === false ? "REMOTE" : current?.local === true ? "LOCAL" : "OWNER";

  return (
    <section class="access-audit" aria-labelledby="access-audit-title" aria-busy={loading}>
      <header class="access-audit__gate">
        <div class={`access-audit__signal is-${accessMode.toLowerCase()}`} aria-hidden="true"><span /></div>
        <div class="access-audit__title">
          <div class="heading-info-group">
            <h2 id="access-audit-title">{t("audit.title")}</h2>
            <InfoTip text={t("audit.footer")} align="start" side="bottom" />
          </div>
        </div>
        <div class="access-audit__current">
          <span>SESSION · {accessMode}</span>
          <strong>{accessDeviceName(current)}</strong>
          <small>{current === null || current === undefined ? t("audit.checkingOwner") : current.local ? t("audit.localSafe") : t("audit.remoteSafe")}</small>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          aria-label={loading ? t("audit.loading") : t("audit.reload")}
          title={loading ? t("audit.loading") : t("audit.reload")}
        >
          <RefreshIcon />
        </button>
      </header>

      <div class="access-audit__rail">
        <div class="access-audit__rail-head" aria-hidden="true">
          <span>{t("audit.time")}</span><span>{t("audit.device")}</span><span>{t("audit.operation")}</span><span>{t("audit.result")}</span>
        </div>
        {error ? (
          <div class="access-audit__message is-error" role="alert"><b>{t("audit.offline")}</b><span>{t("audit.loadFailed")}</span></div>
        ) : snapshot?.records.length === 0 ? (
          <div class="access-audit__message"><b>{t("audit.noActivity")}</b><span>{t("audit.noActivityDetail")}</span></div>
        ) : (
          <ol aria-label={t("audit.logAria")}>
            {(snapshot?.records ?? []).map((record, index) => (
              <li key={`${record.occurredAt}-${record.operation}-${index}`}>
                <time dateTime={record.occurredAt}>{formatTime(record.occurredAt)}</time>
                <span class="access-audit__device"><i class={record.local ? "is-local" : "is-remote"} />{record.deviceName ?? (record.local ? t("audit.thisMac") : t("audit.remoteDevice"))}</span>
                <span>{operationLabel(record.operation)}</span>
                <span class={`access-audit__outcome is-${record.outcome}`}>
                  <i aria-hidden="true" />
                  <InfoTip text={t(outcomeLabels[record.outcome])} align="end" />
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

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

function operationLabel(operation: AccessAuditEntry["operation"]): string {
  const translation = operationLabels[operation];
  return translation === undefined ? operation : t(translation);
}
