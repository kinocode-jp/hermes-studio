import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  createHermesModelsAdapter,
  extractOpenCodexProviders,
  extractLiveModels,
  extractProviders,
  extractReasoningEfforts,
  HermesModelsError,
  mergeProviderExtracts,
} from "./hermes-models.js";

test("OpenCodex discovery keeps bare Codex models and namespaced CLI providers", () => {
  const providers = extractOpenCodexProviders({
    data: [
      { id: "gpt-5.6-luna", owned_by: "openai" },
      { id: "anthropic/claude-sonnet-5", owned_by: "anthropic" },
      { id: "kimi/kimi-k2.7-code", owned_by: "kimi" },
      { id: "disabled/model", owned_by: "disabled" },
      { id: "api_key=not-a-model", owned_by: "openai" },
    ],
  }, [
    { name: "openai", disabled: false },
    { name: "anthropic", disabled: false },
    { name: "kimi", disabled: false },
    { name: "disabled", disabled: true },
  ], 100, 20);

  assert.deepEqual(providers, [
    {
      endpointId: "local-cli-openai",
      name: "OpenAI Codex · OpenCodex CLI",
      baseUrl: "http://127.0.0.1:10100/v1",
      models: ["gpt-5.6-luna"],
    },
    {
      endpointId: "local-cli-anthropic",
      name: "Anthropic / Claude · OpenCodex CLI",
      baseUrl: "http://127.0.0.1:10100/v1",
      models: ["anthropic/claude-sonnet-5"],
    },
    {
      endpointId: "local-cli-kimi",
      name: "Kimi Code · OpenCodex CLI",
      baseUrl: "http://127.0.0.1:10100/v1",
      models: ["kimi/kimi-k2.7-code"],
    },
  ]);
});

test("OpenCodex discovery falls back to model namespace when owned_by is absent", () => {
  const providers = extractOpenCodexProviders({
    data: [
      { id: "xai/grok-4.5" },
      { id: "gpt-5.6-terra" },
    ],
  }, undefined, 100, 20);
  assert.deepEqual(providers.map((provider) => [provider.endpointId, provider.models]), [
    ["local-cli-xai", ["xai/grok-4.5"]],
    ["local-cli-openai", ["gpt-5.6-terra"]],
  ]);
});

test("catalog deadline includes backend acquisition and releases a late lease", async () => {
  let released = 0;
  const adapter = createHermesModelsAdapter({
    timeoutMs: 250,
    resolveProfileBackend: async () => await new Promise((resolve) => {
      setTimeout(() => resolve({
        baseUrl: "http://127.0.0.1:9",
        sessionToken: "x".repeat(32),
        release: () => { released += 1; },
      }), 325);
    }),
  });

  await assert.rejects(
    adapter.loadLiveCatalog("default"),
    (error: unknown) => error instanceof HermesModelsError && error.code === "timed_out",
  );
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.equal(released, 1);
});

