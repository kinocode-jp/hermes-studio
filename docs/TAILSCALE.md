# Private Tailnet deployment (Tailscale Serve)

This guide describes the supported way to reach Hermes Studio from another device
you control (including a phone) over a private Tailscale tailnet. It does not
change the Office security model: one trusted operator, loopback Studio Server listener,
exact HTTPS origin allowlist, one-time enrollment token, and no public exposure.

## What you get

- A single canonical HTTPS origin on the host's MagicDNS name
  (`https://<host>.<tailnet>.ts.net`).
- Tailscale Serve as a **private** HTTPS reverse proxy to
  `http://127.0.0.1:4317`.
- The existing production Studio launcher (`npm start` / `scripts/start-studio.mjs`)
  with remote enrollment enabled.
- Same-origin browser/PWA access on every client. There is no second Studio Server URL
  and no browser-side endpoint switching.

## What you do not get

- Tailscale **Funnel** or any public-internet exposure
- Direct LAN or non-loopback binding of Office
- A native Hermes Studio iOS/Android app
- Multi-user tenancy, OIDC, or untrusted remote operators
- Application authentication from Tailscale alone: Serve keeps traffic private;
  Office still requires enrollment, owner tier for privileged settings, and CSRF
  on mutations

## Privileged settings over the tailnet

`npm run start:tailnet` sets `HERMES_STUDIO_REMOTE_PRIVILEGED=true` so an
**owner**-tier enrolled device can open the Privileged settings tab and deposit
secrets over authenticated HTTPS. Other deployments leave the flag unset
(fail closed). Local desktop capability continues to work with the flag off.

Secret entry on remote Web: `POST /api/v1/secret-transfers` with `{ value }`
only (owner + CSRF); response is `{ transferId, expiresAt }` only. Consume
still sends transferId + field metadata only. Packaged desktop still prefers
the Tauri native deposit path.

## Prerequisites

1. **Host**
   - Either Hermes Studio built for production (`npm run build:production`) or
     the packaged macOS app installed for `npm run start:tailnet:desktop`
   - Tailscale installed, logged in, and connected (`tailscale status` shows
     `BackendState: Running`)
   - Tailscale CLI on `PATH` (`tailscale`)
   - MagicDNS available so the node has a `*.ts.net` DNS name
2. **Phone or other client**
   - Official Tailscale app for iOS or Android (or Tailscale on another machine)
   - Signed into the **same tailnet** as the host
   - A normal mobile browser (Safari, Chrome, etc.). Optional: install the Office
     PWA from that browser after enrollment
3. **Secret**
   - A unique random `HERMES_STUDIO_REMOTE_TOKEN` of **at least 32 characters**
   - Set in the host environment for the initial launch; integrated macOS
     desktop mode then persists the validated configuration in Keychain
   - Never commit the token, write it into the repo, or log it

## Quick start

On the host:

```bash
export HERMES_STUDIO_REMOTE_TOKEN='replace-with-a-random-32+-character-token'
npm run build:production   # once, or after pulling changes
npm run start:tailnet
```

To use the installed macOS desktop app as the owner of that same remote-enabled
Studio Server, quit Hermes Studio completely first and run:

```bash
export HERMES_STUDIO_REMOTE_TOKEN='replace-with-a-random-32+-character-token'
npm run start:tailnet:desktop
```

This launches `/Applications/Hermes Studio.app` directly with the validated
Tailnet environment, so the desktop WebView and remote browsers share one Office
Server on `127.0.0.1:4317`. On this first launch, the desktop app saves the
validated token, canonical Tailnet origin, trusted proxy-hop count, and remote
privileged flag as one encrypted macOS Keychain item. Afterward, normal Finder
or Dock launches restore that configuration automatically; rerun
`start:tailnet:desktop` only to update or rotate it. Closing the desktop window
does not quit the macOS app; use **Hermes Studio → Quit Hermes Studio** before
restarting this mode. Set `HERMES_STUDIO_DESKTOP_EXECUTABLE` to an alternate
absolute `Contents/MacOS/hermes-studio` path when the app is installed elsewhere.

The launcher:

1. Reads the host Tailscale DNS name from `tailscale status --json` (`Self.DNSName`).
2. Requires a valid `HERMES_STUDIO_REMOTE_TOKEN` (32–4096 characters, no NUL).
3. Derives the **single** canonical origin `https://<dns-name>` (trailing dots
   stripped).
4. Builds `HERMES_STUDIO_ALLOWED_ORIGINS` for that single remote URL:
   - Always includes the canonical Tailscale HTTPS origin.
   - Retains any **valid loopback** origins already set.
   - **Rejects** (does not merge) any pre-existing non-loopback remote origin that
     differs from the canonical host-derived origin.
   - Rejects wildcards and non-HTTPS remote origins.
5. Sets `HERMES_STUDIO_TRUSTED_PROXY_HOPS=1` unless you already set a value in
   `1`–`8`.
