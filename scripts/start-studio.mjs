import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
const serverEntry = fileURLToPath(new URL("../apps/server/dist/index.js", import.meta.url));

try {
  await Promise.all([
    access(new URL("../apps/web/dist/index.html", import.meta.url), constants.R_OK),
    access(serverEntry, constants.R_OK),
  ]);
} catch {
  process.stderr.write("Hermes Studio is not built. Run `npm run build:production` first.\n");
  process.exitCode = 1;
  throw new Error("Production assets are missing.");
}

process.env.HERMES_STUDIO_WEB_ROOT ||= webRoot;
await import(serverEntry);
