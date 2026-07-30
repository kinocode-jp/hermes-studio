import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OFFICE_PORT = 4317;
const LOOPBACK_TARGET = `http://127.0.0.1:${OFFICE_PORT}`;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 4_096;
const SERVE_HTTPS_PORT = "443";
const DESKTOP_ARGUMENT = "--desktop";
const FORGET_DESKTOP_ARGUMENT = "--forget-desktop";
const DEFAULT_MACOS_DESKTOP_EXECUTABLE = "/Applications/Hermes Studio.app/Contents/MacOS/hermes-studio";
const DESKTOP_KEYCHAIN_SERVICE = "app.hermesoffice.desktop.remote-config";
const DESKTOP_KEYCHAIN_ACCOUNT = "tailnet-owner";
/** Allow time for interactive Tailscale HTTPS/Serve consent prompts. */
const SERVE_CONFIGURE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Suffixes this launcher reads (and forwards to the selected Office owner).
 * Canonical prefix is HERMES_STUDIO_*; deprecated HERMES_OFFICE_* is copied
 * only when the studio key is unset so existing host envs keep working.
 * Never log values — REMOTE_TOKEN and similar are secrets.
 */
const LEGACY_ENV_SUFFIXES = [
  "REMOTE_TOKEN",
  "ALLOWED_ORIGINS",
  "TRUSTED_PROXY_HOPS",
  "ALLOW_NON_LOOPBACK",
  "HOST",
  "PORT",
  "REMOTE_PRIVILEGED",
];

const officeLauncher = fileURLToPath(new URL("./start-studio.mjs", import.meta.url));
const webIndex = fileURLToPath(new URL("../apps/web/dist/index.html", import.meta.url));
const serverEntry = fileURLToPath(new URL("../apps/server/dist/index.js", import.meta.url));

function launchTarget() {
  const args = process.argv.slice(2);
  if (args.length === 0) return "office";
  if (args.length === 1 && args[0] === DESKTOP_ARGUMENT) return "desktop";
  if (args.length === 1 && args[0] === FORGET_DESKTOP_ARGUMENT) return "forget-desktop";
  fail(`unsupported arguments. Use no arguments for Office Server, ${DESKTOP_ARGUMENT} for the installed desktop app, or ${FORGET_DESKTOP_ARGUMENT} to remove its saved remote configuration.`);
}

function fail(message) {
  process.stderr.write(`Hermes Studio tailnet launcher: ${message}\n`);
  process.exit(1);
}

/**
 * Promote deprecated HERMES_OFFICE_* into HERMES_STUDIO_* when the studio key
 * is absent. HERMES_STUDIO_* always wins (including an intentionally empty
 * value). Does not print or log any env values.
 */
function applyLegacyEnvFallbacks() {
  for (const suffix of LEGACY_ENV_SUFFIXES) {
    const studioKey = `HERMES_STUDIO_${suffix}`;
    const legacyKey = `HERMES_OFFICE_${suffix}`;
    if (Object.prototype.hasOwnProperty.call(process.env, studioKey)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(process.env, legacyKey)) {
      process.env[studioKey] = process.env[legacyKey];
    }
  }
}

