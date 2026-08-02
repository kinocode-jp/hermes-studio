import { request } from "node:http";

const LIVE_DESKTOP_ORIGIN = "http://127.0.0.1:4317";
const OVERRIDE = "HERMES_STUDIO_ALLOW_LIVE_DESKTOP_BUILD";

if (process.env[OVERRIDE] === "1") process.exit(0);

const desktopIsRunning = await new Promise((resolve) => {
  const probe = request(`${LIVE_DESKTOP_ORIGIN}/api/v1/health`, {
    method: "GET",
    timeout: 1_000,
    headers: { Accept: "application/json" },
  }, (response) => {
    response.resume();
    resolve(response.statusCode === 200);
  });
  probe.on("timeout", () => { probe.destroy(); resolve(false); });
  probe.on("error", () => resolve(false));
  probe.end();
});

if (desktopIsRunning) {
  process.stderr.write([
    "Hermes Studio.app is running on port 4317.",
    "Refusing to build a replacement desktop bundle while live sessions may exist.",
    "Use `npm run dev` for normal development on ports 4173/4318.",
    `After intentionally closing Hermes Studio, rerun the build. Emergency override: ${OVERRIDE}=1.`,
    "",
  ].join("\n"));
  process.exit(1);
}
