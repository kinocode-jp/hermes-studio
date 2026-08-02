import { signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Profile } from "../domain";
import { localizeRuntimeMessage, t, type TranslationKey } from "../i18n";
import {
  CELL,
  cellCenter,
  createCharacters,
  generateWorld,
  tickCharacters,
  type OfficeLayoutId,
  type OfficeSizeId,
  type OfficeWorld,
  type SimCharacter
} from "../office/sim";
import { assignTask, selectProfile, selectedProfileId, sessions, tasks } from "../store";
import { isScheduledSessionHidden } from "../scheduled-sessions";
import { loadMoreProfiles, profileInventoryState } from "../inventory";
import { CharacterPortrait } from "./character-portrait";
import { CardsIcon, CloseIcon, ListIcon } from "./icons";
import { InfoTip } from "./info-tip";
import { StatusPill } from "./status-pill";
import { TaskCables, type TaskCable } from "./task-cables";
import { TeamBadges } from "./team-badges";
import { profileDisplayName } from "../profile-names";
import { setOfficeWindowOpen } from "../office-window";
import { teams } from "../teams-store";
import { groupProfilesByTeams, profileGroupItemKey, type ProfileTeamGroup } from "../profile-team-groups";
import { officeGroupMode, setOfficeGroupMode } from "../group-display-prefs";
import { ProfileContextMenu, useProfileContextMenu } from "./profile-context-menu";
import { Office3D } from "./office-3d";
import "./office-scene.css";

const statusTranslation: Record<Profile["status"], TranslationKey> = {
  working: "status.working",
  waiting: "status.waiting",
  idle: "status.idle",
  blocked: "status.blocked"
};

type OfficeView = "scene" | "list";

function storedPreference<T extends string>(key: string, fallback: T, valid: readonly T[]): T {
  try {
    const candidates = [key];
    if (key.startsWith("hermes-studio")) candidates.push(`hermes-office${key.slice("hermes-studio".length)}`);
    for (const candidate of candidates) {
      const value = window.localStorage.getItem(candidate);
      if (value && (valid as readonly string[]).includes(value)) {
        if (candidate !== key) {
          try { window.localStorage.setItem(key, value); } catch { /* migrate best-effort */ }
        }
        return value as T;
      }
    }
  } catch { /* Preferences may be blocked. */ }
  return fallback;
}

function persistPreference(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Preferences may be blocked. */ }
}

const officeView = signal<OfficeView>(storedPreference("hermes-studio.office-view", "scene", ["scene", "list"]));
const officeLayout = signal<OfficeLayoutId>(storedPreference("hermes-studio.office-layout", "studio", ["studio", "lounge"]));
const officeSize = signal<OfficeSizeId>(storedPreference("hermes-studio.office-size", "m", ["s", "m", "l"]));

function setView(view: OfficeView): void { officeView.value = view; persistPreference("hermes-studio.office-view", view); }
function setLayout(layout: OfficeLayoutId): void { officeLayout.value = layout; persistPreference("hermes-studio.office-layout", layout); }
function setSize(size: OfficeSizeId): void { officeSize.value = size; persistPreference("hermes-studio.office-size", size); }

const CHAR_W = 84;
const CHAR_H = 84;
const DENSE_OFFICE_PROFILE_COUNT = 12;
const MIN_INTERACTIVE_SCENE_SCALE = 0.55;

function profileActivity(profileId: string): string | undefined {
  const profileSessions = sessions.value.filter((session) => session.profileId === profileId && !isScheduledSessionHidden(session));
  const current = profileSessions.find((session) => session.status === "streaming" || session.status === "waiting") ?? profileSessions[0];
  return current?.title;
}

function profileDropHandlers(profileId: string) {
  return {
    onDragOver: (event: DragEvent) => event.preventDefault(),
    onDrop: (event: DragEvent) => {
      const taskId = event.dataTransfer?.getData("application/x-hermes-task");
      if (taskId) assignTask(taskId, profileId);
    }
  };
}

function characterTransform(character: SimCharacter): string {
  return `translate3d(${Math.round(character.x - CHAR_W / 2)}px, ${Math.round(character.y - CHAR_H + 14)}px, 0)`;
}

