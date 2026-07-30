import { createPortal } from "preact/compat";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ObsidianGraph, ObsidianGraphNode, ObsidianVaultSummary } from "@hermes-studio/protocol";
import type { CanvasTexture, Mesh, MeshStandardMaterial, Object3D, SpriteMaterial, Vector3 } from "three";
import {
  appModalSizes,
  createModalResizeHandlers,
  getAppModalSize,
} from "../app-modal-layout";
import { loadObsidianGraph, loadObsidianVaults } from "../obsidian-api";
import { t } from "../i18n";
import { CloseIcon, RefreshIcon } from "./icons";
import { InfoTip } from "./info-tip";
import { useMobileOverlay } from "./use-mobile-overlay";
import { useModalOutsideClose } from "./use-modal-outside-close";
import "./obsidian-graph-modal.css";

const SETTINGS_KEY = "hermes-studio:obsidian-graph-settings:v1";

type GraphSettings = {
  vaultId: string;
  search: string;
  showOrphans: boolean;
  showLabels: boolean;
  nodeScale: number;
  linkOpacity: number;
  autoRotate: boolean;
};

const DEFAULT_SETTINGS: GraphSettings = {
  vaultId: "",
  search: "",
  showOrphans: true,
  showLabels: true,
  nodeScale: 1,
  linkOpacity: .34,
  autoRotate: false,
};

export function ObsidianGraphModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const _sizes = appModalSizes.value;
  const modalSize = getAppModalSize("obsidian-graph");
  const resize = useMemo(() => createModalResizeHandlers("obsidian-graph"), []);
  const outsideClose = useModalOutsideClose(onClose);
  const [settings, setSettings] = useState<GraphSettings>(() => readSettings());
  const [vaults, setVaults] = useState<readonly ObsidianVaultSummary[]>([]);
  const [graph, setGraph] = useState<ObsidianGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<ObsidianGraphNode | null>(null);
  const overlay = useMobileOverlay<HTMLElement>({
    kind: "modal",
    open,
    onClose,
    viewport: "(min-width: 0px)",
  });

  const patchSettings = (patch: Partial<GraphSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      writeSettings(next);
      return next;
    });
  };

  useEffect(() => () => resize.dispose(), [resize]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    void loadObsidianVaults()
      .then((next) => {
        if (!active) return;
        setVaults(next);
        const selected = next.some((vault) => vault.id === settings.vaultId)
          ? settings.vaultId
          : next[0]?.id ?? "";
        if (selected !== settings.vaultId) patchSettings({ vaultId: selected });
        if (selected) return loadObsidianGraph(selected);
        return null;
      })
      .then((next) => {
        if (active) setGraph(next ?? null);
      })
      .catch(() => {
        if (active) setError(t("obsidianGraph.loadFailed"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open]);

  const reloadGraph = async (vaultId = settings.vaultId) => {
    if (!vaultId || loading) return;
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    setGraph(null);
    try {
      setGraph(await loadObsidianGraph(vaultId));
    } catch {
      setError(t("obsidianGraph.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  const filteredGraph = useMemo(() => {
    if (!graph) return null;
    const query = settings.search.trim().toLocaleLowerCase();
    const eligible = new Set(graph.nodes
      .filter((node) => settings.showOrphans || node.links > 0)
      .map((node) => node.id));
    const visible = query
      ? new Set(graph.nodes
        .filter((node) => eligible.has(node.id))
        .filter((node) => node.title.toLocaleLowerCase().includes(query) || node.folder.toLocaleLowerCase().includes(query))
        .map((node) => node.id))
      : new Set(eligible);
    if (query) {
      const matched = new Set(visible);
      for (const edge of graph.edges) {
        if (matched.has(edge.source) && eligible.has(edge.target)) visible.add(edge.target);
        if (matched.has(edge.target) && eligible.has(edge.source)) visible.add(edge.source);
      }
    }
    return {
      ...graph,
      nodes: graph.nodes.filter((node) => visible.has(node.id)),
      edges: graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)),
    };
  }, [graph, settings.search, settings.showOrphans]);

  if (!open) return null;
  const modal = (
    <div
      class="obsidian-graph-layer"
      role="presentation"
      data-modal-affordance="true"
      {...outsideClose}
    >
      <section
        ref={overlay.ref}
        class="obsidian-graph-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="obsidian-graph-title"
        tabIndex={-1}
        style={{ width: `${modalSize.width}px`, height: `${modalSize.height}px` }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="obsidian-graph-head">
          <div>
            <h2 id="obsidian-graph-title">{t("obsidianGraph.title")}</h2>
            <span>{graph ? t("obsidianGraph.summary", { nodes: graph.nodes.length, edges: graph.edges.length }) : t("obsidianGraph.subtitle")}</span>
          </div>
          <div class="obsidian-graph-head-actions">
            <button type="button" onClick={() => void reloadGraph()} disabled={loading || !settings.vaultId} aria-label={t("hostApps.reload")} title={t("hostApps.reload")}><RefreshIcon /></button>
            <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}><CloseIcon /></button>
          </div>
        </header>

        <div class="obsidian-graph-layout">
          <div class="obsidian-graph-stage">
            {filteredGraph && filteredGraph.nodes.length > 0 ? (
              <ObsidianGraphScene
                graph={filteredGraph}
                settings={settings}
                onSelectNode={setSelectedNode}
              />
            ) : (
              <div class="obsidian-graph-empty">
                <strong>{loading ? t("obsidianGraph.loading") : vaults.length === 0 ? t("obsidianGraph.noVaults") : t("obsidianGraph.empty")}</strong>
                <p>{vaults.length === 0 ? t("obsidianGraph.noVaultsHelp") : t("obsidianGraph.emptyHelp")}</p>
              </div>
            )}
            {selectedNode && (
              <div class="obsidian-graph-selection" role="status">
                <strong>{selectedNode.title}</strong>
                <span>{selectedNode.folder || t("obsidianGraph.root")}</span>
                <small>{t("obsidianGraph.linkCount", { count: selectedNode.links })}</small>
              </div>
            )}
            {graph?.truncated && <span class="obsidian-graph-truncated"><InfoTip text={t("obsidianGraph.truncated")} align="start" /></span>}
          </div>

          <aside class="obsidian-graph-controls" aria-label={t("obsidianGraph.settings")}>
            <div class="obsidian-graph-controls-head">
              <strong>{t("obsidianGraph.settings")}</strong>
              <InfoTip text={t("obsidianGraph.help")} align="end" />
            </div>
            <label>
              <span>{t("obsidianGraph.vault")}</span>
              <select
                value={settings.vaultId}
                disabled={loading || vaults.length === 0}
                onChange={(event) => {
                  const vaultId = event.currentTarget.value;
                  patchSettings({ vaultId });
                  void reloadGraph(vaultId);
                }}
              >
                {vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.name}</option>)}
              </select>
            </label>
            <label>
              <span>{t("obsidianGraph.search")}</span>
              <input type="search" value={settings.search} placeholder={t("obsidianGraph.searchPlaceholder")} onInput={(event) => patchSettings({ search: event.currentTarget.value })} />
            </label>
            <ToggleRow label={t("obsidianGraph.showOrphans")} checked={settings.showOrphans} onChange={(showOrphans) => patchSettings({ showOrphans })} />
            <ToggleRow label={t("obsidianGraph.showLabels")} checked={settings.showLabels} onChange={(showLabels) => patchSettings({ showLabels })} />
            <ToggleRow label={t("obsidianGraph.autoRotate")} checked={settings.autoRotate} onChange={(autoRotate) => patchSettings({ autoRotate })} />
            <label>
              <span>{t("obsidianGraph.nodeSize")}</span>
              <input type="range" min="0.6" max="1.8" step="0.1" value={settings.nodeScale} onInput={(event) => patchSettings({ nodeScale: Number(event.currentTarget.value) })} />
            </label>
            <label>
              <span>{t("obsidianGraph.linkOpacity")}</span>
              <input type="range" min="0.08" max="0.85" step="0.01" value={settings.linkOpacity} onInput={(event) => patchSettings({ linkOpacity: Number(event.currentTarget.value) })} />
            </label>
            {error && <p class="obsidian-graph-error" role="alert">{error}</p>}
          </aside>
        </div>

        {resize.handles.map((handle) => (
          <div
            key={handle.edge}
            class={`app-modal-resize ${handle.className}`}
            role="separator"
            aria-label={t("common.resizeModal")}
            title={t("common.resizeModal")}
            onPointerDown={resize.begin(handle.edge)}
          />
        ))}
      </section>
    </div>
  );
  return typeof document === "undefined" ? modal : createPortal(modal, document.body);
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label class="obsidian-graph-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>
  );
}

