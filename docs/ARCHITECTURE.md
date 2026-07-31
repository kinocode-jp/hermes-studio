# Hermes Studio architecture

## Document status

This document separates the current pre-1.0 implementation from future design
goals. It is not a claim that every roadmap security control exists.

## Current system

```text
Tauri WebView ─┐
Browser / PWA ─┼── HTTP + WebSocket ── Studio Server ── loopback ── Hermes Agent
               │                         │
               └── same Preact UI        ├── global settings state
                                         ├── Office teams (profile groups)
                                         ├── Profile backend pool
                                         ├── durable remote-device registry
                                         └── bounded in-memory sessions/audit
```

### Web interface

`apps/web` contains the shared Preact/Vite UI and PWA shell. It renders an
office/profile roster, chat workspaces, Kanban, Teams, settings, and responsive mobile
navigation. The character atlas contains six base characters and directional
frames. The browser assigns each current Profile a persisted roster slot: slots
1–6 use the original atlas colors and slot 7 onward reuses those characters with
a deterministic hue shift. Inventory reorder does not change an existing
assignment. Only a complete authoritative inventory may remove deleted Profile
slots and compact the remaining relative order; partial/truncated reads never
prune assignments. Malformed stored slot data is compacted before use.
A profile can override its portrait with browser-local
image data.

The interface talks to Studio Server, not directly to Hermes. Hermes backend
tokens and backend URLs are not part of the public browser DTOs.

### Studio Server

`apps/server` is a Node.js HTTP/WebSocket process. It:

1. serves the production web assets;
2. authenticates local/Tauri or optional remote-token sessions;
3. validates and bounds Office HTTP/WebSocket input;
4. translates supported Profile, chat, settings, and Kanban operations;
5. supervises a managed loopback Hermes backend or adopts an explicitly
   configured loopback backend;
6. starts Profile-pinned Hermes processes for process-scoped settings calls;
7. stores the Office-owned global skill/shared-context state;
8. stores Office-owned Teams metadata (many-to-many profile groups) without
   writing Hermes `kanban.db` or inventing an upstream Hermes teams API;
9. meters skill / MCP / tool usage from the chat event stream (names + daily
   counts only; Asia/Tokyo day keys; `GET /api/v1/stats/usage`).

Chat tool events (`tool.start`) pass through the chat gateway fan-out. Office
classifies each tool name (MCP prefix, profile skill set, else generic tool)
and writes a fail-safe atomic JSON store under `~/.hermes-studio/usage-telemetry.json`.
Telemetry failures never interrupt chat delivery. Content and arguments are
never stored—only public names, totals, last-used timestamps, and a 90-day map.

The remote-device credential digest, fixed `operator` tier, expiry, revocation,
enrollment-token generation digest, and one-time consumption state are persisted
in the device registry (by default `~/.hermes-studio/devices.json`). Office Teams
are persisted under the same Hermes Studio state area (by default
`~/.hermes-studio/teams.json`, override with `HERMES_STUDIO_TEAMS_PATH`). Teams
are Office metadata that group Hermes profile IDs many-to-many; Hermes remains
the canonical source for individual profiles and Kanban card assignees, and card
assignment is never rewritten to a synthetic team identity. The three
Office remote variables (`HERMES_STUDIO_REMOTE_TOKEN`,
`HERMES_STUDIO_ALLOWED_ORIGINS`, `HERMES_STUDIO_TRUSTED_PROXY_HOPS`) come from
the explicit host environment or, for integrated macOS desktop launches, a
validated encrypted Keychain item. Explicit environment values take precedence
over the stored desktop fallback as one deployment configuration; stored and
explicit remote fields are never mixed. The desktop or Node launchers pass these
values only to the Studio Server child; they are not forwarded to the managed
Hermes Agent runtime. The optional
`npm run start:tailnet` entry point (`scripts/start-tailnet.mjs`) discovers the
host Tailscale MagicDNS name, enforces the single canonical HTTPS origin
(rejecting alternate remotes; retaining valid loopback origins), defaults
trusted proxy hops for Serve, creates private Tailscale Serve to loopback port
4317 only when empty or already exact (never overwriting a different Serve
config; production assets preflighted first), and then starts the production
Studio launcher—without Funnel, LAN binding, a second URL, or browser endpoint
switching. Operator documentation: [`TAILSCALE.md`](TAILSCALE.md). The server exposes an owner-only
`/api/v1/host/remote` endpoint that reports the canonical configured HTTPS
origin(s), trusted proxy-hop count, and device metadata without returning the
enrollment token, device digest, or any credential. The web UI renders a
desktop-host administration panel only for sessions authenticated with the Tauri
desktop capability. Session cookies, rate-limit windows, socket bindings,
pending approvals, and the bounded audit feed remain in memory and reset with
the server. The project does not implement a general multi-user identity
provider or public-internet mode.

