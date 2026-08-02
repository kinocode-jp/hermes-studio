import assert from "node:assert/strict";
import test from "node:test";

/**
 * Contract mirror for declared memory-provider secret discovery/write.
 * Live discovery is sequential over GET /api/memory providers + declared
 * surface; this locks the membership and wire shape without a Hermes process.
 */

type SecretMeta = {
  key: string;
  source: "env" | "config" | "memory-provider";
  isSet: boolean;
  provider?: string;
};

function projectMemoryProviderSecrets(
  providers: Array<{ name: string; fields: Array<{ key: string; kind: string; is_set?: boolean }> }>,
  maxProviders = 20,
  maxFieldsPer = 32,
): SecretMeta[] {
  const out: SecretMeta[] = [];
  for (const provider of providers.slice(0, maxProviders)) {
    if (provider.name === "builtin" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(provider.name)) continue;
    let taken = 0;
    for (const field of provider.fields) {
      if (taken >= maxFieldsPer) break;
      if (field.kind !== "secret") continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(field.key)) continue;
      out.push({
        key: field.key,
        source: "memory-provider",
        isSet: field.is_set === true,
        provider: provider.name,
      });
      taken += 1;
    }
  }
  return out;
}

function authorizeMemoryProviderWrite(
  declared: SecretMeta[],
  request: { source: string; key: string; provider?: string },
): boolean {
  if (request.source !== "memory-provider") return false;
  if (typeof request.provider !== "string" || request.provider === "builtin") return false;
  return declared.some(
    (field) =>
      field.source === "memory-provider"
      && field.key === request.key
      && field.provider === request.provider,
  );
}

test("memory-provider secret discovery keeps only declared secret fields", () => {
  const fields = projectMemoryProviderSecrets([
    {
      name: "hindsight",
      fields: [
        { key: "mode", kind: "select", is_set: true },
        { key: "api_key", kind: "secret", is_set: true },
        { key: "api_url", kind: "text", is_set: true },
      ],
    },
    {
      name: "builtin",
      fields: [{ key: "should_skip", kind: "secret", is_set: true }],
    },
  ]);
  assert.deepEqual(fields, [
    { key: "api_key", source: "memory-provider", isSet: true, provider: "hindsight" },
  ]);
  assert.equal(JSON.stringify(fields).includes("value"), false);
});

test("memory-provider write requires declared provider+key membership", () => {
  const declared = projectMemoryProviderSecrets([
    { name: "hindsight", fields: [{ key: "api_key", kind: "secret", is_set: false }] },
  ]);
  assert.equal(
    authorizeMemoryProviderWrite(declared, {
      source: "memory-provider",
      key: "api_key",
      provider: "hindsight",
    }),
    true,
  );
  assert.equal(
    authorizeMemoryProviderWrite(declared, {
      source: "memory-provider",
      key: "api_key",
      provider: "other",
    }),
    false,
  );
  assert.equal(
    authorizeMemoryProviderWrite(declared, {
      source: "memory-provider",
      key: "mode",
      provider: "hindsight",
    }),
    false,
  );
  assert.equal(
    authorizeMemoryProviderWrite(declared, {
      source: "env",
      key: "api_key",
      provider: "hindsight",
    }),
    false,
  );
});
