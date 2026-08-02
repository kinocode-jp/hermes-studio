# Third-party software notices

Hermes Studio source code is licensed under MIT. It also depends on third-party
npm and Rust crates under their own licenses. Those dependencies are not
relicensed by this project.

The authoritative dependency inventories for this revision are:

- `package-lock.json` for npm packages;
- `apps/desktop/src-tauri/Cargo.lock` for Rust crates.

This source repository does not vendor the dependency source archives or their
license texts. Copyright and license notices remain available in each installed
package/crate and its upstream distribution.

## Binary distribution policy

Before publishing any desktop binary or bundled server/web artifact, the
release process must:

1. install only from the committed lockfiles (`npm ci` and Cargo `--locked`);
2. produce a complete license inventory from the resolved npm and Cargo graphs;
3. collect the applicable copyright, license, NOTICE, and attribution texts;
4. review unknown, custom, copyleft, or non-redistributable licenses manually;
5. bundle the generated notices with the application and attach them to the
   release alongside an SBOM and SHA-256 checksums;
6. retain the generated inventory as a release artifact tied to the commit.

An official binary release is blocked until this process is automated and its
output has been reviewed. See [`docs/RELEASING.md`](docs/RELEASING.md).
