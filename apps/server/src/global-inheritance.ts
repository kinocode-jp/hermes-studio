import { isGlobalContextWithinBudget } from "@hermes-studio/protocol";
import type {
  HermesSettingsAdapter,
  OfficeGlobalSettingsDto,
  OfficeGlobalSettingsStore,
  OfficeGlobalSettingsUpdate,
  OfficePendingGlobalSkillMutation,
  OfficePendingSkillOverride,
} from "./hermes-settings.js";
import { HermesSettingsError } from "./hermes-settings.js";
import type { OfficeTeamSkillLayer } from "./office-teams.js";

export interface GlobalInheritanceOptions {
  store: OfficeGlobalSettingsStore;
  settings: HermesSettingsAdapter;
  listProfiles(): Promise<string[]>;
  /**
   * Optional middle inheritance tier. When provided, desired skills for a
   * profile are global ∪ every enabled team that lists the profile as a member.
   * Profile overrides still win and permanently relinquish Office ownership.
   */
  listTeamLayers?(): Promise<readonly OfficeTeamSkillLayer[]>;
  /** Total budget for one queued reconciliation/materialization job. */
  materializationTimeoutMs?: number;
}

const DEFAULT_MATERIALIZATION_TIMEOUT_MS = 10_000;

/**
 * Owns the boundary between Office policy layers and independent Hermes homes.
 *
 * Precedence for skill materialization (enable-set union):
 *   1. Global shared skills (when sharedSkillsEnabled)
 *   2. Team skills for every team containing the profile (when skillsEnabled)
 *   3. Profile-level user toggles permanently override Office for that pair
 *
 * Context for new sessions (joined, global first, then teams by id):
 *   enabled global context + enabled team contexts for the session profile
 *
 * Every mutation is serialized so provenance changes cannot race a sync.
 */
