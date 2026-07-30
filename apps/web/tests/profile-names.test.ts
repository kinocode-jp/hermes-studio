import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); },
  clear: () => { memory.clear(); },
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const {
  ensurePokemonDisplayNames,
  displayProfileReferences,
  forgetProfileDisplayName,
  profileDisplayName,
  profileSecondaryName,
  setProfileDisplayName,
} = await import("../src/profile-names");

const STORAGE_KEY = "hermes-studio:profile-display-names:v1";
const LEGACY_STORAGE_KEY = "hermes-office:profile-names-ja:v1";

before(() => {
  memory.clear();
});

afterEach(() => {
  memory.clear();
  for (const id of ["pikachu", "charizard", "custom-agent", "Pikachu", "default"]) {
    forgetProfileDisplayName(id);
  }
});

test("uses display name when set, otherwise profile name", () => {
  setProfileDisplayName("custom-agent", "カスタム");
  assert.equal(profileDisplayName({ id: "custom-agent", name: "custom-agent" }), "カスタム");
  assert.equal(profileSecondaryName({ id: "custom-agent", name: "custom-agent" }), "custom-agent");
  forgetProfileDisplayName("custom-agent");
  assert.equal(profileDisplayName({ id: "custom-agent", name: "custom-agent" }), "custom-agent");
  assert.equal(profileSecondaryName({ id: "custom-agent", name: "custom-agent" }), "");
});

test("default profile can use a local display name without changing the hermes id", () => {
  assert.equal(profileDisplayName({ id: "default", name: "default" }), "default");
  assert.equal(profileSecondaryName({ id: "default", name: "default" }), "");

  setProfileDisplayName("default", "オフィス主任");
  assert.equal(profileDisplayName({ id: "default", name: "default" }), "オフィス主任");
  assert.equal(profileSecondaryName({ id: "default", name: "default" }), "default");
  assert.equal(JSON.parse(memory.get(STORAGE_KEY) ?? "{}").default, "オフィス主任");

  // Clearing restores the Hermes profile name; id remains "default".
  setProfileDisplayName("default", "");
  assert.equal(profileDisplayName({ id: "default", name: "default" }), "default");
  assert.equal(profileSecondaryName({ id: "default", name: "default" }), "");
});

test("default profile accepts embedded displayName overlays", () => {
  assert.equal(
    profileDisplayName({ id: "default", name: "default", displayName: "Main desk" }),
    "Main desk",
  );
  assert.equal(
    profileSecondaryName({ id: "default", name: "default", displayName: "Main desk" }),
    "default",
  );
});

test("common profile names require an explicit @ reference in prose", () => {
  const profiles = [{ id: "default", name: "default", displayName: "受付" }];
  assert.equal(displayProfileReferences("Use the default value.", profiles), "Use the default value.");
  assert.equal(displayProfileReferences("Ask @default next.", profiles), "Ask 受付（default） next.");
});

test("profile reference display preserves copy-sensitive paths, URLs, and filenames", () => {
  const profiles = [{ id: "haunter", name: "haunter", displayName: "ゴースト" }];
  assert.equal(
    displayProfileReferences(
      "Ask haunter. Read /profiles/haunter/config, haunter.md, and https://haunter.example/@haunter.",
      profiles,
    ),
    "Ask ゴースト（haunter）. Read /profiles/haunter/config, haunter.md, and https://haunter.example/@haunter.",
  );
});

test("profile reference display is single-pass when one alias names another profile", () => {
  const profiles = [
    { id: "alpha", name: "alpha", displayName: "beta" },
    { id: "beta", name: "beta", displayName: "gamma" },
  ];
  assert.equal(displayProfileReferences("Ask alpha.", profiles), "Ask beta（alpha）.");
});

test("already formatted references stay single when the canonical name is emphasized", () => {
  const profiles = [{ id: "haunter", name: "haunter", displayName: "ゴースト" }];
  assert.equal(
    displayProfileReferences("ゴースト（**haunter**）", profiles),
    "ゴースト（**haunter**）",
  );
});

test("uses built-in Pokémon Japanese names without requiring storage", () => {
  assert.equal(profileDisplayName({ id: "pikachu", name: "pikachu" }), "ピカチュウ");
  assert.equal(profileSecondaryName({ id: "pikachu", name: "pikachu" }), "pikachu");
  assert.equal(profileDisplayName({ id: "charizard", name: "charizard" }), "リザードン");
});

test("registers Japanese Pokémon names only for missing aliases", () => {
  setProfileDisplayName("charizard", "カスタム");
  ensurePokemonDisplayNames(["pikachu", "charizard", "custom-agent", "default"]);
  assert.equal(profileDisplayName({ id: "pikachu", name: "pikachu" }), "ピカチュウ");
  assert.equal(profileDisplayName({ id: "charizard", name: "charizard" }), "カスタム");
  assert.equal(profileDisplayName({ id: "custom-agent", name: "custom-agent" }), "custom-agent");
  assert.equal(profileDisplayName({ id: "default", name: "default" }), "default");
  assert.ok(memory.has(STORAGE_KEY));
  assert.equal(memory.has(LEGACY_STORAGE_KEY), false);
});

test("cleared display names are not re-auto-registered and keep the Hermes name", () => {
  ensurePokemonDisplayNames(["pikachu"]);
  assert.equal(profileDisplayName({ id: "pikachu", name: "pikachu" }), "ピカチュウ");
  setProfileDisplayName("pikachu", "");
  assert.equal(profileDisplayName({ id: "pikachu", name: "pikachu" }), "pikachu");
  ensurePokemonDisplayNames(["pikachu"]);
  assert.equal(profileDisplayName({ id: "pikachu", name: "pikachu" }), "pikachu");
});
