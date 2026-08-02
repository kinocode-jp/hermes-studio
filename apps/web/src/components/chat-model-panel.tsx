import { useEffect, useRef, useState } from "preact/hooks";
import { t, type TranslationKey } from "../i18n";
import {
  CHAT_MODEL_FIXED_OPTIONS,
  CHAT_MODEL_MANUAL_PROVIDER,
  ChatModelCatalogError,
  chatModelActivePresetId,
  chatModelName,
  chatModelPresets,
  chatModelProvider,
  chatModelReasoningEffort,
  chatModelSubName,
  chatModelSubProvider,
  chatModelSubReasoningEffort,
  clearActiveChatModelPreset,
  createChatModelPreset,
  deleteChatModelPreset,
  fetchLiveChatModels,
  isManualChatModelProvider,
  modelSelectValue,
  needsManualModelEntry,
  providerSelectValue,
  renameChatModelPreset,
  resolvedCreateModelPrefs,
  resolvedReasoningEffortForCreate,
  reconcileReasoningEffortValue,
  sanitizeReasoningEffort,
  selectChatModelPreset,
  setChatModelSelection,
  setChatModelSubReasoningEffort,
  setChatModelSubSelection,
  type LiveChatModelOption,
  type LiveChatProviderOption,
} from "../chat-model-prefs";
import { cancelSessionModelChange, stageSessionModelChange } from "../store";
import { InfoTip } from "./info-tip";

type ModelsState = "idle" | "loading" | "ready" | "error";
type MainSelection = { provider: string; model: string };

const EFFORT_LABEL_KEYS: Record<string, TranslationKey> = {
  none: "chat.model.reasoning.none",
  minimal: "chat.model.reasoning.minimal",
  low: "chat.model.reasoning.low",
  medium: "chat.model.reasoning.medium",
  high: "chat.model.reasoning.high",
  xhigh: "chat.model.reasoning.xhigh",
  max: "chat.model.reasoning.max",
  ultra: "chat.model.reasoning.ultra",
};

