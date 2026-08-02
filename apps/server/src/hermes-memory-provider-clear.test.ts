import assert from "node:assert/strict";
import test from "node:test";
import {
  findUniqueEnvKeyForMemoryProvider,
  listExactProviderEnvClearCandidates,
} from "./hermes-settings.js";

/**
 * Clear-safety contract for memory-provider secrets.
 * Hermes declared PUT ignores empty secrets and omits env_key; Office may only
 * DELETE an env key when /api/env metadata has an explicit provider slug equal
 * to the validated memory provider and the candidate set is uniquely size 1.
 */

test("missing provider metadata never matches clear candidates", () => {
  const env = {
    HINDSIGHT_API_KEY: { is_set: true, is_password: true },
    OTHER_API_KEY: { is_set: true, is_password: true, provider: "" },
    ALSO: { is_set: true, is_password: true, provider: null },
  };
  assert.deepEqual(listExactProviderEnvClearCandidates(env, "hindsight"), []);
  assert.equal(findUniqueEnvKeyForMemoryProvider(env, "hindsight"), undefined);
});

test("exact provider match requires uniqueness — zero or multiple reject", () => {
  const none = {
    OPENAI_API_KEY: { is_set: true, is_password: true, provider: "openai" },
  };
  assert.deepEqual(listExactProviderEnvClearCandidates(none, "hindsight"), []);
  assert.equal(findUniqueEnvKeyForMemoryProvider(none, "hindsight"), undefined);

  const unique = {
    HINDSIGHT_API_KEY: { is_set: true, is_password: true, provider: "hindsight" },
    OPENAI_API_KEY: { is_set: true, is_password: true, provider: "openai" },
  };
  assert.deepEqual(listExactProviderEnvClearCandidates(unique, "hindsight"), ["HINDSIGHT_API_KEY"]);
  assert.equal(findUniqueEnvKeyForMemoryProvider(unique, "hindsight"), "HINDSIGHT_API_KEY");

  const multi = {
    HINDSIGHT_API_KEY: { is_set: true, is_password: true, provider: "hindsight" },
    HINDSIGHT_ORG: { is_set: true, is_password: true, provider: "hindsight" },
  };
  assert.deepEqual(
    listExactProviderEnvClearCandidates(multi, "hindsight").sort(),
    ["HINDSIGHT_API_KEY", "HINDSIGHT_ORG"].sort(),
  );
  assert.equal(findUniqueEnvKeyForMemoryProvider(multi, "hindsight"), undefined);
});

test("suffix-like keys without exact provider equality are never selected", () => {
  // Former bug: api_key suffix could match any *_API_KEY when provider filter
  // treated missing provider as wildcard.
  const env = {
    OPENAI_API_KEY: { is_set: true, is_password: true },
    ANTHROPIC_API_KEY: { is_set: true, is_password: true, provider: "anthropic" },
    HINDSIGHT_API_KEY: { is_set: true, is_password: true, provider: "hindsight" },
  };
  assert.equal(findUniqueEnvKeyForMemoryProvider(env, "hindsight"), "HINDSIGHT_API_KEY");
  // Requesting clear for a provider with no explicit rows fails closed.
  assert.equal(findUniqueEnvKeyForMemoryProvider(env, "openai"), undefined);
  // custom / channel_managed excluded
  const blocked = {
    HINDSIGHT_API_KEY: { is_set: true, is_password: true, provider: "hindsight", custom: true },
  };
  assert.equal(findUniqueEnvKeyForMemoryProvider(blocked, "hindsight"), undefined);
});

test("unset env keys are not clear candidates", () => {
  const env = {
    HINDSIGHT_API_KEY: { is_set: false, is_password: true, provider: "hindsight" },
  };
  assert.deepEqual(listExactProviderEnvClearCandidates(env, "hindsight"), []);
  assert.equal(findUniqueEnvKeyForMemoryProvider(env, "hindsight"), undefined);
});