function isLoopbackHost(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isLoopbackOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeOrigin(origin) {
  const value = origin.trim();
  if (value === "" || value === "*" || value === "null") return "";
  try {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
      return "";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (parsed.pathname !== "/") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function parseOriginList(raw) {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function stripTrailingDots(value) {
  return value.replace(/\.+$/u, "");
}

function isValidTailscaleDnsName(dnsName) {
  if (typeof dnsName !== "string") return false;
  const host = stripTrailingDots(dnsName).toLowerCase();
  if (host.length < 8 || host.length > 253) return false;
  if (!host.endsWith(".ts.net")) return false;
  if (host.includes("://") || host.includes("/") || host.includes(" ") || host.includes(":")) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u.test(host)) {
    return false;
  }
  return true;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeySet(obj, expectedKeys) {
  const keys = Object.keys(obj).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length) return false;
  return keys.every((key, index) => key === expected[index]);
}

async function runTailscale(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("tailscale", args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: options.timeoutMs ?? 15_000,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      fail(
        "the Tailscale CLI (`tailscale`) was not found on PATH. Install Tailscale, ensure the CLI is available, and join this host to a tailnet before using start:tailnet.",
      );
    }
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderr.trim() !== "" ? stderr.trim() : message;
    fail(`Tailscale command failed (${args.join(" ")}): ${detail}`);
  }
}

async function discoverCanonicalOrigin() {
  const { stdout } = await runTailscale(["status", "--json"]);
  let status;
  try {
    status = JSON.parse(stdout);
  } catch {
    fail("could not parse `tailscale status --json` output.");
  }

  const backendState = typeof status?.BackendState === "string" ? status.BackendState : "";
  if (backendState !== "Running") {
    fail(
      `Tailscale is not running (BackendState=${backendState || "unknown"}). Bring the host online with \`tailscale up\` and retry.`,
    );
  }

  const rawDnsName = status?.Self?.DNSName;
  if (typeof rawDnsName !== "string" || rawDnsName.trim() === "") {
    fail("Tailscale status did not include Self.DNSName. Confirm MagicDNS is available for this node.");
  }
  if (!isValidTailscaleDnsName(rawDnsName)) {
    fail(`Tailscale DNS name is missing or invalid (${JSON.stringify(rawDnsName)}).`);
  }

  const host = stripTrailingDots(rawDnsName).toLowerCase();
  const origin = normalizeOrigin(`https://${host}`);
  if (origin === "" || !origin.startsWith("https://")) {
    fail(`derived Office origin is not a valid HTTPS origin for host ${host}.`);
  }
  return origin;
}

/**
 * Preserve a single canonical remote Office URL.
 * Valid loopback origins may remain. Any pre-existing non-loopback remote origin
 * that differs from the host-derived canonical Tailscale HTTPS origin is rejected
 * (not merged). The canonical origin is always present in the result.
 */
function validateAndBuildAllowedOrigins(canonicalOrigin) {
  const existingRaw = process.env.HERMES_STUDIO_ALLOWED_ORIGINS;
  const existing = parseOriginList(existingRaw);
  const allowed = [];
  const seen = new Set();

  for (const candidate of existing) {
    const normalized = normalizeOrigin(candidate);
    if (normalized === "") {
      fail(
        "HERMES_STUDIO_ALLOWED_ORIGINS contains an invalid origin entry. Use exact origins only (no wildcards, credentials, paths, or query strings).",
      );
    }

    if (isLoopbackOrigin(normalized)) {
      if (!seen.has(normalized)) {
        seen.add(normalized);
        allowed.push(normalized);
      }
      continue;
    }

    if (!normalized.startsWith("https://")) {
      fail(
        `refusing non-HTTPS remote origin ${normalized}. Tailnet deployment requires exact HTTPS origins only.`,
      );
    }

    if (normalized !== canonicalOrigin) {
      fail(
        `HERMES_STUDIO_ALLOWED_ORIGINS contains remote origin ${normalized} that differs from the single canonical Tailscale origin ${canonicalOrigin}. start:tailnet does not merge alternate remote origins; unset or correct HERMES_STUDIO_ALLOWED_ORIGINS and retry.`,
      );
    }

    if (!seen.has(normalized)) {
      seen.add(normalized);
      allowed.push(normalized);
    }
  }

  if (!seen.has(canonicalOrigin)) {
    allowed.push(canonicalOrigin);
    seen.add(canonicalOrigin);
  }

  if (!seen.has(canonicalOrigin)) {
    fail("internal error: canonical Tailscale origin was not retained in the allowlist.");
  }

  return allowed;
}

function validateToken() {
  const token = process.env.HERMES_STUDIO_REMOTE_TOKEN;
  if (token === undefined || token === "") {
    fail(
      "HERMES_STUDIO_REMOTE_TOKEN is required. Set a unique random enrollment token of at least 32 characters in the host environment (do not commit it).",
    );
  }
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH || token.includes("\0")) {
    fail(
      `HERMES_STUDIO_REMOTE_TOKEN must contain ${MIN_TOKEN_LENGTH} to ${MAX_TOKEN_LENGTH} characters and must not include NUL.`,
    );
  }
}

function validateHostBinding() {
  if (process.env.HERMES_STUDIO_ALLOW_NON_LOOPBACK === "true") {
    fail(
      "HERMES_STUDIO_ALLOW_NON_LOOPBACK=true conflicts with private Tailnet deployment. Keep Office on loopback and use Tailscale Serve only.",
    );
  }

  const host = process.env.HERMES_STUDIO_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    fail(
      `HERMES_STUDIO_HOST=${host} is not loopback. Private Tailnet deployment requires the Office listener on 127.0.0.1 (or ::1/localhost) behind Tailscale Serve.`,
    );
  }

  const portRaw = process.env.HERMES_STUDIO_PORT;
  if (portRaw !== undefined && portRaw !== "") {
    // Require a canonical base-10 integer string (reject "4317junk", "4317.5", etc.).
    if (!/^(?:0|[1-9]\d*)$/u.test(portRaw)) {
      fail(
        `HERMES_STUDIO_PORT must be ${OFFICE_PORT} for start:tailnet (Serve is fixed to ${LOOPBACK_TARGET}). Unset it or set it to ${OFFICE_PORT}.`,
      );
    }
    const port = Number(portRaw);
    if (!Number.isSafeInteger(port) || port !== OFFICE_PORT) {
      fail(
        `HERMES_STUDIO_PORT must be ${OFFICE_PORT} for start:tailnet (Serve is fixed to ${LOOPBACK_TARGET}). Unset it or set it to ${OFFICE_PORT}.`,
      );
    }
  }
}

