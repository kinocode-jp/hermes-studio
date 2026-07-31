# Hermes settings adapter contract

> **Document status:** This describes the currently implemented settings
> adapter, including Advanced safe config, Privileged desktop-only config, and
> the one-shot secret transfer. Skill hub install/delete and memory-provider
> setup commands remain out of scope.

Validated against the locally installed Hermes Agent 0.18.2 source on
2026-07-16. `apps/server/src/hermes-settings.ts` is the Office-facing boundary.

## Profile routing

Hermes profiles are separate `HERMES_HOME` directories. Skills endpoints accept
an optional `profile`, but the memory status/provider/reset endpoints do not.
Office therefore resolves a loopback `hermes --profile <name> serve` backend for
the selected profile and sends all profile settings calls to that process. The
resolver may pool these processes with an idle TTL. It must not pass a primary
profile's memory call through `?profile=` and assume it was scoped.

The backend token remains inside Studio Server. Browsers receive normalized DTOs
only; they never receive the Hermes origin, token, filesystem paths, raw provider
objects, or backend exception details.

## Official endpoints used

| Feature | Read | Write | Notes |
| --- | --- | --- | --- |
| Skills list | `GET /api/skills` | — | Profile-pinned backend |
| Skill enablement | — | `PUT /api/skills/toggle` | `{name, enabled}` |
| Skill document | `GET /api/skills/content?name=...` | `PUT /api/skills/content` | Response `path` is discarded |
| Memory status | `GET /api/memory` | — | Process-scoped; file sizes only |
| Active memory provider | — | `PUT /api/memory/provider` | Empty provider selects built-in memory |
| Provider settings | `GET /api/memory/providers/{name}/config?surface=declared` | matching `PUT` | Non-secret fields on the general adapter; declared secret fields use the desktop one-shot secret channel (`source: memory-provider`) |
| Built-in memory reset | — | `POST /api/memory/reset` | Explicit `all`, `memory`, or `user`; destructive |
| Profile identity | `GET /api/profiles/{name}/soul` | matching `PUT` | Official `SOUL.md` surface |
| Safe Hermes config | `GET /api/config/schema`, `GET /api/config` | `PUT /api/config` | Schema-driven ordinary leaves only on Advanced; Office never exposes secrets on that surface |
| Privileged Hermes config | same schema/config | `PUT /api/config` | Previously excluded non-secret leaves; desktop-capability owner only |
| Env secrets | `GET /api/env` (metadata) | `PUT /api/env` | Declared catalog keys only; values never returned to Office clients |

Hermes 0.18.2 has no stable dashboard API for reading or editing raw
`MEMORY.md` and `USER.md`. Office therefore owns a versioned raw-edit contract
that reads and writes only the resolved profile home's
`memories/MEMORY.md` and `memories/USER.md` (path traversal rejected; the
`memories` directory and leaf files must not be symlinks or non-directory /
non-regular nodes; UTF-8 + NUL + size limits; atomic mode-0600 replacement;
SHA-256 `expectedRevision`). Built-in reset still uses the official
profile-pinned Hermes `POST /api/memory/reset`. Provider
status/selection/configuration remains on the Hermes dashboard routes.

## Office global layer

Hermes has no global profile. `OfficeGlobalSettingsStore` owns shared skill
selection and shared context separately from every Hermes home. It uses:

- atomic replacement with a mode-0600 temporary file;
- optimistic `expectedRevision` concurrency control;
- serialized in-process writes;
- bounded content and strict skill names;
- rejection of likely credentials in shared context.

The protocol defines one 64 KiB JSON wire budget for a global update and the
later `session.create` seed. Shared context may occupy at most 48 KiB after JSON
escaping, leaving a 16 KiB envelope reserve; at most 64 global skills may be
selected. The server store, HTTP route, chat adapter, and Web byte counter all
consume these same protocol constants.

`GlobalInheritanceCoordinator` materializes the **union** of global and team
skills through the official profile-pinned skills API. Desired skills for a
profile are:

- global skills when `sharedSkillsEnabled` is true, plus
- skills from every team that lists the profile as a member and has
  `skillsEnabled` true.

It records the exact profile/skill pairs that Office changed from disabled to
enabled. A later removal from the desired set disables only those pairs; skills
that were already enabled by the Profile are never claimed. A Profile-scoped
toggle permanently relinquishes Office ownership for that pair, so a later
global or team save cannot overwrite the user's Profile choice. Ownership
progress is checkpointed during synchronization and survives process restart.
Do not point several profiles at one writable `SKILL.md` directory.

