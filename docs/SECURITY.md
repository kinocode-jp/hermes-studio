# Security model and implementation status

## Scope and trust model

Hermes Agent can execute tools with the host user's authority. Prompts, Profile
instructions, Skills, Memory, and Kanban-triggered activity are therefore
execution-adjacent input rather than ordinary low-risk application data.

Hermes Studio is experimental, pre-1.0 software. Its currently supported model
is one trusted operator on one machine, with Office and Hermes on loopback.
Private-network remote access by that same operator is experimental. Direct
public-internet exposure, untrusted multi-user use, and tenant isolation are not
supported.

This document describes controls visible in the current source. It is not an
independent audit, certification, or warranty.

## Implemented controls

### Listener and request boundary

- Office Server binds to loopback by default.
- Office Server requires a loopback listener; direct non-loopback binding is
  rejected. Remote browsers must arrive through the configured loopback proxy.
- Local bootstrap checks the peer address, exact Host/Origin allowlists, and
  rejects forwarded requests rather than trusting proxy headers.
- The actual loopback listener origin is always retained for local owner
  management. Port `4173` Vite origins are allowed only by development scripts,
  never by the production default or remote-origin configuration.
- CORS and WebSocket upgrades validate exact configured origins.
- HTTP methods, content types, JSON shapes, identifiers, request bodies,
  WebSocket frames, outbound responses, and event buffers are bounded. HTTP
  responses use a separate bounded budget from request bodies; large chat
  histories and profile/session inventories use byte-bounded pages and opaque
  continuation cursors. History cursors are signed, session/profile-bound, and
  carry the fixed tail window plus cumulative page, message, and UTF-8 wire-byte
  totals. Both server and client page newest-to-older and stop at 40 pages, 500
  messages, or 8 MiB, preserving the newest saved turns in a partial result.
  Inventory collection also has an overall deadline and row/page ceilings;
  incomplete upstream reads are marked truncated. Slow chat
  clients are disconnected with a retryable close code and resynchronize from
  durable history after reconnecting.
- Static web serving rejects traversal and symlink escape and sets a restrictive
  CSP plus cache policies.

These controls reduce accidental exposure and cross-site drive-by requests.
They do not make direct public binding a supported deployment.

### Sessions and mutations

- Local browser sessions and optional remote-token sessions use random HttpOnly,
  SameSite cookies with a bounded lifetime.
- Cookie-authenticated mutations require a matching CSRF token.
- The Tauri path requires an exact Tauri origin and a random launch-scoped
  desktop capability supplied to the WebView through Tauri IPC.
- A remote enrollment token can be spent once per configured token generation
  through a configured loopback HTTPS proxy. The comparison uses a digest and
  constant-time equality; attempts are rate-limited globally, per client, and
  per credential digest in bounded maps.
- Enrollment creates a separate long-lived device credential with a fixed
  `operator` tier. The registry stores only its digest, expiry, revocation, and
  the enrollment-token generation/consumption state in a mode-0600 file under a
  mode-0700 directory by default.
- A restart with the same enrollment token reloads the durable device. Changing
  the token and restarting invalidates all previous devices and opens one
  replacement enrollment.
- A local owner can list or durably revoke the remote device. Remote logout also
  revokes that device, clears both device/session cookies, invalidates its
  sessions, and closes matching event/chat sockets.
- Per-operation policy checks enforce minimum tiers and distinguish remote-safe,
  step-up-required, and local-only operations. No remote step-up flow exists, so
  step-up operations fail closed for remote devices.
- Hermes chat sessions are shared within the declared single-operator trust
  model; a remote operator may resume/read stored sessions shown in its snapshot.
  This is not per-device chat isolation.
- Pending approval replies are bound to the authenticated device and exact chat
  socket that received the request. Permanent approval remains local-only.
- Snapshot `capabilities.access` and allowed operations are calculated from the
  authenticated request rather than a fixed local-owner value.
- WebSocket authentication uses the existing Office session/capability boundary,
  origin checks, frame bounds, and connection cleanup.
- Audit records are kept in a bounded in-memory feed. Both the audit endpoint
  and audit-derived event notifications require owner access.