function stableProfileIds(profileIds: string[]): string[] {
  return [...profileIds].sort((left, right) => left === right ? 0 : left < right ? -1 : 1);
}

/** Default / reception profile is always seat 0 (entrance desk). */
function orderProfilesForOffice(profileIds: readonly string[]): string[] {
  const ids = [...profileIds];
  const defaultIndex = ids.findIndex((id) => id === "default");
  if (defaultIndex <= 0) return ids;
  const [defaultId] = ids.splice(defaultIndex, 1);
  return [defaultId!, ...ids];
}

function placeCharactersAtAssignedDesks(world: OfficeWorld, characters: SimCharacter[]): void {
  for (const character of characters) {
    const desk = world.desks[character.deskIndex];
    if (!desk) continue;
    const seat = cellCenter(desk.chair);
    character.x = seat.x;
    character.y = seat.y;
    character.path = [];
    character.pause = Number.POSITIVE_INFINITY;
    character.moving = false;
    character.direction = "front";
  }
}

function OfficeStage({
  profiles,
  world,
  onProfileActivate,
}: {
  profiles: Profile[];
  world: OfficeWorld;
  onProfileActivate: (event: MouseEvent, profileId: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const charEls = useRef(new Map<string, HTMLButtonElement>());
  const simRef = useRef<SimCharacter[]>([]);
  const statusRef = useRef(new Map<string, Profile["status"]>());
  const [scale, setScale] = useState(1);
  const worldW = world.cols * CELL;
  const worldH = world.rows * CELL;
  const profileKey = profiles.map((profile) => profile.id).join("|");
  const denseLayout = profiles.length >= DENSE_OFFICE_PROFILE_COUNT;
  const assignedProfileIds = useMemo(
    () => orderProfilesForOffice(
      denseLayout
        ? stableProfileIds(profiles.map((profile) => profile.id))
        : profiles.map((profile) => profile.id),
    ),
    [denseLayout, profileKey]
  );
  const assignedDeskByProfile = useMemo(
    () => new Map(assignedProfileIds.map((profileId, deskIndex) => [profileId, deskIndex])),
    [assignedProfileIds]
  );
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const profilesByDesk = assignedProfileIds.map((profileId) => profilesById.get(profileId)!);

  statusRef.current = new Map(profiles.map((profile) => [profile.id, profile.status]));

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const fitScale = Math.min(rect.width / worldW, rect.height / worldH, 1.4);
      setScale(Math.max(fitScale, MIN_INTERACTIVE_SCENE_SCALE));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [worldW, worldH]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const frame = window.requestAnimationFrame(() => {
      stage.scrollLeft = Math.max(0, (stage.scrollWidth - stage.clientWidth) / 2);
      stage.scrollTop = Math.max(0, (stage.scrollHeight - stage.clientHeight) / 2);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scale, worldW, worldH]);

  useEffect(() => {
    simRef.current = createCharacters(world, assignedProfileIds, simRef.current);
    const paint = (now = performance.now()) => {
      const walkFrame = Math.floor(now / 220) % 2;
      for (const character of simRef.current) {
        const el = charEls.current.get(character.id);
        if (!el) continue;
        el.style.transform = characterTransform(character);
        el.style.zIndex = String(100 + Math.round(character.y / 4));
        el.classList.toggle("is-walking", character.moving);
        el.dataset.direction = character.direction;
        el.dataset.walkFrame = String(walkFrame);
      }
    };
    paint();
    if (denseLayout || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      placeCharactersAtAssignedDesks(world, simRef.current);
      paint();
      return;
    }
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      tickCharacters(world, simRef.current, statusRef.current, dt);
      paint(now);
    }, 80);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, profileKey, denseLayout, assignedProfileIds]);

  const cables: TaskCable[] = tasks.value.flatMap((task) => {
    if (!task.assigneeId) return [];
    const deskIndex = assignedDeskByProfile.get(task.assigneeId);
    const desk = deskIndex === undefined ? undefined : world.desks[deskIndex];
    if (deskIndex === undefined || !desk) return [];
    const profile = profilesById.get(task.assigneeId);
    if (!profile) return [];
    return [{
      id: `cable-${task.id}`,
      taskId: task.id,
      taskLabel: task.title,
      profileId: profile.id,
      profileName: profileDisplayName(profile),
      source: { x: (world.board.x + world.board.w / 2) * CELL, y: CELL * 0.9 },
      target: { x: (desk.x + 1) * CELL, y: (desk.y + 0.4) * CELL },
      state: task.status === "running" ? "active" : task.status === "blocked" ? "blocked" : "queued",
      pulse: task.status === "running"
    }];
  });

  return (
    <div class="office-stage" ref={stageRef} data-character-layout={denseLayout ? "assigned" : "roaming"}>
      <div class="office-world-frame" style={{ width: `${worldW * scale}px`, height: `${worldH * scale}px` }}>
        <div class="office-world" style={{ width: `${worldW}px`, height: `${worldH}px`, transform: `scale(${scale})` }}>
          <div class="ow-wall" style={{ height: `${CELL}px` }} aria-hidden="true">
            <span /><span /><span /><span />
            <span class="ow-board" style={{ left: `${world.board.x * CELL}px`, width: `${world.board.w * CELL}px` }}>{t("office.board")}</span>
          </div>
          {world.objects.map((object) => (
            <div
              key={object.id}
              class={`ow-obj ow-${object.type}`}
              style={{ left: `${object.x * CELL}px`, top: `${object.y * CELL}px`, width: `${object.w * CELL}px`, height: `${object.h * CELL}px`, zIndex: object.solid ? 60 + object.y : 10 }}
              aria-hidden="true"
            />
          ))}
          {world.desks.slice(0, profilesByDesk.length).map((desk, index) => (
            <div
              key={`desk-${index}`}
              class="ow-obj ow-desk"
              style={{ left: `${desk.x * CELL}px`, top: `${desk.y * CELL}px`, width: `${2 * CELL}px`, height: `${CELL}px`, zIndex: 60 + desk.y, "--agent-color": profilesByDesk[index]!.color }}
              aria-hidden="true"
            >
              <i class="ow-monitor" />
            </div>
          ))}
          {cables.length > 0 && (
            <TaskCables
              cables={cables}
              width={worldW}
              height={worldH}
              maxCables={24}
              onSelect={(cable) => selectProfile(cable.profileId, { openWorkspace: true })}
            />
          )}
          {profiles.map((profile) => {
            const stateLabel = t(statusTranslation[profile.status]);
            const activity = profileActivity(profile.id);
            const displayName = profileDisplayName(profile);
            return (
              <button
                key={profile.id}
                ref={(el) => { if (el) charEls.current.set(profile.id, el); else charEls.current.delete(profile.id); }}
                class={`ow-char ${selectedProfileId.value === profile.id ? "is-selected" : ""}`}
                style={{ width: `${CHAR_W}px`, height: `${CHAR_H}px`, "--agent-color": profile.color }}
                data-status={profile.status}
                title={activity ?? stateLabel}
                aria-current={selectedProfileId.value === profile.id ? "true" : undefined}
                onClick={(event) => onProfileActivate(event, profile.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onProfileActivate(event, profile.id);
                }}
                {...profileDropHandlers(profile.id)}
                aria-label={t("office.profileLabel", { name: displayName, state: stateLabel, activity: activity ?? stateLabel, count: profile.sessions })}
              >
                <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--sim" decorative />
                <span class="ow-char-name" title={displayName}>{displayName}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function OfficeProfileRow({
  profile,
  onActivate,
}: {
  profile: Profile;
  onActivate: (event: MouseEvent, profileId: string) => void;
}) {
  const stateLabel = t(statusTranslation[profile.status]);
  const activity = profileActivity(profile.id);
  const displayName = profileDisplayName(profile);
  return (
    <button
      class={`office-row ${selectedProfileId.value === profile.id ? "is-selected" : ""}`}
      style={{ "--agent-color": profile.color }}
      aria-current={selectedProfileId.value === profile.id ? "true" : undefined}
      onClick={(event) => onActivate(event, profile.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onActivate(event, profile.id);
      }}
      {...profileDropHandlers(profile.id)}
      aria-label={t("office.profileLabel", { name: displayName, state: stateLabel, activity: activity ?? stateLabel, count: profile.sessions })}
    >
      <CharacterPortrait profileId={profile.id} profileName={displayName} class="character-portrait--row" decorative />
      <span class="office-row-main">
        <b>{displayName}</b>
        {activity && <small title={activity}>{activity}</small>}
        <TeamBadges profileId={profile.id} />
      </span>
      <span class="office-row-meta">
        <StatusPill status={profile.status} />
        {profile.sessions > 0 && <span class="chat-chip" title={`${profile.sessions} ${t("office.chats")}`}>{profile.sessions}</span>}
      </span>
    </button>
  );
}

function OfficeList({
  profiles,
  onActivate,
}: {
  profiles: Profile[];
  onActivate: (event: MouseEvent, profileId: string) => void;
}) {
  return (
    <div class="office-list">
      {profiles.map((profile) => (
        <OfficeProfileRow key={profile.id} profile={profile} onActivate={onActivate} />
      ))}
    </div>
  );
}

function OfficeGroupedList({
  groups,
  onActivate,
}: {
  groups: ProfileTeamGroup<Profile>[];
  onActivate: (event: MouseEvent, profileId: string) => void;
}) {
  return (
    <div class="office-group-list" data-office-group="teams">
      {groups.map((group) => (
        <section
          key={group.key}
          class={`profile-group ${group.kind === "unassigned" ? "profile-group--unassigned" : ""}`}
          aria-label={group.kind === "team" ? group.name : t("team.group.unassigned")}
        >
          <header
            class="profile-group-header"
            style={group.kind === "team" ? { "--team-color": group.color } : undefined}
          >
            <i aria-hidden="true" />
            <b title={group.kind === "team" ? group.name : t("team.group.unassigned")}>
              {group.kind === "team" ? group.name : t("team.group.unassigned")}
            </b>
            <small>{t("team.group.count", { count: group.profiles.length })}</small>
          </header>
          <div class="profile-group-body office-list">
            {group.profiles.map((profile) => (
              <OfficeProfileRow
                key={profileGroupItemKey(group.key, profile.id)}
                profile={profile}
                onActivate={onActivate}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function OfficeScene({ profiles, embedded = false }: { profiles: Profile[]; embedded?: boolean }) {
  const working = profiles.filter((profile) => profile.status === "working").length;
  const attention = profiles.filter((profile) => profile.status === "waiting" || profile.status === "blocked").length;
  const world = useMemo(
    () => generateWorld(officeLayout.value, officeSize.value, Math.max(1, profiles.length)),
    [officeLayout.value, officeSize.value, profiles.length]
  );
  const inventory = profileInventoryState.value;
  const hasTeams = teams.value.length > 0;
  const groupMode = hasTeams && officeGroupMode.value === "teams" ? "teams" : "profiles";
  const grouping = groupMode === "teams"
    ? groupProfilesByTeams(profiles, teams.value)
    : { mode: "flat" as const, profiles };
  // Team mode forces list so many-to-many membership is not ambiguous on the scene floor.
  // Profile count never forces list — large rosters stay on the office floor.
  const effectiveView: OfficeView = groupMode === "teams" ? "list" : officeView.value;
  const {
    menu,
    menuRef,
    closeMenu,
    openProfileMenu,
    openMenuSession,
  } = useProfileContextMenu();

  const onProfileActivate = (event: MouseEvent, profileId: string) => {
    // Right-click / context menu keeps the action menu; left-click opens the detail modal.
    if (event.type === "contextmenu" || event.button === 2) {
      openProfileMenu(event, profileId);
      return;
    }
    event.preventDefault();
    selectProfile(profileId, { openDetail: true });
  };

  return (
    <section
      class={`office-wrap ${embedded ? "office-wrap--embedded" : ""}`}
      aria-label={embedded ? t("office.title") : undefined}
      aria-labelledby={embedded ? undefined : "office-title"}
      data-view={effectiveView}
      data-office-group={groupMode}
    >
      <header class="office-heading">
        {!embedded && (
          <div class="heading-info-group">
            <h1 id="office-title">{t("office.title")}</h1>
            <InfoTip text={t("office.hint")} align="start" side="bottom" />
          </div>
        )}
        <div class="office-heading-actions">
        <div class="office-toolbar">
          <div class="shift-readout" aria-label={t("office.summary")}>
            <span class="stat stat--working" title={t("office.workingCount")}><i /><b>{working}</b></span>
            <span class="stat stat--waiting" title={t("office.attentionCount")}><i /><b>{attention}</b></span>
            <span class="stat stat--total" title={t("office.profilesCount")}><i /><b>{profiles.length}</b></span>
          </div>
          {hasTeams && (
            <div class="profile-group-toggle office-group-seg" role="group" aria-label={t("office.group.aria")}>
              <button
                type="button"
                class={groupMode === "profiles" ? "is-active" : ""}
                aria-pressed={groupMode === "profiles"}
                title={t("office.group.profiles")}
                aria-label={t("office.group.profiles")}
                onClick={() => setOfficeGroupMode("profiles")}
              >{t("office.group.profiles")}</button>
              <button
                type="button"
                class={groupMode === "teams" ? "is-active" : ""}
                aria-pressed={groupMode === "teams"}
                title={t("office.group.teams")}
                aria-label={t("office.group.teams")}
                onClick={() => setOfficeGroupMode("teams")}
              >{t("office.group.teams")}</button>
            </div>
          )}
          <div class="office-seg office-seg--view" role="group" aria-label={t("office.viewLabel")}>
            <button
              type="button"
              class={effectiveView === "scene" ? "is-active" : ""}
              title={groupMode === "teams" ? t("office.group.teamsForcesList") : t("office.viewScene")}
              aria-label={t("office.viewScene")}
              aria-pressed={effectiveView === "scene"}
              disabled={groupMode === "teams"}
              onClick={() => setView("scene")}
            ><CardsIcon /></button>
            <button type="button" class={effectiveView === "list" ? "is-active" : ""} title={t("office.viewList")} aria-label={t("office.viewList")} aria-pressed={effectiveView === "list"} onClick={() => setView("list")}><ListIcon /></button>
          </div>
          {effectiveView === "scene" && (
            <>
              <div class="office-seg office-seg--scene" role="group" aria-label={t("office.layoutLabel")}>
                <button type="button" class={officeLayout.value === "studio" ? "is-active" : ""} title={t("office.layout.studio")} aria-pressed={officeLayout.value === "studio"} onClick={() => setLayout("studio")}>A</button>
                <button type="button" class={officeLayout.value === "lounge" ? "is-active" : ""} title={t("office.layout.lounge")} aria-pressed={officeLayout.value === "lounge"} onClick={() => setLayout("lounge")}>B</button>
              </div>
              <div class="office-seg office-seg--scene" role="group" aria-label={t("office.sizeLabel")}>
                {(["s", "m", "l"] as const).map((size) => (
                  <button key={size} type="button" class={officeSize.value === size ? "is-active" : ""} title={`${t("office.sizeLabel")} ${size.toUpperCase()}`} aria-pressed={officeSize.value === size} onClick={() => setSize(size)}>{size.toUpperCase()}</button>
                ))}
              </div>
            </>
          )}
        </div>
        {!embedded && (
          <button
            type="button"
            class="office-collapse-button"
            aria-label={t("office.remove")}
            title={t("office.remove")}
            onClick={() => setOfficeWindowOpen(false)}
          ><CloseIcon width={18} height={18} /></button>
        )}
        </div>
      </header>

      {effectiveView === "scene" && (
        <Office3D profiles={profiles} world={world} onProfileActivate={onProfileActivate} />
      )}
      {effectiveView === "list" && (
        groupMode === "teams" && grouping.mode === "grouped"
          ? <OfficeGroupedList groups={grouping.groups} onActivate={onProfileActivate} />
          : <OfficeList profiles={profiles} onActivate={onProfileActivate} />
      )}
      {inventory.hasMore && <button class="secondary-button inventory-more" disabled={inventory.loading} onClick={() => void loadMoreProfiles()}>{inventory.loading ? t("inventory.loading") : t("inventory.showMore")}</button>}
      {inventory.truncated && !inventory.hasMore && <small class="inventory-note">{t("inventory.truncated")}</small>}
      {inventory.error && <small class="inventory-note inventory-note--error">{localizeRuntimeMessage(inventory.error)}</small>}

      {menu && (
        <ProfileContextMenu
          menu={menu}
          menuRef={menuRef}
          onClose={closeMenu}
          onOpenSession={openMenuSession}
        />
      )}
    </section>
  );
}
