import { createStudioServer } from "./server.js";
import { HermesBackend } from "./hermes-backend.js";
import { OfficeTeamsStore } from "./office-teams.js";
import { brandEnv, brandEnvIsTrue, brandStatePath } from "./brand-env.js";
import { HermesAgentUpdateManager } from "./hermes-agent-update.js";

const host = brandEnv("HOST") ?? "127.0.0.1";
const configuredPort = Number.parseInt(brandEnv("PORT") ?? "4317", 10);
const port = Number.isSafeInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 4317;
const configuredOrigins = brandEnv("ALLOWED_ORIGINS")
  ?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const desktopOrigins = brandEnv("DESKTOP_ORIGINS")
  ?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
const parsedTrustedProxyHops = Number.parseInt(brandEnv("TRUSTED_PROXY_HOPS") ?? "0", 10);
const trustedProxyHops = Number.isInteger(parsedTrustedProxyHops) && parsedTrustedProxyHops >= 0 && parsedTrustedProxyHops <= 8
  ? parsedTrustedProxyHops
  : 0;
const maxChatSessionLeasesPerOwner = positiveBrandInteger("CHAT_SESSION_LEASES_PER_OWNER");
const maxChatSessionLeasesPerProfile = positiveBrandInteger("CHAT_SESSION_LEASES_PER_PROFILE");
const maxChatSessionLeasesTotal = positiveBrandInteger("CHAT_SESSION_LEASES_TOTAL");

const teamsPath = brandEnv("TEAMS_PATH") ?? brandStatePath("teams.json");
const teamsStore = new OfficeTeamsStore(teamsPath);
const listTeamLayers = async () => await teamsStore.listSkillLayers();
const hermesExecutable = brandEnv("HERMES_EXECUTABLE") ?? "hermes";
const hermesAgentUpdate = new HermesAgentUpdateManager(hermesExecutable);

const hermesMode = brandEnv("HERMES_MODE") ?? "managed";
const hermesToken = brandEnv("HERMES_TOKEN");
const runtimeSource = hermesMode === "demo"
  ? undefined
  : hermesMode === "existing"
    ? new HermesBackend({
        baseUrl: brandEnv("HERMES_URL") ?? "",
        ...(hermesToken === undefined ? {} : { sessionToken: hermesToken }),
        listTeamLayers,
      })
    : new HermesBackend({
        executable: hermesExecutable,
        listTeamLayers,
      });

let shuttingDown = false;
let server: ReturnType<typeof createStudioServer> | undefined;
let initialization: Promise<void> | undefined;
let shutdownFlight: Promise<void> | undefined;

function shutdown(): Promise<void> {
  if (shutdownFlight !== undefined) return shutdownFlight;
  shuttingDown = true;
  const flight = (async () => {
    const activeServer = server;
    if (activeServer !== undefined) {
      // The server owns the bounded shutdown order: persistence and listener
      // closure start immediately while managed Hermes children stop in parallel.
      await activeServer.close();
      return;
    }
    // During startup there may be no server object yet. Abort the runtime and
    // wait for initialization together; a candidate that wins the race checks
    // shuttingDown and closes itself before publishing the listener.
    await Promise.allSettled([
      runtimeSource?.close(),
      initialization,
    ]);
    await server?.close();
  })();
  shutdownFlight = flight;
  return flight;
}

// Install handlers before the first asynchronous initialization boundary so a
// partially-started managed Hermes child always reaches the shared cleanup path.
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

// The packaged desktop launcher owns this server through a private stdin pipe.
// If the native parent crashes or is force-quit, the kernel closes the pipe;
// follow the same cleanup path as SIGTERM so port 4317 is not orphaned.
if (brandEnvIsTrue("DESKTOP_PARENT_PIPE")) {
  process.stdin.resume();
  const parentPipeClosed = (): void => {
    void shutdown().finally(() => process.exit(0));
  };
  process.stdin.once("end", parentPipeClosed);
  process.stdin.once("error", parentPipeClosed);
}

initialization = (async () => {
  try {
    if (runtimeSource !== undefined) await runtimeSource.start();
    if (shuttingDown) return;

    const remoteToken = brandEnv("REMOTE_TOKEN");
    const desktopCapability = brandEnv("DESKTOP_CAPABILITY");
    const webRoot = brandEnv("WEB_ROOT");
    const candidate = createStudioServer({
      host,
      port,
      ...(configuredOrigins === undefined ? {} : { allowedOrigins: configuredOrigins }),
      allowNonLoopback: brandEnvIsTrue("ALLOW_NON_LOOPBACK"),
      trustedProxyHops,
      deviceRegistryPath: brandEnv("DEVICE_REGISTRY_PATH") ?? brandStatePath("devices.json"),
      tokenUsagePath: brandEnv("TOKEN_USAGE_PATH") ?? brandStatePath("token-usage.json"),
      teamsPath,
      teamsStore,
      ...(remoteToken === undefined ? {} : { remoteToken }),
      ...(desktopCapability === undefined ? {} : { desktopCapability }),
      ...(desktopOrigins === undefined ? {} : { desktopOrigins }),
      ...(webRoot === undefined ? {} : { staticWebRoot: webRoot }),
      // Fail closed unless the Tailscale launcher (or operator) sets this explicitly.
      // Accepts HERMES_STUDIO_REMOTE_PRIVILEGED or deprecated HERMES_OFFICE_REMOTE_PRIVILEGED.
      remotePrivilegedEnabled: brandEnvIsTrue("REMOTE_PRIVILEGED"),
      ...(maxChatSessionLeasesPerOwner === undefined ? {} : { maxChatSessionLeasesPerOwner }),
      ...(maxChatSessionLeasesPerProfile === undefined ? {} : { maxChatSessionLeasesPerProfile }),
      ...(maxChatSessionLeasesTotal === undefined ? {} : { maxChatSessionLeasesTotal }),
      ...(runtimeSource === undefined ? {} : { runtimeSource }),
      hermesAgentUpdate,
    });
    const address = await candidate.listen();
    if (shuttingDown) { await candidate.close(); return; }
    server = candidate;
    process.stdout.write(`Hermes Studio Server listening on http://${address.address}:${address.port}\n`);
  } catch (error) {
    await runtimeSource?.close().catch(() => undefined);
    throw error;
  }
})();
await initialization;

function positiveBrandInteger(name: string): number | undefined {
  const raw = brandEnv(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export { createStudioServer } from "./server.js";
export { HermesBackend } from "./hermes-backend.js";
export { discoverHermesRuntime } from "./hermes-runtime.js";
