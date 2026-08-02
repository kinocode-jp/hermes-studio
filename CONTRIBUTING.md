# Contributing to Hermes Studio

Thanks for considering a contribution. Hermes Studio is pre-1.0 software, so
please discuss large product, protocol, security-boundary, or storage changes in
an issue before investing in an implementation.

## Development setup

Use the versions pinned in `.node-version` and `rust-toolchain.toml`, then:

```bash
npm ci
npm run dev
```

Useful checks are:

```bash
npm run typecheck
npm test --workspace @hermes-studio/web
npm run test:server
npm run build:production
```

Desktop work also requires the Tauri prerequisites for the host platform.
CI is the final verification source for pull requests.

## Pull requests

- Keep changes focused and explain user-visible and security-boundary effects.
- Add or update tests for behavior changes.
- Do not commit generated build output, credentials, private prompts, Hermes
  home data, or personal filesystem paths.
- Preserve the lockfiles and review dependency or GitHub Action updates as
  supply-chain changes.
- Update README/docs when the actual implementation changes. Clearly label
  future designs as proposals rather than implemented behavior.
- Record the source, generation tool/date, transformations, and license for new
  bundled visual assets in `ASSETS.md`.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository. Please use a GitHub-provided `noreply` address if
you do not want a personal email address recorded in Git history.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md).
