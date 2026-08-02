# Hermes Studio

Hermes Studio is an experimental, standalone visual interface for
[Hermes Agent](https://github.com/NousResearch/hermes-agent). A Hermes Profile
appears as an office character whose chats, settings, and assigned Kanban work
can be opened from one responsive interface.

> [!IMPORTANT]
> Hermes Studio is an independent community project. It is not an official
> Nous Research product, is not affiliated with or endorsed by Nous Research,
> and does not replace the official Hermes Agent interface.

The project is pre-1.0 and currently intended for source builds by a single
trusted operator. Do not expose it directly to the public internet. See
[Security status](#security-status) before enabling remote access.

## What is implemented

- Discovery of installed Hermes Profiles and stored sessions.
- An animated pixel-office Profile roster. Six base characters include
  front/side/back walking frames; profiles seven and later reuse the roster
  with deterministic hue variants. Roster slots are saved in the browser so
  inventory reorder is stable; after a complete authoritative inventory, slots
  for deleted Profiles are removed and the current roster is compacted.
- Per-Profile custom portrait uploads stored in the browser.
- Up to four simultaneous chat panes with resume, streaming, steering,
  interruption, reconnect, and normalized tool events.
- Office Teams (many-to-many grouping of Hermes Profiles) with roster badges,
  team workload from Kanban, and a Kanban team filter; assignment remains to an
  individual Hermes profile
- Hermes Kanban viewing and mutations, Profile assignment, comments, live
  refresh, and task cables on the office floor.
- Profile-scoped installed Skills, SOUL, and Memory-provider settings through
  Profile-pinned Hermes backends.
- An Office-owned global selected-skill/shared-context layer with explicit
  inheritance synchronization.
- English/Japanese UI, adjustable text size, light/dark themes, responsive
  phone navigation, and an installable PWA shell.
- Loopback browser sessions, Tauri launch capabilities, origin/Host checks,
  CSRF checks for cookie-authenticated writes, bounded request bodies, an
  experimental one-time remote-device enrollment/revocation flow, and a
  desktop-only host administration surface that reports remote access status
  without exposing secrets.

Deliberate exclusions include raw Memory-file editing, destructive Memory
reset, provider-secret entry, Skill installation/deletion, arbitrary Hermes
RPC, and public multi-user administration.

> [!NOTE]
> A steering message shown as **Hermes queue accepted** means stock Hermes
> returned `status: "queued"`; it does not prove that the running turn applied
> the message. In the pinned Hermes version, guidance accepted as a turn is
> finishing can be returned as `pending_steer` by the turn finalizer, but the
> TUI gateway does not forward that leftover into another turn. Hermes Studio
> therefore cannot guarantee delivery at that boundary without forking Hermes,
> and it deliberately does not retry automatically because doing so could apply
> the same instruction twice.

### Live session capacity

Hermes Studio keeps one managed runtime for the `default` profile while allowing
multiple independent chat sessions to use it. Live attachments are bounded so a
burst cannot exhaust the host; when the limit is full, additional sessions show
**Waiting for a run slot** and retry in FIFO order. One initial prompt can be
submitted while a session is waiting and is sent only after that session owns a
live slot. The pending prompt is held by the current Studio client, so closing or
reloading that client cancels it instead of risking an automatic duplicate send.

The defaults are 16 live sessions per Office owner, 8 per profile, and 256 for
the server. Operators can tune them without changing source:

```bash
HERMES_STUDIO_CHAT_SESSION_LEASES_PER_OWNER=32 \
HERMES_STUDIO_CHAT_SESSION_LEASES_PER_PROFILE=16 \
HERMES_STUDIO_CHAT_SESSION_LEASES_TOTAL=512 \
npm start
```

These are live-resource limits, not stored-conversation limits. A literal
unlimited live-process setting is intentionally not provided; queueing preserves
requests while keeping file descriptors, memory, sockets, and model-provider
load bounded.

## Repository layout

```text
apps/web                 Shared responsive Preact/Vite interface and PWA
apps/desktop             Tauri 2 desktop shell
apps/server              Local HTTP/WebSocket control-plane server
packages/hermes-client   Hermes transport boundary
packages/protocol        Shared DTO contract
packages/ui-tokens       Visual tokens
docs                     Design and integration documentation
```

## Requirements

- Node.js/npm versions from `.node-version` and `package.json` (**Node.js 22.x** is required for the desktop launcher’s managed Studio Server)
- Hermes Agent installed for the same OS user (`hermes --version` must report a valid Hermes Agent semantic version). Studio does not pin a particular Hermes Agent release; API response shapes are still validated at runtime. The desktop shell looks for absolute, user-owned binaries under paths such as `~/.hermes/node/bin/node`, `~/.local/bin/hermes`, Homebrew, nvm/fnm/asdf Node 22 installs, and optional overrides `HERMES_STUDIO_NODE` / `HERMES_STUDIO_HERMES_EXECUTABLE`
- Rust toolchain from `rust-toolchain.toml` and the Tauri host prerequisites
  when developing the desktop shell

Node.js and Hermes Agent are **not** redistributed inside the desktop app bundle
today (size, Hermes’ own install surface, and the absence of an official signed
Office binary release). They remain local managed runtimes. See
[Desktop shell behavior](#desktop-shell-behavior).

## Development

Install exactly from the committed lockfile:

```bash
npm ci
npm run dev
```

This starts the PWA on port `4173` and Studio Server on port `4317`. By default,
Studio Server starts a managed stock `hermes serve` process on an OS-selected
loopback port. The development command explicitly allows the two Vite origins;
production does not trust port `4173`. The Hermes backend credential stays in
Studio Server.

Run surfaces individually with:

```bash
npm run dev:server
npm run dev:web
npm run dev:desktop
```

Runtime modes:

```bash
# Default: start and supervise a loopback Hermes backend
HERMES_STUDIO_HERMES_MODE=managed npm run dev

# UI/server demonstration without reading or starting Hermes
HERMES_STUDIO_HERMES_MODE=demo npm run dev

# Connect to an explicitly managed loopback-only Hermes backend
HERMES_STUDIO_HERMES_MODE=existing \
HERMES_STUDIO_HERMES_URL=http://127.0.0.1:12345 \
HERMES_STUDIO_HERMES_TOKEN=replace-me npm run dev
```

Do not commit environment files, tokens, Hermes home data, or generated build
output.

## Local production build

Build and serve the web/server surface locally:

```bash
npm run build:production
npm start
```

The default listener is `127.0.0.1:4317`. Build desktop assets and the local
Tauri application with:

```bash
npm run build --workspace @hermes-studio/desktop
```

This is a developer build, not an official signed release. No project binary is
currently published. The release requirements are tracked in
[`docs/RELEASING.md`](docs/RELEASING.md).

### Private Tailnet (phone / remote browser)

For the same trusted operator on another device in your Tailscale tailnet,
including a phone, use the first-class tailnet launcher after a production
build:

```bash
export HERMES_STUDIO_REMOTE_TOKEN='replace-with-a-random-32+-character-token'
npm run start:tailnet
```

To launch the installed macOS desktop app and have its single owned Office
Server serve both the desktop WebView and Tailnet browsers, quit the app fully
and use `npm run start:tailnet:desktop` with the same token environment. This
avoids running a second Studio Server or moving the desktop app to another port.
The first integrated launch stores the validated remote configuration in macOS
Keychain; subsequent Finder or Dock launches restore it automatically. Use
`npm run forget:tailnet:desktop` to make future icon launches local-only.

Both launch modes discover the host MagicDNS name, set the single canonical
`https://…ts.net` origin (rejecting any pre-existing remote origin that
differs; valid loopback origins may remain), defaults trusted proxy hops to
`1`, creates persistent private Tailscale Serve to
`http://127.0.0.1:4317` only when empty or already exact (never overwriting a
different Serve config; no `--yes`—Tailscale may prompt for HTTPS consent),
and start the selected production or packaged-desktop target after its asset
preflight.
It does **not** enable Funnel, bind Office to a LAN address, or publish a
second URL.

On the phone: install the official Tailscale iOS/Android app, join the same
tailnet, then open the single printed HTTPS origin in a browser (or install the
PWA). There is no native Hermes Studio app. Tailscale selects direct
peer-to-peer or DERP relay transport itself; Office stays same-origin.

Full operator steps, fail-closed conditions, and day-2 operations are in
[`docs/TAILSCALE.md`](docs/TAILSCALE.md).

## Desktop shell behavior

Hermes Studio is web-first: the shared web UI is the primary interface. The
optional Tauri desktop shell is a **one-click local launcher**: click the app,
and when port `4317` is free and the managed runtimes are present it starts an
owned Studio Server child, proves readiness, then opens the packaged Web UI.
You should not need a separate terminal or `npm start` for normal desktop use.

### Prerequisites for “click and run”

| Component | Bundled in `.app`? | Required on the machine |
| --- | --- | --- |
| Web UI assets | Yes (Tauri `frontendDist`) | No |
| Studio Server JS | Yes (`resources/server/hermes-studio-server.mjs`) | No |
| Optional same-origin web copy for browser use of `:4317` | Yes when built via `npm run build:desktop-assets` (`resources/web`) | No |
| Node.js **22.x** | **No** (not redistributed) | **Yes** — preferred `~/.hermes/node/bin/node` |
| Hermes Agent | **No** (not redistributed) | **Yes** — preferred `~/.local/bin/hermes`; no release pin |

**Why Node/Hermes are not bundled:** there is no official signed Hermes Studio
binary release yet (`docs/RELEASING.md`); Hermes Agent is a separate install with
its own lifecycle and size; shipping Node increases the bundle and still leaves
Hermes as an external dependency. Until an official release ships a managed
runtime story, the desktop shell discovers local, absolute, user-owned
executables (with ownership/mode checks) instead of downloading or auto-killing
anything.

Optional overrides (absolute paths only):

```bash
export HERMES_STUDIO_NODE=/absolute/path/to/node
export HERMES_STUDIO_HERMES_EXECUTABLE=/absolute/path/to/hermes
open -a "Hermes Studio"   # or your local tauri run
```

### Startup flow

The launcher does not create its main native window or WebView while it classifies
port 4317.

- **Free port:** the shell starts its own child, captures child stdout/stderr under
  `~/Library/Logs/HermesStudio/` (macOS) or `~/.hermes-studio/logs/` (other Unix),
  verifies health and a nonce-bound HMAC readiness proof without transmitting the
  shell’s ephemeral desktop capability, opens the packaged Web UI, and stops only
  that owned child on exit. It repeats a fresh proof on a blocking worker before
  every capability release and in a 250 ms native monitor. Gate wait, child checks,
  and proof share a 750 ms absolute deadline. Confirmed child exit or invalid proof
  clears the capability before the desktop window closes; transient network/I/O
  failure fails that send and must repeat for three monitor checks before
  invalidation. The web client does not cache the root capability. Trust boundary
  notes are in `docs/SECURITY.md`.
- **Compatible Office already running** (health contract + Hermes Studio Web UI
  shape on `/`): open `http://127.0.0.1:4317/` in the WebView—the **same UI as a
  browser**. The launcher does not spawn a second server, generate a desktop
  capability, or stop/kill the existing process when the app quits. Desktop-only
  host administration (capability IPC) is unavailable in this mode.
- **Missing Node/Hermes, missing bundle resources, spawn failure, or readiness
  timeout:** the window stays open on a cause-specific notice with **Details**,
  a **Diagnostic log** path (`desktop-startup.log`), recovery steps (install Node
  Node 22.x / installed Hermes Agent, free the port, reinstall the app), and no process kill.
- **Incompatible, malformed, timing-out, non-Hermes, or Web-UI-missing listener:**
  fail closed with a fixed notice; never take over the port or kill the process.

Diagnostic logs scrub remote tokens and desktop capabilities. They do not replace
Hermes’ own logging.

Remote access is implemented by the Studio Server and the web UI; the desktop
shell is not a relay and is not required on remote client devices.

## Security status

The supported trust model is one trusted operator on one machine. The safest
deployment keeps both Office and Hermes on loopback.

Remote-device access exists for the same operator, but remains experimental. If
you use it, keep Office bound to loopback and place an authenticated HTTPS
private-network proxy such as Tailscale Serve in front of it. Configure one
unique random, one-time enrollment token of at least 32 characters, one exact
HTTPS origin, and the exact number of trusted loopback proxy hops. The supported
operator path for a private Tailscale tailnet (including phones) is
`npm run start:tailnet` (or `npm run start:tailnet:desktop` for the installed
macOS app), which discovers the MagicDNS name, enforces the
single canonical HTTPS origin, defaults trusted proxy hops to `1`, configures
persistent private Serve only when empty or already exact, and starts
the selected Office owner—without Funnel, LAN binding, or a second URL. See
[`docs/TAILSCALE.md`](docs/TAILSCALE.md). The
**Desktop Host Administration** panel in the Tauri desktop UI shows the live
status, configured origins, and registered devices; it appears only for the owner
who launched the desktop app and is never shown to local browsers or remote
operators.

```bash
# Preferred: private tailnet launcher (Serve + single canonical origin + production start)
HERMES_STUDIO_REMOTE_TOKEN='replace-with-a-random-32+-character-token' \
npm run start:tailnet

# Manual equivalent when you already know the exact HTTPS origin
HERMES_STUDIO_REMOTE_TOKEN='replace-with-a-random-32+-character-token' \
HERMES_STUDIO_ALLOWED_ORIGINS='https://your-device.your-tailnet.ts.net' \
HERMES_STUDIO_TRUSTED_PROXY_HOPS=1 \
npm start
```

Configured remote origins are added to, rather than substituted for, the
server's actual loopback listener origin. This keeps the local production UI at
`http://127.0.0.1:4317` available for owner-only device review and revocation;
unrelated local development origins remain denied.

The first remote browser exchanges the enrollment token over the configured
HTTPS proxy for a separate device credential and HttpOnly session cookie. The
one-time enrollment state and device credential digest are persisted in
`~/.hermes-studio/devices.json` by default; plaintext credentials are not stored
there. Restarting with the same enrollment token preserves that device, which
can renew its short-lived session from its device cookie. Office Teams metadata
is stored separately under `~/.hermes-studio/teams.json` by default
(`HERMES_STUDIO_TEAMS_PATH` overrides the path). Teams group Hermes profile IDs
many-to-many on the Office side only; they do not write Hermes `kanban.db`.

A remote device receives the `operator` tier. It can use the shared
single-operator chat/session namespace and update Kanban, but cannot manage Teams,
change Profile/global settings, or invoke step-up/local-only operations. Capabilities in
the snapshot are calculated for the authenticated client. Approval replies are
bound to the requesting device and chat socket; permanent approvals remain
local-only. Audit records and audit events are owner-only.

A verified local owner can list/revoke an enrolled device. Remote **Log out**
also revokes that device, clears both cookies, and closes its active sockets. A
revoked or lost device cannot be replaced with an already-consumed token. To
recover, generate a different random enrollment token, update
`HERMES_STUDIO_REMOTE_TOKEN`, and restart Office. The token-generation change
invalidates every previously enrolled remote device and opens one replacement
enrollment. Enroll the replacement browser using the new token. Token rotation
is therefore a global remote-device reset, not a per-device operation.

An unreadable or malformed registry fails closed: stored devices are not
accepted and enrollment is not reopened. To recover as the local host owner,
stop Office, move the damaged registry out of the way, configure a different
random enrollment token, restart, and enroll again. Do not edit a live registry;
this recovery intentionally invalidates every old remote-device credential.

This is not OIDC, general multi-user device administration, tenant isolation,
or a claim that an untrusted remote user can safely share the host. Direct
public-internet and direct non-loopback exposure are unsupported; Office must
remain on loopback behind the configured private HTTPS proxy.

Read [`docs/SECURITY.md`](docs/SECURITY.md) for implemented controls, known
limitations, and roadmap boundaries. Report suspected vulnerabilities through
[`SECURITY.md`](SECURITY.md), not a public issue.

## Migration from Hermes Office

Hermes Studio is the rebrand of the former **Hermes Office** product name. Existing
single-operator installs should keep working without a forced cutover.

**Environment variables.** Canonical host configuration uses the `HERMES_STUDIO_*`
prefix. Deprecated `HERMES_OFFICE_*` variables remain as a **read fallback** when
the matching studio key is unset (including `npm run start:tailnet`, the Office
Server, and the desktop launcher). When both are set, **`HERMES_STUDIO_*` wins**,
including an intentionally empty value. Prefer the new names in new installs and
docs; do not commit tokens.

**On-disk state.** The product state directory is `~/.hermes-studio` (devices,
teams, and related Office-owned files). If `~/.hermes-studio` is absent and
`~/.hermes-office` exists, the server **safely renames** the legacy directory into
the new path on first start (same filesystem). If rename is not possible, the
legacy path continues to be used so enrolled devices and teams are not abandoned.
When `~/.hermes-studio` already exists, `~/.hermes-office` is left alone.

**Compatibility identifiers (intentionally unchanged).** Cookie names
(`hermes_office_session` / `hermes_office_device`), WebSocket subprotocol ids
(`hermes-office.v1`, `hermes-office.desktop.*`), the desktop readiness proof
domain (`hermes-office-desktop-readiness`), and the Tauri bundle identifier
(`app.hermesoffice.desktop`) keep their pre-rebrand values so existing enrolled
devices, session cookies, proof verification, and signed/installed desktop
bundles remain compatible. Browser storage keys use `hermes-studio…` with a
dual-read of matching `hermes-office…` keys where needed.

Studio Server is the runtime/control-plane name. “Office” remains only in
workspace feature names such as Office Teams and office floor; it refers to the
in-product workspace model and is not a leftover product brand.

## Documentation

- [`docs/HERMES-INTEGRATION.md`](docs/HERMES-INTEGRATION.md) — pinned upstream
  API research and the adapter boundary
- [`docs/HERMES-SETTINGS.md`](docs/HERMES-SETTINGS.md) — current settings
  adapter contract and exclusions
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current architecture and
  explicitly separated roadmap
- [`docs/TAILSCALE.md`](docs/TAILSCALE.md) — private Tailnet deployment with
  Tailscale Serve (`npm run start:tailnet`)
- [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) — toolchain pins, update policy,
  and known dependency limitations
- [`docs/DESIGN.md`](docs/DESIGN.md) — product/design direction, not an
  implementation guarantee
- [`ASSETS.md`](ASSETS.md) — original asset provenance and license
- [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) — dependency notice and
  binary distribution policy

## License

Hermes Studio source and original project assets are available under the
[MIT License](LICENSE). Third-party dependencies and Hermes Agent remain under
their respective licenses. See [ASSETS.md](ASSETS.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