function configureTrustedProxyHops() {
  const raw = process.env.HERMES_STUDIO_TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") {
    process.env.HERMES_STUDIO_TRUSTED_PROXY_HOPS = "1";
    return 1;
  }
  // Require a canonical base-10 integer string (reject "1junk", "1.5", etc.).
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    fail(
      "HERMES_STUDIO_TRUSTED_PROXY_HOPS must be an integer from 1 to 8 for Tailscale Serve. Unset it to default to 1.",
    );
  }
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 1 || hops > 8) {
    fail(
      "HERMES_STUDIO_TRUSTED_PROXY_HOPS must be an integer from 1 to 8 for Tailscale Serve. Unset it to default to 1.",
    );
  }
  return hops;
}

/**
 * Production asset preflight. Must run before creating persistent Serve config
 * so a missing build cannot leave a newly configured proxy behind.
 */
async function assertProductionAssets() {
  try {
    await Promise.all([access(webIndex, constants.R_OK), access(serverEntry, constants.R_OK)]);
  } catch {
    fail("Hermes Studio is not built. Run `npm run build:production` first.");
  }

  try {
    await access(officeLauncher, constants.R_OK);
  } catch {
    fail(`production launcher is missing at ${officeLauncher}.`);
  }
}

function configuredDesktopExecutable() {
  const configured = process.env.HERMES_STUDIO_DESKTOP_EXECUTABLE;
  const executable = configured === undefined || configured.trim() === ""
    ? DEFAULT_MACOS_DESKTOP_EXECUTABLE
    : configured.trim();
  if (process.platform !== "darwin") {
    fail(`${DESKTOP_ARGUMENT} currently supports the packaged macOS desktop app only.`);
  }
  if (!isAbsolute(executable) || executable.includes("\0")) {
    fail("HERMES_STUDIO_DESKTOP_EXECUTABLE must be an absolute path to the packaged desktop executable.");
  }
  return executable;
}

/**
 * Desktop asset preflight. Must run before creating persistent Serve config so
 * a missing or incomplete app bundle cannot leave a new proxy behind.
 */
async function assertDesktopApplication(executable) {
  const contentsDirectory = dirname(dirname(executable));
  const bundledServer = join(contentsDirectory, "Resources/resources/server/hermes-studio-server.mjs");
  const bundledWebIndex = join(contentsDirectory, "Resources/resources/web/index.html");
  try {
    await Promise.all([
      access(executable, constants.R_OK | constants.X_OK),
      access(bundledServer, constants.R_OK),
      access(bundledWebIndex, constants.R_OK),
    ]);
  } catch {
    fail(
      `the packaged desktop app is missing or incomplete at ${executable}. Install Hermes Studio.app or set HERMES_STUDIO_DESKTOP_EXECUTABLE to its Contents/MacOS/hermes-studio executable.`,
    );
  }
}

/**
 * A running desktop app would attach to its existing local-only child instead
 * of starting a new remote-enabled child. Require a free Office port before
 * launching the desktop target so that failure mode is explicit.
 */