Team settings live on `OfficeTeamsStore` (`settings.revision` is independent of
membership `revision`) and are exposed at `GET/PUT /api/v1/teams/{id}/settings`.
Team membership or settings changes rematerialize skills without bumping the
global settings revision.

Global writes are staged with `skillSync.state = "pending"`. Full success changes
the state to `ready`; partial upstream failure returns HTTP 502 while retaining a
bounded, secret-free failure list for an explicit retry. Revision conflicts return
HTTP 409. This avoids presenting a partially materialized update as complete.

When shared context is enabled, Office injects it as one internal Hermes system
message only on a new `session.create` request. It is never injected on
`session.resume`, and browser requests cannot provide `messages` or use the
internal seed channel.

## Office agent behavior (subagents)

Hermes has no subagent defaults field. `OfficeAgentBehaviorStore` persists
per-profile `{ subagentMode, preferredSubagent }` under
`~/.hermes-studio/agent-behavior.json` with the same atomic write and
`expectedRevision` pattern as the global store. When `subagentMode` is `auto`,
Office appends a short trusted system seed on `session.create` (composed after
shared context when both are present). This is instructional only; Office does
not control Hermes subagent runtime plumbing.

## Office HTTP surface

Every route below requires an Office session. `PUT`/`PATCH` additionally require
the session's `X-CSRF-Token`. Request bodies are bounded JSON objects and unknown
fields fail closed.

- `GET/PATCH /api/v1/settings/global`
- `GET/PUT /api/v1/teams/{teamId}/settings` (team middle layer; also embedded on team list/detail)
- `GET /api/v1/profiles/{profile}/settings`
- `GET /api/v1/profiles/{profile}/skills`
- `PATCH /api/v1/profiles/{profile}/skills/{skill}`
- `GET/PUT /api/v1/profiles/{profile}/skills/{skill}/content`
- `GET/PUT /api/v1/profiles/{profile}/soul`
- `GET/PUT /api/v1/profiles/{profile}/agent-behavior`
- `GET /api/v1/profiles/{profile}/config/schema` (safe field descriptors; `state.read`)
- `GET/PATCH /api/v1/profiles/{profile}/config` (safe leaf values; GET `state.read`, PATCH `profile-config.update`)
- `GET/PATCH /api/v1/profiles/{profile}/privileged-config` (previously excluded non-secret leaves; `privileged-config.read` / `privileged-config.update`; **owner**, local always; remote only when `HERMES_STUDIO_REMOTE_PRIVILEGED=true`)
- `GET/POST /api/v1/profiles/{profile}/secrets` (secret metadata / one-shot consume; GET uses `privileged-config.read`, POST uses `secret.write`; same owner gate)
- `POST /api/v1/secret-transfers` (one-shot secret deposit for desktop native **or** authenticated remote owner HTTPS; `secret.write`; body `{ value }` only; response transferId only)
- `GET /api/v1/profiles/{profile}/memory` (status/sizes only; `state.read`)
- `GET /api/v1/profiles/{profile}/memory/files` (**raw bodies**; `memory.update`)
- `GET/PUT /api/v1/profiles/{profile}/memory/files/{memory|user}` (**raw bodies**; `memory.update`)
- `POST /api/v1/profiles/{profile}/memory/reset` (`target`: `all` | `memory` | `user`; `memory.update`)
- `GET/PATCH /api/v1/profiles/{profile}/memory/providers/{provider}`
- `PUT /api/v1/profiles/{profile}/memory/provider`

Global writes carry an integer `expectedRevision`. Skill/SOUL/provider/memory-file
document writes and schema-driven Hermes config writes carry a SHA-256
`expectedRevision`; toggles/provider selection carry the previous effective
value. Stale writes return HTTP 409. Office serializes each profile/resource
compare-and-write pair, so concurrent writes through the same Studio Server
re-read after the prior write and cannot both accept one revision. Raw
memory-file **reads and writes** use the `memory.update` policy (manager tier,
local step-up for remote devices; CSRF on mutations only) and are auditable
without embedding document bodies in audit records or `profile.changed` events.
Provider status/sizes remain on ordinary `state.read`.

### Schema-driven Hermes config (stage 1)

Hermes 0.18.2 exposes ~500+ dashboard schema fields via
`GET /api/config/schema` plus nested values on `GET /api/config`. Office does
**not** forward the raw schema or config:

