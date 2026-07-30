# Security policy

## Supported versions

Hermes Studio is experimental, pre-1.0 software. Security fixes are applied to
the current `main` branch; no released version is currently supported. This
repository does not yet publish official desktop binaries.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, pull
request, discussion, or chat transcript.

Use GitHub's **Report a vulnerability** form in this repository's Security tab:

<https://github.com/kinocode-jp/hermes-studio/security/advisories/new>

Include the affected commit/version, impact, prerequisites, and the smallest
safe reproduction you can provide. Remove tokens, prompts, profile data, and
personal paths. If private vulnerability reporting is temporarily unavailable,
ask the `kinocode-jp` organization owners for a private contact route without
publishing vulnerability details.

Maintainers will acknowledge a report when capacity permits, validate it,
coordinate a fix, and agree on disclosure timing with the reporter. No specific
response or remediation SLA is promised for this experimental project.

## Deployment warning

The current supported trust model is one trusted operator on one machine. Keep
Hermes and Hermes Studio bound to loopback. Remote access is experimental and
should only be placed behind an authenticated HTTPS private-network proxy used
by that same trusted operator. For Tailscale, use `npm run start:tailnet`, or
`npm run start:tailnet:desktop` for the installed macOS app; see
[`docs/TAILSCALE.md`](docs/TAILSCALE.md). Direct public-internet exposure,
Tailscale Funnel, and untrusted multi-user/tenant deployments are unsupported.

The implementation status and known limitations are documented in
[`docs/SECURITY.md`](docs/SECURITY.md). That document is descriptive, not a
security certification or warranty.