async function assertDesktopOfficePortAvailable() {
  await new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        fail(
          `port ${OFFICE_PORT} is already in use. Quit Hermes Studio completely (closing its window is not enough on macOS), confirm ${LOOPBACK_TARGET} is no longer serving, and retry.`,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      fail(`could not verify that port ${OFFICE_PORT} is available before desktop launch: ${message}`);
    });
    probe.listen({ host: "127.0.0.1", port: OFFICE_PORT, exclusive: true }, () => {
      probe.close((error) => {
        if (error) {
          fail(`could not release the port ${OFFICE_PORT} preflight listener: ${error.message}`);
        }
        resolve();
      });
    });
  });
}

async function forgetDesktopRemoteConfiguration() {
  if (process.platform !== "darwin") {
    fail(`${FORGET_DESKTOP_ARGUMENT} currently supports macOS Keychain only.`);
  }
  try {
    await execFileAsync(
      "/usr/bin/security",
      ["delete-generic-password", "-a", DESKTOP_KEYCHAIN_ACCOUNT, "-s", DESKTOP_KEYCHAIN_SERVICE],
      { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 15_000 },
    );
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "") : "";
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === 44 || stderr.includes("could not be found in the keychain")) {
      process.stdout.write("Hermes Studio has no saved desktop remote configuration.\n");
      return;
    }
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    fail(`could not remove the saved desktop remote configuration from macOS Keychain: ${message}`);
  }
  process.stdout.write(
    "Hermes Studio desktop remote configuration removed from macOS Keychain. Quit and reopen the app to return to local-only mode. Tailscale Serve remains unchanged.\n",
  );
}

function isEmptyServeConfig(config) {
  if (config === null || config === undefined) return true;
  if (!isPlainObject(config)) return false;
  return Object.keys(config).length === 0;
}

function funnelMappingPresent(config) {
  if (!isPlainObject(config) || !("AllowFunnel" in config)) return false;
  const allowFunnel = config.AllowFunnel;
  if (allowFunnel === true) return true;
  if (!isPlainObject(allowFunnel)) return false;
  return Object.keys(allowFunnel).length > 0;
}

/**
 * Exact idempotent private HTTPS root reverse-proxy for the canonical host on
 * port 443 → http://127.0.0.1:4317. Any other shape is a conflict.
 */
function isExactIdempotentPrivateHttpsRootProxy(config, canonicalHost) {
  if (!isPlainObject(config)) return false;
  // Only the TCP + Web shape we configure is accepted. Services, Foreground,
  // AllowFunnel, or any other top-level key is a conflict / unrecognized config.
  if (!sameKeySet(config, ["TCP", "Web"])) return false;

  const tcp = config.TCP;
  if (!isPlainObject(tcp) || !sameKeySet(tcp, [SERVE_HTTPS_PORT])) return false;
  const tcpHandler = tcp[SERVE_HTTPS_PORT];
  if (!isPlainObject(tcpHandler) || !sameKeySet(tcpHandler, ["HTTPS"])) return false;
  if (tcpHandler.HTTPS !== true) return false;

  const web = config.Web;
  if (!isPlainObject(web)) return false;
  const webKeys = Object.keys(web);
  if (webKeys.length !== 1) return false;

  const expectedWebKey = `${canonicalHost.toLowerCase()}:${SERVE_HTTPS_PORT}`;
  const actualWebKey = webKeys[0];
  if (typeof actualWebKey !== "string" || actualWebKey.toLowerCase() !== expectedWebKey) {
    return false;
  }

  const webServer = web[actualWebKey];
  if (!isPlainObject(webServer) || !sameKeySet(webServer, ["Handlers"])) return false;

  const handlers = webServer.Handlers;
  if (!isPlainObject(handlers) || !sameKeySet(handlers, ["/"])) return false;

  const rootHandler = handlers["/"];
  if (!isPlainObject(rootHandler) || !sameKeySet(rootHandler, ["Proxy"])) return false;
  if (rootHandler.Proxy !== LOOPBACK_TARGET) return false;

  return true;
}

async function readServeStatusJson() {
  const { stdout } = await runTailscale(["serve", "status", "--json"], { timeoutMs: 15_000 });
  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed === "null") {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    fail(
      "could not parse `tailscale serve status --json` output. Refusing to change Serve without a readable configuration.",
    );
  }
}

/**
 * Inspect current Serve JSON before any change. Fail closed unless empty or an
 * exact idempotent private HTTPS root reverse-proxy for this host. Never
 * overwrite a different existing configuration. Reject Funnel mappings and
 * invalid/unrecognized non-empty configuration instead of guessing.
 *
 * @returns {"empty" | "exact"}
 */