1. Fields pass a **fail-closed** policy that prefers **field-id prefixes** over
   Hermes schema categories (category merges such as checkpoints/cron/skills →
   `agent` must not reintroduce denied trees). Stage-1 excludes whole trees
   including `terminal.*`, `auxiliary.*`, `delegation.*`, `moa.*`, `curator.*`,
   `kanban.*`, `cron.*`, `checkpoints.*`, `sessions.*`, `bedrock.*`, plus
   secrets/credentials, approvals/security, gateway/network, messaging,
   desktop/vertex, hooks/updates, model assignment (`model` /
   `fallback_providers` / `toolsets`), write-approval and auto-approve markers,
   path/file/dir/url/cwd/volumes/env/image/shell bindings, and browser
   camofox/private-URL/CDP/unsafe-evaluate surfaces. Allowed ordinary leaves
   remain things like agent timeouts/retries/guidance, display cosmetics,
   compression thresholds, memory enable/char limits (not write approval),
   logging, tool_output / tool_loop_guardrails, human_delay, non-path voice,
   streaming timing, and similar.
2. GET returns only allowed leaves as a flat `values` map plus normalized field
   DTOs (`id`, `category`, `type`, `description`, `options`). Secret-shaped
   string values are dropped even if the field id was allowed. The excluded
   field **count** depends on the live Hermes schema and is not a fixed
   fraction of the ~500 schema entries.
3. **Type fail-closed (Hermes 0.18.2):** the dashboard schema builder
   (`_infer_type`) maps Python `None` defaults to `"string"`, so optional
   numbers such as `max_concurrent_sessions` and `context_file_max_chars` can
   be mislabeled. Office projects a field only when the schema type **and**
   live value resolve to one unambiguous supported editor type (string schema
   + null/missing → deny; string schema + live number → number editor;
   lists → **string rows only**, never coerce boolean/number items via
   `String()`). Ambiguous leaves are counted in `excludedCount` and never
   written.
4. PATCH accepts `{ expectedRevision, changes }` only — dotted field ids mapped
   to boolean/number/string/string-list scalars. Clients cannot send a root
   config object or raw YAML. Office re-validates type, options, size,
   NUL/control characters, NaN/Infinity, nest depth, and list bounds, then
   deep-merges the nested partial into Hermes `PUT /api/config`.
5. `expectedRevision` is the SHA-256 (base64url) of the current safe-leaf
   projection. Hermes PUT is not conditional; Office uses the profile config
   mutation queue + re-read for in-process concurrency and returns 409 on
   revision mismatch.
6. Operation `profile-config.update` is **manager + step-up-required** and
   auditable. Remaining leaves can still change agent behavior, so remote
   devices without local step-up fail closed (same boundary class as
   `skill.enable` / `profile.update`). Audit and `profile.changed` record only
   `{ kind: "config", profile }` — never field names or values.
7. Wire budgets live in `@hermes-studio/protocol`
   (`PROFILE_CONFIG_MAX_*` constants). UI shows the excluded-field **count**
   without naming excluded fields. Advanced tab has explicit **Reload** /
   **Discard** actions that never wipe drafts without confirmation; a config
   GET failure degrades only the Advanced tab (other Settings tabs stay up).

Built-in memory files are frozen into a Hermes session at start, so Office UI
states that save/reset apply to **new sessions only**.

Hermes does not currently expose a conditional-write contract for these routes.
An out-of-process writer that edits Hermes directly can therefore race between
Office's upstream read and write. `expectedRevision` is an in-process Office
concurrency guarantee, not a cross-process transaction; operators should route
interactive settings edits through one Studio Server instance.

### Privileged config + secrets (desktop-capability owner)

Stage-1 Advanced remains the safe ordinary surface. A separate **Privileged**
Settings tab projects previously excluded **non-secret** Hermes leaves
(model/toolsets, terminal/code execution, approvals/security, paths/URLs,
hooks/commands, auxiliary/delegation/MoA/curator/kanban/cron/checkpoints/
sessions/bedrock/computer_use, gateway/network, and similar):

1. Policy is the complement of stage-1 safe leaves: field must not be safe-
   allowed and must not be secret-bearing. Live schema + value resolve
   boolean/number/string/select/string-list editors; object/non-string list
   leaves use a bounded JSON editor only when the live shape validates,
   otherwise they increment `unsupportedCount`.