export function ChatModelPanel({
  profileId,
  sessionId,
  sessionProvider,
  sessionModel,
  sessionReasoningEffort,
  initialProvider,
  canSend,
  onClose,
  onQueued: _onQueued,
}: {
  profileId: string;
  sessionId: string;
  sessionProvider?: string | undefined;
  sessionModel?: string | undefined;
  sessionReasoningEffort?: string | undefined;
  initialProvider?: string | undefined;
  canSend: boolean;
  onClose: () => void;
  onQueued: () => void;
}) {
  const providerWasPreselected = initialProvider !== undefined && initialProvider !== (sessionProvider ?? "");
  const [mainProvider, setMainProvider] = useState(initialProvider ?? sessionProvider ?? "");
  const [mainModel, setMainModel] = useState(providerWasPreselected ? "" : sessionModel ?? "");
  const [mainReasoningEffort, setMainReasoningEffort] = useState(sessionReasoningEffort ?? "");
  const [customModel, setCustomModel] = useState(providerWasPreselected ? "" : sessionModel ?? "");
  const [customSubModel, setCustomSubModel] = useState(chatModelSubName.value);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetNote, setPresetNote] = useState<string | undefined>(undefined);
  const [liveProviders, setLiveProviders] = useState<LiveChatProviderOption[]>([]);
  const [liveModels, setLiveModels] = useState<LiveChatModelOption[]>([]);
  const [catalogProvider, setCatalogProvider] = useState("");
  const [defaultProvider, setDefaultProvider] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [modelsState, setModelsState] = useState<ModelsState>("idle");
  const [modelsError, setModelsError] = useState<string | undefined>(undefined);
  const generationRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || panelRef.current?.contains(target)) return;
      // InfoTip bubbles are portaled to document.body, but still belong to
      // this panel from the user's point of view.
      if (target.closest(".info-tip__bubble")) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  useEffect(() => {
    const preferred = mainProvider;
    const scope = preferred && !isManualChatModelProvider(preferred) ? preferred : undefined;
    // Prefer soft-cached catalog; Hermes refresh is reserved for explicit reload.
    void loadCatalog(scope, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  async function loadCatalog(
    providerScope?: string,
    forceRefresh = false,
    selection: MainSelection = { provider: mainProvider, model: mainModel },
  ): Promise<void> {
    const generation = ++generationRef.current;
    setModelsState("loading");
    setModelsError(undefined);
    try {
      const catalog = await fetchLiveChatModels(profileId, providerScope, { forceRefresh });
      if (generation !== generationRef.current) return;
      setLiveProviders(catalog.providers);
      setLiveModels(catalog.models);
      setCatalogProvider(catalog.provider);
      setDefaultProvider(catalog.defaultProvider);
      setDefaultModel(catalog.defaultModel);
      setModelsState("ready");
      // Callers that just changed provider/model pass the intended selection;
      // state setters do not update the closure that initiated this request.
      const prefProvider = selection.provider;
      const prefModel = selection.model;
      if (prefProvider && !isManualChatModelProvider(prefProvider)) {
        const missingProvider = catalog.providers.length === 0
          || !catalog.providers.some((item) => item.id === prefProvider);
        const missingModel = Boolean(prefModel)
          && catalog.models.length > 0
          && !catalog.models.some((item) => item.id === prefModel)
          && (providerScope === undefined || providerScope === prefProvider || catalog.provider === prefProvider);
        if (missingProvider || missingModel || (prefModel && catalog.models.length === 0)) {
          setCustomModel(prefModel);
        }
      }
      // Drop stored effort when the live model does not publish that level.
      setMainReasoningEffort((current) => reconcileReasoningEffortValue(
        current,
        reasoningEffortsFor(catalog.models, prefProvider, prefModel, "ready"),
      ));
      reconcileSubReasoningEffort(
        catalog.models,
        chatModelSubProvider.value,
        chatModelSubName.value,
      );
    } catch (error) {
      if (generation !== generationRef.current) return;
      setLiveModels([]);
      if (providerScope === undefined) setLiveProviders([]);
      setCatalogProvider("");
      setModelsState("error");
      setModelsError(catalogErrorMessage(error));
      // Fail closed: never send a stale effort without live capability.
      setMainReasoningEffort("");
      setChatModelSubReasoningEffort("");
    }
  }

  const noLiveProviders = modelsState === "ready" && liveProviders.length === 0;
  const retainedProvider = mainProvider;
  const providerInLiveList = liveProviders.some((item) => item.id === retainedProvider);
  const showModelSelect = !isManualChatModelProvider(retainedProvider)
    && retainedProvider !== ""
    && providerInLiveList;
  const emptyLiveModels = modelsState === "ready" && showModelSelect && liveModels.length === 0;
  const showManual = needsManualModelEntry(retainedProvider, mainModel, liveProviders, liveModels)
    || isManualChatModelProvider(retainedProvider)
    || emptyLiveModels
    || noLiveProviders
    || (retainedProvider !== "" && !isManualChatModelProvider(retainedProvider) && !providerInLiveList);
  const selectedEfforts = reasoningEffortsFor(
    liveModels,
    mainProvider,
    mainModel,
    modelsState,
  );
  const showReasoning = selectedEfforts !== undefined && selectedEfforts.length > 0;
  const effortValue = sanitizeReasoningEffort(mainReasoningEffort, selectedEfforts);

  const retainedSubProvider = chatModelSubProvider.value;
  const subProviderInLiveList = liveProviders.some((item) => item.id === retainedSubProvider);
  // Catalog models are scoped to the last main/provider load — only reuse them when sub matches.
  const subCatalogMatches = retainedSubProvider !== ""
    && (retainedSubProvider === catalogProvider || retainedSubProvider === mainProvider);
  const showSubModelSelect = !isManualChatModelProvider(retainedSubProvider)
    && retainedSubProvider !== ""
    && subProviderInLiveList
    && subCatalogMatches;
  const emptySubLiveModels = modelsState === "ready" && showSubModelSelect && liveModels.length === 0;
  const showSubManual = needsManualModelEntry(
    retainedSubProvider,
    chatModelSubName.value,
    liveProviders,
    liveModels,
  )
    || isManualChatModelProvider(retainedSubProvider)
    || emptySubLiveModels
    || (retainedSubProvider !== "" && noLiveProviders)
    || (retainedSubProvider !== "" && !subCatalogMatches)
    || (retainedSubProvider !== "" && !isManualChatModelProvider(retainedSubProvider) && !subProviderInLiveList);
  const selectedSubEfforts = reasoningEffortsFor(
    liveModels,
    chatModelSubProvider.value,
    chatModelSubName.value,
    modelsState,
  );
  const showSubReasoning = selectedSubEfforts !== undefined && selectedSubEfforts.length > 0;
  const subEffortValue = sanitizeReasoningEffort(chatModelSubReasoningEffort.value, selectedSubEfforts);

  const presets = chatModelPresets.value;
  const activePresetId = chatModelActivePresetId.value ?? "";

  function applyMainToSession(provider: string, model: string, effort: string): void {
    const efforts = reasoningEffortsFor(liveModels, provider, model, modelsState);
    const createPrefs = resolvedCreateModelPrefs({ provider, model, reasoningEffort: effort }, efforts);
    // Deferred apply: the /model command is sent with the next outbound prompt.
    stageSessionModelChange(sessionId, createPrefs.provider, createPrefs.model, createPrefs.reasoningEffort);
  }

  function apply(): void {
    if (modelsState === "loading") return;
    let provider = mainProvider;
    let model = mainModel;
    const freeformModel = customModel.trim();
    if (!provider && !model && !freeformModel) {
      setChatModelSelection("", "", "");
      if (defaultModel) applyMainToSession(defaultProvider, defaultModel, "");
      else cancelSessionModelChange(sessionId);
      onClose();
      return;
    }
    const explicitManual = isManualChatModelProvider(provider);
    const keepRealProvider = provider !== "" && !explicitManual;
    const useFreeformModel = explicitManual
      || !provider
      || needsManualModelEntry(provider, model, liveProviders, liveModels)
      || (modelsState === "ready" && liveModels.length === 0 && keepRealProvider)
      || noLiveProviders;

    if (useFreeformModel) {
      model = freeformModel;
      if (!model) return;
      if (!keepRealProvider) provider = CHAT_MODEL_MANUAL_PROVIDER;
    } else if (provider && !model && liveModels.length > 0) {
      return;
    }

    const efforts = reasoningEffortsFor(liveModels, provider, model, modelsState);
    // Fail-closed send gate: only a non-empty live enum can produce a real effort value.
    const effort = resolvedReasoningEffortForCreate(
      { provider, model, reasoningEffort: mainReasoningEffort },
      efforts,
    ) ?? "";
    setChatModelSelection(provider, model, effort);

    // Persist sub selection from free-form / live fields without sending to Hermes.
    let subProvider = chatModelSubProvider.value;
    let subModel = chatModelSubName.value;
    const freeformSub = customSubModel.trim();
    const subExplicitManual = isManualChatModelProvider(subProvider);
    const subKeepReal = subProvider !== "" && !subExplicitManual;
    const useSubFreeform = subExplicitManual
      || !subProvider
      || needsManualModelEntry(subProvider, subModel, liveProviders, liveModels)
      || (modelsState === "ready" && liveModels.length === 0 && subKeepReal)
      || noLiveProviders;
    if (useSubFreeform) {
      if (freeformSub) {
        subModel = freeformSub;
        if (!subKeepReal) subProvider = CHAT_MODEL_MANUAL_PROVIDER;
      }
    }
    const subEfforts = reasoningEffortsFor(liveModels, subProvider, subModel, modelsState);
    const subEffort = resolvedReasoningEffortForCreate(
      { provider: subProvider, model: subModel, reasoningEffort: chatModelSubReasoningEffort.value },
      subEfforts,
    ) ?? "";
    setChatModelSubSelection(subProvider, subModel, subEffort);

    applyMainToSession(provider, model, effort);
    onClose();
  }

  function onPickPreset(presetId: string): void {
    setPresetNote(undefined);
    if (!presetId) {
      // Keep current main/sub; only clear active marker.
      clearActiveChatModelPreset();
      return;
    }
    if (!selectChatModelPreset(presetId)) return;
    setCustomModel(chatModelName.value);
    setCustomSubModel(chatModelSubName.value);
    const main = {
      provider: chatModelProvider.value,
      model: chatModelName.value,
      reasoningEffort: chatModelReasoningEffort.value,
    };
    setMainProvider(main.provider);
    setMainModel(main.model);
    setMainReasoningEffort(main.reasoningEffort);
    applyMainToSession(main.provider, main.model, main.reasoningEffort);
    const preferred = chatModelProvider.value;
    if (preferred && !isManualChatModelProvider(preferred)) {
      void loadCatalog(preferred, false, { provider: main.provider, model: main.model });
    }
  }

  function onCreatePreset(): void {
    setPresetNote(undefined);
    setChatModelSelection(mainProvider, mainModel, mainReasoningEffort);
    const created = createChatModelPreset(presetNameDraft);
    if (!created) {
      setPresetNote(t("chat.modelPreset.nameRequired"));
      return;
    }
    setPresetNameDraft("");
    setPresetNote(t("chat.modelPreset.saved"));
  }

  function onRenamePreset(): void {
    setPresetNote(undefined);
    if (!activePresetId) return;
    if (!renameChatModelPreset(activePresetId, presetNameDraft)) {
      setPresetNote(t("chat.modelPreset.nameRequired"));
      return;
    }
    setPresetNameDraft("");
    setPresetNote(t("chat.modelPreset.renamed"));
  }

  function onDeletePreset(): void {
    setPresetNote(undefined);
    if (!activePresetId) return;
    deleteChatModelPreset(activePresetId);
    setPresetNameDraft("");
  }

  return (
    <div ref={panelRef} class="composer-model-panel">
      <section class="composer-model-section">
        <div class="composer-model-section-head">
          <span class="composer-model-section-label">{t("chat.modelPreset.label")}</span>
          <InfoTip text={t("chat.modelPreset.hint")} align="start" side="bottom" />
        </div>
        <label>
          <span>{t("chat.modelPreset.pick")}</span>
          <select
            value={activePresetId}
            disabled={modelsState === "loading"}
            onChange={(event) => onPickPreset(event.currentTarget.value)}
          >
            <option value="">{t("chat.modelPreset.none")}</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("chat.modelPreset.name")}</span>
          <input
            type="text"
            value={presetNameDraft}
            placeholder={t("chat.modelPreset.namePlaceholder")}
            disabled={modelsState === "loading"}
            onInput={(event) => setPresetNameDraft(event.currentTarget.value)}
          />
        </label>
        <div class="composer-model-preset-actions">
          <button type="button" class="secondary-button" disabled={modelsState === "loading"} onClick={onCreatePreset}>
            {t("chat.modelPreset.create")}
          </button>
          <button
            type="button"
            class="secondary-button"
            disabled={modelsState === "loading" || !activePresetId}
            onClick={onRenamePreset}
          >
            {t("chat.modelPreset.rename")}
          </button>
          <button
            type="button"
            class="secondary-button"
            disabled={modelsState === "loading" || !activePresetId}
            onClick={onDeletePreset}
          >
            {t("chat.modelPreset.delete")}
          </button>
        </div>
        {presetNote && <p role="status">{presetNote}</p>}
      </section>

      <section class="composer-model-section">
        <span class="composer-model-section-label">{t("chat.model.main.label")}</span>
        <label>
          <span>{t("chat.provider.label")}</span>
          <select
            value={providerSelectValue(mainProvider, liveProviders)}
            disabled={modelsState === "loading"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "default") {
                setMainProvider("");
                setMainModel("");
                setMainReasoningEffort("");
                setCustomModel("");
                void loadCatalog(undefined, false, { provider: "", model: "" });
                return;
              }
              if (value === CHAT_MODEL_MANUAL_PROVIDER) {
                const freeform = customModel || mainModel;
                setMainProvider(CHAT_MODEL_MANUAL_PROVIDER);
                setMainModel(freeform);
                setMainReasoningEffort("");
                setCustomModel(freeform);
                return;
              }
              setMainProvider(value);
              setMainModel("");
              setMainReasoningEffort("");
              setCustomModel("");
              void loadCatalog(value, false, { provider: value, model: "" });
            }}
          >
            <option value="default">{t(CHAT_MODEL_FIXED_OPTIONS[0].labelKey)}</option>
            {liveProviders.map((option) => (
              <option key={option.id} value={option.id}>
                {option.active ? t("chat.model.providerActive", { label: option.label }) : option.label}
              </option>
            ))}
            {retainedProvider
              && !isManualChatModelProvider(retainedProvider)
              && !providerInLiveList && (
              <option value={retainedProvider}>{retainedProvider}</option>
            )}
            <option value={CHAT_MODEL_MANUAL_PROVIDER}>{t(CHAT_MODEL_FIXED_OPTIONS[1].labelKey)}</option>
          </select>
        </label>
        {showModelSelect && (
          <label>
            <span>{t("chat.model.label")}</span>
            <select
              value={modelSelectValue(mainModel, liveModels)}
              disabled={modelsState === "loading" || modelsState === "error"}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (!value) {
                  setCustomModel(mainModel);
                  setMainReasoningEffort("");
                  return;
                }
                setMainModel(value);
                setCustomModel(value);
                setMainReasoningEffort((current) => reconcileReasoningEffortValue(
                  current,
                  reasoningEffortsFor(liveModels, mainProvider, value, "ready"),
                ));
              }}
            >
              <option value="">{modelsState === "loading" ? t("chat.model.loading") : t("chat.model.pick")}</option>
              {liveModels.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        )}
        {showReasoning && (
          <label>
            <span>{t("chat.model.reasoning.label")}</span>
            <select
              value={effortValue}
              disabled={modelsState === "loading"}
              onChange={(event) => {
                setMainReasoningEffort(sanitizeReasoningEffort(event.currentTarget.value, selectedEfforts));
              }}
            >
              <option value="">{t("chat.model.reasoning.default")}</option>
              {selectedEfforts!.map((effort) => (
                <option key={effort} value={effort}>
                  {t(EFFORT_LABEL_KEYS[effort] ?? "chat.model.reasoning.default")}
                </option>
              ))}
            </select>
          </label>
        )}
        {showManual && (
          <label>
            <span>{t("chat.model.custom")}</span>
            <input
              type="text"
              value={customModel}
              placeholder={t("chat.model.customPlaceholder")}
              disabled={modelsState === "loading"}
              onInput={(event) => {
                const value = event.currentTarget.value;
                setCustomModel(value);
                const provider = mainProvider;
                if (provider && !isManualChatModelProvider(provider)) {
                  setMainModel(value);
                  setMainReasoningEffort("");
                  return;
                }
                setMainProvider(CHAT_MODEL_MANUAL_PROVIDER);
                setMainModel(value);
                setMainReasoningEffort("");
              }}
            />
          </label>
        )}
      </section>

      <section class="composer-model-section">
        <div class="composer-model-section-head">
          <span class="composer-model-section-label">{t("chat.model.sub.label")}</span>
          <InfoTip text={t("chat.model.sub.hint")} align="start" side="bottom" />
        </div>
        <label>
          <span>{t("chat.provider.label")}</span>
          <select
            value={providerSelectValue(chatModelSubProvider.value, liveProviders)}
            disabled={modelsState === "loading"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "default") {
                setChatModelSubSelection("", "", "");
                setCustomSubModel("");
                return;
              }
              if (value === CHAT_MODEL_MANUAL_PROVIDER) {
                const freeform = customSubModel || chatModelSubName.value;
                setChatModelSubSelection(CHAT_MODEL_MANUAL_PROVIDER, freeform, "");
                setCustomSubModel(freeform);
                return;
              }
              setChatModelSubSelection(value, "", "");
              setCustomSubModel("");
            }}
          >
            <option value="default">{t(CHAT_MODEL_FIXED_OPTIONS[0].labelKey)}</option>
            {liveProviders.map((option) => (
              <option key={`sub-${option.id}`} value={option.id}>
                {option.active ? t("chat.model.providerActive", { label: option.label }) : option.label}
              </option>
            ))}
            {retainedSubProvider
              && !isManualChatModelProvider(retainedSubProvider)
              && !subProviderInLiveList && (
              <option value={retainedSubProvider}>{retainedSubProvider}</option>
            )}
            <option value={CHAT_MODEL_MANUAL_PROVIDER}>{t(CHAT_MODEL_FIXED_OPTIONS[1].labelKey)}</option>
          </select>
        </label>
        {showSubModelSelect && (
          <label>
            <span>{t("chat.model.label")}</span>
            <select
              value={modelSelectValue(chatModelSubName.value, liveModels)}
              disabled={modelsState === "loading" || modelsState === "error"}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (!value) {
                  setCustomSubModel(chatModelSubName.value);
                  setChatModelSubReasoningEffort("");
                  return;
                }
                setChatModelSubSelection(chatModelSubProvider.value, value);
                setCustomSubModel(value);
                reconcileSubReasoningEffort(liveModels, chatModelSubProvider.value, value);
              }}
            >
              <option value="">{modelsState === "loading" ? t("chat.model.loading") : t("chat.model.pick")}</option>
              {liveModels.map((option) => (
                <option key={`sub-model-${option.id}`} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        )}
        {showSubReasoning && (
          <label>
            <span>{t("chat.model.reasoning.label")}</span>
            <select
              value={subEffortValue}
              disabled={modelsState === "loading"}
              onChange={(event) => {
                setChatModelSubReasoningEffort(event.currentTarget.value, selectedSubEfforts);
              }}
            >
              <option value="">{t("chat.model.reasoning.default")}</option>
              {selectedSubEfforts!.map((effort) => (
                <option key={`sub-effort-${effort}`} value={effort}>
                  {t(EFFORT_LABEL_KEYS[effort] ?? "chat.model.reasoning.default")}
                </option>
              ))}
            </select>
          </label>
        )}
        {showSubManual && (
          <label>
            <span>{t("chat.model.custom")}</span>
            <input
              type="text"
              value={customSubModel}
              placeholder={t("chat.model.customPlaceholder")}
              disabled={modelsState === "loading"}
              onInput={(event) => {
                const value = event.currentTarget.value;
                setCustomSubModel(value);
                const provider = chatModelSubProvider.value;
                if (provider && !isManualChatModelProvider(provider)) {
                  setChatModelSubSelection(provider, value, "");
                  return;
                }
                setChatModelSubSelection(CHAT_MODEL_MANUAL_PROVIDER, value, "");
              }}
            />
          </label>
        )}
      </section>

      {modelsState === "loading" && <p role="status">{t("chat.model.loading")}</p>}
      {modelsState === "error" && modelsError && <p class="composer-note is-error" role="alert">{modelsError}</p>}
      {modelsState === "ready" && liveProviders.length === 0 && (
        <p role="status">{t("chat.model.providersEmpty")}</p>
      )}
      {modelsState === "ready" && liveProviders.length > 0 && liveModels.length === 0 && showModelSelect && (
        <p role="status">{t("chat.model.modelsEmpty")}</p>
      )}
      <div class="composer-model-actions">
        <span class="composer-model-actions-info">
          <InfoTip text={t("chat.model.hint")} align="start" side="top" />
        </span>
        <button
          type="button"
          class="secondary-button"
          disabled={modelsState === "loading"}
          onClick={() => {
            const preferred = mainProvider;
            const scope = preferred && !isManualChatModelProvider(preferred) ? preferred : undefined;
            void loadCatalog(scope, true);
          }}
        >
          {t("chat.model.refresh")}
        </button>
        <button type="button" disabled={modelsState === "loading" || !canSend} onClick={apply}>{t("chat.model.apply")}</button>
      </div>
    </div>
  );
}

function reasoningEffortsFor(
  models: readonly LiveChatModelOption[],
  provider: string,
  model: string,
  state: ModelsState,
): readonly string[] | undefined {
  if (state !== "ready") return undefined;
  if (!provider || isManualChatModelProvider(provider) || !model) return undefined;
  const found = models.find((item) => item.id === model);
  const efforts = found?.reasoningEfforts;
  return efforts && efforts.length > 0 ? efforts : undefined;
}

function reconcileSubReasoningEffort(
  models: readonly LiveChatModelOption[],
  provider: string,
  model: string,
): void {
  const efforts = reasoningEffortsFor(models, provider, model, "ready");
  // undefined enum → pass [] so sanitize fail-closes and clears stale effort.
  setChatModelSubReasoningEffort(chatModelSubReasoningEffort.value, efforts ?? []);
}

function catalogErrorMessage(error: unknown): string {
  if (error instanceof ChatModelCatalogError) {
    if (error.code === "unauthorized") return t("chat.model.error.unauthorized");
    if (error.code === "not-found") return t("chat.model.error.notFound");
    if (error.code === "invalid") return t("chat.model.error.invalid");
    if (error.code === "incompatible") return t("chat.model.error.incompatible");
  }
  return t("chat.model.error.unavailable");
}
