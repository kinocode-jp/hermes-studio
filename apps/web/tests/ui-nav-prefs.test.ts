import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeUiNavPreferences,
  persistUiNavPreferences,
  readUiNavPreferences,
} from "../src/ui-nav-prefs.ts";

test("normalizeUiNavPreferences keeps restorable dashboard state and folds modal-only state safely", () => {
  assert.deepEqual(normalizeUiNavPreferences({
    version: 1,
    surface: "kanban",
    settingsTab: "global",
    selectedProfileId: "coder",
  }), {
    version: 1,
    surface: "kanban",
    settingsTab: "global",
    selectedProfileId: "coder",
  });
  assert.equal(normalizeUiNavPreferences({ version: 1, surface: "nope" }).surface, "office");
  assert.equal(normalizeUiNavPreferences(null).surface, "office");
  const migrated = normalizeUiNavPreferences({
    version: 1,
    surface: "library",
    settingsTab: "skills",
    selectedProfileId: "",
  });
  assert.equal(migrated.surface, "office");
  assert.equal(migrated.settingsTab, "global");
});

test("persist and read ui navigation preferences round-trip", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
  };
  assert.equal(persistUiNavPreferences({
    surface: "teams",
    settingsTab: "host",
    selectedProfileId: "default",
  }, storage), true);
  assert.deepEqual(readUiNavPreferences(storage), {
    version: 1,
    surface: "teams",
    settingsTab: "host",
    selectedProfileId: "default",
  });
});