The current enrollment flow is not a complete multi-user authorization system.
The device registry is durable, but sessions, rate limits, pending approvals,
socket bindings, and audit state are not. A normal restart does not revoke a
device or reopen enrollment; only an enrollment-token generation change performs
the documented global reset. An unreadable, malformed, wrong-version, or
invalid-digest registry fails closed and does not reopen enrollment.

### Hermes boundary

- Browsers receive normalized Office DTOs rather than the Hermes token, Hermes
  backend URL, Profile filesystem paths, or raw provider-secret objects.
- Local model discovery probes only fixed loopback OpenCodex/Ollama/LM Studio/
  vLLM model-list URLs with short deadlines and bounded responses. It reads
  provider/model identifiers only and writes only Studio-owned
  `local-cli-*`/`local-runtime-*` custom endpoints with fixed loopback base URLs;
  it never imports CLI credentials or client-supplied endpoint addresses. The
  remote-safe `local-model-providers.sync` operation is therefore a bounded
  rescan of host-local public metadata, not arbitrary profile configuration.
- Schema-driven Hermes config is filtered fail-closed by field-id policy (not
  Hermes category merges alone): only ordinary non-secret, non-execution-
  adjacent leaves cross the Office boundary on the Advanced surface. Whole
  trees such as terminal, auxiliary, delegation, and write-approval surfaces
  are excluded from Advanced. PATCH accepts dotted leaf changes only (no root
  config object / raw YAML). Hermes 0.18.2 null→string schema inference is
  rejected unless schema type and live value resolve unambiguously; list
  editors accept string rows only (no silent boolean/number coercion).
  Secret-shaped values are dropped on read and rejected on ordinary writes.
  Audit/`profile.changed` omit field names and values. Operation
  `profile-config.update` is manager + **step-up-required** and CSRF
  protected, so remote devices without local step-up cannot mutate Advanced
  config.
- Privileged non-secret Hermes leaves and secret metadata use
  `privileged-config.read` / `privileged-config.update` / `secret.write`
  (owner tier). Local owners always receive these ops. Remote owner devices
  receive them only when `HERMES_STUDIO_REMOTE_PRIVILEGED=true` (Tailscale
  launcher sets this intentionally; default off elsewhere). Protocol
  authorize + `allowedOperations` both enforce the flag; handlers use a
  server-derived privileged-owner session bit (never client headers or
  Tailscale IPs). Secret bytes deposit via Tauri native IPC on desktop, or
  via authenticated `POST /api/v1/secret-transfers` `{ value }` for remote
  owners (CSRF + owner + remote-safe); response is transferId only. Consume
  carries transferId + field metadata only. Clear/unset remains a confirmed
  empty transfer. Memory-provider clear deletes at most one env key under the
  exact unique provider-match rule. Secrets never appear in responses, audit
  events (kind/profile/count only), snapshots, or ordinary config DTOs.
  Tailscale provides network privacy only; Office owner-device authentication
  remains mandatory.
- Fixed host application installation uses the auditable `host-app.install`
  operation (owner tier). Remote owners receive it only under the same explicit
  `HERMES_STUDIO_REMOTE_PRIVILEGED=true` deployment gate. The Obsidian handler
  accepts no request body and runs one absolute Homebrew executable with the
  fixed argument list `install --cask obsidian`; installer output is discarded. Local Hermes Agent updates use the same owner/remote-privileged gate with fixed argv `update --yes` (`hermes-agent.update`); updater output is discarded
  and never reflected to clients or logs. See [`HOST-APPS.md`](HOST-APPS.md).
- Obsidian graph reads use the owner-tier, remote-privileged
  `obsidian.vault.read` operation. Vault paths come only from Obsidian's local
  registry; request parameters are opaque ids. Responses exclude note bodies
  and absolute paths, skip symlinks and application/config directories, and
  enforce note, node, edge, and response-size bounds.
- Managed and adopted Hermes endpoints are restricted to loopback.
- Hermes child processes receive a constructed environment allowlist rather
  than Office Server's complete environment; Office auth/proxy configuration
  and unrelated provider credentials are not inherited.
- Profile settings that Hermes scopes to a process are routed to a
  Profile-pinned Hermes backend.