Hermes stored chat sessions are intentionally shared across the single trusted
operator namespace rather than owned by one remote device. An authenticated
remote operator may open/resume a session shown in its snapshot. Approval
responses are different: pending approval state is ephemeral and bound to the
device and chat WebSocket that received it, preventing a second socket/device
from answering that prompt.

Token usage is collected at the shared chat upstream hub (not per browser socket):
confirmed `prompt.submit`/`session.steer` text contributes estimated input tokens;
each assistant `message.complete` contributes output tokens (real `tokens_out` /
`completion_tokens` when Hermes provides them, otherwise characters÷4). Only
numeric counters are stored (no message text) in `~/.hermes-studio/token-usage.json`,
bucketed by Asia/Tokyo day and Profile, with a 90-day retention cap. Estimated
series are labeled in the Office UI via `GET /api/v1/stats/token-usage`.

Chat model preferences (main/sub provider, model, reasoning effort, and named
presets) are revisioned in the Studio-owned
`~/.hermes-studio/chat-model-preferences.json` store. Authenticated desktop and
Tailnet clients synchronize through
`GET`/`PUT /api/v1/settings/chat-model-preferences`; `localStorage` remains only
as an offline fallback and one-time local-desktop migration source when the
shared store is empty. Remote clients never seed from their origin-local cache.
Changes are broadcast as metadata-only events so another connected client can
refresh without exposing preference values in the event or audit log. The main
selection is applied on `session.create` (and as a session-scoped `/model`
command for an open chat). Named **LLM router presets** pair a main model with an
optional **sub model** (intended for subagent-style work) under a user-chosen
label so the composer can switch pairs quickly. Sub model selection is persisted
and shown in the model panel, but Hermes
`session.create` currently accepts only `model` / `provider` / `reasoning_effort`
for the main chat model—there is no accepted wire field for a sub model—so
Office does not invent one. Applying a sub model to Hermes subagents remains
blocked on Hermes support.

Before loading that picker, Studio performs a bounded local-provider sync. It
reads only public model/provider metadata from the fixed loopback OpenCodex
proxy (`127.0.0.1:10100`) and from running OpenAI-compatible local runtimes at
the standard Ollama, LM Studio, and vLLM loopback ports. It then registers or
updates only Studio-owned `local-cli-*` / `local-runtime-*` custom endpoint ids
for the selected Hermes profile. Codex models published without a provider
prefix are grouped using their `owned_by` metadata; namespaced Claude, Gemini,
Kimi, xAI, and other configured OpenCodex providers remain separated. API keys,
OAuth tokens, CLI config files, arbitrary ports, and non-loopback destinations
are never read or accepted by this discovery path. Installed CLIs that do not
publish an OpenAI-compatible model endpoint (for example the OpenCode session
server) are not misrepresented as Hermes model providers.

Snapshot capabilities are derived from the authenticated principal, exposure,
and operation policies at response time. Audit HTTP data and audit-derived
events are delivered only to owner-authorized clients.

### Hermes adapter and runtime

The Office adapter deliberately uses a small part of the stock `hermes serve`
REST/WebSocket surface. Hermes Profiles remain separate Hermes home directories.
Chat can use an explicitly selected Profile. Settings endpoints that are
process-scoped are routed through a lazily created Profile-pinned backend.

Managed mode starts a user-installed Hermes executable and supervises it. The
desktop shell starts the bundled Studio Server JavaScript using a Node runtime
available on the machine. These are local runtime integrations, not bundled,
signed Hermes or Node distributions. The desktop launcher discovers absolute,
user-owned Node 22.x and Hermes Agent binaries (including common
Homebrew/nvm/fnm/asdf layouts and `HERMES_STUDIO_NODE` /
`HERMES_STUDIO_HERMES_EXECUTABLE` overrides), writes a secret-scrubbed diagnostic
log under `~/Library/Logs/HermesStudio/` (macOS) or `~/.hermes-studio/logs/`, and
captures owned Studio Server child stdout/stderr there in release builds so
startup failures are diagnosable without discarding process output.

Host application installation is a separate fixed-function boundary. The
initial Obsidian integration detects the macOS app bundle and may run only the
allowlisted Homebrew cask command; clients cannot supply shell input, package
names, paths, or arguments. Owner and Tailnet deployment gates are documented in
[`HOST-APPS.md`](HOST-APPS.md).