2. Operations `privileged-config.read` (owner, read-only boundary),
   `privileged-config.update` / `secret.write` (owner, remote-safe) are filtered
   for remote sessions unless `HERMES_STUDIO_REMOTE_PRIVILEGED=true` (set by
   `start:tailnet`). Local owner sessions (desktop capability or local-cookie)
   always pass the privileged-owner gate. Remote managers/operators stay denied.
   Tailscale is the private network boundary; Office owner-device auth + CSRF
   remain mandatory.
3. PATCH still accepts only `{ expectedRevision, changes, confirmed? }` —
   no root config object or raw YAML. Destructive/restart-impact fields
   require `confirmed: true` (and UI confirmation). Audit/`profile.changed`
   record `{ kind: "privileged-config", profile, count }` only.
4. Secrets are never returned. `GET .../secrets` returns metadata only
   (`key`, `source` env|config|memory-provider, optional validated `provider`,
   label/description/category, `isSet`). Values never appear in ordinary
   config DTOs, events, audit, logs, or error text.
5. Secret write path: packaged WebView invokes Tauri `deposit_secret_transfer`
   → Rust POSTs the secret to `POST /api/v1/secret-transfers` with the desktop
   capability (not browser fetch) → returns a short-lived single-use
   `transferId` → browser `POST .../secrets` carries transferId + field
   metadata only (`source`, optional `provider`, `key`, revision) → server
   consumes once under `secret.write`, validates membership against live
   Hermes env catalog / secret config leaves / declared memory-provider
   schema, then calls official Hermes `PUT /api/env`, `PUT /api/config`, or
   `PUT /api/memory/providers/{name}/config?surface=declared` with only that
   secret field. **Clear/Unset** uses the same path with an empty-string
   deposit (UI blank Save remains a no-op; Clear is a separate destructive
   confirmation). Empty env maps to Hermes `DELETE /api/env`; config maps to
   empty PUT. Memory-provider clear never uses declared empty PUT (Hermes
   ignores empty secrets) and never guesses env keys by field-id suffix.
   Clear is allowed only when exactly one secret field is set on that provider
   **and** `/api/env` metadata has exactly one is_set key whose **explicit**
   `provider` slug equals the validated memory provider (missing provider
   never matches). Otherwise clear is rejected without deletes. Metadata may
   expose `canClear` (no env key names); the server recomputes on clear.
   Memory-provider discovery is sequential and bounded. TTL, capacity, and
   single-consume are enforced in-memory; plaintext is not persisted in Office.
6. **Explicit-null schema leaves** that Advanced cannot type (Hermes
   `_infer_type(None)` → `"string"`, e.g. `max_concurrent_sessions`,
   `context_file_max_chars`) are projected only on Privileged as a bounded
   JSON editor initialized to `null`. Missing/undefined paths and secrets
   are not invented. Replacing null requires confirmation. These leaves are
   **not** counted in `unsupportedCount` once projected; `unsupportedCount`
   remains for shapes that cannot be validated as JSON or fail public
   description/type gates.

## Deliberate exclusions

- Memory-provider **non-secret** provider setup/install commands remain
  excluded. Declared memory-provider **secret** fields are writable only via
  the desktop one-shot channel (not ordinary memory provider PATCH DTOs).
- Provider setup/install commands: execution-adjacent and require explicit
  step-up authorization.
- Skill hub installation and deletion: require source verification and audit.
- Raw workspace paths, skill paths, profile directories, and Hermes error
  messages: never copied to Office DTOs.
- Likely-secret rejection for raw `MEMORY.md` / `USER.md` bodies: practical
  memory notes false-positive under credential heuristics, so Office bounds
  and path-isolates content instead of scrubbing or rejecting secret-shaped
  prose on this surface.
- Custom/arbitrary Hermes env keys not declared in the catalog (`custom: true`)
  are not writable through Office (fail closed against arbitrary env injection).
- Ambiguous or object-shaped leaves that fail live JSON validation remain on
  `unsupportedCount` rather than a free-form root editor.
- Hermes config secrets/credentials, approvals/security, gateway/network,
  messaging platform bindings, desktop/vertex host settings, entire
  terminal/auxiliary/delegation/moa/curator/kanban/cron/checkpoints/sessions/
  bedrock trees, model/toolset assignment, write-approval/auto-approve fields,
  path/file/dir/url/cwd/volumes/env/image/shell bindings, browser
  camofox/private-URL/CDP/unsafe evaluate/record_sessions, skills external
  dirs/inline shell/guard/write approval, code execution, hooks, and updates:
  never shown or written by the generic **Advanced** Config UI (use Privileged
  / Secrets when desktop-authorized).