- General provider-secret entry, Skill installation/deletion, and arbitrary
  Hermes RPC remain excluded from the GUI/API. Destructive built-in Memory
  reset and raw `MEMORY.md`/`USER.md` **read/edit** are available only through
  the versioned Office settings surface under the `memory.update` policy
  (minimum manager tier, step-up/local for remote devices; CSRF on mutations),
  with fixed profile-home paths, rejection of symlink or non-directory
  `memories/` components as well as leaf symlink/non-regular files,
  UTF-8/NUL/size limits, atomic mode-0600 writes, and revision conflicts.
  Document bodies are not copied into audit records or change events. Memory
  status sizes and non-secret provider schema remain on ordinary `state.read`.
- Office global context rejects likely credentials and is injected only into a
  newly created session through an internal server path.
- Office Teams are user-owned Office metadata (opaque team IDs, name, color,
  optional description/lead, ordered unique member profile IDs). They are stored
  with atomic writes, mode-0600 files under mode-0700 directories by default,
  bounded request/file size, and race-safe serialization. Because team context,
  skills, and membership feed new-session inheritance, Team mutations require
  manager tier plus verified local step-up. Teams never write
  Hermes Agent `kanban.db` and never replace individual card assignees.

The desktop shell canonicalizes local Node/Hermes executable paths, rejects
group/world-writable or unexpected-owner files on Unix, bounds version probes,
and requires Node 22.x plus an installed Hermes Agent with a valid semantic
version. Hermes releases are not pinned; Studio instead validates the API
response contracts it consumes. These executables are not yet
verified against a project-signed digest manifest. Treat the local installation
and user account as part of the trusted computing base.

Source development with `npm run dev` is a different trust boundary: managed
mode accepts the explicitly configured executable value and the default bare
`hermes` name is resolved by the allowlisted `PATH`. It receives the same child
environment allowlist, loopback constraints, and version compatibility check,
but not the desktop shell's canonical-path owner/mode validation. Use a trusted
local installation and set an absolute executable path when stricter source-run
selection is required.

### Browser content and storage

- The UI renders structured text/event data rather than injecting raw tool HTML.
- Access credentials are not intentionally stored in URLs or local storage.
- Custom Profile portraits and appearance preferences are browser-local and
  should be treated as ordinary local application data, not secret storage.

## Remote access guidance

If remote access is necessary:

1. keep Office bound to loopback;
2. use an authenticated HTTPS private-network proxy such as Tailscale Serve;
3. configure the exact number of trusted loopback proxy hops and one exact HTTPS
   origin rather than a wildcard;
4. generate a unique random one-time Office enrollment token of at least 32
   characters and do not
   reuse a Hermes/provider credential;
5. restrict the private network to devices controlled by the same trusted
   operator;
6. if a device is lost, generate a different token, replace
   `HERMES_STUDIO_REMOTE_TOKEN`, restart Office, and enroll the replacement;
   this revokes every older remote device;
7. if the registry is corrupt, stop Office, move the registry aside as the local
   host owner, configure a different token, restart, and enroll again; never edit
   the registry while Office is running; an unreadable or corrupt existing registry
   fails closed and remains enrollment-consumed, so the owner must inspect,
   replace, or remove it while Office is stopped;
8. never expose stock `hermes serve` directly.

For a private Tailscale tailnet (including phones), the supported host entry
point is `npm run start:tailnet` (`scripts/start-tailnet.mjs`). It discovers the
host MagicDNS name from `tailscale status --json`, requires
`HERMES_STUDIO_REMOTE_TOKEN`, sets the single canonical `https://…ts.net` origin
in `HERMES_STUDIO_ALLOWED_ORIGINS` (rejects any pre-existing non-loopback remote
origin that differs; valid loopback origins may remain), defaults
`HERMES_STUDIO_TRUSTED_PROXY_HOPS` to `1` when unset, inspects Serve JSON and
creates persistent private Serve only when empty or already an exact private
HTTPS root reverse-proxy
(`tailscale serve --bg --https=443 http://127.0.0.1:4317`, without `--yes` so
Tailscale may require interactive HTTPS/Serve consent), runs production asset
preflight before creating Serve, and starts the production Office launcher. It
fails closed on missing Tailscale, invalid DNS names, non-HTTPS or alternate
remote origins, missing/short tokens, non-loopback binds, missing production
assets, conflicting or unrecognized Serve configuration, and Funnel mapping. It
does not enable Funnel, bind Office to a LAN or tailnet address, invent a second
Office URL, or switch browser endpoints. Remote clients need the official
Tailscale mobile app (same tailnet) and open the single HTTPS origin in a
browser or PWA—there is no native Hermes Studio app. Tailscale selects direct
peer-to-peer or DERP relay transport; Office remains same-origin. Operator
detail: [`TAILSCALE.md`](TAILSCALE.md).

