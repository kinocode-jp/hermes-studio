# Dependency maintenance

## Reproducibility

- Node and npm compatibility are declared in `package.json`; the development/CI
  Node patch is pinned in `.node-version`.
- Rust is pinned in `rust-toolchain.toml` and Cargo metadata declares the same
  minimum toolchain line.
- npm and Cargo lockfiles are committed. CI installs/checks with `npm ci` and
  `cargo check --locked`.
- `.npmrc` enforces the declared engine range and the public npm registry.
- Dependabot proposes weekly npm, Cargo, and GitHub Actions updates. Updates are
  reviewed and must pass CI; they are not automatically merged.
- GitHub Actions are referenced by immutable full commit SHA.

## Known dependency limitations

The current Cargo lockfile includes `glib 0.18.5` through Tauri's Linux GTK3
dependency graph. That version is in the affected range for
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
Hermes Studio does not call the affected API directly, and the current desktop
bundle configuration targets macOS app/DMG, but reachability on Linux has not
been established.

Therefore Linux desktop binaries are not a supported release target. Before a
Linux target is enabled, maintainers must update to a dependency graph using a
fixed `glib`, run Rust advisory checks, review the other unmaintained GTK/UNIC
warnings, and complete a Linux-specific build/security review. Do not suppress
the advisory without a documented reachability decision and expiry date.

The npm lockfile also contains deprecated build-time transitive packages via
the PWA toolchain. They had no known exact-version OSV advisory at the 2026-07-16
pre-public review, but that result is time-bound and not a guarantee.

## Install scripts

The repository defines no install lifecycle script. The locked graph includes
standard third-party install scripts for esbuild and the optional macOS
`fsevents` package. CI uses the committed lockfile, and reviewers should treat
changes to `hasInstallScript`, registry URLs, integrity values, or lockfile
resolution as supply-chain-sensitive changes.
