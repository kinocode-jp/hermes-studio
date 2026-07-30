import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import {
  GLOBAL_CONTEXT_MAX_UTF8_BYTES,
  GLOBAL_SETTINGS_MAX_SKILLS,
  globalContextUtf8Bytes,
  isGlobalContextWithinBudget,
} from "@hermes-studio/protocol";
import type { SettingsTab } from "../domain";
import { localizeRuntimeMessage, officeMessage, officeRuntimeMessage, t, type RuntimeMessage } from "../i18n";
import { isLocalOfficeClient } from "../auth-state";
import { canMutateSettingsTab, settingsMutationAccess } from "../settings-access";
import { profileDisplayName, profileStoredDisplayName, setProfileDisplayName } from "../profile-names";
import { preserveConcurrentDraft } from "../settings-draft";
import { SettingsMutationRegistry, type SettingsMutationScope } from "../settings-mutation-registry";
import { officeSnapshot } from "../store";
import { AccessAudit } from "./access-audit";
import { DeviceAdmin } from "./device-admin";
import { HostApps } from "./host-apps";
import { HermesAgentUpdate } from "./hermes-agent-update";
import { InfoTip } from "./info-tip";
import { CloseIcon, EditIcon, PlusIcon, RefreshIcon, SaveIcon, TrashIcon } from "./icons";
import { useMobileOverlay } from "./use-mobile-overlay";
import { useModalOutsideClose } from "./use-modal-outside-close";
import {
  REASONING_EFFORT_VALUES,
  fetchLiveChatModels,
  type LiveChatModelOption,
  type LiveChatProviderOption,
} from "../chat-model-prefs";
import { depositSecretTransfer } from "../desktop-transport";
import {
  getCachedGlobalSettings,
  getCachedProfileCoreSettings,
  invalidateSettingsPrefetch,
  peekCachedGlobalSettings,
  peekCachedProfileCoreSettings,
} from "../settings-prefetch";
import {
  SettingsApiError,
  consumeSecretTransfer,
  loadAgentBehavior,
  loadBuiltinMemoryFiles,
  loadGlobalSettings,
  loadMemoryProviderConfig,
  loadPrivilegedProfileConfig,
  loadProfileHermesConfig,
  loadProfileSecrets,
  loadProfileSettings,
  loadUsageStats,
  resetBuiltinMemory,
  secretFieldDraftKey,
  setMemoryProvider,
  loadSkillContent,
  loadProfileProjects,
  listHostDirs,
  type HostDirListing,
  createProfileProject,
  renameProfileProject,
  deleteProfileProject,
  addProfileProjectFolder,
  removeProfileProjectFolder,
  setSkillEnabled,
  updateSkillContent,
  updateAgentBehavior,
  updateBuiltinMemoryFile,
  updateGlobalSettings,
  updateMemoryProviderConfig,
  updatePrivilegedProfileConfig,
  updateProfileHermesConfig,
  updateProfileSoul,
  type BuiltinMemoryFiles,
  type GlobalAgentSettings,
  type HermesConfigValue,
  type HermesPrivilegedConfigValue,
  type HermesSecretFieldMeta,
  type MemoryProviderConfig,
  type MemoryResetTarget,
  type AgentBehaviorSnapshot,
  type ProfileAgentBehavior,
  type SharedSubagentCandidate,
  type ProfileAgentSettings,
  type ProfileProjects,
  type ProfileHermesConfig,
  type ProfilePrivilegedHermesConfig,
  type ProfileSecrets,
  type SkillContent,
  type SkillSettings,
  type UsageStatItem,
} from "../settings-api";
import "./live-settings.css";

export type LiveSettingsScope = "all" | "profile" | "global-host";

export type LiveSettingsProps = {
  profileId: string | null;
  profileLabel?: string;
  /** Restrict which settings surfaces appear in this instance. */
  scope?: LiveSettingsScope;
  initialTab?: SettingsTab;
  activeTab?: SettingsTab;
  showAccessAudit?: boolean;
  showHostAdmin?: boolean;
  onTabChange?: (tab: SettingsTab) => void;
  onChanged?: (kind: "global" | "memory" | "skill" | "soul" | "agent-behavior" | "config" | "privileged-config" | "secret") => void;
};

type ErrorState = { message: RuntimeMessage; conflict: boolean };