6. Inspects `tailscale serve status --json` **before** changing Serve:
   - Empty config → may create the Office mapping later.
   - Exact idempotent private HTTPS root reverse-proxy for this host on port
     `443` → `http://127.0.0.1:4317` → leave as-is (idempotent no-op).
   - Any other mapping, service, port, path, proxy target, Funnel mapping, or
     unrecognized non-empty shape → **fail closed** without overwriting.
7. Verifies the selected target **before** creating any new persistent Serve
   configuration: production assets (`apps/web/dist`, `apps/server/dist`) for
   `start:tailnet`, or the executable and bundled server/Web UI for
   `start:tailnet:desktop`.
8. When Serve was empty, configures persistent private Serve with the current
   CLI syntax (**no** `--yes`; Tailscale may require explicit interactive
   HTTPS/Serve consent):

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:4317
   ```

   Then re-reads Serve status and requires the exact expected mapping.
9. Starts the production Studio launcher, or directly starts the packaged
   desktop executable in desktop mode, forwards `SIGINT`/`SIGTERM`, and prints
   the canonical URL plus mobile steps. Direct desktop launch is required so
   the validated environment reaches the desktop-owned Office child.

Open **only** the printed HTTPS origin in the remote browser. Local owner tools
remain available on the host at `http://127.0.0.1:4317` as before.

### Phone checklist

1. Install the Tailscale **iOS or Android** app.
2. Join the same tailnet as the Office host.
3. There is **no** native Hermes Studio app. Open the single canonical HTTPS URL
   in the system browser (or add it as a PWA / home-screen web app).
4. Complete one-time enrollment with the enrollment token when Office prompts.
   With `start:tailnet`, that device is enrolled as **owner** so Privileged
   settings work; without `HERMES_STUDIO_REMOTE_PRIVILEGED`, remote devices stay
   **operator** (chat/Kanban only).
5. If connectivity is slow or indirect, wait for Tailscale: it selects direct
   peer-to-peer when possible and falls back to DERP relays automatically. Office
   always stays on the same HTTPS origin; it does not probe alternate endpoints.

## Environment variables

| Variable | Role in both Tailnet launch modes |
| --- | --- |
| `HERMES_STUDIO_REMOTE_TOKEN` | **Required.** One-time enrollment token (≥32 characters). |
| `HERMES_STUDIO_REMOTE_PRIVILEGED` | **Set to `true` by `start:tailnet`.** Allows authenticated **owner** devices to use Privileged settings and one-shot secret deposit over the private tailnet HTTPS origin. Default is **off** for other launchers. Tailscale is only the network boundary; Office owner-device authentication and CSRF remain mandatory. Managers/operators cannot use this surface. |
| `HERMES_STUDIO_ALLOWED_ORIGINS` | Optional pre-set exact origins. Non-loopback remotes must already equal the single canonical Tailscale HTTPS origin (or be unset). Valid loopback origins may remain. |
| `HERMES_STUDIO_TRUSTED_PROXY_HOPS` | Defaults to `1` (Serve → loopback). Set only if you knowingly insert additional trusted loopback hops. |
| `HERMES_STUDIO_HOST` | Must stay loopback (`127.0.0.1` / `localhost` / `::1`). Default `127.0.0.1`. |
| `HERMES_STUDIO_PORT` | Must be `4317` when set. Serve is fixed to that target. |
| `HERMES_STUDIO_DESKTOP_EXECUTABLE` | Desktop mode only. Optional absolute path to the packaged macOS executable. Defaults to `/Applications/Hermes Studio.app/Contents/MacOS/hermes-studio`. |

Unsupported / fail-closed when using `start:tailnet`:

- Missing Tailscale CLI, Tailscale not `Running`, or missing/invalid `Self.DNSName`
- Missing, short, oversized, or NUL-containing enrollment token
- Non-HTTPS remote origins in `HERMES_STUDIO_ALLOWED_ORIGINS`
- A pre-existing non-loopback remote origin that differs from the canonical
  Tailscale HTTPS origin (alternate remotes are not merged)
- `HERMES_STUDIO_ALLOW_NON_LOOPBACK=true` or a non-loopback `HERMES_STUDIO_HOST`
- `HERMES_STUDIO_PORT` set to anything other than `4317`
- `HERMES_STUDIO_TRUSTED_PROXY_HOPS` outside `1`–`8`
- Missing production build assets, or a missing/incomplete packaged desktop app
  when using desktop mode (checked before creating Serve config)
- Port `4317` already in use when using desktop mode; quit the existing desktop
  app completely before relaunching it with the Tailnet environment
- macOS Keychain cannot save the validated desktop configuration, or a saved
  configuration is inaccessible, malformed, unsupported, or fails revalidation
- Existing Tailscale Serve configuration that is not empty and not an exact
  private HTTPS root reverse-proxy for this host on port `443` to
  `http://127.0.0.1:4317` (different ports, paths, targets, services, or
  unrecognized shapes are never overwritten)