The installed macOS desktop app can own that same remote-enabled Office process
through `npm run start:tailnet:desktop`. This uses the same discovery, exact
origin, proxy-hop, Serve-conflict, Funnel, and token checks, then directly
launches the packaged executable so the validated environment reaches its owned
Office child. It refuses to start while port `4317` is occupied, avoiding an
accidental attachment to an already-running local-only desktop server. The
native app stores that already-validated configuration as one encrypted macOS
Keychain generic-password item. Normal icon launches use it only when no remote
configuration environment value is explicitly present; an explicit environment
deployment takes precedence as a whole. Malformed, unsupported, locked, or denied Keychain data fails closed
with a desktop startup notice. `npm run forget:tailnet:desktop` removes the saved
item but does not alter persistent Tailscale Serve configuration.

## Desktop host administration panel

The owner-only **Desktop Host Administration** panel is rendered only for
sessions authenticated with the Tauri desktop capability and does not appear for
local browsers or remote operators. It shows whether remote access is enabled,
the canonical configured HTTPS origins, the trusted proxy-hop count, and the
list of registered devices, and it lets the owner revoke a device.

The panel never displays the enrollment token, device credential digests, or
cookies.

When the desktop shell finds an existing listener with the compatible health
contract and expected Hermes Studio HTML shape, it opens
`http://127.0.0.1:4317/` in the WebView (same UI as a browser). Those public
shape checks are **not** cryptographic identity of the process; they are the
operator-local trust boundary for loopback Hermes Studio. The shell does not
spawn a second server, generate an ephemeral desktop capability, or stop/kill
the existing process when the app exits. Without the desktop capability, Tauri
IPC and the host administration panel are unavailable—matching a normal browser
session. Incompatible, malformed, timing-out, non-Hermes, or Web-UI-missing
listeners still fail closed with a fixed self-contained `data:` notice and are
never stopped or replaced. Automatic creation of the configured `main` window is
disabled until classification (and owned-child readiness when the port is free)
completes. The normal packaged app URL loads only after an owned child passes its
capability-keyed HMAC readiness check.

The owned-child readiness check is a challenge-response protocol; it is not an
authenticated request that transmits the desktop capability. Every probe uses a
fresh OS-CSPRNG 32-byte nonce. The request contains only the nonce and fixed
domain/version fields. `/api/v1/health/desktop-proof` exists only when a desktop
capability was configured, accepts only strict bodyless GET requests from a
direct loopback peer with no Origin or forwarding headers, and returns a bounded,
`no-store` JSON HMAC-SHA256 proof. The capability is the HMAC key and is never
included in the request or response. The launcher validates status, content type,
schema, lowercase proof encoding, domain-separated HMAC, and the still-running
owned child before creating its WebView. A listener that races to acquire the
port can observe a nonce but cannot forge the proof or obtain the capability.
This endpoint does not create a session and does not authorize any mutation.
After startup, each WebView capability request repeats a fresh proof and checks
the owned child both before and after it. These bounded process and TCP checks
run through an asynchronous Tauri command on a blocking worker rather than the
IPC/UI executor. Gate acquisition, both child-state checks, and the TCP proof
share one 750 ms absolute deadline. The gate uses bounded `try_lock` polling, so
parallel sends cannot wait indefinitely, starve the monitor, or accumulate
unbounded blocking-worker occupancy; an expired queue wait is a transient
failure for that send. The web transport keeps no capability cache and repeats
that IPC check immediately before every HTTP request and WebSocket connection.
Independently, a 250 ms native monitor repeats the proof. A confirmed child exit,
wrong HMAC, oversized response, malformed response, or strict-contract failure
clears the capability first and then closes the main window. Permanent
invalidation runs in the blocking worker or native monitor and recovers a
poisoned capability-state lock; only after that clear completes may the async
command close the window, so the IPC/UI executor never blocks on state clearing.
A timeout,
connection failure, or I/O error returns no capability for the affected send but
does not permanently invalidate native state unless it occurs in three
consecutive monitor checks; any valid proof resets that counter. An unowned
replacement listener is never stopped or killed.