export class GlobalInheritanceCoordinator {
  readonly #options: GlobalInheritanceOptions;
  readonly #materializationTimeoutMs: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: GlobalInheritanceOptions) {
    this.#options = options;
    this.#materializationTimeoutMs = boundedTimeout(options.materializationTimeoutMs);
  }

  async read(): Promise<OfficeGlobalSettingsDto> {
    const state = await this.#options.store.readMaterialization();
    if (state.pendingSkillOverrides.length === 0 && state.pendingGlobalSkillMutations.length === 0) return state.settings;
    const pending = [
      ...state.pendingSkillOverrides.map((item) => ({ profile: item.profile, skill: item.skill, desiredEnabled: item.desiredEnabled })),
      ...state.pendingGlobalSkillMutations.map((item) => ({ profile: item.profile, skill: item.skill, desiredEnabled: item.desiredEnabled })),
    ];
    return {
      ...state.settings,
      skillSync: {
        state: "pending",
        failures: pending.slice(0, 100).map((item) => ({
          profile: item.profile,
          skill: item.skill,
          operation: item.desiredEnabled ? "enable" as const : "disable" as const,
        })),
      },
    };
  }

  /**
   * Builds the internal system seed for a new session.create.
   * Global context (if enabled) is first; matching team contexts follow in
   * stable teamId order. Combined seed is clipped to the global context budget.
   */
  async sessionCreateContext(profile?: string): Promise<string | undefined> {
    const settings = await this.#options.store.read();
    const parts: string[] = [];
    if (settings.sharedContextEnabled && settings.context.trim() !== "") {
      parts.push(settings.context);
    }
    if (profile !== undefined && profile.trim() !== "" && this.#options.listTeamLayers !== undefined) {
      let layers: readonly OfficeTeamSkillLayer[];
      try {
        layers = await this.#options.listTeamLayers();
      } catch {
        layers = [];
      }
      const matching = layers
        .filter((layer) =>
          layer.contextEnabled
          && layer.context.trim() !== ""
          && layer.memberProfileIds.includes(profile))
        .slice()
        .sort((a, b) => a.teamId.localeCompare(b.teamId));
      for (const layer of matching) parts.push(layer.context);
    }
    if (parts.length === 0) return undefined;
    let combined = "";
    for (const part of parts) {
      const next = combined === "" ? part : `${combined}\n\n${part}`;
      if (!isGlobalContextWithinBudget(next)) break;
      combined = next;
    }
    return combined === "" ? undefined : combined;
  }

  async update(input: OfficeGlobalSettingsUpdate): Promise<OfficeGlobalSettingsDto> {
    const deadlineMs = this.#deadline();
    return await this.#serialized(async () => {
      await this.#reconcilePendingSkillOverrides(deadlineMs);
      await this.#reconcilePendingGlobalSkillMutations(deadlineMs);
      assertBeforeDeadline(deadlineMs);
      const staged = await this.#options.store.beginMaterialization(input);
      return await this.#materializeDesired(staged.settings.revision, staged.settings, staged.managedSkills, staged.skillOverrides, deadlineMs);
    }, deadlineMs);
  }

  /**
   * Re-applies current global ∪ team desired skills without bumping the global
   * settings revision. Used after team settings or membership changes.
   */
  async rematerializeSkills(): Promise<OfficeGlobalSettingsDto> {
    const deadlineMs = this.#deadline();
    return await this.#serialized(async () => {
      await this.#reconcilePendingSkillOverrides(deadlineMs);
      await this.#reconcilePendingGlobalSkillMutations(deadlineMs);
      assertBeforeDeadline(deadlineMs);
      const state = await this.#options.store.readMaterialization();
      return await this.#materializeDesired(
        state.settings.revision,
        state.settings,
        state.managedSkills,
        state.skillOverrides,
        deadlineMs,
      );
    }, deadlineMs);
  }

  /** A Profile-scoped user toggle wins; Office relinquishes this pair. */
  async noteProfileSkillOverride(profile: string, skill: string): Promise<void> {
    const deadlineMs = this.#deadline();
    await this.#serialized(async () => await this.#options.store.markSkillOverride(profile, skill), deadlineMs);
  }

  /** Durable intent protects the user change until Hermes and ownership agree. */
  async applyProfileSkillOverride(
    profile: string,
    skill: string,
    desiredEnabled: boolean,
    expectedEnabled: boolean,
    mutation: () => Promise<void>,
  ): Promise<void> {
    const deadlineMs = this.#deadline();
    await this.#serialized(async () => {
      await this.#reconcilePendingGlobalSkillMutations(deadlineMs);
      const ownership = await this.#options.store.readMaterialization();
      const alreadyOwned = ownership.skillOverrides.some((item) => item.profile === profile && item.skill === skill);
      if (alreadyOwned) {
        try {
          const current = (await this.#options.settings.listSkills(profile, { deadlineMs })).find((item) => item.name === skill);
          if (current?.enabled === desiredEnabled) return;
        } catch { /* Ownership is already durable; the normal mutation reports runtime failure. */ }
        await mutation();
        return;
      }
      const prepared = await this.#options.store.prepareSkillOverride(profile, skill, desiredEnabled, expectedEnabled);
      if (prepared.existing) {
        await this.#reconcilePendingSkillOverride(prepared.transaction, deadlineMs);
        return;
      }
      try {
        await mutation();
      } catch (error) {
        if (isDefinitePreconditionFailure(error)) {
          try { await this.#options.store.abortSkillOverride(prepared.transaction); }
          catch { throw reconciliationPending(); }
          throw error;
        }
        // The upstream outcome can be ambiguous (for example a timeout after
        // applying). Keep the durable intent and make that recovery state explicit.
        throw reconciliationPending();
      }
      await this.#commitSkillOverride(prepared.transaction);
    }, deadlineMs);
  }

  async #materializeDesired(
    revision: number,
    settings: OfficeGlobalSettingsDto,
    managedSkills: Array<{ profile: string; skill: string }>,
    skillOverrides: Array<{ profile: string; skill: string }>,
    deadlineMs: number,
  ): Promise<OfficeGlobalSettingsDto> {
    const managed = new Map(managedSkills.map((item) => [keyOf(item.profile, item.skill), item]));
    const overrides = new Map(skillOverrides.map((item) => [keyOf(item.profile, item.skill), item]));
    const failures: OfficeGlobalSettingsDto["skillSync"]["failures"] = [];
    let profiles: string[];
    try {
      profiles = uniqueProfiles(await settleBeforeDeadline(this.#options.listProfiles(), deadlineMs));
    } catch {
      return await this.#options.store.finishMaterialization(
        revision,
        [...managed.values()],
        [...overrides.values()],
        [{ profile: "default", skill: "profile-discovery", operation: "enable" }],
      );
    }
    const profileSet = new Set(profiles);
    for (const [key, item] of managed) if (!profileSet.has(item.profile)) managed.delete(key);
    for (const [key, item] of overrides) if (!profileSet.has(item.profile)) overrides.delete(key);

    let teamLayers: readonly OfficeTeamSkillLayer[] = [];
    if (this.#options.listTeamLayers !== undefined) {
      try {
        teamLayers = await settleBeforeDeadline(this.#options.listTeamLayers(), deadlineMs);
      } catch {
        return await this.#options.store.finishMaterialization(
          revision,
          [...managed.values()],
          [...overrides.values()],
          [{ profile: "default", skill: "team-discovery", operation: "enable" }],
        );
      }
    }

    for (const [profileIndex, profile] of profiles.entries()) {
      if (deadlineMs <= Date.now()) {
        // Persist all remaining work as pending without issuing more Hermes I/O.
        for (const remainingProfile of profiles.slice(profileIndex)) {
          const remainingDesired = desiredSkillsForProfile(remainingProfile, settings, teamLayers);
          for (const skill of remainingDesired) failures.push({ profile: remainingProfile, skill, operation: "enable" });
          for (const item of managed.values()) {
            if (item.profile === remainingProfile && !remainingDesired.has(item.skill)) {
              failures.push({ profile: item.profile, skill: item.skill, operation: "disable" });
            }
          }
        }
        break;
      }
      const desired = desiredSkillsForProfile(profile, settings, teamLayers);
      let skills;
      try { skills = await this.#options.settings.listSkills(profile, { deadlineMs }); }
      catch {
        for (const skill of desired) failures.push({ profile, skill, operation: "enable" });
        for (const item of managed.values()) if (item.profile === profile && !desired.has(item.skill)) failures.push({ profile, skill: item.skill, operation: "disable" });
        continue;
      }
      const byName = new Map(skills.map((skill) => [skill.name, skill]));

      for (const skill of desired) {
        const key = keyOf(profile, skill);
        const current = byName.get(skill);
        if (overrides.has(key)) {
          managed.delete(key);
          continue;
        }
        if (current === undefined) {
          failures.push({ profile, skill, operation: "enable" });
          continue;
        }
        if (managed.has(key)) {
          // A direct/out-of-band disable is treated as a Profile override.
          if (!current.enabled) {
            managed.delete(key);
            overrides.set(key, { profile, skill });
          }
          continue;
        }
        if (current.enabled) continue; // Already enabled by the Profile/user; never claim it.
        try {
          await this.#applyGlobalSkillMutation(revision, profile, skill, true, false, deadlineMs);
          managed.set(key, { profile, skill });
        } catch (error) {
          if (error instanceof GlobalIntentPersistenceError) throw error.original;
          failures.push({ profile, skill, operation: "enable" });
        }
      }

      for (const item of [...managed.values()]) {
        if (item.profile !== profile || desired.has(item.skill)) continue;
        const current = byName.get(item.skill);
        if (current === undefined || !current.enabled) {
          managed.delete(keyOf(item.profile, item.skill));
          continue;
        }
        try {
          await this.#applyGlobalSkillMutation(revision, profile, item.skill, false, true, deadlineMs);
          managed.delete(keyOf(item.profile, item.skill));
        } catch (error) {
          if (error instanceof GlobalIntentPersistenceError) throw error.original;
          failures.push({ profile, skill: item.skill, operation: "disable" });
        }
      }
    }

    const result = await this.#options.store.finishMaterialization(
      revision,
      [...managed.values()],
      [...overrides.values()],
      dedupeFailures(failures),
    );
    return result;
  }

  async #reconcilePendingSkillOverrides(deadlineMs: number): Promise<void> {
    const state = await this.#options.store.readMaterialization();
    for (const transaction of state.pendingSkillOverrides) {
      assertBeforeDeadline(deadlineMs);
      await this.#reconcilePendingSkillOverride(transaction, deadlineMs);
    }
  }

  async #applyGlobalSkillMutation(
    revision: number,
    profile: string,
    skill: string,
    desiredEnabled: boolean,
    expectedEnabled: boolean,
    deadlineMs: number,
  ): Promise<void> {
    assertBeforeDeadline(deadlineMs);
    let prepared;
    try {
      prepared = await this.#options.store.prepareGlobalSkillMutation(
        revision,
        profile,
        skill,
        desiredEnabled,
        expectedEnabled,
      );
    } catch (error) {
      // Without a durable intent it is unsafe to report an ordinary pending
      // materialization: there is nothing a restart can reconcile. Propagate
      // storage/conflict failure before any Hermes mutation begins.
      throw new GlobalIntentPersistenceError(error);
    }
    if (prepared.existing) {
      await this.#reconcilePendingGlobalSkillMutation(prepared.transaction, deadlineMs);
      return;
    }
    try {
      await this.#options.settings.setSkillEnabled(profile, skill, desiredEnabled, expectedEnabled, { deadlineMs });
    } catch (error) {
      if (isDefinitePreconditionFailure(error)) {
        try { await this.#options.store.abortGlobalSkillMutation(prepared.transaction); }
        catch { throw unavailable(); }
      }
      throw unavailable();
    }
    try { await this.#options.store.commitGlobalSkillMutation(prepared.transaction); }
    catch { throw unavailable(); }
  }

  async #reconcilePendingGlobalSkillMutations(deadlineMs: number): Promise<void> {
    const state = await this.#options.store.readMaterialization();
    for (const transaction of state.pendingGlobalSkillMutations) {
      assertBeforeDeadline(deadlineMs);
      await this.#reconcilePendingGlobalSkillMutation(transaction, deadlineMs);
    }
  }

  async #reconcilePendingGlobalSkillMutation(transaction: OfficePendingGlobalSkillMutation, deadlineMs: number): Promise<void> {
    let skills;
    try { skills = await this.#options.settings.listSkills(transaction.profile, { deadlineMs }); }
    catch { throw unavailable(); }
    const current = skills.find((skill) => skill.name === transaction.skill);
    if (current === undefined) throw unavailable();
    if (current.enabled !== transaction.desiredEnabled) {
      if (current.enabled !== transaction.expectedEnabled) throw new HermesSettingsError("conflict", "Global skill changed while reconciliation was pending.");
      try {
        await this.#options.settings.setSkillEnabled(transaction.profile, transaction.skill, transaction.desiredEnabled, transaction.expectedEnabled, { deadlineMs });
      } catch { throw unavailable(); }
    }
    try { await this.#options.store.commitGlobalSkillMutation(transaction); }
    catch { throw unavailable(); }
  }

  async #reconcilePendingSkillOverride(transaction: OfficePendingSkillOverride, deadlineMs: number): Promise<void> {
    let skills;
    try {
      skills = await this.#options.settings.listSkills(transaction.profile, { deadlineMs });
    } catch {
      throw reconciliationPending();
    }
    const current = skills.find((skill) => skill.name === transaction.skill);
    if (current === undefined) throw reconciliationPending();
    if (current.enabled !== transaction.desiredEnabled) {
      if (current.enabled !== transaction.expectedEnabled) {
        throw new HermesSettingsError("conflict", "Profile skill changed while ownership reconciliation was pending.");
      }
      try {
        await this.#options.settings.setSkillEnabled(
          transaction.profile,
          transaction.skill,
          transaction.desiredEnabled,
          transaction.expectedEnabled,
          { deadlineMs },
        );
      } catch {
        throw reconciliationPending();
      }
    }
    await this.#commitSkillOverride(transaction);
  }

  async #commitSkillOverride(transaction: OfficePendingSkillOverride): Promise<void> {
    try {
      await this.#options.store.commitSkillOverride(transaction);
    } catch {
      throw reconciliationPending();
    }
  }

  async #serialized<T>(operation: () => Promise<T>, deadlineMs: number): Promise<T> {
    const result = this.#queue.then(async () => {
      assertBeforeDeadline(deadlineMs);
      return await operation();
    });
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }

  #deadline(): number { return Date.now() + this.#materializationTimeoutMs; }
}