- Tailscale **Funnel** mapping on the node (public exposure)

### Serve idempotency and conflicts

| Current `tailscale serve status --json` | Launcher behavior |
| --- | --- |
| Empty / absent | After the selected production or desktop target preflight, creates the Office mapping (may prompt for HTTPS/Serve consent). |
| Exact Office mapping (host `:443` root → `http://127.0.0.1:4317`, private HTTPS only) | Idempotent: leaves Serve unchanged and continues. |
| Anything else (other ports/paths/targets, services, Funnel, invalid JSON, unrecognized non-empty shape) | Fails closed; does **not** overwrite. Operator must inspect and, only if appropriate, reset. |

Neither launcher prints the enrollment token or creates project-local secret
files. The server-only launcher keeps it in the process environment. Desktop
mode asks the native app to store the validated configuration as an encrypted
macOS Keychain generic-password item so later icon launches can restore it;
invalid or inaccessible saved data fails closed. Device credentials after
enrollment are handled by Office itself (see [`SECURITY.md`](SECURITY.md)).

## Networking model

```text
Phone browser/PWA
    │  HTTPS (MagicDNS name, port 443)
    ▼
Tailscale (peer-to-peer when possible, else DERP relay)
    │  private tailnet only — not Funnel
    ▼
Tailscale Serve on the host (TLS termination)
    │  HTTP reverse proxy to loopback
    ▼
Hermes Studio on 127.0.0.1:4317
    │
    ▼
Managed/adopted Hermes on loopback
```

Important properties:

- **Same-origin:** cookies, CSRF, WebSockets, and the PWA all use the one HTTPS
  origin Serve publishes. Do not open a different host/port from the phone.
- **Loopback only for Office:** remote clients never speak plain HTTP to the
  Studio Server port across the LAN or tailnet IP; they speak HTTPS to Serve.
- **Transport is Tailscale's job:** path selection (direct vs relay) is outside
  Office. If the phone and host can form a direct path, Tailscale uses it; if
  not, DERP relays carry the encrypted traffic. Operators do not configure a
  second Studio Server URL for “relay mode.”

## Manual equivalent (without the launcher)

If you must configure by hand, keep the same invariants:

```bash
export HERMES_STUDIO_REMOTE_TOKEN='replace-with-a-random-32+-character-token'
export HERMES_STUDIO_ALLOWED_ORIGINS='https://your-host.your-tailnet.ts.net'
export HERMES_STUDIO_TRUSTED_PROXY_HOPS=1

# Inspect first; do not overwrite an unrelated Serve config.
tailscale serve status
# Only when empty (or already the exact Office mapping), then:
tailscale serve --bg --https=443 http://127.0.0.1:4317
npm start
```

Prefer `npm run start:tailnet` so DNS discovery, single-canonical origin checks,
Serve conflict refusal, production preflight-before-Serve, hop defaulting, Funnel
refusal, and operator messaging stay consistent. Complete any Tailscale
interactive HTTPS/Serve consent prompts if shown (the launcher does not pass
`--yes`).

## Day-2 operations

### Stop Office

Stop the Node process (`Ctrl+C` or your supervisor). Serve is **persistent**
(`--bg`) and keeps its configuration across Office restarts and host reboots
until you change or reset it.

### Disable Serve

```bash
tailscale serve --https=443 off
# or clear all Serve config on this node:
tailscale serve reset
```

To make future desktop icon launches local-only, remove the saved Keychain
configuration, then quit and reopen Hermes Studio:

```bash
npm run forget:tailnet:desktop
```

This removal command intentionally leaves Tailscale Serve unchanged. Run one of
the Serve commands above as well when remote proxying should be disabled.

### Rotate the enrollment token

Token rotation is a **global remote-device reset** (same as non-Tailscale remote
access):

1. Stop Office.
2. Set a new random `HERMES_STUDIO_REMOTE_TOKEN`.
3. Run the same launcher again: `npm run start:tailnet` or
   `npm run start:tailnet:desktop`.
4. Enroll the replacement browser/PWA. Previous remote devices are invalidated.

### Revoke a device without rotating

On the host, use a local owner session (desktop host administration panel or the
documented local revoke API) as described in [`SECURITY.md`](SECURITY.md).

### Lost phone

Assume the device credential is compromised. Revoke the device if you still have
host owner access; otherwise rotate the enrollment token and re-enroll only
devices you still control.

## Security boundaries (unchanged)

- Office does not terminate TLS; Serve does.
- Office does not validate Tailscale identity tokens; private network membership
  plus Office enrollment/session cookies form the remote operator path.
- Remote devices receive the fixed `operator` tier, not local-owner powers.
- Direct public binding, Funnel, and stock `hermes serve` exposure remain
  unsupported.

See [`SECURITY.md`](SECURITY.md) and the root [`SECURITY.md`](../SECURITY.md)
for the full model and vulnerability reporting process.