function ObsidianGraphScene({
  graph,
  settings,
  onSelectNode,
}: {
  graph: ObsidianGraph;
  settings: GraphSettings;
  onSelectNode: (node: ObsidianGraphNode | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelectNode);
  selectRef.current = onSelectNode;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || graph.nodes.length === 0) return;
    let disposed = false;
    let animation = 0;
    let cleanup = () => {};
    void (async () => {
      const THREE = await import("three");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      if (disposed) return;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x10121a);
      scene.fog = new THREE.FogExp2(0x10121a, .022);
      const camera = new THREE.PerspectiveCamera(48, 1, .1, 180);
      camera.position.set(0, 5, 22);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      container.replaceChildren(renderer.domElement);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = .07;
      controls.minDistance = 4;
      controls.maxDistance = 70;
      controls.autoRotate = settings.autoRotate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      controls.autoRotateSpeed = .45;

      scene.add(new THREE.AmbientLight(0xbcc6ff, 1.6));
      const key = new THREE.PointLight(0x8b7cff, 28, 45);
      key.position.set(6, 8, 10);
      scene.add(key);
      const fill = new THREE.PointLight(0x43b89f, 18, 40);
      fill.position.set(-10, -4, -6);
      scene.add(fill);

      const positions = new Map<string, Vector3>();
      const nodeByObject = new Map<Object3D, ObsidianGraphNode>();
      const meshes: Mesh[] = [];
      const geometry = new THREE.SphereGeometry(.16, 12, 9);
      const materials = new Map<string, MeshStandardMaterial>();
      const labelTextures: CanvasTexture[] = [];
      const labelMaterials: SpriteMaterial[] = [];
      const topLabels = new Set([...graph.nodes].sort((a, b) => b.links - a.links).slice(0, 90).map((node) => node.id));

      graph.nodes.forEach((node, index) => {
        const seed = hash(node.id);
        const phi = Math.acos(1 - 2 * ((index + .5) / graph.nodes.length));
        const theta = Math.PI * (1 + Math.sqrt(5)) * index + (seed % 1000) / 200;
        const radius = 5.2 + Math.log2(graph.nodes.length + 1) * .8 + ((seed >>> 10) % 100) / 90;
        const position = new THREE.Vector3(
          radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.cos(phi) * .72,
          radius * Math.sin(phi) * Math.sin(theta),
        );
        positions.set(node.id, position);
        const folderKey = node.folder.split("/")[0] || "root";
        let material = materials.get(folderKey);
        if (!material) {
          material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(`hsl(${hash(folderKey) % 360} 58% 62%)`),
            emissive: new THREE.Color(`hsl(${hash(folderKey) % 360} 45% 20%)`),
            roughness: .38,
            metalness: .08,
          });
          materials.set(folderKey, material);
        }
        const mesh = new THREE.Mesh(geometry, material);
        const scale = settings.nodeScale * (1 + Math.min(18, node.links) * .045);
        mesh.scale.setScalar(scale);
        mesh.position.copy(position);
        scene.add(mesh);
        meshes.push(mesh);
        nodeByObject.set(mesh, node);

        if (settings.showLabels && topLabels.has(node.id)) {
          const label = makeLabelSprite(THREE, node.title);
          label.sprite.position.copy(position).add(new THREE.Vector3(0, .35 * scale, 0));
          scene.add(label.sprite);
          labelTextures.push(label.texture);
          labelMaterials.push(label.material);
        }
      });

      const linePoints: number[] = [];
      for (const edge of graph.edges) {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) continue;
        linePoints.push(source.x, source.y, source.z, target.x, target.y, target.z);
      }
      const lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linePoints, 3));
      const lineMaterial = new THREE.LineBasicMaterial({ color: 0x8f99ba, transparent: true, opacity: settings.linkOpacity });
      const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
      scene.add(lines);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2(2, 2);
      const updatePointer = (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      };
      const clearPointer = () => { pointer.set(2, 2); selectRef.current(null); };
      const select = () => {
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(meshes, false)[0]?.object;
        selectRef.current(hit ? nodeByObject.get(hit) ?? null : null);
      };
      renderer.domElement.addEventListener("pointermove", updatePointer);
      renderer.domElement.addEventListener("pointerleave", clearPointer);
      renderer.domElement.addEventListener("click", select);

      const resizeScene = () => {
        const width = Math.max(1, container.clientWidth);
        const height = Math.max(1, container.clientHeight);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resizeScene);
      observer.observe(container);
      resizeScene();
      const render = () => {
        controls.update();
        renderer.render(scene, camera);
        animation = requestAnimationFrame(render);
      };
      render();
      cleanup = () => {
        cancelAnimationFrame(animation);
        observer.disconnect();
        renderer.domElement.removeEventListener("pointermove", updatePointer);
        renderer.domElement.removeEventListener("pointerleave", clearPointer);
        renderer.domElement.removeEventListener("click", select);
        controls.dispose();
        geometry.dispose();
        lineGeometry.dispose();
        lineMaterial.dispose();
        for (const material of materials.values()) material.dispose();
        for (const material of labelMaterials) material.dispose();
        for (const texture of labelTextures) texture.dispose();
        renderer.dispose();
        scene.clear();
        renderer.domElement.remove();
      };
    })();
    return () => {
      disposed = true;
      cleanup();
      selectRef.current(null);
    };
  }, [graph, settings.autoRotate, settings.linkOpacity, settings.nodeScale, settings.showLabels]);

  return <div ref={containerRef} class="obsidian-graph-canvas" aria-label={t("obsidianGraph.canvasAria")} />;
}

function makeLabelSprite(THREE: typeof import("three"), title: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.font = "600 24px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "rgba(242,244,255,.92)";
  context.fillText(title.slice(0, 34), 256, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, opacity: .9 });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(4.8, .6, 1);
  return { sprite, texture, material };
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function readSettings(): GraphSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<GraphSettings> | null;
    if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
    return {
      vaultId: typeof value.vaultId === "string" ? value.vaultId : "",
      search: typeof value.search === "string" ? value.search : "",
      showOrphans: typeof value.showOrphans === "boolean" ? value.showOrphans : true,
      showLabels: typeof value.showLabels === "boolean" ? value.showLabels : true,
      nodeScale: bounded(value.nodeScale, .6, 1.8, 1),
      linkOpacity: bounded(value.linkOpacity, .08, .85, .34),
      autoRotate: typeof value.autoRotate === "boolean" ? value.autoRotate : false,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: GraphSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

function bounded(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
