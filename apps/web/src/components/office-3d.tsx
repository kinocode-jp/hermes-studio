/**
 * Three.js isometric 3D studio scene.
 * Renders the same OfficeWorld data as a warm pixel-art studio with:
 * - Isometric orthographic camera
 * - Canvas-generated tile, wall, furniture, and sign textures
 * - Warm low-saturation workstations with agent-colored screens
 * - Character billboards (sprites) with status indicators
 * - Bright, soft studio lighting that preserves pixel colors
 * - Hover/click raycasting for profile selection
 * - Subtle idle animations (character bob, screen flicker)
 */
import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import type { Sprite as ThreeSprite, Group as ThreeGroup } from "three";
import type { Profile } from "../domain";
import { t } from "../i18n";
import { avatarForProfile } from "../avatar-preferences";
import { KanbanBoard } from "./kanban-board";
import {
  CELL,
  createCharacters,
  tickCharacters,
  type OfficeWorld,
  type OfficeObject,
  type DeskSlot,
} from "../office/sim";
import { profileDisplayName } from "../profile-names";

/* ── Constants ─────────────────────────────────────────────────── */
const UNIT = 1; // 1 cell = 1 three.js unit
const WALL_H = 1.8;
const DESK_H = 0.7;
const MONITOR_H = 0.35;
const SHELF_H = 0.9;
const SOFA_H = 0.35;
const TABLE_H = 0.38;
const COFFEE_H = 0.5;

/* ── Warm pixel studio palette ───────────────────────────────── */
const C_AQUA = 0x43b89f;
const C_SKY = 0xeaf3f1;

const kanbanOverlayOpen = signal(false);

/* ── Helpers ──────────────────────────────────────────────────── */
function cellTo3D(cx: number, cy: number): [number, number, number] {
  return [cx * UNIT, 0, cy * UNIT];
}

