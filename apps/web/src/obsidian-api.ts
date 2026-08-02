import type {
  ObsidianGraph,
  ObsidianGraphEdge,
  ObsidianGraphNode,
  ObsidianVaultSummary,
} from "@hermes-studio/protocol";
import { officeFetchJson } from "./office-api";

export async function loadObsidianVaults(): Promise<readonly ObsidianVaultSummary[]> {
  const value = await officeFetchJson<unknown>("/api/v1/host/apps/obsidian/vaults");
  if (!isRecord(value) || !Array.isArray(value.vaults) || value.vaults.length > 100) throw incompatible();
  return value.vaults.map(parseVault);
}

export async function loadObsidianGraph(vaultId: string): Promise<ObsidianGraph> {
  if (!/^[a-f0-9]{24}$/.test(vaultId)) throw incompatible();
  const value = await officeFetchJson<unknown>(`/api/v1/host/apps/obsidian/graph?vault=${encodeURIComponent(vaultId)}`);
  if (!isRecord(value)
    || value.vaultId !== vaultId
    || typeof value.vaultName !== "string"
    || typeof value.generatedAt !== "string"
    || typeof value.truncated !== "boolean"
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || value.nodes.length > 800
    || value.edges.length > 2_500) throw incompatible();
  return {
    vaultId,
    vaultName: value.vaultName,
    generatedAt: value.generatedAt,
    truncated: value.truncated,
    nodes: value.nodes.map(parseNode),
    edges: value.edges.map(parseEdge),
  };
}

function parseVault(value: unknown): ObsidianVaultSummary {
  if (!isRecord(value) || !/^[a-f0-9]{24}$/.test(String(value.id)) || typeof value.name !== "string") throw incompatible();
  return { id: value.id as string, name: value.name.slice(0, 200) };
}

function parseNode(value: unknown): ObsidianGraphNode {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.title !== "string"
    || typeof value.folder !== "string"
    || value.id.length > 512
    || value.title.length > 200
    || value.folder.length > 400
    || typeof value.links !== "number"
    || !Number.isSafeInteger(value.links)
    || value.links < 0) throw incompatible();
  return { id: value.id, title: value.title, folder: value.folder, links: value.links };
}

function parseEdge(value: unknown): ObsidianGraphEdge {
  if (!isRecord(value) || typeof value.source !== "string" || typeof value.target !== "string") throw incompatible();
  return { source: value.source, target: value.target };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function incompatible(): Error {
  return new Error("Obsidian graph response is incompatible.");
}