test("an explicit model refresh surfaces malformed success instead of returning stale live models", async (t) => {
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/models/refresh") {
      response.writeHead(200, { "Content-Type": "application/json" }).end("not-json");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/model/info") {
      response.end(JSON.stringify({ provider: "openai", model: "gpt-safe" }));
      return;
    }
    if (request.url === "/api/models") {
      response.end(JSON.stringify({ provider: "openai", providers: [{ id: "openai", label: "OpenAI", active: true }] }));
      return;
    }
    if (request.url === "/api/models/live?provider=openai") {
      response.end(JSON.stringify({ models: ["gpt-safe"] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const adapter = createHermesModelsAdapter({
    resolveProfileBackend: async () => ({
      baseUrl: `http://127.0.0.1:${address.port}`,
      sessionToken: "x".repeat(32),
      release: () => undefined,
    }),
  });

  await assert.rejects(
    adapter.loadLiveCatalog("default", "openai", { forceRefresh: true, allowRefresh: true }),
    (error: unknown) => error instanceof HermesModelsError && error.code === "rejected",
  );
});

test("extractProviders reads session_visit-style and options-style payloads", () => {
  const sessionVisit = extractProviders({
    provider: "openrouter",
    providers: [
      { slug: "openrouter", label: "OpenRouter", is_current: true },
      { id: "ollama", name: "Ollama" },
      { id: "secret", label: "api_key_value" },
    ],
  }, 50);
  assert.equal(sessionVisit.activeProvider, "openrouter");
  assert.equal(sessionVisit.hasListedProviders, true);
  assert.deepEqual(sessionVisit.providers.map((item) => item.id), ["openrouter", "ollama"]);
  assert.equal(sessionVisit.providers[0]!.active, true);

  const optionsShape = extractProviders({
    provider: "anthropic",
    providers: [
      { slug: "anthropic", models: ["claude"] },
      { slug: "openai", models: ["gpt"] },
    ],
  }, 50);
  assert.equal(optionsShape.activeProvider, "anthropic");
  assert.equal(optionsShape.hasListedProviders, true);
  assert.equal(optionsShape.providers.length, 2);
});

test("extractProviders injects active-only payloads and marks them incomplete for fallback", () => {
  assert.deepEqual(extractProviders(null, 10), {
    providers: [],
    activeProvider: "",
    hasListedProviders: false,
  });
  const onlyActive = extractProviders({ active_provider: "custom:team", providers: [] }, 10);
  assert.equal(onlyActive.activeProvider, "custom:team");
  assert.equal(onlyActive.hasListedProviders, false);
  assert.deepEqual(onlyActive.providers, [{ id: "custom:team", label: "custom:team", active: true }]);

  const activeWithoutArray = extractProviders({ provider: "openrouter" }, 10);
  assert.equal(activeWithoutArray.hasListedProviders, false);
  assert.deepEqual(activeWithoutArray.providers, [
    { id: "openrouter", label: "openrouter", active: true },
  ]);
});

test("extractProviders omits explicitly unconfigured or disabled rows unless active", () => {
  const result = extractProviders({
    provider: "openrouter",
    providers: [
      { id: "openrouter", label: "OpenRouter", is_current: true },
      { id: "ollama", label: "Ollama", configured: true },
      { id: "missing-key", label: "Missing", configured: false },
      { id: "disabled", label: "Disabled", enabled: false },
      { id: "unauth", label: "Unauth", authenticated: false },
      { id: "active-unconfigured", label: "Still active", configured: false, is_current: true },
      "string-provider",
    ],
  }, 50);
  assert.equal(result.hasListedProviders, true);
  assert.deepEqual(result.providers.map((item) => item.id).sort(), [
    "active-unconfigured",
    "ollama",
    "openrouter",
    "string-provider",
  ].sort());
  assert.equal(result.providers.find((item) => item.id === "missing-key"), undefined);
  assert.equal(result.providers.find((item) => item.id === "disabled"), undefined);
  assert.equal(result.providers.find((item) => item.id === "unauth"), undefined);
  assert.equal(result.providers.find((item) => item.id === "active-unconfigured")?.active, true);
});

test("extractProviders accepts public provider ids containing token vocabulary", () => {
  const result = extractProviders({
    providers: [
      { id: "alibaba-token-plan", label: "Alibaba Token Plan", configured: true },
      { id: "tencent-tokenhub", label: "Tencent TokenHub", configured: true },
      { id: "google-antigravity", label: "Google Antigravity", configured: true },
    ],
  }, 50);
  assert.deepEqual(result.providers.map((item) => item.id), [
    "alibaba-token-plan",
    "tencent-tokenhub",
    "google-antigravity",
  ]);
});

test("mergeProviderExtracts prefers listed fallback catalogs without dropping active", () => {
  const incomplete = extractProviders({ active_provider: "openrouter", providers: [] }, 50);
  assert.equal(incomplete.hasListedProviders, false);

  const full = extractProviders({
    providers: [
      { id: "openrouter", label: "OpenRouter" },
      { id: "ollama", label: "Ollama" },
      { id: "custom:team", label: "Team" },
    ],
  }, 50);
  assert.equal(full.hasListedProviders, true);

  const merged = mergeProviderExtracts(incomplete, full, 50);
  assert.equal(merged.hasListedProviders, true);
  assert.equal(merged.activeProvider, "openrouter");
  assert.deepEqual(merged.providers.map((item) => item.id), ["openrouter", "ollama", "custom:team"]);
  assert.equal(merged.providers.find((item) => item.id === "openrouter")?.active, true);

  // Later incomplete seed must not erase a listed catalog already held.
  const kept = mergeProviderExtracts(merged, incomplete, 50);
  assert.equal(kept.hasListedProviders, true);
  assert.equal(kept.providers.length, 3);
});

test("extractLiveModels accepts string ids and object rows without secrets", () => {
  const models = extractLiveModels({
    models: [
      "llama3.2",
      { id: "org::model", label: "Org" },
      { model: "api_key_leak", label: "bad" },
      { id: "ok", name: "OK" },
    ],
  }, 50);
  assert.deepEqual(models, [
    { id: "llama3.2", label: "llama3.2" },
    { id: "org::model", label: "Org" },
    { id: "ok", label: "OK" },
  ]);
});

test("extractReasoningEfforts only keeps the 8 Hermes levels and ignores boolean flags", () => {
  assert.equal(extractReasoningEfforts({ reasoning: true }), undefined);
  assert.equal(extractReasoningEfforts({ reasoning: false }), undefined);
  assert.deepEqual(
    extractReasoningEfforts({ reasoning_efforts: ["high", "BOGUS", "low", "high", "none"] }),
    ["none", "low", "high"],
  );
  assert.deepEqual(
    extractReasoningEfforts({ reasoning: { allowed_options: ["minimal", "xhigh", "ultra"] } }),
    ["minimal", "xhigh", "ultra"],
  );
  assert.deepEqual(
    extractReasoningEfforts({ supports: { reasoning_effort: ["medium", "max"] } }),
    ["medium", "max"],
  );
});

test("extractLiveModels attaches per-model reasoning efforts from rows and capability maps", () => {
  const models = extractLiveModels({
    models: [
      { id: "with-levels", label: "A", reasoningEfforts: ["low", "high"] },
      { id: "from-caps", label: "B" },
      { id: "plain", label: "C" },
    ],
    capabilities: {
      "from-caps": { reasoning_efforts: ["none", "medium"] },
      plain: { reasoning: true },
    },
  }, 50);
  assert.deepEqual(models.find((item) => item.id === "with-levels")?.reasoningEfforts, ["low", "high"]);
  assert.deepEqual(models.find((item) => item.id === "from-caps")?.reasoningEfforts, ["none", "medium"]);
  assert.equal(models.find((item) => item.id === "plain")?.reasoningEfforts, undefined);
});
