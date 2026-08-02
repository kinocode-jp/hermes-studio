import { t } from "../i18n";
import { teamsForProfile } from "../teams-store";

const MAX_VISIBLE = 2;

export function TeamBadges({ profileId, compact = false }: { profileId: string; compact?: boolean }) {
  const memberships = teamsForProfile(profileId);
  if (memberships.length === 0) return null;
  const visible = memberships.slice(0, MAX_VISIBLE);
  const overflow = memberships.length - visible.length;
  return (
    <span class={`team-badges ${compact ? "team-badges--compact" : ""}`} aria-label={t("teams.memberships", { count: memberships.length })}>
      {visible.map((team) => (
        <span key={team.id} class="team-badge" style={{ "--team-color": team.color }} role="img" aria-label={team.name} title={team.name} />
      ))}
      {overflow > 0 && <span class="team-badge is-more" role="img" aria-label={memberships.slice(MAX_VISIBLE).map((team) => team.name).join(", ")} title={memberships.map((team) => team.name).join(", ")}>+{overflow}</span>}
    </span>
  );
}
