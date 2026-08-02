import { signal } from "@preact/signals";

export const APPEARANCE_STORAGE_KEY = "hermes-studio:appearance:v1";

export const themes = ["paper", "mint", "midnight"] as const;
export const fontScales = [1, 1.125, 1.25, 1.5] as const;

export type Theme = (typeof themes)[number];
export type FontScale = (typeof fontScales)[number];

type AppearancePreferences = {
  theme: Theme;
  fontScale: FontScale;
  richLinkPreviews: boolean;
};

const defaults: AppearancePreferences = { theme: "paper", fontScale: 1, richLinkPreviews: true };
const initial = readPreferences();

export const activeTheme = signal<Theme>(initial.theme);
export const activeFontScale = signal<FontScale>(initial.fontScale);
export const richLinkPreviewsEnabled = signal(initial.richLinkPreviews);

export function initializeAppearance(): void {
  applyAppearance(activeTheme.value, activeFontScale.value);
}

export function setTheme(theme: Theme): void {
  activeTheme.value = theme;
  applyAppearance(theme, activeFontScale.value);
  persistPreferences();
}

export function setFontScale(fontScale: FontScale): void {
  activeFontScale.value = fontScale;
  applyAppearance(activeTheme.value, fontScale);
  persistPreferences();
}

export function setRichLinkPreviewsEnabled(enabled: boolean): void {
  richLinkPreviewsEnabled.value = enabled;
  persistPreferences();
}

function readPreferences(): AppearancePreferences {
  if (typeof localStorage === "undefined") return defaults;
  try {
    const candidate = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? localStorage.getItem("hermes-office:appearance:v1") ?? "null") as Partial<AppearancePreferences> | null;
    return {
      theme: isTheme(candidate?.theme) ? candidate.theme : defaults.theme,
      fontScale: normalizeFontScale(candidate?.fontScale),
      richLinkPreviews: typeof candidate?.richLinkPreviews === "boolean"
        ? candidate.richLinkPreviews
        : defaults.richLinkPreviews,
    };
  } catch {
    return defaults;
  }
}

function persistPreferences(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({
      theme: activeTheme.value,
      fontScale: activeFontScale.value,
      richLinkPreviews: richLinkPreviewsEnabled.value,
    } satisfies AppearancePreferences));
  } catch {
    // Appearance is non-critical; keep the active session usable when storage is unavailable.
  }
}

function applyAppearance(theme: Theme, fontScale: FontScale): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.fontScale = String(fontScale).replace(".", "-");
  root.style.setProperty("--font-scale", String(fontScale));
  root.style.colorScheme = theme === "midnight" ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor(theme));
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (themes as readonly string[]).includes(value);
}

function isFontScale(value: unknown): value is FontScale {
  return typeof value === "number" && (fontScales as readonly number[]).includes(value);
}

function normalizeFontScale(value: unknown): FontScale {
  if (isFontScale(value)) return value;
  if (value === 0.9) return 1;
  if (value === 1.1) return 1.125;
  if (value === 1.2) return 1.25;
  return defaults.fontScale;
}

function themeColor(theme: Theme): string {
  if (theme === "midnight") return "#111b24";
  if (theme === "mint") return "#eef8f5";
  return "#f4f7f9";
}
