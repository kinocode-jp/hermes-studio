import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

const desktopBuild = process.env.HERMES_STUDIO_DESKTOP_BUILD === "1";

const selfDestroyingServiceWorker = [
  "self.addEventListener('install', () => self.skipWaiting());",
  "self.addEventListener('activate', (event) => {",
  "  event.waitUntil(",
  "    caches.keys()",
  "      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))",
  "      .then(() => self.registration.unregister())",
  "      .then(() => self.clients.matchAll({ type: 'window' }))",
  "      .then((clients) => clients.forEach((client) => client.navigate(client.url)))",
  "  );",
  "});",
].join("\n");

/**
 * The production build registers a precaching service worker on this origin.
 * When the dev server runs on the same port, that stale worker keeps serving
 * the old cached app. Serve a self-destroying /sw.js in dev so any previously
 * installed worker unregisters itself and reloads its clients.
 */
const devServiceWorkerReset: Plugin = {
  name: "dev-sw-self-destruct",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/sw.js", (_req, res) => {
      res.setHeader("Content-Type", "application/javascript");
      res.setHeader("Cache-Control", "no-store");
      res.end(selfDestroyingServiceWorker);
    });
  }
};

/**
 * Keep the legacy /sw.js URL available long enough for an older desktop
 * registration to update and remove itself. The new desktop HTML deliberately
 * contains no registration script, so this runs once instead of reloading in a
 * register/unregister loop.
 */
const desktopServiceWorkerReset: Plugin = {
  name: "desktop-sw-self-destruct",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "sw.js", source: selfDestroyingServiceWorker });
  },
};

export default defineConfig({
  plugins: [
    devServiceWorkerReset,
    preact(),
    desktopBuild ? desktopServiceWorkerReset : VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Hermes Studio",
        short_name: "Hermes Studio",
        description: "AI Team Control Center — a visual control plane for Hermes Agent profiles.",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }
        ]
      },
      workbox: {
        navigateFallback: "/index.html",
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,svg,webp}"],
        // Noto Sans JP ships as 124 unicode-range chunks; the browser fetches only
        // the ranges a page actually renders, so cache them on demand instead of
        // precaching the whole family.
        runtimeCaching: [
          {
            urlPattern: /\/fonts\//,
            handler: "CacheFirst",
            options: {
              cacheName: "hermes-studio-fonts",
              expiration: { maxEntries: 160, maxAgeSeconds: 60 * 60 * 24 * 365 }
            }
          }
        ]
      },
    }),
  ],
  server: {
    port: 4173,
    strictPort: true
  }
});
