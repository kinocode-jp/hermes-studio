(() => {
  // Bump when shipping UI that must not stick behind a stale service-worker precache.
  // First visit after a bump unregisters SW caches and reloads once.
  const CLIENT_BUILD = "2026-07-27-desktop-cache-reset-v1";
  try {
    const key = "hermes-studio:client-build";
    const previous = localStorage.getItem(key) ?? localStorage.getItem("hermes-office:client-build");
    if (previous !== CLIENT_BUILD) {
      localStorage.setItem(key, CLIENT_BUILD);
      try { localStorage.removeItem("hermes-office:client-build"); } catch (_) {}
      if (previous) {
        const purge = async () => {
          try {
            if ("serviceWorker" in navigator) {
              const registrations = await navigator.serviceWorker.getRegistrations();
              await Promise.all(registrations.map((registration) => registration.unregister()));
            }
            if (window.caches) {
              const keys = await caches.keys();
              await Promise.all(keys.map((name) => caches.delete(name)));
            }
          } finally {
            location.reload();
          }
        };
        void purge();
        return;
      }
    }
  } catch {
    // Appearance still applies if storage/SW is unavailable.
  }

  const fallback = { theme: "paper", fontScale: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem("hermes-studio:appearance:v1") || localStorage.getItem("hermes-office:appearance:v1") || "null") || fallback;
    const theme = ["paper", "mint", "midnight"].includes(saved.theme) ? saved.theme : fallback.theme;
    const legacyFontScales = new Map([[0.9, 1], [1.1, 1.125], [1.2, 1.25]]);
    const fontScale = [1, 1.125, 1.25, 1.5].includes(saved.fontScale)
      ? saved.fontScale
      : legacyFontScales.get(saved.fontScale) || fallback.fontScale;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.fontScale = String(fontScale).replace(".", "-");
    document.documentElement.style.setProperty("--font-scale", String(fontScale));
    document.documentElement.style.colorScheme = theme === "midnight" ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = fallback.theme;
    document.documentElement.dataset.fontScale = "1";
    document.documentElement.style.setProperty("--font-scale", "1");
    document.documentElement.style.colorScheme = "light";
  }
})();