export function LiveSettings({ profileId, profileLabel, scope = "all", initialTab = "global", activeTab, showAccessAudit = false, showHostAdmin = false, onTabChange, onChanged }: LiveSettingsProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const visibleTab = activeTab ?? tab;
  const [global, setGlobal] = useState<GlobalAgentSettings | null>(null);
  const [profile, setProfile] = useState<ProfileAgentSettings | null>(null);
  const [agentBehavior, setAgentBehavior] = useState<ProfileAgentBehavior | null>(null);
  const [sharedSubagentCandidatesRevision, setSharedSubagentCandidatesRevision] = useState(0);
  const [sharedSubagentCandidates, setSharedSubagentCandidates] = useState<SharedSubagentCandidate[]>([]);
  const [preferredCandidateIds, setPreferredCandidateIds] = useState<string[]>([]);
  const [subagentProviders, setSubagentProviders] = useState<LiveChatProviderOption[]>([]);
  const [subagentModelsByProvider, setSubagentModelsByProvider] = useState<Record<string, LiveChatModelOption[]>>({});
  const [providerConfig, setProviderConfig] = useState<MemoryProviderConfig | null>(null);
  const [memoryFiles, setMemoryFiles] = useState<BuiltinMemoryFiles | null>(null);
  const [globalContext, setGlobalContext] = useState("");
  const [globalSkills, setGlobalSkills] = useState("");
  const [globalSkillOptions, setGlobalSkillOptions] = useState<SkillSettings[]>([]);
  /** Profile the current globalSkillOptions detail (usage, description) was sourced from. */
  const [globalSkillCatalogSource, setGlobalSkillCatalogSource] = useState<string | null>(null);
  const [globalSkillDetailName, setGlobalSkillDetailName] = useState<string | null>(null);
  const [globalSkillDraft, setGlobalSkillDraft] = useState("");
  const [sharedContext, setSharedContext] = useState(true);
  const [sharedSkills, setSharedSkills] = useState(true);
  const [soulDraft, setSoulDraft] = useState("");
  const [subagentAuto, setSubagentAuto] = useState(false);
  const [preferredSubagent, setPreferredSubagent] = useState("");
  const [providerDraft, setProviderDraft] = useState("");
  const [providerValues, setProviderValues] = useState<Record<string, boolean | string>>({});
  const [memoryDraft, setMemoryDraft] = useState("");
  const [userDraft, setUserDraft] = useState("");
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [profileProjects, setProfileProjects] = useState<ProfileProjects | null>(null);
  const [projectsError, setProjectsError] = useState<ErrorState | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [folderDrafts, setFolderDrafts] = useState<Record<string, string>>({});
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [projectEditId, setProjectEditId] = useState<string | null>(null);
  const [projectFolderFormId, setProjectFolderFormId] = useState<string | null>(null);
  const [newProjectFormOpen, setNewProjectFormOpen] = useState(false);
  /** Folder picker target: "new" creates a project; otherwise adds a folder to that project id. */
  const [dirPickerTarget, setDirPickerTarget] = useState<"new" | string | null>(null);
  useEffect(() => {
    if (!projectMenuId) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".settings-projects__menu-wrap")) return;
      setProjectMenuId(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [projectMenuId]);
  const [resetTarget, setResetTarget] = useState<MemoryResetTarget>("all");
  const [skillQuery, setSkillQuery] = useState("");
  const [skillLimit, setSkillLimit] = useState(30);
  const [skillEditorName, setSkillEditorName] = useState<string | null>(null);
  const [usageBySkill, setUsageBySkill] = useState<ReadonlyMap<string, UsageStatItem>>(() => new Map());
  const [hermesConfig, setHermesConfig] = useState<ProfileHermesConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, HermesConfigValue>>({});
  const [configQuery, setConfigQuery] = useState("");
  const [configCategory, setConfigCategory] = useState<string>("");
  /** Isolated from the shared settings error so Advanced config outages do not block other tabs. */
  const [configError, setConfigError] = useState<ErrorState | null>(null);
  const [privilegedConfig, setPrivilegedConfig] = useState<ProfilePrivilegedHermesConfig | null>(null);
  const [privilegedDraft, setPrivilegedDraft] = useState<Record<string, HermesPrivilegedConfigValue>>({});
  const [privilegedQuery, setPrivilegedQuery] = useState("");
  const [privilegedCategory, setPrivilegedCategory] = useState<string>("");
  const [privilegedError, setPrivilegedError] = useState<ErrorState | null>(null);
  const [profileSecrets, setProfileSecrets] = useState<ProfileSecrets | null>(null);
  /** Write-only secret drafts keyed by source:key — never persisted after save. */
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [secretError, setSecretError] = useState<ErrorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<ErrorState | null>(null);
  const generation = useRef(0);
  const mutations = useRef(new SettingsMutationRegistry());
  const initialSharedCandidatesRef = useRef<SharedSubagentCandidate[]>([]);

  const snapshot = officeSnapshot.value;
  const mutationAccess = settingsMutationAccess(snapshot);
  const canReadAudit = snapshot?.capabilities.access.allowedOperations.includes("audit.read") === true;
  const hostAdmin = showHostAdmin && mutationAccess.hostAdmin;
  // Remote devices need the host/device tab for session logout (not revoke).
  const showDeviceAdmin = hostAdmin || (showHostAdmin && !isLocalOfficeClient(location));
  const allowedTabs: SettingsTab[] = scope === "profile"
    ? ["project", "soul", "skills", "memory", "config", "privileged"]
    : scope === "global-host"
      ? (showDeviceAdmin ? ["global", "host"] : ["global"])
      : (showDeviceAdmin
        ? ["global", "project", "skills", "soul", "memory", "config", "privileged", "host"]
        : ["global", "project", "skills", "soul", "memory", "config", "privileged"]);
  const allowedTabKey = allowedTabs.join("|");
  const tabLabels: Record<SettingsTab, string> = {
    global: t(scope === "global-host" ? "settings.scope.global" : "settings.global"),
    project: t("settings.project"),
    skills: t("settings.skills"),
    soul: t("settings.identity"),
    memory: t("settings.memory"),
    config: t("settings.config"),
    privileged: t("settings.privileged"),
    host: t(scope === "global-host" ? "settings.scope.host" : "hostAdmin.title"),
  };
  const globalHostTabDetails: Partial<Record<SettingsTab, string>> = scope === "global-host"
    ? {
      global: t("settings.scope.globalDetail"),
      host: t("settings.scope.hostDetail"),
    }
    : {};
  const settingsTitle = scope === "profile"
    ? t("profile.settings")
    : scope === "global-host"
      ? t("settings.globalTitle")
      : t("settings.title");
  // Profile settings keep a mast; the app settings modal already has its own title.
  const showMast = scope === "all";
  const showTarget = showMast && visibleTab !== "host";
  const showTabs = allowedTabs.length > 1;
  // Stable scalar for reload deps: avoid stale canLoadMemoryBodies after capability changes.
  const canLoadMemoryBodies = mutationAccess.memory;
  const canLoadPrivileged = mutationAccess.privileged;

  // Project tab display-name editor (device-local alias overlay, no server op).
  const projectProfileSummary = profileId
    ? snapshot?.profiles.find((item) => item.id === profileId)
    : undefined;
  const projectNameFallback = projectProfileSummary
    ? profileDisplayName({ id: projectProfileSummary.id, name: projectProfileSummary.name })
    : (profileLabel ?? profileId ?? "");
  const projectNameSaved = profileId ? profileStoredDisplayName(profileId, projectNameFallback) : "";
  const projectNameDirty = projectNameDraft.trim() !== projectNameSaved.trim();

  useEffect(() => {
    setProjectNameDraft(projectNameSaved);
  }, [profileId, projectNameSaved]);

  // Official per-profile Hermes Projects: load when the project tab is shown.
  useEffect(() => {
    if (visibleTab !== "project" || !profileId) return;
    let cancelled = false;
    setProfileProjects(null);
    setRenameDrafts({});
    setFolderDrafts({});
    setProjectsError(null);
    void (async () => {
      try {
        const projects = await loadProfileProjects(profileId);
        if (!cancelled) setProfileProjects(projects);
      } catch (reason) {
        if (!cancelled) setProjectsError(errorState(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [visibleTab, profileId]);

  const performProjects = useCallback(async (key: string, action: () => Promise<void>) => {
    if (!mutations.current.start(key, "projects")) return;
    setBusy(mutations.current.snapshot());
    setProjectsError(null);
    try {
      await action();
    } catch (reason) {
      setProjectsError(errorState(reason));
    } finally {
      mutations.current.finish(key);
      setBusy(mutations.current.snapshot());
    }
  }, []);

  const refreshProjects = async (profile: string) => {
    setProfileProjects(await loadProfileProjects(profile));
  };

  const saveProjectRename = (projectId: string) => {
    if (!profileId || !mutationAccess.project) return;
    const name = (renameDrafts[projectId] ?? "").trim();
    if (name === "") return;
    void performProjects(`projects:rename:${projectId}`, async () => {
      await renameProfileProject(profileId, projectId, name);
      await refreshProjects(profileId);
    });
  };

  const removeProject = (projectId: string, name: string) => {
    if (!profileId || !mutationAccess.project) return;
    if (!window.confirm(t("settings.projects.deleteConfirm", { name }))) return;
    void performProjects(`projects:delete:${projectId}`, async () => {
      setProfileProjects(await deleteProfileProject(profileId, projectId));
    });
  };

  const addProjectFolder = (projectId: string) => {
    if (!profileId || !mutationAccess.project) return;
    const path = (folderDrafts[projectId] ?? "").trim();
    if (path === "") return;
    void performProjects(`projects:folder:${projectId}`, async () => {
      await addProfileProjectFolder(profileId, projectId, { path });
      setFolderDrafts((current) => ({ ...current, [projectId]: "" }));
      await refreshProjects(profileId);
    });
  };

  /** Called when the folder picker confirms a directory. */
  const applyPickedDirectory = (path: string) => {
    const target = dirPickerTarget;
    setDirPickerTarget(null);
    if (!profileId || !mutationAccess.project || !target) return;
    if (target === "new") {
      const fallbackName = path.split("/").filter(Boolean).pop() ?? path;
      const name = newProjectName.trim() || fallbackName;
      void performProjects("projects:create", async () => {
        await createProfileProject(profileId, { name, path });
        setNewProjectName("");
        setNewProjectFormOpen(false);
        await refreshProjects(profileId);
      });
      return;
    }
    void performProjects(`projects:folder:${target}`, async () => {
      await addProfileProjectFolder(profileId, target, { path });
      await refreshProjects(profileId);
    });
  };

  const removeProjectFolder = (projectId: string, path: string) => {
    if (!profileId || !mutationAccess.project) return;
    if (!window.confirm(t("settings.projects.removeFolderConfirm", { path }))) return;
    void performProjects(`projects:folder:${projectId}`, async () => {
      await removeProfileProjectFolder(profileId, projectId, path);
      await refreshProjects(profileId);
    });
  };

  const loadProvider = useCallback(async (targetProfile: string, provider: string, expectedGeneration: number) => {
    if (!provider) {
      if (generation.current === expectedGeneration) {
        setProviderConfig(null);
        setProviderValues({});
      }
      return;
    }
    try {
      const config = await loadMemoryProviderConfig(targetProfile, provider);
      if (generation.current !== expectedGeneration) return;
      setProviderConfig(config);
      setProviderValues(valuesFromConfig(config));
    } catch (reason) {
      if (generation.current === expectedGeneration) setError(errorState(reason));
    }
  }, []);

  // Core settings needed by soul/skills/global first paint. Heavy tabs load lazily.
  const reload = useCallback(async (options?: { force?: boolean }) => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    const hardTimeout = window.setTimeout(() => {
      if (generation.current === currentGeneration) {
        setLoading(false);
        setError((current) => current ?? { message: officeMessage("settings.loadFailed"), conflict: false });
      }
    }, 15_000);

    setError(null);
    setConfigError(null);
    setProviderConfig(null);
    setMemoryFiles(null);
    setMemoryDraft("");
    setUserDraft("");
    setHermesConfig(null);
    setConfigDraft({});
    setPrivilegedConfig(null);
    setPrivilegedDraft({});
    setPrivilegedError(null);
    setProfileSecrets(null);
    setSecretDrafts({});
    setSecretError(null);

    if (options?.force) invalidateSettingsPrefetch(profileId ?? undefined);

    // Paint immediately when warm cache is available.
    const cachedGlobal = peekCachedGlobalSettings();
    const cachedCore = profileId ? peekCachedProfileCoreSettings(profileId) : null;
    if (cachedGlobal || cachedCore) {
      if (cachedGlobal) {
        setGlobal(cachedGlobal);
        setGlobalContext(cachedGlobal.context);
        setGlobalSkills(cachedGlobal.skills.join("\n"));
        setGlobalSkillOptions((current) => mergeGlobalSkillOptions(current, [], cachedGlobal.skills));
        setSharedContext(cachedGlobal.sharedContextEnabled);
        setSharedSkills(cachedGlobal.sharedSkillsEnabled);
      }
      if (cachedCore) {
        setProfile(cachedCore.profile);
        setSoulDraft(cachedCore.profile.soul.content ?? "");
        setProviderDraft(cachedCore.profile.memory.activeProvider ?? "");
        const skillUsage = new Map<string, UsageStatItem>();
        for (const item of cachedCore.usage?.items ?? []) {
          if (item.kind === "skill") skillUsage.set(item.name, item);
        }
        setUsageBySkill(skillUsage);
        if (cachedCore.behavior) {
          setAgentBehavior(cachedCore.behavior.profile);
          setSharedSubagentCandidatesRevision(cachedCore.behavior.sharedRevision);
          const shared = cachedCore.behavior.sharedCandidates.map((item) => ({ ...item }));
          setSharedSubagentCandidates(shared);
          initialSharedCandidatesRef.current = shared.map((item) => ({ ...item }));
          setPreferredCandidateIds([...cachedCore.behavior.profile.preferredCandidateIds]);
          setSubagentAuto(cachedCore.behavior.profile.subagentMode === "auto");
          setPreferredSubagent(cachedCore.behavior.profile.preferredSubagent);
        }
      }
      setLoading(false);
    }

    try {
      const settled = await Promise.allSettled([
        getCachedGlobalSettings({ force: options?.force === true }),
        profileId ? getCachedProfileCoreSettings(profileId, { force: options?.force === true }) : Promise.resolve(null),
      ]);
      if (generation.current !== currentGeneration) return;

      const nextGlobal = settled[0].status === "fulfilled" ? settled[0].value : null;
      const nextCore = settled[1].status === "fulfilled" ? settled[1].value : null;
      const nextProfile = nextCore?.profile ?? null;
      const nextBehavior = nextCore?.behavior ?? null;
      const nextUsage = nextCore?.usage ?? null;

      // Core failures should surface, but not block forever.
      const coreFailure = settled.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
      if (coreFailure) setError(errorState(coreFailure.reason));

      if (nextGlobal) {
        setGlobal(nextGlobal);
        setGlobalContext(nextGlobal.context);
        setGlobalSkills(nextGlobal.skills.join("\n"));
        setGlobalSkillOptions((current) => mergeGlobalSkillOptions(current, [], nextGlobal.skills));
        setSharedContext(nextGlobal.sharedContextEnabled);
        setSharedSkills(nextGlobal.sharedSkillsEnabled);
      } else {
        setGlobal(null);
      }

      setProfile(nextProfile);
      setSoulDraft(nextProfile?.soul.content ?? "");
      setProviderDraft(nextProfile?.memory.activeProvider ?? "");

      const skillUsage = new Map<string, UsageStatItem>();
      for (const item of nextUsage?.items ?? []) {
        if (item.kind === "skill") skillUsage.set(item.name, item);
      }
      setUsageBySkill(skillUsage);

      if (nextBehavior) {
        setAgentBehavior(nextBehavior.profile);
        setSharedSubagentCandidatesRevision(nextBehavior.sharedRevision);
        const shared = nextBehavior.sharedCandidates.map((item) => ({ ...item }));
        setSharedSubagentCandidates(shared);
        initialSharedCandidatesRef.current = shared.map((item) => ({ ...item }));
        setPreferredCandidateIds([...nextBehavior.profile.preferredCandidateIds]);
        setSubagentAuto(nextBehavior.profile.subagentMode === "auto");
        setPreferredSubagent(nextBehavior.profile.preferredSubagent);
      } else {
        setAgentBehavior(null);
        setSharedSubagentCandidatesRevision(0);
        setSharedSubagentCandidates([]);
        initialSharedCandidatesRef.current = [];
        setPreferredCandidateIds([]);
        setSubagentAuto(false);
        setPreferredSubagent("");
      }

      // Provider config is secondary; never block first paint.
      if (nextProfile) {
        void loadProvider(nextProfile.profile, nextProfile.memory.activeProvider, currentGeneration);
      }
    } catch (reason) {
      if (generation.current === currentGeneration) setError(errorState(reason));
    } finally {
      window.clearTimeout(hardTimeout);
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [loadProvider, profileId]);

  // Lazy-load memory bodies only when Memory tab is opened.
  useEffect(() => {
    if (visibleTab !== "memory" || !profileId || !canLoadMemoryBodies) return;
    if (memoryFiles) return;
    const expected = generation.current;
    let cancelled = false;
    void (async () => {
      try {
        const nextMemoryFiles = await loadBuiltinMemoryFiles(profileId);
        if (cancelled || generation.current !== expected) return;
        setMemoryFiles(nextMemoryFiles);
        setMemoryDraft(nextMemoryFiles.memory.content ?? "");
        setUserDraft(nextMemoryFiles.user.content ?? "");
      } catch (reason) {
        if (!cancelled && generation.current === expected) setError(errorState(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [canLoadMemoryBodies, memoryFiles, profileId, visibleTab]);

  // Lazy-load advanced config only when Advanced tab is opened.
  useEffect(() => {
    if (visibleTab !== "config" || !profileId) return;
    if (hermesConfig || configError) return;
    const expected = generation.current;
    let cancelled = false;
    void (async () => {
      try {
        const config = await loadProfileHermesConfig(profileId);
        if (cancelled || generation.current !== expected) return;
        setHermesConfig(config);
        setConfigDraft({ ...config.values });
        setConfigError(null);
        if (config.categories.length > 0) {
          setConfigCategory((current) =>
            current && config.categories.includes(current) ? current : config.categories[0]!,
          );
        }
      } catch (reason) {
        if (!cancelled && generation.current === expected) {
          setHermesConfig(null);
          setConfigDraft({});
          setConfigError(errorState(reason));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [configError, hermesConfig, profileId, visibleTab]);

  // Lazy-load privileged + secrets only when Privileged tab is opened.
  useEffect(() => {
    if (visibleTab !== "privileged" || !profileId || !canLoadPrivileged) return;
    if (privilegedConfig || profileSecrets || privilegedError || secretError) return;
    const expected = generation.current;
    let cancelled = false;
    void (async () => {
      const [privilegedResult, secretsResult] = await Promise.all([
        loadPrivilegedProfileConfig(profileId).then(
          (config) => ({ ok: true as const, config }),
          (reason: unknown) => ({ ok: false as const, reason }),
        ),
        loadProfileSecrets(profileId).then(
          (secrets) => ({ ok: true as const, secrets }),
          (reason: unknown) => ({ ok: false as const, reason }),
        ),
      ]);
      if (cancelled || generation.current !== expected) return;
      if (privilegedResult.ok) {
        setPrivilegedConfig(privilegedResult.config);
        setPrivilegedDraft(privilegedResult.config ? { ...privilegedResult.config.values } : {});
        setPrivilegedError(null);
        if (privilegedResult.config && privilegedResult.config.categories.length > 0) {
          setPrivilegedCategory((current) =>
            current && privilegedResult.config!.categories.includes(current)
              ? current
              : privilegedResult.config!.categories[0]!,
          );
        }
      } else {
        setPrivilegedConfig(null);
        setPrivilegedDraft({});
        setPrivilegedError(errorState(privilegedResult.reason));
      }
      if (secretsResult.ok) {
        setProfileSecrets(secretsResult.secrets);
        setSecretDrafts({});
        setSecretError(null);
      } else {
        setProfileSecrets(null);
        setSecretDrafts({});
        setSecretError(errorState(secretsResult.reason));
      }
    })();
    return () => { cancelled = true; };
  }, [canLoadPrivileged, privilegedConfig, privilegedError, profileId, profileSecrets, secretError, visibleTab]);

  useEffect(() => {
    if (!allowedTabs.includes(visibleTab)) {
      const fallback = allowedTabs[0] ?? "global";
      setTab(fallback);
      onTabChange?.(fallback);
    }
  }, [allowedTabKey, onTabChange, visibleTab]);

  // Load once per profile/settings target. Tab switches reuse the in-memory draft.
  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload, profileId, scope]);

  useEffect(() => { setSkillLimit(30); }, [profileId, skillQuery]);

  const perform = useCallback(async (
    key: string,
    scope: SettingsMutationScope,
    action: () => Promise<void>,
    kind: "global" | "memory" | "skill" | "soul" | "agent-behavior" | "config" | "privileged-config" | "secret",
  ) => {
    if (!mutations.current.start(key, scope)) return;
    setBusy(mutations.current.snapshot());
    setError(null);
    try {
      await action();
      invalidateSettingsPrefetch(profileId ?? undefined);
      onChanged?.(kind);
    } catch (reason) {
      setError(errorState(reason));
    } finally {
      mutations.current.finish(key);
      setBusy(mutations.current.snapshot());
    }
  }, [onChanged]);

  const saveGlobal = () => {
    if (!global || !mutationAccess.global) return;
    const submitted = { globalContext, globalSkills, sharedContext, sharedSkills };
    void perform("global", "global", async () => {
      const updated = await updateGlobalSettings({
        expectedRevision: global.revision,
        sharedContextEnabled: submitted.sharedContext,
        sharedSkillsEnabled: submitted.sharedSkills,
        context: submitted.globalContext,
        skills: parseSkillLines(submitted.globalSkills),
      });
      setGlobal(updated);
      setGlobalContext((current) => preserveConcurrentDraft(current, submitted.globalContext, updated.context));
      setGlobalSkills((current) => preserveConcurrentDraft(current, submitted.globalSkills, updated.skills.join("\n")));
      setSharedContext((current) => preserveConcurrentDraft(current, submitted.sharedContext, updated.sharedContextEnabled));
      setSharedSkills((current) => preserveConcurrentDraft(current, submitted.sharedSkills, updated.sharedSkillsEnabled));
    }, "global");
  };

  const openSkillEditor = (name: string) => {
    setSkillEditorName(name);
  };

  const closeSkillEditor = () => {
    setSkillEditorName(null);
  };

  const toggleSkill = (name: string, enabled: boolean) => {
    if (!profile || !mutationAccess.skill) return;
    void perform(`skill:${name}`, `skill:${name}`, async () => {
      await setSkillEnabled(profile.profile, name, !enabled, enabled);
      setProfile((current) => current === null ? current : {
        ...current,
        skills: current.skills.map((skill) => skill.name === name ? { ...skill, enabled: !enabled } : skill),
      });
    }, "skill");
  };

  const saveSoul = () => {
    if (!profile || profile.soul.redacted || !mutationAccess.soul) return;
    const submittedDraft = soulDraft;
    void perform("soul", "soul", async () => {
      const updated = await updateProfileSoul(profile.profile, submittedDraft, profile.soul.revision);
      setProfile((current) => current === null ? current : { ...current, soul: updated });
      setSoulDraft((current) => preserveConcurrentDraft(current, submittedDraft, updated.content));
    }, "soul");
  };


  const ensureSubagentProviders = useCallback(async () => {
    if (!profileId || subagentProviders.length > 0) return;
    try {
      const catalog = await fetchLiveChatModels(profileId);
      setSubagentProviders(catalog.providers);
      if (catalog.provider) {
        setSubagentModelsByProvider((current) => ({ ...current, [catalog.provider]: catalog.models }));
      }
    } catch {
      // Catalog is optional for free-form fallback options.
    }
  }, [profileId, subagentProviders.length]);

  const ensureSubagentModels = useCallback(async (provider: string) => {
    if (!profileId || !provider || subagentModelsByProvider[provider]) return;
    try {
      const catalog = await fetchLiveChatModels(profileId, provider);
      setSubagentModelsByProvider((current) => ({ ...current, [provider]: catalog.models }));
      if (catalog.providers.length > 0) setSubagentProviders(catalog.providers);
    } catch {
      // Ignore catalog failures; retained values remain selectable.
    }
  }, [profileId, subagentModelsByProvider]);

  // Load the provider/model catalog as soon as the subagent editor is visible so
  // the dropdowns are populated before the first tap (not only on focus).
  useEffect(() => {
    if (visibleTab !== "soul" || !profileId) return;
    void ensureSubagentProviders();
  }, [visibleTab, profileId, ensureSubagentProviders]);
  const candidateProvidersKey = sharedSubagentCandidates.map((item) => item.provider).filter(Boolean).join("|");
  useEffect(() => {
    if (visibleTab !== "soul") return;
    for (const provider of candidateProvidersKey.split("|")) {
      if (provider) void ensureSubagentModels(provider);
    }
  }, [visibleTab, candidateProvidersKey, ensureSubagentModels]);

  const saveAgentBehavior = () => {
    if (!profile || !agentBehavior || !mutationAccess.soul) return;
    const selected = preferredCandidateIds
      .map((id) => sharedSubagentCandidates.find((item) => item.id === id))
      .filter((item): item is SharedSubagentCandidate => item !== undefined && item.enabled)
      .slice(0, 3);
    const derivedPreferred = selected[0]
      ? (selected[0].label.trim() || [selected[0].provider, selected[0].model].filter(Boolean).join("/") || preferredSubagent)
      : "";
    const submitted = {
      subagentAuto,
      preferredSubagent: derivedPreferred,
      preferredCandidateIds: selected.map((item) => item.id),
      sharedCandidates: sharedSubagentCandidates.map((item) => ({ ...item })),
    };
    void perform("agent-behavior", "agent-behavior", async () => {
      const updated = await updateAgentBehavior(profile.profile, {
        expectedRevision: agentBehavior.revision,
        expectedSharedRevision: sharedSubagentCandidatesRevision,
        subagentMode: submitted.subagentAuto ? "auto" : "manual",
        preferredSubagent: submitted.preferredSubagent,
        preferredCandidateIds: submitted.preferredCandidateIds,
        sharedCandidates: submitted.sharedCandidates,
      });
      setAgentBehavior(updated.profile);
      setSharedSubagentCandidatesRevision(updated.sharedRevision);
      const shared = updated.sharedCandidates.map((item) => ({ ...item }));
      setSharedSubagentCandidates(shared);
      initialSharedCandidatesRef.current = shared.map((item) => ({ ...item }));
      setPreferredCandidateIds([...updated.profile.preferredCandidateIds]);
      setSubagentAuto((current) => preserveConcurrentDraft(current, submitted.subagentAuto, updated.profile.subagentMode === "auto"));
      setPreferredSubagent((current) => preserveConcurrentDraft(current, submitted.preferredSubagent, updated.profile.preferredSubagent));
    }, "agent-behavior");
  };

  const saveHermesConfig = () => {
    if (!profile || !hermesConfig || !mutationAccess.config) return;
    const changes = collectConfigChanges(hermesConfig.values, configDraft);
    if (Object.keys(changes).length === 0) return;
    const submitted = { ...configDraft };
    // Capture target + generation so a late response cannot overwrite a newer profile.
    // expectedRevision is still the revision observed at submit time (server 409 on stale).
    const targetProfile = profile.profile;
    const expectedRevision = hermesConfig.revision;
    const requestGeneration = generation.current;
    void perform("hermes-config", "config", async () => {
      const updated = await updateProfileHermesConfig(targetProfile, {
        expectedRevision,
        changes,
      });
      if (generation.current !== requestGeneration) return;
      setHermesConfig(updated);
      setConfigError(null);
      setConfigDraft((current) => {
        // Keep concurrent local edits that were not part of this save.
        // Revision-based conflict remains on the server (HTTP 409).
        const next = { ...updated.values };
        for (const [key, value] of Object.entries(current)) {
          if (!(key in changes) && JSON.stringify(value) !== JSON.stringify(submitted[key])) {
            next[key] = value;
          }
        }
        return next;
      });
    }, "config");
  };

  const saveProvider = () => {
    if (!profile || !mutationAccess.memory || providerDraft === profile.memory.activeProvider) return;
    void perform("provider", "memory", async () => {
      const memory = await setMemoryProvider(profile.profile, providerDraft, profile.memory.activeProvider);
      setProfile((current) => current === null ? current : { ...current, memory });
      const currentGeneration = generation.current;
      await loadProvider(profile.profile, memory.activeProvider, currentGeneration);
    }, "memory");
  };

  const saveProviderConfig = () => {
    if (!profile || !providerConfig || !mutationAccess.memory) return;
    void perform("provider-config", "memory", async () => {
      const updated = await updateMemoryProviderConfig(
        profile.profile,
        providerConfig.name,
        providerValues,
        providerConfig.revision,
      );
      setProviderConfig(updated);
      setProviderValues(valuesFromConfig(updated));
    }, "memory");
  };

  const saveMemoryFile = (key: "memory" | "user") => {
    if (!profile || !memoryFiles || !mutationAccess.memory) return;
    const submittedDraft = key === "memory" ? memoryDraft : userDraft;
    const expectedRevision = key === "memory" ? memoryFiles.memory.revision : memoryFiles.user.revision;
    void perform(`memory-file:${key}`, "memory", async () => {
      const updated = await updateBuiltinMemoryFile(profile.profile, key, submittedDraft, expectedRevision);
      setMemoryFiles((current) => current === null ? current : { ...current, [key]: updated });
      if (key === "memory") {
        setMemoryDraft((current) => preserveConcurrentDraft(current, submittedDraft, updated.content));
      } else {
        setUserDraft((current) => preserveConcurrentDraft(current, submittedDraft, updated.content));
      }
      setProfile((current) => {
        if (current === null) return current;
        const builtin = { ...current.memory.builtin };
        if (key === "memory") {
          builtin.memoryBytes = updated.bytes;
          builtin.hasMemory = updated.exists && updated.bytes > 0;
        } else {
          builtin.userBytes = updated.bytes;
          builtin.hasUser = updated.exists && updated.bytes > 0;
        }
        return { ...current, memory: { ...current.memory, builtin } };
      });
    }, "memory");
  };

  const confirmResetMemory = () => {
    if (!profile || !mutationAccess.memory) return;
    const label = resetTarget === "all"
      ? t("settings.memoryReset.targetAll")
      : resetTarget === "memory"
        ? "MEMORY.md"
        : "USER.md";
    if (!window.confirm(t("settings.memoryReset.confirm", { target: label }))) return;
    void perform("memory-reset", "memory", async () => {
      const result = await resetBuiltinMemory(profile.profile, resetTarget);
      setMemoryFiles(result.files);
      setMemoryDraft(result.files.memory.content);
      setUserDraft(result.files.user.content);
      setProfile((current) => current === null ? current : { ...current, memory: result.status });
    }, "memory");
  };

  const ensureGlobalSkillCatalog = useCallback(async () => {
    const candidates = [
      profileId,
      snapshot?.profiles.find((item) => item.id === "default")?.id,
      snapshot?.profiles[0]?.id,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const candidate of candidates) {
      try {
        const settings = await loadProfileSettings(candidate);
        if (settings.skills.length > 0) {
          setGlobalSkillCatalogSource(candidate);
          setGlobalSkillOptions((current) => mergeGlobalSkillOptions(current, settings.skills, parseSkillLines(globalSkills)));
          return;
        }
      } catch {
        // Try the next profile; global skills remain editable as free-form names.
      }
    }
    setGlobalSkillOptions((current) => mergeGlobalSkillOptions(current, [], parseSkillLines(globalSkills)));
  }, [globalSkills, profileId, snapshot?.profiles]);

  useEffect(() => {
    if (visibleTab !== "global") return;
    void ensureGlobalSkillCatalog();
  }, [ensureGlobalSkillCatalog, visibleTab]);

  const toggleGlobalSkill = (name: string, enabled: boolean) => {
    const selected = new Set(parseSkillLines(globalSkills));
    if (enabled) selected.add(name);
    else selected.delete(name);
    setGlobalSkills([...selected].join("\n"));
    setGlobalSkillOptions((current) => mergeGlobalSkillOptions(current, [], [name]));
  };

  const addGlobalSkillDraft = () => {
    const name = globalSkillDraft.trim();
    if (!name) return;
    toggleGlobalSkill(name, true);
    setGlobalSkillDraft("");
  };

  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLocaleLowerCase();
    if (!query) return profile?.skills ?? [];
    return (profile?.skills ?? []).filter((skill) => `${skill.name} ${skill.description} ${skill.category}`.toLocaleLowerCase().includes(query));
  }, [profile, skillQuery]);
  const visibleSkills = filteredSkills.slice(0, skillLimit);
  const filteredConfigFields = useMemo(() => {
    if (!hermesConfig) return [];
    const query = configQuery.trim().toLocaleLowerCase();
    return hermesConfig.fields.filter((field) => {
      if (configCategory && field.category !== configCategory) return false;
      if (!query) return true;
      return `${field.id} ${field.description} ${field.category}`.toLocaleLowerCase().includes(query);
    });
  }, [configCategory, configQuery, hermesConfig]);
  const configDirtyCount = useMemo(() => {
    if (!hermesConfig) return 0;
    return Object.keys(collectConfigChanges(hermesConfig.values, configDraft)).length;
  }, [configDraft, hermesConfig]);

  /** Reload Advanced config only. Never discards local drafts without confirmation. */
  const reloadHermesConfig = () => {
    if (!profileId) return;
    if (configDirtyCount > 0) {
      if (!window.confirm(t("settings.configDiscardConfirm"))) return;
    }
    // Dedicated busy key; failures stay on configError so other Settings tabs remain usable.
    if (!mutations.current.start("hermes-config-reload", "config")) return;
    setBusy(mutations.current.snapshot());
    // Capture before the request: profile switch / full reload advances generation.
    // A late success must not overwrite the new profile; a late failure must not clear it.
    const targetProfile = profileId;
    const requestGeneration = generation.current;
    void (async () => {
      try {
        const updated = await loadProfileHermesConfig(targetProfile);
        if (generation.current !== requestGeneration) return;
        setHermesConfig(updated);
        setConfigDraft({ ...updated.values });
        setConfigError(null);
        if (updated.categories.length > 0) {
          setConfigCategory((current) =>
            current && updated.categories.includes(current) ? current : updated.categories[0]!,
          );
        }
      } catch (reason) {
        if (generation.current !== requestGeneration) return;
        setHermesConfig(null);
        setConfigDraft({});
        setConfigError(errorState(reason));
      } finally {
        // Always release the busy key even when the response is ignored as stale.
        mutations.current.finish("hermes-config-reload");
        setBusy(mutations.current.snapshot());
      }
    })();
  };

  /** Explicit discard of local Advanced drafts back to the last loaded revision. */
  const discardHermesConfigDraft = () => {
    if (!hermesConfig || configDirtyCount === 0) return;
    if (!window.confirm(t("settings.configDiscardConfirm"))) return;
    setConfigDraft({ ...hermesConfig.values });
  };

  const filteredPrivilegedFields = useMemo(() => {
    if (!privilegedConfig) return [];
    const query = privilegedQuery.trim().toLocaleLowerCase();
    return privilegedConfig.fields.filter((field) => {
      if (privilegedCategory && field.category !== privilegedCategory) return false;
      if (!query) return true;
      return `${field.id} ${field.description} ${field.category}`.toLocaleLowerCase().includes(query);
    });
  }, [privilegedCategory, privilegedConfig, privilegedQuery]);

  const privilegedDirtyCount = useMemo(() => {
    if (!privilegedConfig) return 0;
    return Object.keys(collectConfigChanges(privilegedConfig.values, privilegedDraft)).length;
  }, [privilegedConfig, privilegedDraft]);

  const reloadPrivilegedConfig = () => {
    if (!profileId || !mutationAccess.privileged) return;
    if (privilegedDirtyCount > 0) {
      if (!window.confirm(t("settings.privileged.discardConfirm"))) return;
    }
    if (!mutations.current.start("privileged-config-reload", "privileged")) return;
    setBusy(mutations.current.snapshot());
    const targetProfile = profileId;
    const requestGeneration = generation.current;
    void (async () => {
      try {
        const [updated, secrets] = await Promise.all([
          loadPrivilegedProfileConfig(targetProfile),
          loadProfileSecrets(targetProfile),
        ]);
        if (generation.current !== requestGeneration) return;
        setPrivilegedConfig(updated);
        setPrivilegedDraft({ ...updated.values });
        setPrivilegedError(null);
        setProfileSecrets(secrets);
        setSecretDrafts({});
        setSecretError(null);
        if (updated.categories.length > 0) {
          setPrivilegedCategory((current) =>
            current && updated.categories.includes(current) ? current : updated.categories[0]!,
          );
        }
      } catch (reason) {
        if (generation.current !== requestGeneration) return;
        setPrivilegedConfig(null);
        setPrivilegedDraft({});
        setPrivilegedError(errorState(reason));
      } finally {
        mutations.current.finish("privileged-config-reload");
        setBusy(mutations.current.snapshot());
      }
    })();
  };

  const discardPrivilegedDraft = () => {
    if (!privilegedConfig || privilegedDirtyCount === 0) return;
    if (!window.confirm(t("settings.privileged.discardConfirm"))) return;
    setPrivilegedDraft({ ...privilegedConfig.values });
  };

  const savePrivilegedConfig = () => {
    if (!profileId || !privilegedConfig || !mutationAccess.privileged) return;
    const changes = collectConfigChanges(privilegedConfig.values, privilegedDraft);
    const keys = Object.keys(changes);
    if (keys.length === 0) return;
    const needsConfirm = keys.some((key) => {
      const field = privilegedConfig.fields.find((item) => item.id === key);
      return field?.requiresConfirmation === true;
    });
    if (needsConfirm && !window.confirm(t("settings.privileged.confirmSave"))) return;
    const expectedRevision = privilegedConfig.revision;
    const submitted = { ...privilegedDraft };
    const targetProfile = profileId;
    const requestGeneration = generation.current;
    void perform("privileged-config", "privileged", async () => {
      const updated = await updatePrivilegedProfileConfig(targetProfile, {
        expectedRevision,
        changes,
        ...(needsConfirm ? { confirmed: true as const } : {}),
      });
      if (generation.current !== requestGeneration) return;
      setPrivilegedConfig(updated);
      setPrivilegedError(null);
      setPrivilegedDraft((current) => {
        const next = { ...updated.values };
        for (const [key, value] of Object.entries(current)) {
          if (!(key in changes) && JSON.stringify(value) !== JSON.stringify(submitted[key])) {
            next[key] = value;
          }
        }
        return next;
      });
    }, "privileged-config");
  };

  const secretConfirmLabel = (field: HermesSecretFieldMeta): string =>
    field.source === "memory-provider"
      ? `${field.providerLabel || field.provider || "provider"} / ${field.label || field.key}`
      : (field.label || field.key);

  const submitSecretTransfer = (
    field: HermesSecretFieldMeta,
    value: string,
    confirmMessage: string,
  ) => {
    if (!profileId || !profileSecrets || !mutationAccess.privileged) return;
    if (!window.confirm(confirmMessage)) return;
    const draftKey = secretFieldDraftKey(field);
    const targetProfile = profileId;
    const expectedRevision = profileSecrets.revision;
    const requestGeneration = generation.current;
    void perform(`secret:${draftKey}`, "secret", async () => {
      // Secret bytes (including empty clear) go through Tauri IPC only.
      // Browser fetch carries transferId + field metadata, never the value.
      let transferId: string;
      try {
        transferId = await depositSecretTransfer(value);
      } finally {
        // Write-only control stays blank after every deposit attempt.
        setSecretDrafts((current) => {
          const next = { ...current };
          delete next[draftKey];
          return next;
        });
      }
      const updated = await consumeSecretTransfer(targetProfile, {
        transferId,
        key: field.key,
        source: field.source,
        ...(field.provider === undefined ? {} : { provider: field.provider }),
        expectedRevision,
      });
      if (generation.current !== requestGeneration) return;
      setProfileSecrets(updated);
      setSecretError(null);
      setSecretDrafts({});
    }, "secret");
  };

  const saveSecretField = (field: HermesSecretFieldMeta) => {
    if (!profileId || !profileSecrets || !mutationAccess.privileged) return;
    const draftKey = secretFieldDraftKey(field);
    const value = secretDrafts[draftKey] ?? "";
    // Blank input is a no-op for ordinary Save (use Clear to unset).
    if (value === "") return;
    submitSecretTransfer(
      field,
      value,
      t("settings.privileged.secretConfirm", { key: secretConfirmLabel(field) }),
    );
  };

  const clearSecretField = (field: HermesSecretFieldMeta) => {
    if (!profileId || !profileSecrets || !mutationAccess.privileged) return;
    // canClear is a UI hint only; server recomputes clear safety.
    if (!field.isSet || !field.canClear) return;
    submitSecretTransfer(
      field,
      "",
      t("settings.privileged.secretClearConfirm", { key: secretConfirmLabel(field) }),
    );
  };

  const parsedGlobalSkills = parseSkillLines(globalSkills);
  const globalContextBytes = globalContextUtf8Bytes(globalContext);
  const globalContextValid = isGlobalContextWithinBudget(globalContext);
  const globalSkillsValid = parsedGlobalSkills.length <= GLOBAL_SETTINGS_MAX_SKILLS;
  const currentTabWritable = canMutateSettingsTab(mutationAccess, visibleTab);

  const profileName = profileLabel || profile?.profile || profileId || t("settings.noProfile");
  const globalDirty = global !== null && (
    global.context !== globalContext ||
    global.skills.join("\n") !== parsedGlobalSkills.join("\n") ||
    global.sharedContextEnabled !== sharedContext ||
    global.sharedSkillsEnabled !== sharedSkills
  );
  const soulDirty = profile !== null && profile.soul.content !== soulDraft;
  const agentBehaviorDirty = agentBehavior !== null && (
    (agentBehavior.subagentMode === "auto") !== subagentAuto
    || agentBehavior.preferredCandidateIds.join("\0") !== preferredCandidateIds.join("\0")
    || JSON.stringify(sharedSubagentCandidates) !== JSON.stringify(initialSharedCandidatesRef.current)
  );
  const providerConfigDirty = providerConfig !== null && JSON.stringify(providerValues) !== JSON.stringify(valuesFromConfig(providerConfig));
  const memoryFileDirty = memoryFiles !== null && memoryFiles.memory.content !== memoryDraft;
  const userFileDirty = memoryFiles !== null && memoryFiles.user.content !== userDraft;
  const memoryBusy = busy.has("provider") || busy.has("provider-config")
    || busy.has("memory-file:memory") || busy.has("memory-file:user") || busy.has("memory-reset");

  return (
    <section class="live-settings" aria-busy={loading}>
      {showMast && (
        <header class="live-settings__mast">
          <div>
            <h1>{settingsTitle}</h1>
          </div>
          {showTarget && (
            <div class="live-settings__target">
              <span>{t("settings.target")}</span>
              <b>{profileName}</b>
            </div>
          )}
        </header>
      )}

      {showTabs && (
        <nav class="live-settings__tabs" aria-label={t("settings.categories")}>
          {allowedTabs.map((id) => (
            <button
              key={id}
              type="button"
              class={visibleTab === id ? "is-active" : ""}
              aria-current={visibleTab === id ? "page" : undefined}
              aria-label={tabLabels[id]}
              title={tabLabels[id]}
              onClick={() => { setTab(id); onTabChange?.(id); }}
              disabled={id !== "global" && id !== "host" && !profileId}
              // Keep tabs clickable even while background refresh is running.
            >
              <span>{tabLabels[id]}</span>
              {globalHostTabDetails[id] && <small>{globalHostTabDetails[id]}</small>}
            </button>
          ))}
        </nav>
      )}

      {scope === "global-host" && (
        <header class="settings-scope-intro">
          <span>{visibleTab === "host" ? t("settings.scope.hostEyebrow") : t("settings.scope.globalEyebrow")}</span>
          <h1>{tabLabels[visibleTab]}</h1>
          <p>{visibleTab === "host" ? t("settings.scope.hostLead") : t("settings.scope.globalLead")}</p>
        </header>
      )}

      {visibleTab !== "host" && !currentTabWritable && (
        <div class="live-settings__notice is-read-only" role="status">
          <span>{t("settings.readOnly")}</span>
          <p>{mutationAccess.localOwner ? t("settings.permissionUnavailable") : t("settings.localOwnerRequired")}</p>
        </div>
      )}

      {error && (
        <div class={`live-settings__notice ${error.conflict ? "is-conflict" : "is-error"}`} role="alert">
          <span>{error.conflict ? t("settings.conflict") : t("settings.offline")}</span>
          <p>{localizeRuntimeMessage(error.message)}</p>
          <button type="button" onClick={() => void reload({ force: true })} aria-label={t("settings.reload")} title={t("settings.reload")}><RefreshIcon /></button>
        </div>
      )}

      {loading && !error && visibleTab !== "host" && !profile && !(scope === "global-host" && global) ? (
        <SettingsSkeleton />
      ) : visibleTab === "host" ? (
        showDeviceAdmin && (
          <>
            <section class="settings-host-group" aria-labelledby="settings-host-runtime-title">
              <header>
                <h2 id="settings-host-runtime-title">{t("settings.host.runtimeTitle")}</h2>
                <p>{t("settings.host.runtimeLead")}</p>
              </header>
              <HermesAgentUpdate permitted={mutationAccess.hermesUpdate} />
              <HostApps permitted={mutationAccess.hostApps} vaultAccess={mutationAccess.obsidianVaults} />
            </section>
            <section class="settings-host-group" aria-labelledby="settings-host-access-title">
              <header>
                <h2 id="settings-host-access-title">{t("settings.host.accessTitle")}</h2>
                <p>{t("settings.host.accessLead")}</p>
              </header>
              <DeviceAdmin />
              {showAccessAudit && canReadAudit && <AccessAudit />}
            </section>
          </>
        )
      ) : visibleTab === "global" ? (
        <div class="live-settings__global">
          {global?.skillSync.state === "pending" && (
            <div class="live-settings__notice is-conflict settings-sync-notice" role="status">
              <span>{t("settings.syncPending")}</span>
              <p>{t("settings.syncPendingDetail")}</p>
              <div class="settings-sync-failures" aria-label={t("settings.syncFailures")}>
                {global.skillSync.failures.slice(0, 5).map((failure) => (
                  <small key={`${failure.profile}-${failure.skill}-${failure.operation}`}>{failure.profile} / {failure.skill} / {failure.operation}</small>
                ))}
              </div>
            </div>
          )}
          <div class="settings-ledger">
            <SectionHead title={t("settings.inheritance")} note={`revision ${global?.revision ?? "—"}`} info={t("settings.inherit")} />
            <SwitchRow label={t("settings.sharedSkills")} detail={t("settings.sharedSkillsDetail")} checked={sharedSkills} disabled={!mutationAccess.global} onChange={setSharedSkills} />
            <SwitchRow label={t("settings.sharedContext")} detail={t("settings.sharedContextDetail")} checked={sharedContext} disabled={!mutationAccess.global} onChange={setSharedContext} />
          </div>
          <div class="settings-global-stack">
            <div class="settings-ledger">
              <SectionHead title={t("settings.globalSkills")} note={t("settings.skillBudget", { count: parsedGlobalSkills.length, max: GLOBAL_SETTINGS_MAX_SKILLS })} info={t("settings.globalSkillsHelp")} />
              <div class="settings-global-skill-picker" role="group" aria-label={t("settings.globalSkills")} aria-invalid={!globalSkillsValid}>
                {globalSkillOptions.length === 0 ? (
                  <p class="settings-empty">{t("settings.globalSkillsEmpty")}</p>
                ) : globalSkillOptions.map((skill) => {
                  const checked = parsedGlobalSkills.includes(skill.name);
                  const hasDetail = skill.category !== "" || skill.description !== "" || skill.provenance !== "unknown";
                  return (
                    <span class={`settings-global-skill-option ${checked ? "is-checked" : ""}`} key={skill.name}>
                      <label>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!mutationAccess.global || (!checked && parsedGlobalSkills.length >= GLOBAL_SETTINGS_MAX_SKILLS)}
                          onChange={(event) => toggleGlobalSkill(skill.name, event.currentTarget.checked)}
                        />
                        <span>{skill.name}</span>
                      </label>
                      {hasDetail && (
                        <InfoTip
                          text={[
                            skill.description || t("settings.noDescription"),
                            [skill.category, skill.provenance !== "unknown" ? skill.provenance : ""].filter(Boolean).join(" · "),
                            skill.usage > 0 ? t("settings.usage.hermesOnly", { count: skill.usage }) : t("settings.usage.none"),
                          ].filter(Boolean).join(" — ")}
                          align="center"
                        />
                      )}
                    </span>
                  );
                })}
              </div>
              {globalSkillCatalogSource && globalSkillOptions.some((skill) => skill.category !== "" || skill.description !== "") && (
                <small class="settings-global-skill-source">{t("settings.globalSkillsSource", { profile: globalSkillCatalogSource })}</small>
              )}
              <div class="settings-global-skill-add">
                <input
                  type="text"
                  value={globalSkillDraft}
                  disabled={!mutationAccess.global}
                  placeholder={t("settings.globalSkillsAddPlaceholder")}
                  aria-label={t("settings.globalSkillsAddPlaceholder")}
                  onInput={(event) => setGlobalSkillDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addGlobalSkillDraft();
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={!mutationAccess.global || !globalSkillDraft.trim() || parsedGlobalSkills.length >= GLOBAL_SETTINGS_MAX_SKILLS}
                  onClick={addGlobalSkillDraft}
                >
                  {t("settings.globalSkillsAdd")}
                </button>
              </div>
              <small class={`settings-budget ${globalSkillsValid ? "" : "is-over"}`}>{t("settings.skillBudget", { count: parsedGlobalSkills.length, max: GLOBAL_SETTINGS_MAX_SKILLS })}</small>
            </div>
            <div class="settings-ledger">
              <SectionHead title={t("settings.sharedContext")} info={t("settings.noSecrets")} />
              <textarea value={globalContext} onInput={(event) => setGlobalContext(event.currentTarget.value)} rows={8} disabled={!mutationAccess.global} aria-invalid={!globalContextValid} aria-describedby="global-context-budget" placeholder={t("settings.contextPlaceholder")} />
              <small id="global-context-budget" class={`settings-budget ${globalContextValid ? "" : "is-over"}`}>{t("settings.contextBudget", { count: globalContextBytes, max: GLOBAL_CONTEXT_MAX_UTF8_BYTES })}</small>
            </div>
          </div>
          <div class="settings-ledger settings-ledger--actions">
            <ActionBar dirty={globalDirty} retryPending={global?.skillSync.state === "pending"} busy={busy.has("global")} permitted={mutationAccess.global} valid={globalContextValid && globalSkillsValid} onSave={saveGlobal} />
          </div>
        </div>
      ) : !profile ? (
        <EmptyProfile onReload={reload} />
      ) : visibleTab === "project" ? (
        (() => {
          const profileId = profile.profile;
          const isDefault = profileId === "default";
          const logicalHome = isDefault
            ? t("settings.project.homeDefault")
            : t("settings.project.homeNamed", { id: profileId });
          const relativePath = isDefault ? "HERMES_HOME" : `HERMES_HOME/profiles/${profileId}`;
          return (
            <div class="live-settings__project">
              <div class="settings-ledger settings-ledger--wide">
                <SectionHead
                  title={t("settings.project")}
                  info={[t("settings.project.note"), t("settings.project.help"), t("settings.project.pathPrivacy")].join(" ")}
                />
                <dl class="settings-project-meta">
                  <div>
                    <dt>{t("settings.project.profile")}</dt>
                    <dd><code>{profileId}</code></dd>
                  </div>
                  <div>
                    <dt>{t("settings.project.displayName")}</dt>
                    <dd>
                      <form
                        class="settings-project-name"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!profileId || !projectNameDirty) return;
                          setProfileDisplayName(profileId, projectNameDraft);
                        }}
                      >
                        <input
                          type="text"
                          value={projectNameDraft}
                          maxLength={40}
                          placeholder={projectProfileSummary?.name || profileId}
                          aria-label={t("profile.displayName")}
                          onInput={(event) => setProjectNameDraft(event.currentTarget.value)}
                        />
                        <button type="submit" disabled={!projectNameDirty} aria-label={t("profile.saveName")} title={t("profile.saveName")}><SaveIcon /></button>
                      </form>
                      <InfoTip text={t("profile.nameLocalNote")} align="start" />
                    </dd>
                  </div>
                  <div>
                    <dt>{t("settings.project.boundDirectory")}</dt>
                    <dd>{logicalHome}</dd>
                  </div>
                  <div>
                    <dt>{t("settings.project.relativePath")}</dt>
                    <dd><code>{relativePath}</code></dd>
                  </div>
                  <div>
                    <dt>{t("settings.project.sessionCwd")}</dt>
                    <dd>{t("settings.project.sessionCwdValue")}</dd>
                  </div>
                  <div>
                    <dt>{t("settings.project.memoryPath")}</dt>
                    <dd><code>{relativePath}/memories</code></dd>
                  </div>
                </dl>
              </div>
              <div class="settings-ledger settings-ledger--wide">
                <SectionHead
                  title={t("settings.projects.title")}
                  info={[t("settings.projects.lead"), t("settings.projects.note")].join(" ")}
                />
                {projectsError && (
                  <div class="live-settings__notice is-error" role="alert">
                    <p>{localizeRuntimeMessage(projectsError.message)}</p>
                  </div>
                )}
                {!profileProjects ? (
                  !projectsError && <p class="settings-project-help">{t("settings.projects.loading")}</p>
                ) : (
                  <>
                    {profileProjects.projects.length === 0 && (
                      <p class="settings-project-help">{t("settings.projects.empty")}</p>
                    )}
                    <ul class="settings-projects">
                      {profileProjects.projects.map((project) => {
                        const renameDraft = renameDrafts[project.id] ?? project.name;
                        const folderDraft = folderDrafts[project.id] ?? "";
                        const projectBusy = busy.has(`projects:rename:${project.id}`)
                          || busy.has(`projects:delete:${project.id}`)
                          || busy.has(`projects:folder:${project.id}`);
                        const controlsDisabled = !mutationAccess.project || projectBusy;
                        const menuOpen = projectMenuId === project.id;
                        const editing = projectEditId === project.id;
                        const folderFormOpen = projectFolderFormId === project.id;
                        return (
                          <li class="settings-projects__item" key={project.id}>
                            <div class="settings-projects__head">
                              {editing ? (
                                <form
                                  class="settings-projects__rename"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    saveProjectRename(project.id);
                                    setProjectEditId(null);
                                  }}
                                >
                                  <input
                                    type="text"
                                    value={renameDraft}
                                    maxLength={200}
                                    disabled={controlsDisabled}
                                    aria-label={t("settings.projects.nameLabel")}
                                    onInput={(event) => setRenameDrafts((current) => ({ ...current, [project.id]: event.currentTarget.value }))}
                                  />
                                  <button
                                    type="submit"
                                    disabled={controlsDisabled || renameDraft.trim() === "" || renameDraft.trim() === project.name}
                                    aria-label={t("settings.projects.renameSave")}
                                    title={t("settings.projects.renameSave")}
                                  ><SaveIcon /></button>
                                  <button
                                    type="button"
                                    class="settings-projects__quiet"
                                    aria-label={t("settings.skillEditor.close")}
                                    title={t("settings.skillEditor.close")}
                                    onClick={() => { setProjectEditId(null); setProjectFolderFormId(null); }}
                                  ><CloseIcon /></button>
                                </form>
                              ) : (
                                <span class="settings-projects__name">
                                  <b>{project.name}</b>
                                  {project.folders.some((folder) => folder.isPrimary) && (
                                    <span class="settings-projects__status is-primary"><i aria-hidden="true" /></span>
                                  )}
                                </span>
                              )}
                              {project.archived && <span class="settings-projects__status"><i aria-hidden="true" /><InfoTip text={t("settings.projects.archived")} align="start" /></span>}
                              {!editing && (
                                <button
                                  type="button"
                                  class="settings-projects__edit"
                                  disabled={!mutationAccess.project}
                                  aria-label={t("settings.projects.edit")}
                                  title={t("settings.projects.edit")}
                                  onClick={() => {
                                    setProjectMenuId(null);
                                    if (folderFormOpen) { setProjectFolderFormId(null); setProjectEditId(null); }
                                    else { setProjectFolderFormId(project.id); setProjectEditId(project.id); }
                                  }}
                                ><EditIcon /></button>
                              )}
                              <span class="settings-projects__menu-wrap">
                                <button
                                  type="button"
                                  class="settings-projects__menu-trigger"
                                  disabled={!mutationAccess.project}
                                  aria-haspopup="menu"
                                  aria-expanded={menuOpen}
                                  aria-label={t("sidebar.menu.trigger")}
                                  title={t("sidebar.menu.trigger")}
                                  onClick={() => setProjectMenuId(menuOpen ? null : project.id)}
                                >⋯</button>
                                {menuOpen && (
                                  <div class="settings-projects__menu" role="menu">
                                    <button
                                      type="button"
                                      role="menuitem"
                                      disabled={controlsDisabled}
                                      onClick={() => { setProjectMenuId(null); setProjectEditId(project.id); setProjectFolderFormId(null); }}
                                    ><EditIcon /> {t("settings.projects.rename")}</button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      disabled={controlsDisabled}
                                      onClick={() => { setProjectMenuId(null); setDirPickerTarget(project.id); }}
                                    ><PlusIcon /> {t("settings.projects.addFolder")}</button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      disabled={controlsDisabled}
                                      onClick={() => { setProjectMenuId(null); setProjectFolderFormId(project.id); setProjectEditId(null); }}
                                    ><EditIcon /> {t("settings.projects.pathDirect")}</button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      class="is-destructive"
                                      disabled={controlsDisabled}
                                      onClick={() => { setProjectMenuId(null); removeProject(project.id, project.name); }}
                                    ><TrashIcon /> {t("settings.projects.delete")}</button>
                                  </div>
                                )}
                              </span>
                            </div>
                            {(editing || folderFormOpen) && (
                              <ul class="settings-projects__folders">
                                {project.folders.map((folder) => (
                                  <li key={folder.path}>
                                    <code>{folder.path}</code>
                                    {folder.isPrimary && <span class="settings-projects__status is-primary"><i aria-hidden="true" /><InfoTip text={t("settings.projects.primary")} align="start" /></span>}
                                    <button
                                      type="button"
                                      disabled={controlsDisabled}
                                      title={t("settings.projects.removeFolder")}
                                      aria-label={`${t("settings.projects.removeFolder")}: ${folder.path}`}
                                      onClick={() => removeProjectFolder(project.id, folder.path)}
                                    ><TrashIcon /></button>
                                  </li>
                                ))}
                                {project.folders.length === 0 && (
                                  <li class="settings-projects__nofolders">{t("settings.projects.noFolders")}</li>
                                )}
                              </ul>
                            )}
                            {folderFormOpen && (
                              <form
                                class="settings-projects__addfolder"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  addProjectFolder(project.id);
                                }}
                              >
                                <button
                                  type="button"
                                  class="settings-projects__browse"
                                  disabled={controlsDisabled}
                                  onClick={() => setDirPickerTarget(project.id)}
                                ><PlusIcon /> {t("settings.projects.browse")}</button>
                                <input
                                  type="text"
                                  value={folderDraft}
                                  placeholder={t("settings.projects.folderPlaceholder")}
                                  disabled={controlsDisabled}
                                  aria-label={t("settings.projects.addFolder")}
                                  onInput={(event) => setFolderDrafts((current) => ({ ...current, [project.id]: event.currentTarget.value }))}
                                />
                                <button type="submit" disabled={controlsDisabled || folderDraft.trim() === ""} aria-label={t("settings.projects.addFolder")} title={t("settings.projects.addFolder")}>
                                  <PlusIcon />
                                </button>
                                <button
                                  type="button"
                                  class="settings-projects__quiet"
                                  aria-label={t("settings.skillEditor.close")}
                                  title={t("settings.skillEditor.close")}
                                  onClick={() => setProjectFolderFormId(null)}
                                ><CloseIcon /></button>
                              </form>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    {/* New project: name is optional (defaults to the folder name); the folder always comes from the picker. */}
                    {newProjectFormOpen ? (
                      <form
                        class="settings-projects__create"
                        onSubmit={(event) => {
                          event.preventDefault();
                          setDirPickerTarget("new");
                        }}
                      >
                        <input
                          type="text"
                          value={newProjectName}
                          maxLength={200}
                          placeholder={t("settings.projects.namePlaceholder")}
                          disabled={!mutationAccess.project || busy.has("projects:create")}
                          aria-label={t("settings.projects.namePlaceholder")}
                          onInput={(event) => setNewProjectName(event.currentTarget.value)}
                        />
                        <button
                          type="submit"
                          class="settings-projects__browse"
                          disabled={!mutationAccess.project || busy.has("projects:create")}
                        >{t("settings.projects.chooseFolder")}</button>
                        <button
                          type="button"
                          class="settings-projects__quiet"
                          aria-label={t("settings.skillEditor.close")}
                          title={t("settings.skillEditor.close")}
                          disabled={busy.has("projects:create")}
                          onClick={() => setNewProjectFormOpen(false)}
                        ><CloseIcon /></button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        class="settings-projects__new"
                        disabled={!mutationAccess.project || busy.has("projects:create")}
                        onClick={() => setNewProjectFormOpen(true)}
                      ><PlusIcon /> {t("settings.projects.create")}</button>
                    )}
                    {dirPickerTarget && (
                      <DirectoryPicker
                        onPick={applyPickedDirectory}
                        onClose={() => setDirPickerTarget(null)}
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })()
      ) : visibleTab === "skills" ? (
        <div class="live-settings__skills">
          <div class="settings-toolbar">
            <div><b>{profile.skills.filter((skill) => skill.enabled).length}</b><span>{t("settings.enabledAvailable", { count: profile.skills.length })}</span></div>
            <input type="search" value={skillQuery} onInput={(event) => setSkillQuery(event.currentTarget.value)} placeholder={t("settings.skillSearch")} aria-label={t("settings.skillSearch")} />
          </div>
          <div class="skill-switchboard">
            {visibleSkills.map((skill) => (
              <article class={`skill-line ${skill.enabled ? "is-enabled" : ""}`} key={skill.name}>
                <button
                  type="button"
                  class="skill-line__open"
                  aria-label={t("settings.skillEditor.openAria", { name: skill.name })}
                  title={t("settings.skillEditor.openAria", { name: skill.name })}
                  onClick={() => openSkillEditor(skill.name)}
                >
                  <span class="skill-line__light" aria-hidden="true" />
                  <div>
                    <b>{skill.name}</b>
                    <span class="skill-line__usage">{skillUsageLabel(skill.usage, usageBySkill.get(skill.name))}</span>
                  </div>
                  <small>{skill.provenance} · {skill.category}</small>
                </button>
                <InfoTip text={skill.description || t("settings.noDescription")} align="end" />
                <button
                  type="button"
                  class="skill-line__toggle"
                  role="switch"
                  aria-checked={skill.enabled}
                  aria-label={skill.enabled ? "ON" : "OFF"}
                  title={skill.enabled ? "ON" : "OFF"}
                  disabled={!mutationAccess.skill || busy.has(`skill:${skill.name}`)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSkill(skill.name, skill.enabled);
                  }}
                >
                  <span class="skill-line__toggle-dot" aria-hidden="true" />
                </button>
              </article>
            ))}
            {filteredSkills.length === 0 && <p class="settings-empty">{t("settings.noSkills")}</p>}
            {filteredSkills.length > visibleSkills.length && (
              <button class="settings-load-more" type="button" onClick={() => setSkillLimit((current) => current + 30)} aria-label={t("settings.showMore", { count: filteredSkills.length - visibleSkills.length })} title={t("settings.showMore", { count: filteredSkills.length - visibleSkills.length })}>
                <PlusIcon />
              </button>
            )}
          </div>
        </div>
      ) : visibleTab === "soul" ? (
        <div class="live-settings__soul">
          {!profile ? (
            <div class="settings-empty settings-empty--profile">
              <b>{t("settings.loading")}</b>
              <p>{error ? localizeRuntimeMessage(error.message) : t("settings.selectProfile")}</p>
              <button type="button" onClick={() => void reload({ force: true })} aria-label={t("settings.reload")} title={t("settings.reload")}><RefreshIcon /></button>
            </div>
          ) : (
            <>
              <div class="settings-ledger settings-ledger--editor">
                <SectionHead title={`${profile.profile} / SOUL.md`} note={`revision ${shortRevision(profile.soul.revision)}`} info={t("settings.soulNote")} />
                {profile.soul.redacted && <p class="settings-warning">{t("settings.redacted")}</p>}
                <textarea value={soulDraft} onInput={(event) => setSoulDraft(event.currentTarget.value)} rows={18} disabled={profile.soul.redacted || !mutationAccess.soul} spellcheck={false} />
                <ActionBar dirty={soulDirty && !profile.soul.redacted} busy={busy.has("soul")} permitted={mutationAccess.soul} onSave={saveSoul} />
              </div>
              {agentBehavior && (
            <div class="settings-ledger">
              <SectionHead
                title={t("settings.subagents.title")}
                note={`revision ${agentBehavior.revision}`}
                info={t("settings.subagents.note")}
              />
              <SwitchRow
                label={t("settings.subagents.auto")}
                detail={t("settings.subagents.autoDetail")}
                checked={subagentAuto}
                disabled={!mutationAccess.soul}
                onChange={setSubagentAuto}
              />
              <div class="settings-subagent-candidates">
                <div class="settings-subagent-candidates-head">
                  <div class="heading-info-group">
                    <span>{t("settings.subagents.candidates")}</span>
                    <InfoTip text={t("settings.subagents.candidatesHelp")} align="start" />
                  </div>
                  <button
                    type="button"
                    class="settings-subagent-add"
                    disabled={!mutationAccess.soul || sharedSubagentCandidates.length >= 12}
                    aria-label={t("settings.subagents.addCandidate")}
                    title={t("settings.subagents.addCandidate")}
                    onClick={() => {
                      const id = `candidate-${crypto.randomUUID().slice(0, 8)}`;
                      setSharedSubagentCandidates((current) => [
                        ...current,
                        {
                          id,
                          label: t("settings.subagents.candidateDefaultLabel", { index: current.length + 1 }),
                          provider: "",
                          model: "",
                          reasoningEffort: "",
                          enabled: true,
                        },
                      ]);
                    }}
                  >
                    <PlusIcon />
                  </button>
                </div>
                {sharedSubagentCandidates.length === 0 && (
                  <p class="settings-subagent-empty">{t("settings.subagents.candidatesEmpty")}</p>
                )}
                {sharedSubagentCandidates.map((candidate, index) => {
                  const selectedRank = preferredCandidateIds.indexOf(candidate.id);
                  const models = subagentModelsByProvider[candidate.provider] ?? [];
                  return (
                    <article class="settings-subagent-candidate" key={candidate.id}>
                      <label class="settings-subagent-check">
                        <input
                          type="checkbox"
                          checked={selectedRank >= 0}
                          disabled={!mutationAccess.soul || !candidate.enabled}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setPreferredCandidateIds((current) => {
                              if (checked) {
                                if (current.includes(candidate.id)) return current;
                                return [...current, candidate.id].slice(0, 3);
                              }
                              return current.filter((id) => id !== candidate.id);
                            });
                          }}
                        />
                        <span class="settings-subagent-check-label">
                          <span>
                            {selectedRank >= 0
                              ? t("settings.subagents.priority", { rank: selectedRank + 1 })
                              : t("settings.subagents.useCandidate")}
                          </span>
                          {index === 0 && <InfoTip text={t("settings.subagents.fallbackHelp")} align="start" />}
                        </span>
                      </label>
                      <label class="settings-field">
                        <span>{t("settings.subagents.candidateLabel")}</span>
                        <input
                          type="text"
                          value={candidate.label}
                          disabled={!mutationAccess.soul}
                          onInput={(event) => {
                            const value = event.currentTarget.value;
                            setSharedSubagentCandidates((current) => current.map((item, itemIndex) => (
                              itemIndex === index ? { ...item, label: value } : item
                            )));
                          }}
                        />
                      </label>
                      <div class="settings-subagent-grid">
                        <label class="settings-field">
                          <span>{t("chat.provider.label")}</span>
                          <select
                            value={candidate.provider}
                            disabled={!mutationAccess.soul}
                            onFocus={() => { void ensureSubagentProviders(); }}
                            onChange={(event) => {
                              const provider = event.currentTarget.value;
                              setSharedSubagentCandidates((current) => current.map((item, itemIndex) => (
                                itemIndex === index ? { ...item, provider, model: "" } : item
                              )));
                              if (provider) void ensureSubagentModels(provider);
                            }}
                          >
                            <option value="">{t("chat.model.default")}</option>
                            {subagentProviders.map((provider) => (
                              <option key={provider.id} value={provider.id}>{provider.label}</option>
                            ))}
                            {candidate.provider && !subagentProviders.some((provider) => provider.id === candidate.provider) && (
                              <option value={candidate.provider}>{candidate.provider}</option>
                            )}
                          </select>
                        </label>
                        <label class="settings-field">
                          <span>{t("chat.model.label")}</span>
                          <select
                            value={candidate.model}
                            disabled={!mutationAccess.soul}
                            onFocus={() => { if (candidate.provider) void ensureSubagentModels(candidate.provider); }}
                            onChange={(event) => {
                              const model = event.currentTarget.value;
                              setSharedSubagentCandidates((current) => current.map((item, itemIndex) => (
                                itemIndex === index ? { ...item, model } : item
                              )));
                            }}
                          >
                            <option value="">{t("chat.model.default")}</option>
                            {models.map((model) => (
                              <option key={model.id} value={model.id}>{model.label}</option>
                            ))}
                            {candidate.model && !models.some((model) => model.id === candidate.model) && (
                              <option value={candidate.model}>{candidate.model}</option>
                            )}
                          </select>
                        </label>
                        <label class="settings-field">
                          <span>{t("chat.model.reasoning.label")}</span>
                          <select
                            value={candidate.reasoningEffort}
                            disabled={!mutationAccess.soul}
                            onChange={(event) => {
                              const reasoningEffort = event.currentTarget.value;
                              setSharedSubagentCandidates((current) => current.map((item, itemIndex) => (
                                itemIndex === index ? { ...item, reasoningEffort } : item
                              )));
                            }}
                          >
                            <option value="">{t("chat.model.reasoning.default")}</option>
                            {REASONING_EFFORT_VALUES.map((effort) => (
                              <option key={effort} value={effort}>{effort}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div class="settings-subagent-row-actions">
                        <label class="settings-subagent-enabled">
                          <input
                            type="checkbox"
                            checked={candidate.enabled}
                            disabled={!mutationAccess.soul}
                            onChange={(event) => {
                              const enabled = event.currentTarget.checked;
                              setSharedSubagentCandidates((current) => current.map((item, itemIndex) => (
                                itemIndex === index ? { ...item, enabled } : item
                              )));
                              if (!enabled) {
                                setPreferredCandidateIds((current) => current.filter((id) => id !== candidate.id));
                              }
                            }}
                          />
                          <span>{t("settings.subagents.candidateEnabled")}</span>
                        </label>
                        <button
                          type="button"
                          class="settings-subagent-remove"
                          disabled={!mutationAccess.soul}
                          aria-label={t("settings.subagents.removeCandidate")}
                          title={t("settings.subagents.removeCandidate")}
                          onClick={() => {
                            setSharedSubagentCandidates((current) => current.filter((item) => item.id !== candidate.id));
                            setPreferredCandidateIds((current) => current.filter((id) => id !== candidate.id));
                          }}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
              <ActionBar dirty={agentBehaviorDirty} busy={busy.has("agent-behavior")} permitted={mutationAccess.soul} onSave={saveAgentBehavior} />
            </div>
          )}
            </>
          )}
        </div>
      ) : visibleTab === "privileged" ? (
        <div class="live-settings__config live-settings__privileged">
          <div class="settings-ledger settings-ledger--wide settings-info-banner">
            <SectionHead
              title={t("settings.privileged")}
              info={[t("settings.privileged.lead"), t("settings.privileged.desktopOnlyNote"), t("settings.privileged.applyNote")].join(" ")}
            />
          </div>
          {!mutationAccess.privileged ? (
            <div class="live-settings__notice is-read-only" role="status">
              <span>{t("settings.privileged.unavailableTitle")}</span>
              <p>{t("settings.privileged.unavailableDetail")}</p>
            </div>
          ) : (
            <>
              {privilegedError && (
                <div class={`live-settings__notice ${privilegedError.conflict ? "is-conflict" : "is-error"}`} role="alert">
                  <span>{privilegedError.conflict ? t("settings.conflict") : t("settings.privileged.unavailableTitle")}</span>
                  <p>{localizeRuntimeMessage(privilegedError.message)}</p>
                  <button
                    type="button"
                    disabled={busy.has("privileged-config-reload") || busy.has("privileged-config")}
                    onClick={() => reloadPrivilegedConfig()}
                    aria-label={busy.has("privileged-config-reload") ? t("settings.loading") : t("settings.privileged.reload")}
                    title={busy.has("privileged-config-reload") ? t("settings.loading") : t("settings.privileged.reload")}
                  >
                    <RefreshIcon />
                  </button>
                </div>
              )}
              {!privilegedConfig ? (
                !privilegedError && <p class="settings-empty">{t("settings.privileged.unavailableTitle")}</p>
              ) : (
                <>
                  <div class="settings-toolbar settings-toolbar--config">
                    <div>
                      <b>{privilegedDirtyCount}</b>
                      <span>{t("settings.privileged.dirty", { count: privilegedDirtyCount })}</span>
                    </div>
                    <div class="settings-config-meta">
                      <small>revision {shortRevision(privilegedConfig.revision)}</small>
                      {privilegedConfig.unsupportedCount > 0 && (
                        <small>{t("settings.privileged.unsupported", { count: privilegedConfig.unsupportedCount })}</small>
                      )}
                      {privilegedConfig.secretFieldCount > 0 && (
                        <small>{t("settings.privileged.secretCount", { count: privilegedConfig.secretFieldCount })}</small>
                      )}
                    </div>
                    <div class="settings-config-toolbar-actions">
                      <button
                        type="button"
                        disabled={busy.has("privileged-config-reload") || busy.has("privileged-config")}
                        onClick={() => reloadPrivilegedConfig()}
                        aria-label={busy.has("privileged-config-reload") ? t("settings.loading") : t("settings.privileged.reload")}
                        title={busy.has("privileged-config-reload") ? t("settings.loading") : t("settings.privileged.reload")}
                      >
                        <RefreshIcon />
                      </button>
                      <button
                        type="button"
                        disabled={privilegedDirtyCount === 0 || busy.has("privileged-config") || busy.has("privileged-config-reload")}
                        onClick={() => discardPrivilegedDraft()}
                        aria-label={t("settings.privileged.discard")}
                        title={t("settings.privileged.discard")}
                      >
                        <CloseIcon />
                      </button>
                    </div>
                    <input
                      type="search"
                      value={privilegedQuery}
                      onInput={(event) => setPrivilegedQuery(event.currentTarget.value)}
                      placeholder={t("settings.privileged.search")}
                      aria-label={t("settings.privileged.search")}
                    />
                  </div>
                  <nav class="settings-config-categories" aria-label={t("settings.privileged.categories")}>
                    {privilegedConfig.categories.map((category) => (
                      <button
                        key={category}
                        type="button"
                        class={privilegedCategory === category ? "is-active" : ""}
                        onClick={() => setPrivilegedCategory(category)}
                        aria-label={category}
                        title={category}
                      >
                        {category}
                      </button>
                    ))}
                  </nav>
                  <div class="settings-ledger settings-ledger--wide">
                    <SectionHead
                      title={privilegedCategory || t("settings.privileged")}
                      note={`${filteredPrivilegedFields.length} fields`}
                    />
                    <div class="provider-fields config-fields">
                      {filteredPrivilegedFields.map((field) => (
                        <PrivilegedFieldEditor
                          key={field.id}
                          field={field}
                          value={privilegedDraft[field.id] ?? privilegedConfig.values[field.id]}
                          disabled={!mutationAccess.privileged || busy.has("privileged-config") || busy.has("privileged-config-reload")}
                          onChange={(next) => setPrivilegedDraft((current) => ({ ...current, [field.id]: next }))}
                        />
                      ))}
                      {filteredPrivilegedFields.length === 0 && <p class="settings-empty">{t("settings.privileged.noFields")}</p>}
                    </div>
                    <ActionBar
                      dirty={privilegedDirtyCount > 0}
                      busy={busy.has("privileged-config") || busy.has("privileged-config-reload")}
                      permitted={mutationAccess.privileged}
                      onSave={savePrivilegedConfig}
                    />
                  </div>
                </>
              )}

              <div class="settings-ledger settings-ledger--wide">
                <SectionHead
                  title={t("settings.privileged.secretsTitle")}
                  note={profileSecrets ? `revision ${shortRevision(profileSecrets.revision)}` : "—"}
                  info={t("settings.privileged.secretsNote")}
                />
                {secretError && (
                  <div class={`live-settings__notice ${secretError.conflict ? "is-conflict" : "is-error"}`} role="alert">
                    <span>{secretError.conflict ? t("settings.conflict") : t("settings.privileged.secretsUnavailable")}</span>
                    <p>{localizeRuntimeMessage(secretError.message)}</p>
                  </div>
                )}
                {!profileSecrets ? (
                  !secretError && <p class="settings-empty">{t("settings.privileged.secretsUnavailable")}</p>
                ) : (
                  <div class="provider-fields config-fields secret-fields">
                    {profileSecrets.fields.map((field) => {
                      const draftKey = secretFieldDraftKey(field);
                      const busyKey = `secret:${draftKey}`;
                      const context = field.source === "memory-provider"
                        ? t("settings.privileged.secretMemoryProvider", {
                          provider: field.providerLabel || field.provider || "provider",
                        })
                        : field.source === "env"
                          ? t("settings.privileged.secretEnv")
                          : t("settings.privileged.secretConfig");
                      return (
                        <label class="settings-field" key={draftKey}>
                          <span class="heading-info-group" title={field.key}>
                            {field.label || field.key}
                            <InfoTip
                              text={`${context} · ${field.isSet ? t("settings.privileged.secretIsSet") : t("settings.privileged.secretNotSet")}${field.description ? ` · ${field.description}` : ""}`}
                              align="start"
                            />
                          </span>
                          <input
                            type="password"
                            autoComplete="off"
                            spellcheck={false}
                            value={secretDrafts[draftKey] ?? ""}
                            disabled={!mutationAccess.privileged || busy.has(busyKey)}
                            placeholder={t("settings.privileged.secretPlaceholder")}
                            onInput={(event) => {
                              const next = event.currentTarget.value;
                              setSecretDrafts((current) => ({ ...current, [draftKey]: next }));
                            }}
                          />
                          <div class="settings-secret-actions">
                            <button
                              type="button"
                              class="settings-secret-save"
                              disabled={
                                !mutationAccess.privileged
                                || busy.has(busyKey)
                                || !(secretDrafts[draftKey] ?? "")
                              }
                              onClick={() => saveSecretField(field)}
                              aria-label={busy.has(busyKey) ? t("settings.saving") : t("settings.privileged.secretSave")}
                              title={busy.has(busyKey) ? t("settings.saving") : t("settings.privileged.secretSave")}
                            >
                              <SaveIcon />
                            </button>
                            {field.canClear && (
                              <button
                                type="button"
                                class="settings-secret-clear"
                                disabled={
                                  !mutationAccess.privileged
                                  || busy.has(busyKey)
                                  || !field.isSet
                                }
                                onClick={() => clearSecretField(field)}
                                aria-label={busy.has(busyKey) ? t("settings.saving") : t("settings.privileged.secretClear")}
                                title={busy.has(busyKey) ? t("settings.saving") : t("settings.privileged.secretClear")}
                              >
                                <TrashIcon />
                              </button>
                            )}
                          </div>
                        </label>
                      );
                    })}
                    {profileSecrets.fields.length === 0 && (
                      <p class="settings-empty">{t("settings.privileged.noSecrets")}</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      ) : visibleTab === "config" ? (
        <div class="live-settings__config">
          <div class="settings-ledger settings-ledger--wide settings-info-banner">
            <SectionHead
              title={t("settings.config")}
              info={[t("settings.configLead"), t("settings.configApplyNote")].join(" ")}
            />
          </div>
          {configError && (
            <div class={`live-settings__notice ${configError.conflict ? "is-conflict" : "is-error"}`} role="alert">
              <span>{configError.conflict ? t("settings.conflict") : t("settings.configUnavailable")}</span>
              <p>{localizeRuntimeMessage(configError.message)}</p>
              <button
                type="button"
                disabled={busy.has("hermes-config-reload") || busy.has("hermes-config")}
                onClick={() => reloadHermesConfig()}
                aria-label={busy.has("hermes-config-reload") ? t("settings.loading") : t("settings.configReload")}
                title={busy.has("hermes-config-reload") ? t("settings.loading") : t("settings.configReload")}
              >
                <RefreshIcon />
              </button>
            </div>
          )}
          {!hermesConfig ? (
            !configError && <p class="settings-empty">{t("settings.configUnavailable")}</p>
          ) : (
            <>
              <div class="settings-toolbar settings-toolbar--config">
                <div>
                  <b>{configDirtyCount}</b>
                  <span>{t("settings.configDirty", { count: configDirtyCount })}</span>
                </div>
                <div class="settings-config-meta">
                  <small>revision {shortRevision(hermesConfig.revision)}</small>
                  {hermesConfig.excludedCount > 0 && (
                    <small>{t("settings.configExcluded", { count: hermesConfig.excludedCount })}</small>
                  )}
                </div>
                <div class="settings-config-toolbar-actions">
                  <button
                    type="button"
                    disabled={busy.has("hermes-config-reload") || busy.has("hermes-config")}
                    onClick={() => reloadHermesConfig()}
                    aria-label={busy.has("hermes-config-reload") ? t("settings.loading") : t("settings.configReload")}
                    title={busy.has("hermes-config-reload") ? t("settings.loading") : t("settings.configReload")}
                  >
                    <RefreshIcon />
                  </button>
                  <button
                    type="button"
                    disabled={configDirtyCount === 0 || busy.has("hermes-config") || busy.has("hermes-config-reload")}
                    onClick={() => discardHermesConfigDraft()}
                    aria-label={t("settings.configDiscard")}
                    title={t("settings.configDiscard")}
                  >
                    <CloseIcon />
                  </button>
                </div>
                <input
                  type="search"
                  value={configQuery}
                  onInput={(event) => setConfigQuery(event.currentTarget.value)}
                  placeholder={t("settings.configSearch")}
                  aria-label={t("settings.configSearch")}
                />
              </div>
              <nav class="settings-config-categories" aria-label={t("settings.configCategories")}>
                {hermesConfig.categories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    class={configCategory === category ? "is-active" : ""}
                    onClick={() => setConfigCategory(category)}
                    aria-label={category}
                    title={category}
                  >
                    {category}
                  </button>
                ))}
              </nav>
              <div class="settings-ledger settings-ledger--wide">
                <SectionHead
                  title={configCategory || t("settings.config")}
                  note={`${filteredConfigFields.length} fields`}
                />
                <div class="provider-fields config-fields">
                  {filteredConfigFields.map((field) => (
                    <ConfigFieldEditor
                      key={field.id}
                      field={field}
                      value={configDraft[field.id] ?? hermesConfig.values[field.id]}
                      disabled={!mutationAccess.config || busy.has("hermes-config") || busy.has("hermes-config-reload")}
                      onChange={(next) => setConfigDraft((current) => ({ ...current, [field.id]: next }))}
                    />
                  ))}
                  {filteredConfigFields.length === 0 && <p class="settings-empty">{t("settings.configNoFields")}</p>}
                </div>
                <ActionBar
                  dirty={configDirtyCount > 0}
                  busy={busy.has("hermes-config") || busy.has("hermes-config-reload")}
                  permitted={mutationAccess.config}
                  onSave={saveHermesConfig}
                />
              </div>
            </>
          )}
        </div>
      ) : (
        <div class="live-settings__memory">
          <div class="memory-gauge">
            <div class="memory-gauge-head">
              <p>{t("settings.builtinMemory")}</p>
              <InfoTip text={[t("settings.memoryNote"), t("settings.memoryApplyNote")].join(" ")} align="start" />
            </div>
            <div class="memory-gauge-metrics">
              <span>
                <b>{formatBytes(memoryFiles?.memory.bytes ?? profile.memory.builtin.memoryBytes)}</b>
                <small>MEMORY.md</small>
              </span>
              <i aria-hidden="true" />
              <span>
                <b>{formatBytes(memoryFiles?.user.bytes ?? profile.memory.builtin.userBytes)}</b>
                <small>USER.md</small>
              </span>
            </div>
          </div>
          <div class="settings-ledger">
            <SectionHead title={t("settings.memoryProvider")} note={profile.memory.activeProvider || t("settings.builtin")} />
            <label class="settings-field"><span>{t("settings.provider")}</span>
              <select value={providerDraft} disabled={!mutationAccess.memory || memoryBusy} onChange={(event) => setProviderDraft(event.currentTarget.value)}>
                <option value="">{t("settings.builtin")}</option>
                {profile.memory.providers.filter((provider) => provider.name !== "builtin").map((provider) => <option key={provider.name} value={provider.name}>{provider.name}{provider.configured ? "" : ` — ${t("settings.setupRequired")}`}</option>)}
              </select>
            </label>
            <ActionBar dirty={providerDraft !== profile.memory.activeProvider} busy={memoryBusy} permitted={mutationAccess.memory} onSave={saveProvider} />
          </div>
          <div class="settings-ledger settings-ledger--editor settings-ledger--memory-file">
            <SectionHead
              title="MEMORY.md"
              note={memoryFiles ? `revision ${shortRevision(memoryFiles.memory.revision)}` : "—"}
              info={t("settings.memoryFileNote")}
            />
            <textarea
              value={memoryDraft}
              onInput={(event) => setMemoryDraft(event.currentTarget.value)}
              rows={12}
              disabled={!mutationAccess.memory || memoryFiles === null || memoryBusy}
              spellcheck={false}
              aria-label="MEMORY.md"
            />
            <ActionBar
              dirty={memoryFileDirty}
              busy={busy.has("memory-file:memory")}
              permitted={mutationAccess.memory && memoryFiles !== null}
              onSave={() => saveMemoryFile("memory")}
            />
          </div>
          <div class="settings-ledger settings-ledger--editor settings-ledger--memory-file">
            <SectionHead
              title="USER.md"
              note={memoryFiles ? `revision ${shortRevision(memoryFiles.user.revision)}` : "—"}
              info={t("settings.userFileNote")}
            />
            <textarea
              value={userDraft}
              onInput={(event) => setUserDraft(event.currentTarget.value)}
              rows={12}
              disabled={!mutationAccess.memory || memoryFiles === null || memoryBusy}
              spellcheck={false}
              aria-label="USER.md"
            />
            <ActionBar
              dirty={userFileDirty}
              busy={busy.has("memory-file:user")}
              permitted={mutationAccess.memory && memoryFiles !== null}
              onSave={() => saveMemoryFile("user")}
            />
          </div>
          <div class="settings-ledger settings-ledger--memory-reset">
            <SectionHead title={t("settings.memoryReset.title")} info={t("settings.memoryReset.note")} />
            <label class="settings-field">
              <span>{t("settings.memoryReset.target")}</span>
              <select
                value={resetTarget}
                disabled={!mutationAccess.memory || memoryBusy}
                onChange={(event) => setResetTarget(event.currentTarget.value as MemoryResetTarget)}
              >
                <option value="all">{t("settings.memoryReset.targetAll")}</option>
                <option value="memory">MEMORY.md</option>
                <option value="user">USER.md</option>
              </select>
            </label>
            <footer class="settings-actions">
              <span>{t("settings.memoryReset.destructive")}</span>
              <button
                type="button"
                class="settings-actions__danger"
                disabled={!mutationAccess.memory || memoryBusy}
                onClick={confirmResetMemory}
                aria-label={busy.has("memory-reset") ? t("settings.memoryReset.resetting") : t("settings.memoryReset.action")}
                title={busy.has("memory-reset") ? t("settings.memoryReset.resetting") : t("settings.memoryReset.action")}
              >
                <TrashIcon />
              </button>
            </footer>
          </div>
          {providerConfig && providerConfig.fields.some((field) => field.kind !== "secret") && (
            <div class="settings-ledger settings-ledger--wide">
              <SectionHead title={t("settings.providerSettings", { name: providerConfig.label })} note={`revision ${shortRevision(providerConfig.revision)}`} />
              <div class="provider-fields">
                {providerConfig.fields.filter((field) => field.kind !== "secret").map((field) => (
                  <label class="settings-field" key={field.key}>
                    <span class="heading-info-group">
                      {field.label}{field.required ? " *" : ""}
                      {field.description && <InfoTip text={field.description} align="start" />}
                    </span>
                    {field.kind === "boolean" ? (
                      <input type="checkbox" checked={providerValues[field.key] === true} disabled={!mutationAccess.memory || memoryBusy} onChange={(event) => setProviderValues({ ...providerValues, [field.key]: event.currentTarget.checked })} />
                    ) : field.kind === "select" ? (
                      <select value={String(providerValues[field.key] ?? "")} disabled={!mutationAccess.memory || memoryBusy} onChange={(event) => setProviderValues({ ...providerValues, [field.key]: event.currentTarget.value })}>
                        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    ) : (
                      <input value={String(providerValues[field.key] ?? "")} disabled={!mutationAccess.memory || memoryBusy} onInput={(event) => setProviderValues({ ...providerValues, [field.key]: event.currentTarget.value })} />
                    )}
                  </label>
                ))}
              </div>
              <ActionBar dirty={providerConfigDirty} busy={memoryBusy} permitted={mutationAccess.memory} onSave={saveProviderConfig} />
            </div>
          )}
        </div>
      )}
      {skillEditorName && profile && (
        <SkillContentModal
          profileId={profile.profile}
          skillName={skillEditorName}
          skillMeta={profile.skills.find((item) => item.name === skillEditorName)}
          canEdit={mutationAccess.skill}
          onClose={closeSkillEditor}
        />
      )}
    </section>
  );
}

function SkillContentModal({
  profileId,
  skillName,
  skillMeta,
  canEdit,
  onClose,
}: {
  profileId: string;
  skillName: string;
  skillMeta?: SkillSettings | undefined;
  canEdit: boolean;
  onClose(): void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<SkillContent | null>(null);
  const [draft, setDraft] = useState("");
  const dirty = content !== null && draft !== content.content;
  const close = () => { if (!saving) onClose(); };
  const outsideClose = useModalOutsideClose(close);
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open: true,
    onClose: close,
    viewport: "(min-width: 0px)",
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    setDraft("");
    void (async () => {
      try {
        const next = await loadSkillContent(profileId, skillName);
        if (cancelled) return;
        setContent(next);
        setDraft(next.content);
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : t("settings.skillEditor.loadFailed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [profileId, skillName]);

  const save = async () => {
    if (!content || content.redacted || !canEdit || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await updateSkillContent(profileId, skillName, draft, content.revision);
      setContent(updated);
      setDraft(updated.content);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("settings.skillEditor.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const modal = (
    <div
      class="skill-editor-layer"
      role="presentation"
      data-modal-affordance="true"
      {...outsideClose}
    >
      <button class="skill-editor-scrim" type="button" disabled={saving} aria-label={t("common.close")} title={t("common.close")} onClick={close} />
      <section
        ref={overlay.ref}
        class="skill-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-editor-title"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="skill-editor-head">
          <div>
            <span>{t("settings.skillEditor.title")}</span>
            <h2 id="skill-editor-title">{skillName}</h2>
            {skillMeta && (
              <small>
                {skillMeta.provenance} · {skillMeta.category}
                {skillMeta.description && <InfoTip text={skillMeta.description} align="start" />}
              </small>
            )}
          </div>
          <button type="button" class="skill-editor-close" disabled={saving} onClick={close} aria-label={t("common.close")} title={t("common.close")}><CloseIcon /></button>
        </header>
        <div class="skill-editor-body">
          <div class="skill-editor-meta">
            <InfoTip text={t("settings.skillEditor.note")} align="start" />
          </div>
          {loading ? (
            <p class="skill-editor-status" role="status">{t("settings.skillEditor.loading")}</p>
          ) : error && !content ? (
            <div class="skill-editor-error" role="alert">
              <p>{error}</p>
              <button type="button" class="quiet-button" aria-label={t("settings.reload")} title={t("settings.reload")} onClick={() => {
                setLoading(true);
                setError(null);
                void loadSkillContent(profileId, skillName)
                  .then((next) => {
                    setContent(next);
                    setDraft(next.content);
                  })
                  .catch((reason) => {
                    setError(reason instanceof Error ? reason.message : t("settings.skillEditor.loadFailed"));
                  })
                  .finally(() => setLoading(false));
              }}><RefreshIcon /></button>
            </div>
          ) : (
            <>
              {content?.redacted && <p class="settings-warning">{t("settings.redacted")}</p>}
              <textarea
                value={draft}
                onInput={(event) => setDraft(event.currentTarget.value)}
                rows={18}
                disabled={!canEdit || content?.redacted === true || saving}
                spellcheck={false}
                aria-label={skillName}
              />
              {error && <p class="skill-editor-inline-error" role="alert">{error}</p>}
            </>
          )}
        </div>
        <footer class="skill-editor-actions">
          <button type="button" class="quiet-button" disabled={saving} onClick={close} aria-label={t("settings.skillEditor.close")} title={t("settings.skillEditor.close")}><CloseIcon /></button>
          <button
            type="button"
            class="primary-button"
            disabled={!canEdit || !content || content.redacted || !dirty || saving || loading}
            onClick={() => void save()}
            aria-label={saving ? t("settings.saving") : t("settings.save")}
            title={saving ? t("settings.saving") : t("settings.save")}
          >
            <SaveIcon />
          </button>
        </footer>
      </section>
    </div>
  );

  if (typeof document === "undefined") return modal;
  return createPortal(modal, document.body);
}

function SectionHead({ title, note, info }: { title: string; note?: string; info?: string }) {
  return (
    <header class="settings-section-head">
      <div class="heading-info-group">
        <h2>{title}</h2>
        {info && <InfoTip text={info} align="end" />}
      </div>
      {note && <small>{note}</small>}
    </header>
  );
}

/** Modal directory browser backed by the read-only host fs listing API. */
function DirectoryPicker({ onPick, onClose }: { onPick(path: string): void; onClose(): void }) {
  const [listing, setListing] = useState<HostDirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const requestGeneration = useRef(0);
  const overlay = useMobileOverlay<HTMLDivElement>({
    kind: "modal",
    open: true,
    onClose,
    viewport: "(min-width: 0px)",
  });
  const load = useCallback((path?: string) => {
    const generation = ++requestGeneration.current;
    setError(false);
    setLoading(true);
    void listHostDirs(path)
      .then((next) => {
        if (requestGeneration.current === generation) setListing(next);
      })
      .catch(() => {
        if (requestGeneration.current === generation) setError(true);
      })
      .finally(() => {
        if (requestGeneration.current === generation) setLoading(false);
      });
  }, []);
  useEffect(() => {
    load();
    return () => { requestGeneration.current += 1; };
  }, [load]);
  return (
    <div ref={overlay.ref} class="dir-picker-layer" role="dialog" aria-modal="true" aria-label={t("settings.projects.chooseFolder")} tabIndex={-1}>
      <div class="dir-picker-scrim" onClick={onClose} />
      <div class="dir-picker">
        <header>
          <b>{t("settings.projects.chooseFolder")}</b>
          <button type="button" class="dir-picker__close" aria-label={t("settings.skillEditor.close")} title={t("settings.skillEditor.close")} onClick={onClose}><CloseIcon /></button>
        </header>
        <div class="dir-picker__path"><code>{listing?.path ?? "…"}</code></div>
        <div class="dir-picker__list" aria-busy={loading}>
          {error && <p class="dir-picker__error">{t("settings.loadFailed")}</p>}
          {listing && (
            <>
              {listing.parent !== null && (
                <button type="button" class="dir-picker__row is-up" disabled={loading} onClick={() => load(listing.parent!)}>
                  <span aria-hidden="true">↑</span> ..
                </button>
              )}
              <button type="button" class="dir-picker__row is-home" disabled={loading} onClick={() => load(listing.home)}>
                <span aria-hidden="true">⌂</span> {t("settings.projects.home")}
              </button>
              {listing.dirs.map((dir) => (
                <button type="button" key={dir.path} class="dir-picker__row" disabled={loading} onClick={() => load(dir.path)}>
                  <span aria-hidden="true">▸</span> {dir.name}
                </button>
              ))}
              {listing.dirs.length === 0 && <p class="dir-picker__empty">{t("settings.projects.noSubdirs")}</p>}
            </>
          )}
        </div>
        <footer>
          <button type="button" class="dir-picker__cancel" onClick={onClose}>{t("settings.skillEditor.close")}</button>
          <button type="button" class="dir-picker__pick" disabled={!listing || loading} onClick={() => {
            if (listing && !loading) onPick(listing.path);
          }}>
            {t("settings.projects.useThisFolder")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function SwitchRow({ label, detail, checked, disabled, onChange }: { label: string; detail: string; checked: boolean; disabled: boolean; onChange(value: boolean): void }) {
  return (
    <label class="settings-switch">
      <span class="settings-switch__label">
        <b>{label}</b>
        <InfoTip text={detail} align="start" />
      </span>
      <input
        class="settings-toggle"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function ActionBar({ dirty, retryPending = false, busy, permitted, valid = true, onSave }: { dirty: boolean; retryPending?: boolean; busy: boolean; permitted: boolean; valid?: boolean; onSave(): void }) {
  const actionable = dirty || retryPending;
  const status = !permitted
    ? t("settings.readOnly")
    : !valid
      ? t("settings.invalidBudget")
      : dirty
        ? t("settings.unsaved")
        : retryPending
          ? t("settings.retryRequired")
          : "";
  return (
    <footer class={`settings-actions ${status ? "" : "is-statusless"}`}>
      {status ? <span>{status}</span> : <span class="settings-actions__spacer" aria-hidden="true" />}
      <button type="button" disabled={!permitted || !valid || !actionable || busy} onClick={onSave} aria-label={busy ? t("settings.saving") : retryPending && !dirty ? t("settings.retrySync") : t("settings.save")} title={busy ? t("settings.saving") : retryPending && !dirty ? t("settings.retrySync") : t("settings.save")}>
        <SaveIcon /> <span class="settings-actions__label">{busy ? t("settings.saving") : retryPending && !dirty ? t("settings.retrySync") : t("settings.save")}</span>
      </button>
    </footer>
  );
}

function SettingsSkeleton() {
  return <div class="settings-skeleton" aria-label={t("settings.loadingAria")}><i /><i /><i /><span>{t("settings.loading")}</span></div>;
}

function EmptyProfile({ onReload }: { onReload(): Promise<void> }) {
  return <div class="settings-empty settings-empty--profile"><b>{t("settings.selectProfile")}</b><button type="button" onClick={() => void onReload()} aria-label={t("settings.reload")} title={t("settings.reload")}><RefreshIcon /></button></div>;
}

function valuesFromConfig(config: MemoryProviderConfig): Record<string, boolean | string> {
  return Object.fromEntries(config.fields.filter((field) => field.kind !== "secret" && field.value !== undefined).map((field) => [field.key, field.value!])) as Record<string, boolean | string>;
}

function parseSkillLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
}

/**
 * Merges known-detail skills (from a loaded profile catalog) and bare names
 * (already-selected global skills, or a free-form addition) into one sorted
 * list. A name that only exists as a plain string (no catalog match) still
 * gets a minimal placeholder entry so it renders in the picker.
 */
function mergeGlobalSkillOptions(
  current: SkillSettings[],
  detailed: readonly SkillSettings[],
  bareNames: readonly string[],
): SkillSettings[] {
  const byName = new Map(current.map((skill) => [skill.name, skill]));
  for (const skill of detailed) byName.set(skill.name, skill);
  for (const name of bareNames) {
    if (!name || byName.has(name)) continue;
    byName.set(name, { name, category: "", description: "", enabled: false, provenance: "unknown", usage: 0 });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function collectConfigChanges<T>(
  baseline: Record<string, T>,
  draft: Record<string, T>,
): Record<string, T> {
  const changes: Record<string, T> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (JSON.stringify(value) !== JSON.stringify(baseline[key])) changes[key] = value;
  }
  return changes;
}

function ConfigFieldEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ProfileHermesConfig["fields"][number];
  value: HermesConfigValue | undefined;
  disabled: boolean;
  onChange(value: HermesConfigValue): void;
}) {
  return (
    <label class="settings-field">
      <span class="heading-info-group" title={field.id}>
        {field.id}
        {field.description && <InfoTip text={field.description} align="start" />}
      </span>
      {field.type === "boolean" ? (
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      ) : field.type === "select" ? (
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
          {typeof value === "string" && value !== "" && !field.options.some((option) => option.value === value) && (
            <option value={value}>{value}</option>
          )}
        </select>
      ) : field.type === "number" ? (
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          disabled={disabled}
          onInput={(event) => {
            const next = event.currentTarget.value;
            if (next.trim() === "") return;
            const parsed = Number(next);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
        />
      ) : field.type === "list" ? (
        // Server projects string-lists only. Never coerce boolean/number rows via String().
        <ListFieldEditor
          value={asStringList(value)}
          disabled={disabled}
          onChange={(items) => onChange(items)}
        />
      ) : (
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          spellcheck={false}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </label>
  );
}

function PrivilegedFieldEditor({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ProfilePrivilegedHermesConfig["fields"][number];
  value: HermesPrivilegedConfigValue | undefined;
  disabled: boolean;
  onChange(value: HermesPrivilegedConfigValue): void;
}) {
  const impactLabel = field.impact === "restart"
    ? t("settings.privileged.impactRestart")
    : field.impact === "destructive"
      ? t("settings.privileged.impactDestructive")
      : t("settings.privileged.impactNewSession");
  return (
    <label class="settings-field">
      <span class="heading-info-group" title={field.id}>
        {field.id}
        <InfoTip text={field.description ? `${impactLabel} · ${field.description}` : impactLabel} align="start" />
      </span>
      {field.type === "boolean" ? (
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      ) : field.type === "select" ? (
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
          {typeof value === "string" && value !== "" && !field.options.some((option) => option.value === value) && (
            <option value={value}>{value}</option>
          )}
        </select>
      ) : field.type === "number" ? (
        <input
          type="number"
          value={typeof value === "number" ? value : ""}
          disabled={disabled}
          onInput={(event) => {
            const next = event.currentTarget.value;
            if (next.trim() === "") return;
            const parsed = Number(next);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
        />
      ) : field.type === "list" ? (
        <ListFieldEditor
          value={asStringList(value as HermesConfigValue | undefined)}
          disabled={disabled}
          onChange={(items) => onChange(items)}
        />
      ) : field.type === "json" ? (
        <JsonFieldEditor
          value={value}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          spellcheck={false}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </label>
  );
}

function JsonFieldEditor({
  value,
  disabled,
  onChange,
}: {
  value: HermesPrivilegedConfigValue | undefined;
  disabled: boolean;
  onChange(value: HermesPrivilegedConfigValue): void;
}) {
  const [text, setText] = useState(() => stableJsonText(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(stableJsonText(value));
    setInvalid(false);
  }, [value]);
  return (
    <div class="config-json-editor">
      <textarea
        value={text}
        disabled={disabled}
        spellcheck={false}
        rows={6}
        aria-invalid={invalid}
        onInput={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          try {
            const parsed = JSON.parse(next) as unknown;
            setInvalid(false);
            onChange(parsed);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && <small class="settings-budget is-over">{t("settings.privileged.jsonInvalid")}</small>}
    </div>
  );
}

function stableJsonText(value: HermesPrivilegedConfigValue | undefined): string {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return "null";
  }
}

/** Fail closed: only pass through string[] values; never map(String) scalars. */
function asStringList(value: HermesConfigValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  if (!value.every((item): item is string => typeof item === "string")) return [];
  return value;
}

function ListFieldEditor({
  value,
  disabled,
  onChange,
}: {
  value: string[];
  disabled: boolean;
  onChange(value: string[]): void;
}) {
  return (
    <div class="config-list-editor">
      {value.map((item, index) => (
        <div class="config-list-row" key={`row-${index}`}>
          <input
            type="text"
            value={item}
            disabled={disabled}
            spellcheck={false}
            onInput={(event) => {
              const next = [...value];
              next[index] = event.currentTarget.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            disabled={disabled}
            aria-label={t("settings.configListRemove")}
            title={t("settings.configListRemove")}
            onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
          >
            <TrashIcon />
          </button>
        </div>
      ))}
      <button
        type="button"
        class="config-list-add"
        disabled={disabled || value.length >= 64}
        onClick={() => onChange([...value, ""])}
        aria-label={t("settings.configListAdd")}
        title={t("settings.configListAdd")}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function errorState(reason: unknown): ErrorState {
  if (reason instanceof SettingsApiError) return { message: officeRuntimeMessage(reason.message), conflict: reason.kind === "conflict" };
  return { message: officeMessage("settings.loadFailed"), conflict: false };
}

function shortRevision(value: string): string { return value.slice(0, 8); }
function formatBytes(value: number): string { return value < 1_024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }

/** Compact monospace usage line: Studio day stats when present, else Hermes cumulative-only. */
function skillUsageLabel(hermesUsage: number, office: UsageStatItem | undefined): string {
  if (office !== undefined) {
    const date = formatUsageDate(office.lastUsedAt);
    const line = t("settings.usage.stats", { total: office.total, period: office.periodCount, date });
    if (hermesUsage > 0 && hermesUsage !== office.total) {
      return `${line} · ${t("settings.usage.hermes", { count: hermesUsage })}`;
    }
    return line;
  }
  if (hermesUsage > 0) return t("settings.usage.hermesOnly", { count: hermesUsage });
  return t("settings.usage.none");
}

function formatUsageDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return t("settings.usage.unknownDate");
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  } catch {
    return iso.slice(0, 10);
  }
}