async function assertServeConfigurationSafe(canonicalHost) {
  const config = await readServeStatusJson();

  if (isEmptyServeConfig(config)) {
    return "empty";
  }

  if (!isPlainObject(config)) {
    fail(
      "existing Tailscale Serve configuration is invalid or unrecognized. Inspect with `tailscale serve status` and reset only if you intend to replace it. The launcher will not overwrite an unrecognized configuration.",
    );
  }

  if (funnelMappingPresent(config)) {
    fail(
      "Tailscale Funnel mapping is present on this node. Public Funnel exposure is unsupported. Disable Funnel (`tailscale funnel reset` or turn off the matching funnel handlers) and use private Serve only. The launcher will not overwrite Funnel configuration.",
    );
  }

  if (isExactIdempotentPrivateHttpsRootProxy(config, canonicalHost)) {
    return "exact";
  }

  fail(
    `existing Tailscale Serve configuration is not an exact private HTTPS root reverse-proxy for ${canonicalHost} on port ${SERVE_HTTPS_PORT} to ${LOOPBACK_TARGET}. The launcher will not overwrite a different Serve mapping, service, or port configuration. Inspect with \`tailscale serve status\` and, only if appropriate, clear it with \`tailscale serve reset\` (or disable the conflicting handler) before retrying.`,
  );
}

/**
 * Create persistent private Serve. Does not pass --yes; Tailscale may require
 * explicit interactive HTTPS/Serve consent. stdio is inherited so operators can
 * see and answer prompts.
 */
function createPersistentPrivateServe() {
  return new Promise((resolve) => {
    const child = spawn(
      "tailscale",
      ["serve", "--bg", `--https=${SERVE_HTTPS_PORT}`, LOOPBACK_TARGET],
      {
        stdio: "inherit",
        env: process.env,
      },
    );

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      fail(
        `Tailscale Serve configuration timed out after ${SERVE_CONFIGURE_TIMEOUT_MS / 1000}s (including any interactive HTTPS/Serve consent). Retry and complete any Tailscale prompts when shown.`,
      );
    }, SERVE_CONFIGURE_TIMEOUT_MS);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        fail(
          "the Tailscale CLI (`tailscale`) was not found on PATH. Install Tailscale, ensure the CLI is available, and join this host to a tailnet before using start:tailnet.",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      fail(`Tailscale Serve configuration failed: ${message}`);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) {
        fail(`Tailscale Serve configuration interrupted (${signal}).`);
      }
      if (code !== 0 && code !== null) {
        fail(
          `Tailscale Serve configuration exited with code ${code}. Complete any required interactive HTTPS/Serve consent and ensure private Serve can target ${LOOPBACK_TARGET}.`,
        );
      }
      resolve();
    });
  });
}