After a managed child exits unexpectedly, Office invalidates that generation's
origin and token immediately, publishes `runtime.status`, and performs one
single-flight recovery sequence with bounded attempts and backoff. Exhausted
recovery enters the explicit `error` state. Server shutdown suppresses recovery
and waits for any in-flight attempt before terminating the current child, so a
managed process is never respawned after shutdown begins.

The desktop launcher canonicalizes and validates executable ownership/mode and
requires Node 22.x and an installed Hermes Agent without pinning its release. A
source `npm run dev` launch uses the explicit
Hermes executable value; its default bare `hermes` name is resolved through the
allowlisted `PATH` and does not receive the desktop path ownership/mode check.

The exact upstream research and known compatibility uncertainties are in
[`HERMES-INTEGRATION.md`](HERMES-INTEGRATION.md).

### Desktop shell

`apps/desktop` is a small Tauri 2 wrapper intended as a **click-to-run local
launcher**. Production builds bundle the generated Studio Server module and web
assets (WebView `frontendDist` plus optional `resources/web` for same-origin
browser access to `:4317`). At launch, the desktop shell probes the configured
loopback port. If the port is free, release and development launches both
generate a launch-scoped random desktop capability, start an owned Studio Server
child, verify its health and a capability-keyed proof, open the packaged Web UI,
and stop only that child on exit. If Node/Hermes or bundle resources are missing,
or the child fails readiness, the shell keeps a fixed notice with concrete
details and the diagnostic log path instead of a blank failure.
The capability is available to the WebView only through a fresh asynchronous
Tauri IPC call. Its bounded TCP and process checks run on a blocking worker, not
the IPC/UI executor. Concurrent checks use a short polling gate whose wait,
child-state checks, and TCP proof share one 750 ms absolute deadline; an expired
queue wait fails only that check instead of blocking a worker indefinitely. The
shell repeats the nonce-bound proof and owned-child liveness check before each
release, and the web client does not cache the capability in its transport
module or Office session. A 250 ms native monitor
performs the same fresh proof. Child exit or a complete response with a wrong
HMAC or invalid strict contract clears the native capability immediately before
closing the main window. Invalid-state clearing runs on the worker/monitor,
recovers a poisoned capability lock, and must complete before the asynchronous
command closes the window; the IPC/UI executor never waits on that mutex.
Timeout, connection, and I/O failures return no
capability for that send but require three consecutive monitor failures before
permanent invalidation; a valid proof resets the count. This also detects a
development watch parent that remains alive after its actual port listener
exits, while tolerating one short event-loop stall. Replacement listeners are
never killed.

Owned-child readiness never sends that capability to the listener. For each
probe the launcher creates a new 32-byte OS-random nonce and sends only its
lowercase hexadecimal encoding plus a fixed readiness domain and protocol
version. The child returns an HMAC-SHA256 proof keyed by the launch-scoped
capability. The launcher checks the bounded response and proof in constant time,
then confirms that the owned child is still alive. This authenticates the child
across the unavoidable port-bind/startup race without revealing the WebView
authentication credential to a process that wins that race.

The HMAC proof connection and a subsequent WebView HTTP or WebSocket connection
cannot be made atomic by the browser networking boundary. A process that
rebinds the fixed port in the very small interval after the immediate proof but
before the browser send could still observe that one capability use. The
per-send proof, absence of a long-lived web cache, and independent monitor bound
this residual local-host race; they do not provide TCP channel binding. Deployments
whose local users or processes are outside the trust boundary should use the web
surface without the optional desktop capability bridge.

The configured `main` window has automatic creation disabled. No native window
or WebView exists while listener classification (and, when the port is free,
owned-child readiness) is pending.

After an owned child passes its capability-bound HMAC readiness check, the
launcher creates `main` with the configured packaged app URL. If a listener
already has a compatible protocol response and serves the expected Hermes Studio
Web UI shape from `/`, the launcher opens `http://127.0.0.1:4317/` in the
WebView—the same shared UI as a normal browser. Public shape checks are not
cryptographic identity; they are the operator-local trust used to treat the
loopback service as Hermes Studio. In that mode the launcher does not generate a
desktop capability, start a child, or stop/kill the existing process on exit.
Desktop-only host administration (Tauri capability IPC) is unavailable; the
session matches a browser session against that server. Remote clients still need
only a browser, not the desktop app.

Incompatible, malformed, timing-out, non-Hermes, or Web-UI-missing listeners fail
closed with a fixed self-contained `data:` notice. Failures while starting an
owned server distinguish managed runtime, bundled resources, child launch,
readiness, and internal state. These paths do not crash the shell and never stop,
replace, or take ownership of an existing listener. The health-only
`npm run dev:server` process is not opened unless the Web UI is also served from
the same listener.

Local builds are developer artifacts. A signed/notarized project release and
release provenance pipeline do not exist yet; see [`RELEASING.md`](RELEASING.md).

