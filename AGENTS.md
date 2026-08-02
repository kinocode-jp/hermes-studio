# AGENTS.md

## Local UI workflow

- Always develop against the Vite hot-reload surface, not a production static build.
- Preferred entrypoint: `npm run dev`
- Open the UI at `http://127.0.0.1:4173/` (or `http://localhost:4173/`).
- The dev API server runs on `http://127.0.0.1:4318/` (`npm run dev` sets `HERMES_STUDIO_PORT=4318` and `VITE_STUDIO_SERVER_PORT=4318`).
- Treat `http://127.0.0.1:4317/` as the desktop app / production surface only (Hermes Studio.app health-checks and serves this port). Because dev uses 4318, the desktop app and the dev stack can run at the same time.
- After source UI changes, do not rebuild web assets (`npm run build:web`, desktop web bundle copy, packaged app resources) just to preview them.
- Rebuild / package only when the user explicitly asks for production, desktop packaging, or a release-like verification.
- Never copy, sync, or install a generated `Hermes Studio.app` over `/Applications/Hermes Studio.app` while port 4317 is serving. Close the packaged app and confirm 4317 is free first; replacing the live bundle terminates its WebSocket sessions.

## Starting/restarting `npm run dev`

- Do not background `npm run dev` with `&`, `nohup`, or `disown` inside a plain exec/shell call. In this sandboxed exec environment those detachment methods do not reliably survive the parent shell exiting, and the server processes get silently reaped even though the launch log looks successful.
- Start (or restart) `npm run dev` in a **persistent PTY/session-backed shell call** and leave that session running instead of trying to detach it. Confirm both ports are actually serving before telling the user it's restarted:
  - `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/` should return `200`.
  - `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4318/api/v1/health` should return `200`.
- If both checks don't return `200`, the dev server is not actually up yet — do not report success from the log output alone.
