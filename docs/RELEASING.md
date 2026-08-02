# Release policy

Hermes Studio currently publishes source only. Building locally is supported
for development, but a local `.app` or DMG is not an official project release.

## Desktop package contents (local / future binary release)

A Tauri production package includes:

- packaged Web UI (`frontendDist`);
- bundled Studio Server module (`resources/server/hermes-studio-server.mjs`);
- optional static web copy (`resources/web`) produced by
  `npm run build:desktop-assets` for operators who open `http://127.0.0.1:4317/`
  in a normal browser while the desktop-owned server is running.

It does **not** currently ship Node.js or Hermes Agent. Local builds and any
future official binary must document the managed runtime requirements (Node
22.x and a separately installed Hermes Agent). Studio does not pin a Hermes
Agent release; it validates the API response contracts it consumes.
Desktop diagnostic logs for launcher failures live under
`~/Library/Logs/HermesStudio/` on macOS (or `~/.hermes-studio/logs/` elsewhere)
and must never contain remote enrollment tokens or desktop capabilities.

## Binary release gate

Before the first public binary release, maintainers must add and review a
protected release workflow that:

- triggers only from an approved immutable tag;
- separates untrusted pull-request CI from signing/notarization jobs;
- uses a protected GitHub environment with the minimum required permissions;
- pins every GitHub Action to a full commit SHA;
- builds from committed npm and Cargo lockfiles;
- fails on unresolved applicable dependency advisories; a Linux release remains
  blocked by the `glib` limitation documented in `DEPENDENCIES.md`;
- signs and notarizes macOS artifacts with an identified release authority;
- produces SHA-256 checksums, an SBOM, dependency license inventory, and full
  third-party notices;
- publishes GitHub artifact attestations/provenance where available;
- records the source commit, toolchain versions, and generated metadata.

Release credentials must never be available to fork pull requests, build
scripts from unreviewed commits, or a `pull_request_target` checkout.

## Repository settings after creation

For `main`, require the CI checks in `.github/workflows/ci.yml`; prohibit force
pushes and deletion. While the repository has only one trusted reviewer, do not
set a required approval count that makes the maintainer unable to merge their
own PR. As soon as a second trusted reviewer has write access, require at least
one approval, dismiss stale approvals, and require approval of the latest
reviewable push. Enable private vulnerability reporting, Dependabot
alerts/security updates, secret scanning, non-provider pattern scanning,
validity checks, and push protection where the organization plan supports them.

Do not advertise or upload an official binary until the binary release gate is
implemented. `THIRD_PARTY_NOTICES.md` describes the notice requirements.