The proof TCP connection and the following browser-managed request are distinct:
there is no atomic channel binding across Tauri IPC and WebView networking. A
malicious local process that rebinds port 4317 in the narrow interval after a
successful per-send proof and before that browser request could observe that
single capability use. The repeated proof, cache removal, and monitor sharply
bound exposure after listener replacement but do not eliminate this residual
local-host scheduling race. Treat mutually untrusted local processes as outside
the optional desktop bridge's threat model and use normal browser/device
authentication for that environment.

If that listener does not serve the Web UI or a bounded probe times out, the
desktop window displays a fixed,
self-contained recovery notice instead of crashing. The notice contains no
server-supplied content, scripts, external resources, or secrets and does not
stop or replace the existing process. Recovery instructions are fixed per
failure kind: port owner and normal-close checks for an unrelated listener;
update or normal restart and log checks for compatibility and probe failures;
combined development or built web assets only when the Web UI is unavailable.
Owned-server runtime, resource, child-launch, readiness, and internal-state
failures also have separate fixed instructions.

Changing server-only remote access requires updating the host environment
(`HERMES_STUDIO_REMOTE_TOKEN`, and when not using `start:tailnet` also
`HERMES_STUDIO_ALLOWED_ORIGINS` / `HERMES_STUDIO_TRUSTED_PROXY_HOPS`) and
restarting Office. Desktop persistence is updated by rerunning
`npm run start:tailnet:desktop` with the intended token and removed with
`npm run forget:tailnet:desktop`. The optional `npm run start:tailnet` host
launcher may set the single discovered HTTPS origin, default trusted proxy hops to `1`, and
create private Tailscale Serve only when empty or already exact (never
overwriting a different Serve config); no in-browser toggle, scheduler, or
remote UI can modify those values. Serve configuration is owned by the host
Tailscale daemon (`--bg` persists until cleared with `tailscale serve`
off/reset).

The `/api/v1/host/remote` status endpoint requires the Tauri desktop capability,
while POST `/api/v1/devices/:id/revoke` deliberately remains local-owner + CSRF
on the trusted loopback listener so the owner can recover when the Tauri
desktop bridge is unavailable.

TLS and proxy authentication are provided by the proxy; Office's loopback HTTP
listener does not itself terminate TLS or validate Tailscale/OIDC identity.

## Known limitations

The following are not implemented or not claimed as complete:

- configurable grants or multiple simultaneously enrolled remote devices;
- RBAC, independent account recovery, and tenant boundaries suitable for
  untrusted users (the current durable fixed `operator` and global token-rotation
  recovery are for the single-operator model);
- remote reauthentication/step-up (step-up operations currently fail closed)
  and an unforgeable native presence flow beyond the Tauri capability;
- OIDC, PKCE, trusted proxy identity, public recovery, or public-internet mode;
- persistent tamper-evident audit storage and export;
- OS credential-store backed provider-secret entry;
- project-signed Node/Hermes runtime version and digest verification;
- signed/notarized project binaries, checksums, SBOM, and provenance;
- a formal external penetration test.

Some of these controls appear as design targets in historical/product documents.
They must not be described as implemented until code, tests, and a security
review support that statement.

## Security invariants for changes

- Never return Office, Hermes, provider, tunnel, or identity-provider secrets in
  browser DTOs, logs, audit records, errors, URLs, or WebSocket events.
- Construct child-process environments from an explicit minimum allowlist; do
  not inherit the entire Office Server environment.
- Keep Hermes endpoints on loopback and reject redirects or alternate addresses
  that escape that boundary.
- Apply authorization on the server for every request and socket operation;
  hiding UI controls is not authorization.
- Treat Skill content, SOUL, shared context, prompts, Kanban comments, tool
  output, filenames, and Markdown as untrusted input.
- Use revision/idempotency checks for mutation paths and re-check authorization
  when queued work begins.
- Do not introduce a permissive fallback when a remote identity, proxy, audit,
  persistence, or compatibility check fails.

## Reporting

Use the private process in the root [`SECURITY.md`](../SECURITY.md). Do not
publish exploit details in a GitHub issue.