## Current data model

```text
Office global layer
  ├── selected installed skills
  └── shared context for new sessions
          ↓
Office team layer (per team, many-to-many with profiles)
  ├── team skills + skillsEnabled toggle
  └── team shared context + contextEnabled toggle
          ↓ explicit synchronization (union enable-set) / session seed
Office per-profile agent behavior
  └── subagent mode (auto|manual) + preferred name
Hermes Profile (one office character)
  ├── installed skills / SOUL / memory provider
  ├── profile skill overrides (permanent per skill pair)
  ├── live and stored chat sessions
  └── assigned shared Kanban cards
```

### Settings precedence (skills & context)

Office owns three inheritance tiers above Hermes homes. Hermes has no global or
team profile; Office persists its own JSON and materializes into profiles.

1. **Global** (`OfficeGlobalSettingsStore`): skills and shared context for every
   profile when the corresponding toggle is on.
2. **Team** (`OfficeTeamsStore.settings` per team): skills and context for
   members of that team when that team's toggle is on. A profile in multiple
   teams receives the **union** of enabled team skill sets. Team settings use an
   independent `settings.revision` (membership `revision` is separate).
3. **Profile**: a user skill toggle permanently relinquishes Office ownership for
   that profile/skill pair. Later global or team saves never re-claim it.

Effective skills to enable for a profile:

`desired = (global.skills if sharedSkillsEnabled) ∪ (team.skills for each
membership team with skillsEnabled)`

Office records only the pairs it flipped from disabled→enabled. Removal from
`desired` disables only those Office-managed pairs. Skills already enabled by
the profile/user are never claimed.

**Shared context** for a new `session.create` is joined (global first, then
matching team contexts in stable team id order) and clipped to the single
global context wire budget. Context is never injected on `session.resume`.

HTTP: `GET/PUT /api/v1/teams/{teamId}/settings` (revision-checked). Team list
and detail payloads include `settings`. After team settings or membership
changes, Office rematerializes skills using the same pending-mutation/retry
path as global sync.

The Office global layer is not a Hermes “global profile”. It is Office-owned
state synchronized through the supported Profile endpoints with recorded
ownership so a later global change does not claim an independently enabled
Profile skill. Shared context is joined global-first, then matching team
layers, clipped to the budget, and injected only when Office creates a new
chat session. Per-profile agent behavior (subagent defaults) is also
Office-owned JSON; when mode is `auto`, Office appends a short system seed on
`session.create` only (never on resume).

## Current deployment modes

### Local desktop or browser

Loopback is the supported default. Local browser bootstrap is restricted by
socket address, Host, Origin, and forwarded-header checks. The Tauri path also
requires its launch-scoped capability.

### Private-network remote access (experimental)

The same trusted operator may put the loopback listener behind an authenticated
HTTPS private-network proxy with an exact trusted-hop count. Office can spend a
configured token once to enroll one durable `operator` device, then uses a
separate device cookie and short-lived HttpOnly session cookie. Cookie mutations
require CSRF. A restart with the same token reloads the device registry. A local
owner revoke or remote logout durably revokes the device and closes active
sockets.

Replacement enrollment is deliberately global: change the configured random
enrollment token and restart Office. A token-generation mismatch clears all
previous remote-device grants and reopens one enrollment. This is not general
multi-user identity or a tenant boundary.

Malformed, unreadable, wrong-version, or invalid-digest registry data fails
closed without reopening enrollment. Local-host recovery is to stop Office,
move the damaged registry aside, change the random token, restart, and enroll a
replacement; all previous device credentials are invalid after that recovery.

### Public internet (unsupported)

OIDC, trusted proxy identity, multiple independently granted remote devices,
account recovery, and a reviewed public exposure mode are roadmap items. Do not
interpret their mention in design documents as an implemented feature.

## Roadmap architecture (not implemented contract)

Possible future work includes:

- configurable multiple-device viewer/operator/manager/owner grants (the current
  durable enrollment permits one fixed `operator` per token generation);
- reauthentication/step-up and native local-presence proof for high-risk work;
- persistent, append-oriented audit storage;
- OIDC Authorization Code with PKCE and explicit trusted-proxy identity;
- version/integrity verification for managed Hermes and Node runtimes;
- operating-system credential-store integration beyond the desktop-native
  one-shot secret transfer already used for declared Hermes env/config secrets;
- resumable ordered event journals with permission-filtered subscriptions;
- signed/notarized releases, checksums, SBOMs, and attestations;
- a separate native mobile client if the responsive PWA becomes insufficient.

Roadmap controls must fail closed and receive a security review before README or
release notes describe them as supported.
