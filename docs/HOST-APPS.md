# Host application installation

Hermes Studio can detect and install a small, explicitly allowlisted set of
applications on the Mac that runs Studio Server. The first supported host app
is Obsidian.

## Obsidian

Open **Settings → Desktop Host Administration → App integrations**. Studio
shows one of these states:

- **Ready to install** — Homebrew is present and Obsidian is not installed.
- **Installing** — the fixed Homebrew cask install is running.
- **Installed** — `/Applications/Obsidian.app` or
  `~/Applications/Obsidian.app` exists.
- **Setup required / failed** — Homebrew is missing, the platform is not macOS,
  the install failed, or the 20-minute timeout expired.

The install action runs the official Homebrew cask command with a fixed
executable and argument list:

```text
brew install --cask obsidian
```

The browser cannot provide an executable, package name, shell fragment, path,
or extra argument. Studio does not create an Obsidian vault, open an app, or
modify any Markdown data as part of installation.

## Authorization boundary

The status endpoint requires an authenticated Studio session. Installation is
the auditable `host-app.install` operation and requires an **owner** session.

- A local owner may install.
- A Tailnet-enrolled owner may install only when
  `HERMES_STUDIO_REMOTE_PRIVILEGED=true`; `npm run start:tailnet` enables this
  intentionally.
- Managers, operators, viewers, and ordinary remote deployments are denied.
- Browser mutations still require the normal CSRF token.

This operation shares the remote-privileged deployment gate used by privileged
configuration and secret transfer, but it never receives or returns a secret.

## HTTP surface

- `GET /api/v1/host/apps/obsidian` — bounded status metadata.
- `POST /api/v1/host/apps/obsidian/install` — starts the fixed install and
  returns immediately with `installing`; request bodies are rejected.

Clients poll the status endpoint while installation is running. Installer
stdout and stderr are discarded rather than copied into HTTP responses or
Studio logs.

## Obsidian note graph

After Obsidian is installed, **Graph and settings** reads the vault registry
maintained by Obsidian itself and displays Markdown note links in an interactive
Three.js scene. Studio accepts a vault id only; browsers cannot provide an
arbitrary filesystem path.

- `GET /api/v1/host/apps/obsidian/vaults` lists registered vault ids and names.
- `GET /api/v1/host/apps/obsidian/graph?vault=…` returns a bounded graph.

The graph response contains relative note ids, display titles, folders, link
counts, and edges. It excludes note bodies and absolute paths. Symlinks,
`.obsidian`, `.git`, `.trash`, and `node_modules` are not scanned. Individual
notes are limited to 512 KiB and the graph is limited to 800 notes. Access is
the owner-tier, remote-privileged `obsidian.vault.read` operation.

Graph presentation settings (vault selection, filters, labels, node size, link
opacity, and automatic rotation) are stored in the browser. Studio does not
rewrite Obsidian's internal application settings or vault files.


## Hermes Agent update

Open **Settings → Desktop Host Administration**. Studio can check the local
Hermes Agent install and run the official fixed update command:

```text
hermes update --yes
```

Status is exposed as:

- `GET /api/v1/host/hermes-agent` — bounded status metadata (version + phase only).
- `POST /api/v1/host/hermes-agent/update` — starts the fixed update and returns
  immediately with `updating`; request bodies are rejected.

Authorization matches host-app install: auditable `hermes-agent.update`, owner
tier, local always, remote only when `HERMES_STUDIO_REMOTE_PRIVILEGED=true`.
Clients cannot supply an executable, branch, shell fragment, or extra argument.
Updater stdout/stderr are discarded.