/* ── Component ─────────────────────────────────────────────────── */
export function Office3D({
  profiles,
  world,
  onProfileActivate,
}: {
  profiles: Profile[];
  world: OfficeWorld;
  onProfileActivate: (event: MouseEvent, profileId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const threeRef = useRef<{
    dispose: () => void;
    updateProfiles: (p: Profile[]) => void;
  } | null>(null);

  const activateRef = useRef(onProfileActivate);
  activateRef.current = onProfileActivate;

  useEffect(() => {
    const container = containerRef.current!;
    if (!container) return;
    // Guard against double-mount (Preact strict mode / HMR)
    if (container.querySelector("canvas")) return;

    let disposed = false;
    let THREE: typeof import("three");

    async function init() {
      try {
      THREE = await import("three");
      if (disposed) return;

      const {
        Scene, OrthographicCamera, WebGLRenderer,
        AmbientLight, DirectionalLight, PointLight,
        BoxGeometry, PlaneGeometry, CylinderGeometry, SphereGeometry,
        Mesh, MeshStandardMaterial, MeshBasicMaterial,
        SpriteMaterial, Sprite, CanvasTexture,
        Raycaster, Vector2, Group, Color, Fog,
        DoubleSide, PCFSoftShadowMap, SRGBColorSpace,
        NearestFilter, RepeatWrapping, NoToneMapping,
      } = THREE;

      const ownedTextures = new Set<InstanceType<typeof CanvasTexture>>();
      function makePixelTexture(
        width: number,
        height: number,
        paint: (ctx: CanvasRenderingContext2D) => void,
        repeat?: { x: number; y: number },
      ) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingEnabled = false;
        paint(ctx);
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        texture.magFilter = NearestFilter;
        texture.minFilter = NearestFilter;
        texture.generateMipmaps = false;
        if (repeat) {
          texture.wrapS = RepeatWrapping;
          texture.wrapT = RepeatWrapping;
          texture.repeat.set(repeat.x, repeat.y);
        }
        texture.needsUpdate = true;
        ownedTextures.add(texture);
        return texture;
      }

      function makeDitherTexture(base: string, light: string, dark: string, accent?: string) {
        return makePixelTexture(8, 8, (ctx) => {
          ctx.fillStyle = base;
          ctx.fillRect(0, 0, 8, 8);
          ctx.fillStyle = light;
          ctx.fillRect(0, 0, 8, 1);
          ctx.fillRect(1, 3, 1, 1);
          ctx.fillRect(6, 5, 1, 1);
          ctx.fillStyle = dark;
          ctx.fillRect(0, 7, 8, 1);
          ctx.fillRect(4, 2, 1, 1);
          ctx.fillRect(2, 6, 1, 1);
          if (accent) {
            ctx.fillStyle = accent;
            ctx.fillRect(7, 1, 1, 1);
            ctx.fillRect(0, 4, 1, 1);
          }
        });
      }

      const pixelTextures = {
        desk: makeDitherTexture("#c99e70", "#e6c69b", "#9b7254", "#efd6ac"),
        reception: makeDitherTexture("#b9d8cc", "#d8ebe2", "#739e91", "#f3dfad"),
        wood: makeDitherTexture("#b9825c", "#d6a779", "#805941", "#e7bd86"),
        metal: makeDitherTexture("#8fa39c", "#c5d2cc", "#62756f"),
        cream: makeDitherTexture("#e8dfca", "#fff8e8", "#c9bba2", "#d9cda9"),
        terracotta: makeDitherTexture("#b87361", "#d9987f", "#805047", "#e5b592"),
        sage: makeDitherTexture("#6e9b77", "#91bd8c", "#476a56", "#b4cf91"),
        dark: makeDitherTexture("#334943", "#587069", "#20332f", "#79b3a4"),
        aqua: makeDitherTexture("#43a991", "#76cbb5", "#2d786b", "#d9ead8"),
        amber: makeDitherTexture("#c58e36", "#edc76e", "#8a642d", "#fff0ac"),
      };

      /* ── Scene setup ─────────────────────────────────────── */
      const scene = new Scene();
      scene.background = new Color(C_SKY);
      scene.fog = new Fog(C_SKY, 34, 64);
      function disposeSceneResources() {
        const geometries = new Set<{ dispose: () => void }>();
        const materials = new Set<{ dispose: () => void }>();
        scene.traverse((object) => {
          const renderable = object as unknown as {
            geometry?: { dispose: () => void };
            material?: { dispose: () => void } | Array<{ dispose: () => void }>;
          };
          if (renderable.geometry) geometries.add(renderable.geometry);
          if (Array.isArray(renderable.material)) {
            for (const material of renderable.material) materials.add(material);
          } else if (renderable.material) {
            materials.add(renderable.material);
          }
        });
        for (const geometry of geometries) geometry.dispose();
        for (const material of materials) material.dispose();
        for (const texture of ownedTextures) texture.dispose();
        ownedTextures.clear();
        scene.clear();
      }

      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      const aspect = w / h;
      const fitFrustum = (viewportAspect: number) => Math.max(
        Math.max(world.cols, world.rows) * 0.56,
        (world.cols + world.rows) * 0.4 / Math.max(0.45, viewportAspect),
      );
      const frustum = fitFrustum(aspect);
      const camera = new OrthographicCamera(
        -frustum * aspect, frustum * aspect,
        frustum, -frustum, 0.1, 100
      );
      // Isometric angle
      const cx = world.cols * 0.5;
      const cz = world.rows * 0.5;
      const defaultCamPos = [cx + 18, 17, cz + 20] as const;
      const defaultTarget = [cx, 0.15, cz] as const;
      const cameraStorageKey = "hermes-studio.camera-state.pixel-v1";
      // Restore saved camera state
      let savedCam: { px: number; py: number; pz: number; tx: number; ty: number; tz: number; zoom: number } | null = null;
      try {
        const raw = localStorage.getItem(cameraStorageKey);
        if (raw) savedCam = JSON.parse(raw);
      } catch { /* ignore */ }
      if (savedCam) {
        camera.position.set(savedCam.px, savedCam.py, savedCam.pz);
        camera.zoom = savedCam.zoom || 1;
        camera.updateProjectionMatrix();
      } else {
        camera.position.set(...defaultCamPos);
      }
      camera.lookAt(savedCam ? savedCam.tx : defaultTarget[0], savedCam ? savedCam.ty : defaultTarget[1], savedCam ? savedCam.tz : defaultTarget[2]);

      const renderer = new WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = PCFSoftShadowMap;
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.toneMapping = NoToneMapping;
      renderer.toneMappingExposure = 1;
      container.appendChild(renderer.domElement);

      /* ── OrbitControls ───────────────────────────────────── */
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(cx, 0, cz);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enableRotate = true;
      controls.enableZoom = true;
      controls.enablePan = true;
      controls.minZoom = 0.3;
      controls.maxZoom = 3.0;
      controls.maxPolarAngle = Math.PI / 2.1;
      controls.mouseButtons = { LEFT: 0, MIDDLE: 1, RIGHT: 2 }; // LEFT=rotate, MIDDLE=dolly, RIGHT=pan
      controls.touches = { ONE: 0, TWO: 2 }; // ONE=rotate, TWO=pan+zoom
      if (savedCam) {
        controls.target.set(savedCam.tx, savedCam.ty, savedCam.tz);
      }
      controls.update();

      // Save camera state on change (throttled)
      let camSaveTimer = 0;
      const saveCamState = () => {
        clearTimeout(camSaveTimer);
        camSaveTimer = window.setTimeout(() => {
          try {
            localStorage.setItem(cameraStorageKey, JSON.stringify({
              px: camera.position.x, py: camera.position.y, pz: camera.position.z,
              tx: controls.target.x, ty: controls.target.y, tz: controls.target.z,
              zoom: camera.zoom,
            }));
          } catch { /* ignore */ }
        }, 500);
      };
      controls.addEventListener("change", saveCamState);

      /* ── Lighting ────────────────────────────────────────── */
      const ambient = new AmbientLight(0xfffbef, 1.65);
      scene.add(ambient);

      const sun = new DirectionalLight(0xfff7e6, 1.75);
      sun.position.set(cx + 10, 22, cz + 6);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -25;
      sun.shadow.camera.right = 25;
      sun.shadow.camera.top = 25;
      sun.shadow.camera.bottom = -25;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 50;
      sun.shadow.bias = -0.001;
      sun.shadow.normalBias = 0.02;
      scene.add(sun);

      const fill = new DirectionalLight(0xd8fff5, 0.55);
      fill.position.set(-8, 10, -6);
      scene.add(fill);

      const warmLight1 = new PointLight(0xffdba8, 0.24, 24);
      warmLight1.position.set(world.cols * 0.3, 3, world.rows * 0.3);
      scene.add(warmLight1);
      const warmLight2 = new PointLight(0xbaf5e7, 0.2, 24);
      warmLight2.position.set(world.cols * 0.7, 3, world.rows * 0.7);
      scene.add(warmLight2);

      /* ── Floor ───────────────────────────────────────────── */
      const floorTex = makePixelTexture(16, 16, (ctx) => {
        ctx.fillStyle = "#c68f63";
        ctx.fillRect(0, 0, 16, 16);
        ctx.fillStyle = "#d7a977";
        ctx.fillRect(0, 0, 8, 8);
        ctx.fillRect(8, 8, 8, 8);
        ctx.fillStyle = "#b77955";
        ctx.fillRect(0, 7, 8, 1);
        ctx.fillRect(8, 15, 8, 1);
        ctx.fillRect(7, 0, 1, 8);
        ctx.fillRect(15, 8, 1, 8);
        ctx.fillStyle = "#edc493";
        ctx.fillRect(2, 2, 3, 1);
        ctx.fillRect(10, 10, 4, 1);
        ctx.fillStyle = "#976247";
        ctx.fillRect(11, 4, 2, 1);
        ctx.fillRect(3, 12, 2, 1);
      }, { x: world.cols / 2, y: world.rows / 2 });
      const floorGeo = new PlaneGeometry(world.cols * UNIT, world.rows * UNIT);
      const floorMat = new MeshStandardMaterial({
        map: floorTex,
        roughness: 0.96,
        metalness: 0,
      });
      const floor = new Mesh(floorGeo, floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(world.cols * 0.5, 0, world.rows * 0.5);
      floor.receiveShadow = true;
      scene.add(floor);

      /* ── Walls ───────────────────────────────────────────── */
      const wallTex = makePixelTexture(32, 24, (ctx) => {
        ctx.fillStyle = "#f4ead4";
        ctx.fillRect(0, 0, 32, 24);
        ctx.fillStyle = "#fff7e7";
        for (let x = 1; x < 32; x += 5) ctx.fillRect(x, 2 + (x % 3), 1, 1);
        ctx.fillStyle = "#a8d6c6";
        ctx.fillRect(0, 13, 32, 4);
        ctx.fillStyle = "#79b9a5";
        ctx.fillRect(0, 16, 32, 1);
        ctx.fillStyle = "#dfd1b9";
        ctx.fillRect(0, 23, 32, 1);
        ctx.fillRect(7, 8, 1, 1);
        ctx.fillRect(22, 5, 1, 1);
      }, { x: Math.max(2, world.cols / 4), y: 1 });
      const wallMat = new MeshStandardMaterial({ map: wallTex, roughness: 0.94, metalness: 0 });
      const wallThickness = 0.15;

      // Back wall (z=0)
      const backWall = new Mesh(
        new BoxGeometry(world.cols * UNIT, WALL_H, wallThickness),
        wallMat
      );
      backWall.position.set(world.cols * 0.5, WALL_H / 2, -wallThickness / 2);
      backWall.castShadow = true;
      backWall.receiveShadow = true;
      scene.add(backWall);

      // Left wall (x=0)
      const leftWall = new Mesh(
        new BoxGeometry(wallThickness, WALL_H, world.rows * UNIT),
        wallMat
      );
      leftWall.position.set(-wallThickness / 2, WALL_H / 2, world.rows * 0.5);
      leftWall.castShadow = true;
      leftWall.receiveShadow = true;
      scene.add(leftWall);

      const ledMat = new MeshStandardMaterial({
        map: pixelTextures.dark,
        roughness: 0.85,
      });
      const backLed = new Mesh(new BoxGeometry(world.cols * UNIT, 0.08, 0.08), ledMat);
      backLed.position.set(world.cols * 0.5, 0.04, 0.04);
      scene.add(backLed);
      const leftLed = new Mesh(new BoxGeometry(0.08, 0.08, world.rows * UNIT), ledMat);
      leftLed.position.set(0.04, 0.04, world.rows * 0.5);
      scene.add(leftLed);

      // Fixed task-board portal on the entrance-side back wall.
      const boardMat = new MeshStandardMaterial({ map: pixelTextures.dark, roughness: 0.8, metalness: 0 });
      const boardMesh = new Mesh(
        new BoxGeometry(world.board.w * UNIT * 1.0, 1.2, 0.12),
        boardMat
      );
      boardMesh.position.set((world.board.x + world.board.w / 2) * UNIT, WALL_H * 0.5, 0.08);
      boardMesh.userData = { isBoard: true };
      scene.add(boardMesh);

      const frameMat = new MeshStandardMaterial({ map: pixelTextures.aqua, roughness: 0.82, metalness: 0 });
      const bw = world.board.w * UNIT * 1.0;
      const bh = 1.2;
      const bx = (world.board.x + world.board.w / 2) * UNIT;
      const by = WALL_H * 0.5;
      const boardFrame: InstanceType<typeof Mesh>[] = [];
      for (const fy of [by + bh/2 + 0.04, by - bh/2 - 0.04]) {
        const fb = new Mesh(new BoxGeometry(bw + 0.15, 0.08, 0.14), frameMat);
        fb.position.set(bx, fy, 0.08);
        scene.add(fb);
        boardFrame.push(fb);
      }
      for (const fx of [bx - bw/2 - 0.04, bx + bw/2 + 0.04]) {
        const fb = new Mesh(new BoxGeometry(0.08, bh + 0.15, 0.14), frameMat);
        fb.position.set(fx, by, 0.08);
        scene.add(fb);
        boardFrame.push(fb);
      }

      const boardLabelTex = makePixelTexture(128, 40, (ctx) => {
        ctx.fillStyle = "#f8edcf";
        ctx.fillRect(0, 0, 128, 40);
        ctx.fillStyle = "#d9ead8";
        ctx.fillRect(4, 4, 120, 7);
        ctx.fillStyle = "#d97862";
        ctx.fillRect(9, 15, 22, 17);
        ctx.fillStyle = "#e2b65d";
        ctx.fillRect(36, 15, 22, 11);
        ctx.fillStyle = "#73aa96";
        ctx.fillRect(63, 15, 22, 15);
        ctx.fillStyle = "#fff8e8";
        ctx.fillRect(90, 15, 29, 9);
        ctx.fillStyle = "#25433f";
        ctx.font = "700 13px 'Noto Sans JP', system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("タスクボード", 64, 8);
        ctx.fillRect(0, 38, 128, 2);
      });
      const boardLabelMat = new MeshBasicMaterial({ map: boardLabelTex, transparent: false });
      const boardLabel = new Mesh(new PlaneGeometry(bw - 0.12, bh - 0.12), boardLabelMat);
      boardLabel.position.set(bx, by, 0.145);
      boardLabel.userData = { isBoard: true };
      scene.add(boardLabel);

      const boardGlow = new PointLight(C_AQUA, 0.12, 4);
      boardGlow.position.set(bx, by, 1.5);
      scene.add(boardGlow);

      /* ── Studio marquee sign on back wall ────────────────── */
      const marqueeTex = makePixelTexture(128, 20, (ctx) => {
        ctx.fillStyle = "#315852";
        ctx.fillRect(0, 2, 128, 16);
        ctx.fillStyle = "#8ac7b4";
        ctx.fillRect(2, 4, 124, 2);
        ctx.fillStyle = "#fff4d9";
        ctx.font = "700 10px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("HERMES STUDIO", 64, 11);
      });
      const marqueeMat = new SpriteMaterial({ map: marqueeTex, transparent: true, depthTest: false });
      const marquee = new Sprite(marqueeMat);
      marquee.scale.set(5.1, 0.8, 1);
      marquee.position.set(world.cols * 0.35, WALL_H * 0.85, 0.2);
      marquee.center.set(0.5, 0.5);
      scene.add(marquee);

      /* ── Ceiling light bars ──────────────────────────────── */
      const barMat = new MeshStandardMaterial({ map: pixelTextures.metal, roughness: 0.7, metalness: 0.05 });
      const barGlowMat = new MeshBasicMaterial({ map: pixelTextures.cream });
      for (let bi = 0; bi < 2; bi++) {
        const bz = world.rows * (0.35 + bi * 0.3);
        const bar = new Mesh(new BoxGeometry(world.cols * 0.55, 0.06, 0.2), barMat);
        bar.position.set(world.cols * 0.5, WALL_H + 0.5, bz);
        scene.add(bar);
        const glow = new Mesh(new BoxGeometry(world.cols * 0.5, 0.03, 0.12), barGlowMat);
        glow.position.set(world.cols * 0.5, WALL_H + 0.46, bz);
        scene.add(glow);
      }

      /* ── Furniture builder ───────────────────────────────── */


      function addBox(
        x: number,
        z: number,
        w: number,
        d: number,
        h: number,
        texture: InstanceType<typeof CanvasTexture>,
        yOff = 0,
      ) {
        const geo = new BoxGeometry(w, h, d);
        const mat = new MeshStandardMaterial({ map: texture, roughness: 0.88, metalness: 0 });
        const mesh = new Mesh(geo, mat);
        mesh.position.set(x + w / 2, h / 2 + yOff, z + d / 2);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
        return mesh;
      }

      const deskHighlights = new Map<string, {
        surface: ReturnType<typeof addBox>;
        outlineMaterial: InstanceType<typeof MeshBasicMaterial>;
      }>();
      function addDesk(desk: DeskSlot, profileId: string, agentColor: string, isReception = false) {
        const [dx, , dz] = cellTo3D(desk.x, desk.y);
        const surface = addBox(dx, dz, 2 * UNIT, 1 * UNIT, DESK_H, isReception ? pixelTextures.reception : pixelTextures.desk);
        const outlineMat = new MeshBasicMaterial({
          map: pixelTextures.aqua,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });
        const outline = new Mesh(new BoxGeometry(2.08, 0.06, 1.08), outlineMat);
        outline.position.set(dx + 1, DESK_H + 0.035, dz + 0.5);
        scene.add(outline);
        deskHighlights.set(profileId, { surface, outlineMaterial: outlineMat });
        if (isReception) {
          const signTex = makePixelTexture(64, 20, (ctx) => {
            ctx.fillStyle = "#315852";
            ctx.fillRect(1, 2, 62, 16);
            ctx.fillStyle = "#86c8b5";
            ctx.fillRect(3, 4, 58, 2);
            ctx.fillStyle = "#fff2ce";
            ctx.font = "700 9px ui-monospace, monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("RECEPTION", 32, 12);
          });
          const signMat = new SpriteMaterial({ map: signTex, transparent: true, depthTest: false });
          const sign = new Sprite(signMat);
          sign.scale.set(1.8, 0.45, 1);
          sign.position.set(dx + 1, DESK_H + 0.8, dz + 0.5);
          sign.center.set(0.5, 0.5);
          scene.add(sign);
          const spotLight = new PointLight(C_AQUA, 0.12, 4);
          spotLight.position.set(dx + 1, 2.5, dz + 0.5);
          scene.add(spotLight);
        }
        // Desk legs
        addBox(dx + 0.1, dz + 0.1, 0.08, 0.08, DESK_H, pixelTextures.wood);
        addBox(dx + 1.8, dz + 0.1, 0.08, 0.08, DESK_H, pixelTextures.wood);
        addBox(dx + 0.1, dz + 0.8, 0.08, 0.08, DESK_H, pixelTextures.wood);
        addBox(dx + 1.8, dz + 0.8, 0.08, 0.08, DESK_H, pixelTextures.wood);
        // Monitor
        addBox(dx + 1.3, dz + 0.1, 0.5, 0.06, MONITOR_H, pixelTextures.dark, DESK_H);
        const screenTex = makePixelTexture(16, 12, (ctx) => {
          ctx.fillStyle = "#20332f";
          ctx.fillRect(0, 0, 16, 12);
          ctx.fillStyle = agentColor;
          ctx.fillRect(2, 2, 12, 2);
          ctx.fillRect(2, 6, 8, 1);
          ctx.fillRect(2, 9, 11, 1);
          ctx.fillStyle = "#fff4d9";
          ctx.fillRect(12, 6, 2, 2);
        });
        const screenMat = new MeshBasicMaterial({ map: screenTex });
        const screen = new Mesh(new BoxGeometry(0.44, 0.28, 0.02), screenMat);
        screen.position.set(dx + 1.55, DESK_H + MONITOR_H * 0.5, dz + 0.14);
        scene.add(screen);
        // Monitor stand
        addBox(dx + 1.45, dz + 0.15, 0.1, 0.15, 0.08, pixelTextures.metal, DESK_H);
        const lampArm = new Mesh(new CylinderGeometry(0.025, 0.025, 0.35, 6), new MeshStandardMaterial({ map: pixelTextures.metal, roughness: 0.75 }));
        lampArm.position.set(dx + 0.35, DESK_H + 0.18, dz + 0.7);
        scene.add(lampArm);
        const lampHead = new Mesh(new SphereGeometry(0.07, 6, 4), new MeshBasicMaterial({ map: pixelTextures.amber }));
        lampHead.position.set(dx + 0.35, DESK_H + 0.38, dz + 0.7);
        scene.add(lampHead);
      }

      function addObject3D(obj: OfficeObject) {
        const [ox, , oz] = cellTo3D(obj.x, obj.y);
        const ow = obj.w * UNIT;
        const od = obj.h * UNIT;

        switch (obj.type) {
          case "meeting": {
            addBox(ox, oz, ow, od, TABLE_H, pixelTextures.cream);
            for (let ci = 0; ci < obj.w; ci++) {
              addBox(ox + ci + 0.2, oz - 0.4, 0.5, 0.4, 0.3, pixelTextures.terracotta);
              addBox(ox + ci + 0.2, oz + od, 0.5, 0.4, 0.3, pixelTextures.terracotta);
            }
            break;
          }
          case "shelf": {
            addBox(ox, oz, ow, od, SHELF_H, pixelTextures.wood);
            // Shelf dividers
            for (let si = 1; si < 3; si++) {
              addBox(ox, oz, ow, 0.05, 0.03, pixelTextures.dark, si * SHELF_H / 3);
            }
            // Equipment cases (colored blocks)
            const bookTextures = [pixelTextures.terracotta, pixelTextures.aqua, pixelTextures.amber, pixelTextures.sage];
            for (let bi = 0; bi < Math.min(ow * 2, 8); bi++) {
              const bookTexture = bookTextures[bi % bookTextures.length]!;
              addBox(ox + 0.1 + bi * 0.35, oz + 0.1, 0.25, 0.3, 0.22 + (bi % 3) * 0.05, bookTexture, SHELF_H * 0.35);
            }
            break;
          }
          case "coffee": {
            addBox(ox, oz, ow, od, COFFEE_H, pixelTextures.cream);
            addBox(ox + 0.3, oz + 0.1, 0.4, 0.4, 0.35, pixelTextures.dark, COFFEE_H);
            const coffeeLed = new Mesh(new SphereGeometry(0.035, 4, 3), new MeshBasicMaterial({ map: pixelTextures.amber }));
            coffeeLed.position.set(ox + 0.5, COFFEE_H + 0.38, oz + 0.3);
            scene.add(coffeeLed);
            break;
          }
          case "sofa": {
            const sofaMat = new MeshStandardMaterial({ map: pixelTextures.terracotta, roughness: 0.9 });
            const sofaSeat = new Mesh(new BoxGeometry(ow, SOFA_H, od), sofaMat);
            sofaSeat.position.set(ox + ow / 2, SOFA_H / 2, oz + od / 2);
            sofaSeat.castShadow = true;
            scene.add(sofaSeat);
            // Back rest
            const backRest = new Mesh(new BoxGeometry(ow, 0.3, 0.15), sofaMat);
            backRest.position.set(ox + ow / 2, SOFA_H + 0.15, oz + 0.08);
            backRest.castShadow = true;
            scene.add(backRest);
            break;
          }
          case "plant": {
            // Pot
            const potGeo = new CylinderGeometry(0.2, 0.15, 0.25, 8);
            const potMat = new MeshStandardMaterial({ map: pixelTextures.terracotta, roughness: 0.9 });
            const pot = new Mesh(potGeo, potMat);
            pot.position.set(ox + 0.5, 0.125, oz + 0.5);
            pot.castShadow = true;
            scene.add(pot);
            // Foliage
            const leafGeo = new SphereGeometry(0.35, 8, 6);
            const leafMat = new MeshStandardMaterial({ map: pixelTextures.sage, roughness: 0.9 });
            const leaf = new Mesh(leafGeo, leafMat);
            leaf.position.set(ox + 0.5, 0.25 + 0.35, oz + 0.5);
            leaf.scale.set(1, 1.2, 1);
            leaf.castShadow = true;
            scene.add(leaf);
            break;
          }
          case "rug": {
            const rugTex = makePixelTexture(16, 16, (ctx) => {
              ctx.fillStyle = "#80b8a5";
              ctx.fillRect(0, 0, 16, 16);
              ctx.fillStyle = "#b7d6bd";
              ctx.fillRect(2, 2, 12, 12);
              ctx.fillStyle = "#e7cf91";
              ctx.fillRect(5, 5, 6, 6);
              ctx.fillStyle = "#527b70";
              ctx.fillRect(0, 0, 16, 1);
              ctx.fillRect(0, 15, 16, 1);
              ctx.fillRect(0, 0, 1, 16);
              ctx.fillRect(15, 0, 1, 16);
            }, { x: Math.max(1, obj.w / 2), y: Math.max(1, obj.h / 2) });
            const rugGeo = new PlaneGeometry(ow, od);
            const rugMat = new MeshStandardMaterial({
              map: rugTex,
              roughness: 0.95,
            });
            const rug = new Mesh(rugGeo, rugMat);
            rug.rotation.x = -Math.PI / 2;
            rug.position.set(ox + ow / 2, 0.01, oz + od / 2);
            scene.add(rug);
            break;
          }
        }
      }

      /* ── Build world objects ─────────────────────────────── */
      // debug overlay removed
      for (const obj of world.objects) {
        addObject3D(obj);
      }


      /* ── Build desks ─────────────────────────────────────── */
      const profileById = new Map(profiles.map(p => [p.id, p]));
      // Ensure "default" profile is always at desk 0 (reception)
      const orderedIds = (() => {
        const ids = profiles.map(p => p.id);
        const di = ids.indexOf("default");
        if (di > 0) { ids.splice(di, 1); ids.unshift("default"); }
        return ids;
      })();
      for (let di = 0; di < Math.min(world.desks.length, orderedIds.length); di++) {
        const prof = profileById.get(orderedIds[di]!);
        addDesk(world.desks[di]!, orderedIds[di]!, prof?.color ?? "#55d6be", orderedIds[di] === "default");
      }


      /* ── Characters as atlas sprites ─────────────────────── */
      const charGroup = new Group();
      scene.add(charGroup);

      // Load character atlas
      const ATLAS_COLS = 9;
      const ATLAS_ROWS = 6;
      const atlasImg = new Image();
      atlasImg.crossOrigin = "anonymous";
      atlasImg.src = "/characters/hermes-studio-character-atlas-v4.webp";
      await new Promise<void>((resolve) => { atlasImg.onload = () => resolve(); atlasImg.onerror = () => resolve(); });
      if (disposed) {
        clearTimeout(camSaveTimer);
        controls.removeEventListener("change", saveCamState);
        controls.dispose();
        disposeSceneResources();
        renderer.renderLists.dispose();
        renderer.dispose();
        if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
        return;
      }

      function makeCharSprite(profile: Profile) {
        const g = new Group();

        // Downsample the existing avatar to a 32px cell, then add a true 1px outline.
        const avatar = avatarForProfile(profile.id);
        const rowIndex = avatar.kind === "creature" ? avatar.index : 0;
        const avatarCanvas = document.createElement("canvas");
        avatarCanvas.width = 32;
        avatarCanvas.height = 32;
        const avatarCtx = avatarCanvas.getContext("2d")!;
        avatarCtx.imageSmoothingEnabled = false;
        if (atlasImg.complete && atlasImg.naturalWidth > 0) {
          const sw = atlasImg.naturalWidth / ATLAS_COLS;
          const sh = atlasImg.naturalHeight / ATLAS_ROWS;
          avatarCtx.drawImage(atlasImg, 0, rowIndex * sh, sw, sh, 0, 0, 32, 32);
        } else {
          avatarCtx.fillStyle = profile.color;
          avatarCtx.fillRect(10, 5, 12, 11);
          avatarCtx.fillRect(8, 16, 16, 11);
          avatarCtx.fillStyle = "#fff3d4";
          avatarCtx.fillRect(12, 9, 2, 2);
          avatarCtx.fillRect(18, 9, 2, 2);
        }
        const avatarPixels = avatarCtx.getImageData(0, 0, 32, 32);
        const charTex = makePixelTexture(36, 36, (ctx) => {
          ctx.fillStyle = "#25433f";
          for (let y = 0; y < 32; y++) {
            for (let x = 0; x < 32; x++) {
              if (avatarPixels.data[(y * 32 + x) * 4 + 3]! < 24) continue;
              for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) ctx.fillRect(x + ox + 2, y + oy + 2, 1, 1);
              }
            }
          }
          ctx.drawImage(avatarCanvas, 2, 2);
        });
        const charMat = new SpriteMaterial({ map: charTex, transparent: true, depthTest: true, alphaTest: 0.05, toneMapped: false });
        const charSprite = new Sprite(charMat);
        charSprite.scale.set(1.08, 1.08, 1);
        charSprite.center.set(0.5, 0);
        charSprite.position.y = 0;
        charSprite.userData = { profileId: profile.id };
        charSprite.renderOrder = 2;
        g.add(charSprite);

        const hoverMat = new SpriteMaterial({
          map: charTex,
          color: C_AQUA,
          transparent: true,
          opacity: 0,
          depthTest: true,
          depthWrite: false,
          alphaTest: 0.05,
          toneMapped: false,
        });
        const hoverSprite = new Sprite(hoverMat);
        hoverSprite.scale.set(1.22, 1.22, 1);
        hoverSprite.center.set(0.5, 0);
        hoverSprite.position.z = -0.015;
        hoverSprite.renderOrder = 1;
        g.add(hoverSprite);

        const shadowTex = makePixelTexture(32, 16, (ctx) => {
          ctx.fillStyle = "rgba(49,88,82,.9)";
          ctx.fillRect(7, 4, 18, 1);
          ctx.fillRect(4, 5, 24, 2);
          ctx.fillRect(2, 7, 28, 3);
          ctx.fillRect(5, 10, 22, 2);
          ctx.fillRect(9, 12, 14, 1);
          ctx.fillStyle = profile.color;
          ctx.fillRect(5, 6, 1, 1);
          ctx.fillRect(26, 9, 1, 1);
        });
        const shadowMat = new MeshBasicMaterial({
          map: shadowTex,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
          alphaTest: 0.04,
          side: DoubleSide,
          toneMapped: false,
        });
        const shadow = new Mesh(new PlaneGeometry(0.82, 0.46), shadowMat);
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.018;
        charGroup.add(shadow);

        // Name label sprite
        const name = profileDisplayName(profile);
        const labelTex = makePixelTexture(128, 24, (ctx) => {
          ctx.font = "700 11px 'Noto Sans JP', system-ui, sans-serif";
          const textWidth = Math.min(116, Math.ceil(ctx.measureText(name).width));
          const labelWidth = textWidth + 10;
          const left = Math.floor((128 - labelWidth) / 2);
          ctx.fillStyle = "#fff4d9";
          ctx.fillRect(left - 1, 3, labelWidth + 2, 18);
          ctx.fillStyle = "#25433f";
          ctx.fillRect(left, 4, labelWidth, 16);
          ctx.fillStyle = "#fff9e9";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(name, 64, 12, 116);
        });
        const labelMat = new SpriteMaterial({ map: labelTex, transparent: true, depthTest: false, toneMapped: false });
        const label = new Sprite(labelMat);
        label.scale.set(1.28, 0.24, 1);
        label.position.y = 1.12;
        label.center.set(0.5, 0);
        g.add(label);

        return { group: g, charSprite, hoverSprite, shadow, shadowMaterial: shadowMat, label };
      }

      type CharEntry = {
        group: ThreeGroup;
        charSprite: ThreeSprite;
        hoverSprite: ThreeSprite;
        shadow: InstanceType<typeof Mesh>;
        shadowMaterial: InstanceType<typeof MeshBasicMaterial>;
        label: ThreeSprite;
      };
      const charSprites = new Map<string, CharEntry>();
      for (const profile of profiles) {
        const entry = makeCharSprite(profile);
        charGroup.add(entry.group);
        charSprites.set(profile.id, entry);
      }


      /* ── Simulation ──────────────────────────────────────── */
      let simChars = createCharacters(world, orderedIds);
      const statusMap = new Map(profiles.map(p => [p.id, p.status]));

      /* ── Centrifugal force physics ─────────────────────────── */
      // Per-character physics state: offset from home position + velocity
      const charPhysics = new Map<string, { ox: number; oz: number; vx: number; vz: number; tumble: number }>();
      for (const p of profiles) {
        charPhysics.set(p.id, { ox: 0, oz: 0, vx: 0, vz: 0, tumble: 0 });
      }
      let prevAzimuth = Math.atan2(camera.position.x - cx, camera.position.z - cz);
      const CENTRIFUGAL_STRENGTH = 12.0;  // how hard characters get flung
      const SPRING_BACK = 3.0;           // spring constant pulling back to home
      const FRICTION = 4.0;              // velocity damping
      /* ── Raycaster ───────────────────────────────────────── */
      const raycaster = new Raycaster();
      const mouse = new Vector2(-9, -9);
      let hoveredId: string | null = null;
      let boardHovered = false;
      const boardTargets = [boardMesh, boardLabel, ...boardFrame];

      function getCharMeshes() {
        return [...charSprites.values()].map(c => c.charSprite);
      }

      function onPointerMove(e: PointerEvent) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      }

      function onPointerLeave() {
        mouse.set(-9, -9);
      }

      function onPointerDown(e: PointerEvent) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        // Check board click first
        const boardHits = raycaster.intersectObjects(boardTargets);
        if (boardHits.length > 0) {
          kanbanOverlayOpen.value = true;
          return;
        }
        const hits = raycaster.intersectObjects(getCharMeshes());
        if (hits.length > 0) {
          const pid = hits[0]!.object.userData.profileId as string;
          if (pid) activateRef.current(e as unknown as MouseEvent, pid);
        }
      }

      renderer.domElement.addEventListener("pointermove", onPointerMove);
      renderer.domElement.addEventListener("pointerleave", onPointerLeave);
      renderer.domElement.addEventListener("pointerdown", onPointerDown);

      /* ── Animation loop ──────────────────────────────────── */
      let lastTick = performance.now();
      let frameId = 0;

      function animate() {
        if (disposed) return;
        frameId = requestAnimationFrame(animate);
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastTick) / 1000);
        lastTick = now;

        // Tick simulation
        tickCharacters(world, simChars, statusMap, dt);

        // ── Centrifugal force from camera rotation ──
        const curAzimuth = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
        let dAzimuth = curAzimuth - prevAzimuth;
        // Wrap to [-PI, PI]
        if (dAzimuth > Math.PI) dAzimuth -= 2 * Math.PI;
        if (dAzimuth < -Math.PI) dAzimuth += 2 * Math.PI;
        prevAzimuth = curAzimuth;
        const angularVel = dAzimuth / Math.max(dt, 0.001); // rad/s
        const absOmega = Math.abs(angularVel);
        // Only apply centrifugal force when spinning fast enough
        const centrifugalActive = absOmega > 0.3;

        // Update character positions
        raycaster.setFromCamera(mouse, camera);
        const allCharMeshes = getCharMeshes();
        const hoverHits = raycaster.intersectObjects(allCharMeshes);
        const newHoveredId = hoverHits.length > 0 ? (hoverHits[0]!.object.userData.profileId as string ?? null) : null;
        const newBoardHovered = raycaster.intersectObjects(boardTargets).length > 0;

        for (const char of simChars) {
          const entry = charSprites.get(char.id);
          if (!entry) continue;
          const homeX = char.x / CELL;
          const homeZ = char.y / CELL;
          const phys = charPhysics.get(char.id);
          if (!phys) continue;

          if (centrifugalActive) {
            // Direction from rotation center to character (radial outward)
            const rx = homeX + phys.ox - controls.target.x;
            const rz = homeZ + phys.oz - controls.target.z;
            const rDist = Math.sqrt(rx * rx + rz * rz) || 1;
            // Centrifugal acceleration = omega^2 * r, directed outward
            const cForce = angularVel * angularVel * CENTRIFUGAL_STRENGTH;
            // Tangential component (Coriolis-like, perpendicular to radial)
            const tForce = angularVel * 2.0;
            phys.vx += (rx / rDist * cForce + (-rz / rDist) * tForce) * dt;
            phys.vz += (rz / rDist * cForce + (rx / rDist) * tForce) * dt;
            // Tumble effect
            phys.tumble += absOmega * dt * 3;
          }

          // Spring back toward home (0,0 offset)
          phys.vx += -phys.ox * SPRING_BACK * dt;
          phys.vz += -phys.oz * SPRING_BACK * dt;
          // Friction
          const frictionFactor = Math.max(0, 1 - FRICTION * dt);
          phys.vx *= frictionFactor;
          phys.vz *= frictionFactor;
          phys.tumble *= Math.max(0, 1 - 3.0 * dt);
          // Integrate position
          phys.ox += phys.vx * dt;
          phys.oz += phys.vz * dt;
          // Clamp to world bounds
          const maxOff = world.cols * 0.3;
          phys.ox = Math.max(-maxOff, Math.min(maxOff, phys.ox));
          phys.oz = Math.max(-maxOff, Math.min(maxOff, phys.oz));

          const wx = homeX + phys.ox;
          const wz = homeZ + phys.oz;
          const speed = Math.sqrt(phys.vx * phys.vx + phys.vz * phys.vz);
          const bob = char.moving ? Math.sin(now * 0.008) * 0.06 : Math.sin(now * 0.002 + char.x) * 0.02;
          // When flung, characters lift off the ground
          const lift = Math.min(speed * 0.15, 2.0);
          entry.group.position.set(wx, bob + lift, wz);
          entry.shadow.position.set(wx, 0.018, wz);
          // Tumble rotation when airborne
          entry.group.rotation.z = Math.sin(phys.tumble) * Math.min(speed * 0.1, 0.8);
          entry.group.rotation.x = Math.cos(phys.tumble * 0.7) * Math.min(speed * 0.08, 0.5);

          const isHovered = newHoveredId === char.id;
          const targetY = isHovered ? 0.08 : 0;
          entry.group.position.y += targetY + lift * 0.2;
          entry.shadowMaterial.opacity = isHovered ? 0.9 : 0.42;
          entry.hoverSprite.material.opacity = isHovered ? 0.76 : 0;
          const deskHighlight = deskHighlights.get(char.id);
          if (deskHighlight) {
            deskHighlight.surface.material.emissive.setHex(C_AQUA);
            deskHighlight.surface.material.emissiveIntensity = isHovered ? 0.32 : 0;
            deskHighlight.outlineMaterial.opacity = isHovered ? 0.94 : 0;
          }
          // Stretch effect when moving fast
          const stretch = 1 + Math.min(speed * 0.05, 0.4);
          const squash = 1 / Math.sqrt(stretch);
          const ts = isHovered ? 1.15 : 1.0;
          entry.charSprite.scale.set(1.08 * ts * squash, 1.08 * ts * stretch, 1);
          entry.hoverSprite.scale.set(1.22 * ts * squash, 1.22 * ts * stretch, 1);
          entry.label.scale.set(isHovered ? 1.42 : 1.28, isHovered ? 0.27 : 0.24, 1);
        }

        const hoverTargetChanged = newHoveredId !== hoveredId || newBoardHovered !== boardHovered;
        boardHovered = newBoardHovered;
        boardMat.emissive.setHex(C_AQUA);
        boardMat.emissiveIntensity = boardHovered ? 0.32 : 0;
        frameMat.emissive.setHex(C_AQUA);
        frameMat.emissiveIntensity = boardHovered ? 0.52 : 0.06;
        boardLabel.scale.setScalar(boardHovered ? 1.035 : 1);

        if (hoverTargetChanged) {
          hoveredId = newHoveredId;
          renderer.domElement.style.cursor = hoveredId || boardHovered ? "pointer" : "default";
        }

        // Subtle light animation
        warmLight1.intensity = 0.22 + Math.sin(now * 0.001) * 0.03;
        warmLight2.intensity = 0.18 + Math.cos(now * 0.0013) * 0.025;
        boardGlow.intensity = boardHovered ? 0.28 : 0.1 + Math.sin(now * 0.002) * 0.025;

        controls.update();
        renderer.render(scene, camera);
      }
      animate();

      /* ── Resize ──────────────────────────────────────────── */
      const resizeObs = new ResizeObserver(() => {
        const rw = container!.clientWidth;
        const rh = container!.clientHeight;
        if (rw === 0 || rh === 0) return;
        const a = rw / rh;
        const resizedFrustum = fitFrustum(a);
        camera.left = -resizedFrustum * a;
        camera.right = resizedFrustum * a;
        camera.top = resizedFrustum;
        camera.bottom = -resizedFrustum;
        camera.updateProjectionMatrix();
        renderer.setSize(rw, rh);
      });
      resizeObs.observe(container);

      /* ── Dispose ─────────────────────────────────────────── */
      threeRef.current = {
        dispose() {
          disposed = true;
          cancelAnimationFrame(frameId);
          clearTimeout(camSaveTimer);
          resizeObs.disconnect();
          renderer.domElement.removeEventListener("pointermove", onPointerMove);
          renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
          renderer.domElement.removeEventListener("pointerdown", onPointerDown);
          controls.removeEventListener("change", saveCamState);
          controls.dispose();
          disposeSceneResources();
          renderer.renderLists.dispose();
          renderer.dispose();
          if (renderer.domElement.parentElement === container) {
            container!.removeChild(renderer.domElement);
          }
        },
        updateProfiles(newProfiles: Profile[]) {
          statusMap.clear();
          for (const p of newProfiles) statusMap.set(p.id, p.status);
        }
      };
      } catch (err) {
        console.error("[3D] init error:", err);
      }
    }

    void init();

    return () => {
      disposed = true;
      threeRef.current?.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  // Update statuses without full rebuild
  useEffect(() => {
    threeRef.current?.updateProfiles(profiles);
  }, [profiles]);

  return (
    <>
      <div
        ref={containerRef}
        class="office-3d-container"
        aria-label={t("office.board")}
      />
      {kanbanOverlayOpen.value && (
        <div class="office-3d-kanban-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) kanbanOverlayOpen.value = false; }}>
          {/* Kanban's own page-title-row already carries the title, filters,
              sync, and add-task actions; only the close affordance lives
              in the overlay chrome to avoid a duplicate "Task board" heading. */}
          <button
            type="button"
            class="office-3d-kanban-close"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={() => { kanbanOverlayOpen.value = false; }}
          >×</button>
          <div class="office-3d-kanban-body">
            <KanbanBoard hideTitle />
          </div>
        </div>
      )}
    </>
  );
}