function printOperatorGuidance(canonicalOrigin, trustedProxyHops, allowedOrigins, serveWasPreconfigured, target) {
  const serveLine = serveWasPreconfigured
    ? `Tailscale Serve        : already configured (idempotent) private HTTPS :${SERVE_HTTPS_PORT} → ${LOOPBACK_TARGET} (persistent --bg)`
    : `Tailscale Serve        : private HTTPS :${SERVE_HTTPS_PORT} → ${LOOPBACK_TARGET} (persistent --bg; interactive consent if Tailscale prompted)`;

  const lines = [
    "",
    "Hermes Studio private Tailnet deployment",
    "========================================",
    `Canonical HTTPS origin : ${canonicalOrigin}`,
    `Allowed origins        : ${allowedOrigins.join(", ")}`,
    `Trusted proxy hops     : ${trustedProxyHops}`,
    `Loopback Office target : ${LOOPBACK_TARGET}`,
    serveLine,
    "",
    "Mobile / remote client steps",
    "----------------------------",
    "1. Install the official Tailscale app on the phone (iOS or Android).",
    "2. Sign in so the phone joins the same tailnet as this host.",
    "3. There is no native Hermes Studio app. Open the single canonical HTTPS URL",
    `   in the phone browser (or install it as a PWA): ${canonicalOrigin}`,
    "4. Complete one-time device enrollment with the host-configured remote token",
    "   when prompted. Do not paste the token into chat logs or screenshots.",
    "",
    "Networking notes",
    "----------------",
    "• Tailscale chooses direct peer-to-peer connectivity when possible and falls",
    "  back to DERP relays itself. Hermes Studio does not implement a second URL,",
    "  LAN bind, or browser-side endpoint switch.",
    "• Office remains same-origin at the canonical HTTPS origin above. Cookies,",
    "  CSRF, WebSockets, and the PWA all use that single origin through Serve.",
    "• Funnel and any public-internet exposure remain unsupported.",
    "• The launcher never overwrites a different existing Serve configuration.",
    ...(target === "desktop" ? [
      "• The desktop app saves this validated remote configuration in macOS",
      "  Keychain. Later Finder or Dock launches restore it automatically.",
    ] : []),
    "",
    target === "desktop"
      ? "Starting Hermes Studio desktop app with the remote configuration…"
      : "Starting production Office launcher…",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function startChild(executable, args, description) {
  const child = spawn(executable, args, {
    stdio: "inherit",
    env: process.env,
  });

  const forward = (signal) => {
    if (child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
  };

  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));

  child.on("error", (error) => {
    process.stderr.write(`Hermes Studio tailnet launcher: failed to start ${description}: ${error.message}\n`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      // Re-raise the same signal so shells and process managers see the true cause.
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

function startOffice() {
  startChild(process.execPath, [officeLauncher], "production Office launcher");
}

function startDesktop(executable) {
  // Invoke the bundle executable directly instead of `open` so the desktop
  // parent inherits the validated remote environment and forwards only the
  // Office-specific variables to its owned server child.
  startChild(executable, [], "Hermes Studio desktop app");
}

// --- main ---

async function main() {
  const target = launchTarget();
  if (target === "forget-desktop") {
    await forgetDesktopRemoteConfiguration();
    return;
  }
  const desktopExecutable = target === "desktop" ? configuredDesktopExecutable() : undefined;

  // Accept deprecated HERMES_OFFICE_* host env when HERMES_STUDIO_* is unset.
  // Prefer studio keys; never log secret values (e.g. REMOTE_TOKEN).
  applyLegacyEnvFallbacks();

  validateToken();
  validateHostBinding();
  const trustedProxyHops = configureTrustedProxyHops();
  const canonicalOrigin = await discoverCanonicalOrigin();
  const canonicalHost = new URL(canonicalOrigin).hostname;
  const allowedOrigins = validateAndBuildAllowedOrigins(canonicalOrigin);
  process.env.HERMES_STUDIO_ALLOWED_ORIGINS = allowedOrigins.join(",");
  // Keep the default listener explicit for the child without writing any secrets.
  process.env.HERMES_STUDIO_HOST ||= "127.0.0.1";
  process.env.HERMES_STUDIO_PORT ||= String(OFFICE_PORT);
  // Tailscale-only path: intentionally enable remote owner privileged settings
  // and one-shot secret deposit over authenticated HTTPS. Default is off for all
  // other launchers. Tailscale is the network boundary; Office owner auth remains mandatory.
  process.env.HERMES_STUDIO_REMOTE_PRIVILEGED = "true";

  // Inspect Serve first (fail closed on conflict) without changing it.
  const serveStateBefore = await assertServeConfigurationSafe(canonicalHost);

  // Target assets before creating any new persistent Serve mapping.
  if (target === "desktop") {
    await assertDesktopApplication(desktopExecutable);
    await assertDesktopOfficePortAvailable();
  } else {
    await assertProductionAssets();
  }

  let serveState = serveStateBefore;
  if (serveStateBefore === "empty") {
    // Configure without --yes; may prompt interactively for HTTPS/Serve consent.
    await createPersistentPrivateServe();

    // Confirm the new mapping matches exactly; fail closed otherwise.
    serveState = await assertServeConfigurationSafe(canonicalHost);
    if (serveState !== "exact") {
      fail(
        "Tailscale Serve did not result in the exact private HTTPS root reverse-proxy mapping expected. Inspect with `tailscale serve status` and correct or reset before retrying.",
      );
    }
  }

  if (target === "desktop") {
    // The native desktop saves only the already-validated Tailnet values to
    // macOS Keychain. This flag is consumed by the desktop parent and is never
    // forwarded to Office or Hermes children.
    process.env.HERMES_STUDIO_PERSIST_REMOTE_CONFIG = "true";
  }
  printOperatorGuidance(canonicalOrigin, trustedProxyHops, allowedOrigins, serveStateBefore === "exact", target);
  if (target === "desktop") startDesktop(desktopExecutable);
  else startOffice();
}

await main();
