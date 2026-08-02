import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, extname, join, normalize, relative, sep } from "node:path";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import type {
  ObsidianGraph,
  ObsidianGraphEdge,
  ObsidianGraphNode,
  ObsidianVaultSummary,
} from "@hermes-studio/protocol";

const MAX_NOTES = 800;
const MAX_NOTE_BYTES = 512 * 1024;
const MAX_LINKS_PER_NOTE = 300;
const MAX_EDGES = 2_500;
const MAX_DEPTH = 24;
const SKIPPED_DIRECTORIES = new Set([".git", ".obsidian", "node_modules", ".trash"]);

type RegisteredVault = ObsidianVaultSummary & { path: string };

/** Reads only vaults registered by Obsidian. HTTP clients never provide paths. */
export class ObsidianVaultManager {
  async listVaults(): Promise<readonly ObsidianVaultSummary[]> {
    const vaults = await this.#registeredVaults();
    return vaults.map(({ id, name }) => ({ id, name }));
  }

  async graph(vaultId: string): Promise<ObsidianGraph | undefined> {
    if (!/^[a-f0-9]{24}$/.test(vaultId)) return undefined;
    const vault = (await this.#registeredVaults()).find((candidate) => candidate.id === vaultId);
    if (vault === undefined) return undefined;

    const files: string[] = [];
    let truncated = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || files.length >= MAX_NOTES) {
        truncated = true;
        return;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= MAX_NOTES) {
          truncated = true;
          return;
        }
        if (entry.name.startsWith(".") && entry.name !== ".md") continue;
        const candidate = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(candidate, depth + 1);
        } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
          files.push(candidate);
        }
      }
    };
    await visit(vault.path, 0);

    const records = files.flatMap((path) => {
      const rel = slash(relative(vault.path, path));
      if (rel.length === 0 || rel.length > 512 || /[\u0000-\u001f\u007f]/.test(rel)) return [];
      const id = rel.replace(/\.md$/i, "");
      const folder = slash(dirname(id));
      return [{
        path,
        id,
        title: basename(id).slice(0, 200),
        folder: folder === "." ? "" : folder.slice(0, 400),
      }];
    });
    const byId = new Map(records.map((record) => [normalizeLink(record.id), record.id]));
    const byTitle = new Map<string, string[]>();
    for (const record of records) {
      const key = normalizeLink(record.title);
      byTitle.set(key, [...(byTitle.get(key) ?? []), record.id]);
    }

    const edgeKeys = new Set<string>();
    const edges: ObsidianGraphEdge[] = [];
    const degree = new Map(records.map((record) => [record.id, 0]));
    noteLoop: for (const record of records) {
      let source = "";
      try {
        const metadata = await lstat(record.path);
        if (!metadata.isFile() || metadata.size > MAX_NOTE_BYTES) continue;
        source = await readFile(record.path, "utf8");
      } catch {
        continue;
      }
      const links = extractLinks(source).slice(0, MAX_LINKS_PER_NOTE);
      for (const rawLink of links) {
        const target = resolveTarget(rawLink, record.id, byId, byTitle);
        if (target === undefined || target === record.id) continue;
        const key = `${record.id}\u0000${target}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ source: record.id, target });
        degree.set(record.id, (degree.get(record.id) ?? 0) + 1);
        degree.set(target, (degree.get(target) ?? 0) + 1);
        if (edges.length >= MAX_EDGES) {
          truncated = true;
          break noteLoop;
        }
      }
    }

    const nodes: ObsidianGraphNode[] = records.map((record) => ({
      id: record.id,
      title: record.title,
      folder: record.folder,
      links: degree.get(record.id) ?? 0,
    }));
    return {
      vaultId: vault.id,
      vaultName: vault.name,
      generatedAt: new Date().toISOString(),
      truncated,
      nodes,
      edges,
    };
  }

  async #registeredVaults(): Promise<RegisteredVault[]> {
    const registryPath = obsidianRegistryPath();
    if (registryPath === undefined) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(registryPath, "utf8"));
    } catch {
      return [];
    }
    if (!isRecord(parsed) || !isRecord(parsed.vaults)) return [];
    const vaults: RegisteredVault[] = [];
    for (const value of Object.values(parsed.vaults)) {
      if (!isRecord(value) || typeof value.path !== "string" || value.path.includes("\0")) continue;
      try {
        const canonical = await realpath(value.path);
        const metadata = await lstat(canonical);
        if (!metadata.isDirectory()) continue;
        vaults.push({
          id: createHash("sha256").update(canonical).digest("hex").slice(0, 24),
          name: basename(canonical) || "Vault",
          path: canonical,
        });
      } catch {
        continue;
      }
    }
    return vaults.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function obsidianRegistryPath(): string | undefined {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
  if (platform() === "win32") {
    const appData = process.env.APPDATA;
    return appData ? join(appData, "obsidian", "obsidian.json") : undefined;
  }
  return join(homedir(), ".config", "obsidian", "obsidian.json");
}

function extractLinks(source: string): string[] {
  const links: string[] = [];
  for (const match of source.matchAll(/!?(?:\[\[([^\]]+)\]\])/g)) {
    const value = match[1]?.split("|")[0]?.split("#")[0]?.trim();
    if (value) links.push(value);
  }
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const value = match[1]?.split("#")[0]?.trim();
    if (value && !/^[a-z][a-z0-9+.-]*:/i.test(value)) links.push(decodeSafe(value));
  }
  return links;
}

function resolveTarget(
  raw: string,
  sourceId: string,
  byId: ReadonlyMap<string, string>,
  byTitle: ReadonlyMap<string, string[]>,
): string | undefined {
  const withoutExtension = raw.replace(/\.md$/i, "");
  const direct = normalizeLink(withoutExtension);
  const directMatch = byId.get(direct);
  if (directMatch) return directMatch;
  const relativeTarget = normalizeLink(slash(normalize(join(dirname(sourceId), withoutExtension))));
  const relativeMatch = byId.get(relativeTarget);
  if (relativeMatch) return relativeMatch;
  const titleMatches = byTitle.get(normalizeLink(basename(withoutExtension)));
  return titleMatches?.length === 1 ? titleMatches[0] : undefined;
}

function normalizeLink(value: string): string {
  return slash(value).replace(/^\.\//, "").normalize("NFC").toLocaleLowerCase();
}

function slash(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function decodeSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