/**
 * Effective Office skill enable-set for one profile.
 * Union of global (if enabled) and every membership team's skills (if enabled).
 * Profile overrides are applied later by the materializer, not here.
 */
export function desiredSkillsForProfile(
  profile: string,
  global: Pick<OfficeGlobalSettingsDto, "sharedSkillsEnabled" | "skills">,
  teamLayers: readonly OfficeTeamSkillLayer[],
): Set<string> {
  const desired = new Set<string>();
  if (global.sharedSkillsEnabled) {
    for (const skill of global.skills) desired.add(skill);
  }
  for (const layer of teamLayers) {
    if (!layer.skillsEnabled) continue;
    if (!layer.memberProfileIds.includes(profile)) continue;
    for (const skill of layer.skills) desired.add(skill);
  }
  return desired;
}

function uniqueProfiles(profiles: string[]): string[] {
  const result = [...new Set(profiles)];
  if (result.length === 0 || result.length > 1_000 || result.some((profile) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile))) throw new Error("Invalid Hermes profile inventory.");
  return result;
}

function dedupeFailures(failures: OfficeGlobalSettingsDto["skillSync"]["failures"]): OfficeGlobalSettingsDto["skillSync"]["failures"] {
  const seen = new Set<string>();
  return failures.filter((failure) => { const key = `${failure.profile}\0${failure.skill}\0${failure.operation}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 100);
}

function keyOf(profile: string, skill: string): string { return `${profile}\0${skill}`; }
function unavailable(): HermesSettingsError { return new HermesSettingsError("rejected", "Global skills are pending synchronization. Retry after checking the affected profiles."); }
class GlobalIntentPersistenceError extends Error {
  constructor(readonly original: unknown) { super("Global skill intent could not be persisted."); }
}
function reconciliationPending(): HermesSettingsError { return new HermesSettingsError("rejected", "Profile skill changed, but ownership reconciliation is still pending. Retry safely before global synchronization."); }
function isDefinitePreconditionFailure(error: unknown): boolean {
  return error instanceof HermesSettingsError
    && (error.code === "conflict" || error.code === "invalid_request" || error.code === "not_found");
}

function boundedTimeout(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value)
    ? DEFAULT_MATERIALIZATION_TIMEOUT_MS
    : Math.min(60_000, Math.max(100, Math.trunc(value)));
}

function assertBeforeDeadline(deadlineMs: number): void {
  if (deadlineMs <= Date.now()) throw unavailable();
}

async function settleBeforeDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw unavailable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(unavailable()), remainingMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
