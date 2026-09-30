import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PlaneGeometry, ScalarFrame, Vec3, WindowLevel } from "../core/types";
import { planeCorners, planeNormal } from "../core/spaceTime";
import { grayscaleRgba } from "./grayscale";
import type { GlassItem } from "./GlassStage";

type RendererSurface = {
  domElement: HTMLCanvasElement;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
};

type WebGPUBackendResources = {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
  device?: { destroy(): void } | null;
  context?: { unconfigure(): void } | null;
  gl?: { getExtension(name: string): { loseContext(): void } | null } | null;
};

type DeviceLostInfo = { reason?: string | null; message?: string };

type RendererWithBackend = RendererSurface & {
  backend?: WebGPUBackendResources;
  onDeviceLost?: (info: DeviceLostInfo) => void;
  forceContextLoss?: () => void;
};

type RuntimeCallbacks = {
  onSelect(id: string): void;
  onInspect?(id: string): void;
  onUnavailable?(reason: string): void;
};

type RuntimeBackend = "WebGPU" | "WebGL2";

type ItemVisual = {
  atlas: THREE.Group;
  motion: THREE.Group;
  atlasEdges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  atlasImage: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  atlasLabel: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  atlasReflection: THREE.Group;
  cube: THREE.Group;
  cubeImage: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  cubeEdges: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  texture: THREE.DataTexture | null;
  labelTexture: THREE.CanvasTexture | null;
  labelCanvas: HTMLCanvasElement | null;
  geometryKey: string;
  item: GlassItem;
};

const ATLAS_CARD_WIDTH = 3.05;
const ATLAS_CARD_HEIGHT = 3.15;
const ATLAS_CARD_DEPTH = 0.12;
const ATLAS_IMAGE_WIDTH = 2.72;
const ATLAS_IMAGE_HEIGHT = 2.42;
const ATLAS_STACK_STEP = 0.46;
const MAX_PIXEL_RATIO = 1.75;
const POINTER_DRAG_THRESHOLD = 4;

function asThreeVector(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[1], value[2]);
}

function disposeRendererAndOwnedDevice(renderer: RendererSurface): void {
  const rendererWithBackend = renderer as RendererWithBackend;
  const backend = rendererWithBackend.backend;
  const ownsWebGPUDevice = backend?.isWebGPUBackend === true && backend.device != null;
  let intentionalDeviceDestroy = false;
  const onDeviceLost = rendererWithBackend.onDeviceLost;

  if (ownsWebGPUDevice && onDeviceLost) {
    rendererWithBackend.onDeviceLost = (info) => {
      if (intentionalDeviceDestroy && info.reason === "destroyed") return;
      onDeviceLost.call(rendererWithBackend, info);
    };
  }

  try {
    renderer.dispose();
  } catch {
    // Keep releasing the renderer-owned GPU device even if Three.js cleanup is partial.
  }

  if (ownsWebGPUDevice) {
    try {
      backend.context?.unconfigure();
    } catch {
      // A partially initialized WebGPU context may not be configurable yet.
    }
    intentionalDeviceDestroy = true;
    try {
      backend.device?.destroy();
    } catch {
      // Device teardown is best-effort after the renderer's resources have been disposed.
    }
    return;
  }

  if (rendererWithBackend.forceContextLoss) {
    try {
      rendererWithBackend.forceContextLoss();
    } catch {
      // WebGL context loss is best-effort after renderer resources are disposed.
    }
  } else if (backend?.isWebGLBackend) {
    try {
      backend.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // The WebGPU renderer's WebGL fallback may not expose the context-loss extension.
    }
  }
}

function numericKey(values: number[]): string {
  return values.map((value) => Number.isFinite(value) ? value.toPrecision(7) : "x").join(",");
}

function geometryKey(geometry?: PlaneGeometry): string {
  if (!geometry) return "none";
  return numericKey([
    ...geometry.origin,
    ...geometry.rowCosines,
    ...geometry.columnCosines,
    ...geometry.pixelSpacing,
    geometry.rows,
    geometry.columns,
    geometry.thickness
  ]) + `:${geometry.frameOfReferenceUid}`;
}

function createSoftShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 8, 64, 64, 62);
    gradient.addColorStop(0, "rgba(35, 45, 54, 0.22)");
    gradient.addColorStop(0.5, "rgba(35, 45, 54, 0.10)");
    gradient.addColorStop(1, "rgba(35, 45, 54, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function createGlassReflectionTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.32, "rgba(255,255,255,0.02)");
    gradient.addColorStop(0.47, "rgba(255,255,255,0.58)");
    gradient.addColorStop(0.54, "rgba(255,255,255,0.24)");
    gradient.addColorStop(0.72, "rgba(255,255,255,0.03)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function createLabelTexture(label: string, dark = false): { texture: THREE.CanvasTexture; canvas: HTMLCanvasElement } {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 64;
  drawLabel(canvas, label, dark);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, canvas };
}

function drawLabel(canvas: HTMLCanvasElement, label: string, dark = false): void {
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = dark ? "#dce8eb" : "#26323a";
    context.font = "600 25px Inter, ui-sans-serif, system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label.slice(0, 44), canvas.width / 2, canvas.height / 2, canvas.width - 16);
  }
}

function createDataTexture(frame: ScalarFrame, window: WindowLevel): THREE.DataTexture {
  const { descriptor, pixels } = frame;
  const rgba = grayscaleRgba(pixels, window, descriptor.photometric);
  const texture = new THREE.DataTexture(
    new Uint8Array(rgba),
    descriptor.columns,
    descriptor.rows,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function updateDataTexture(texture: THREE.DataTexture, frame: ScalarFrame, window: WindowLevel): boolean {
  const { descriptor, pixels } = frame;
  const rgba = grayscaleRgba(pixels, window, descriptor.photometric);
  const image = texture.image as { data: Uint8Array; width: number; height: number };
  const expectedLength = descriptor.rows * descriptor.columns * 4;
  if (image.width !== descriptor.columns || image.height !== descriptor.rows || image.data.length !== expectedLength) {
    return false;
  }
  image.data.set(rgba);
  texture.needsUpdate = true;
  return true;
}

function getFrameAspect(frame: ScalarFrame | null): number {
  if (!frame || frame.descriptor.rows < 1) return 1;
  return frame.descriptor.columns / frame.descriptor.rows;
}

function fitImage(width: number, height: number, maxWidth: number, maxHeight: number): [number, number] {
  const scale = Math.min(maxWidth / Math.max(width, 1e-6), maxHeight / Math.max(height, 1e-6));
  return [width * scale, height * scale];
}

function lpsRotation(): THREE.Matrix4 {
  // A single rigid patient-space orientation used for every plane and bound.
  // LPS maps to a conventional right/up/toward-camera scene basis.
  return new THREE.Matrix4().set(
    -1, 0, 0, 0,
    0, 0, 1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1
  );
}

function planeCenter(geometry: PlaneGeometry): THREE.Vector3 {
  const row = asThreeVector(geometry.rowCosines);
  const column = asThreeVector(geometry.columnCosines);
  const [rowSpacing, columnSpacing] = geometry.pixelSpacing;
  return asThreeVector(geometry.origin)
    .addScaledVector(row, (geometry.columns - 1) * columnSpacing / 2)
    .addScaledVector(column, (geometry.rows - 1) * rowSpacing / 2);
}

function dimensionsFor(geometry: PlaneGeometry): [number, number] {
  return [
    Math.max(0.1, geometry.columns * geometry.pixelSpacing[1]),
    Math.max(0.1, geometry.rows * geometry.pixelSpacing[0])
  ];
}

/** Map DICOM column-right / row-down coordinates onto a right-handed image plane. */
function orientedPlaneQuaternion(geometry: PlaneGeometry, patientToWorld: THREE.Matrix4): THREE.Quaternion {
  const right = asThreeVector(geometry.rowCosines).normalize().transformDirection(patientToWorld);
  const normal = asThreeVector(planeNormal(geometry)).negate().normalize().transformDirection(patientToWorld);
  const up = normal.clone().cross(right).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
}

function hasUsableGeometry(geometry?: PlaneGeometry): geometry is PlaneGeometry {
  return Boolean(
    geometry && geometry.rows > 0 && geometry.columns > 0 &&
    geometry.pixelSpacing[0] > 0 && geometry.pixelSpacing[1] > 0 &&
    geometry.rowCosines.every(Number.isFinite) && geometry.columnCosines.every(Number.isFinite) &&
    geometry.origin.every(Number.isFinite)
  );
}

function hasPatientGeometry(geometry?: PlaneGeometry): geometry is PlaneGeometry {
  return hasUsableGeometry(geometry) && geometry.frameOfReferenceUid.trim().length > 0;
}

export class GlassRuntime {
  readonly backend: RuntimeBackend;
  readonly renderer: RendererSurface;
  readonly canvas: HTMLCanvasElement;

  private readonly host: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.05, 1000);
  private readonly controls: OrbitControls;
  private readonly visuals = new Map<string, ItemVisual>();
  private readonly world = new THREE.Group();
  private readonly atlasRoot = new THREE.Group();
  private readonly cubeRoot = new THREE.Group();
  private readonly shadowGeometry = new THREE.PlaneGeometry(3.2, 3.0);
  private readonly shadowTexture: THREE.CanvasTexture;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private readonly reflectionGeometry = new THREE.PlaneGeometry(0.05, 2.72);
  private readonly reflectionTexture: THREE.CanvasTexture;
  private readonly reflectionMaterial: THREE.MeshBasicMaterial;
  private readonly cardGeometry: RoundedBoxGeometry;
  private readonly cardEdgeGeometry: THREE.EdgesGeometry;
  private readonly glassMaterial: THREE.MeshBasicMaterial;
  private readonly cardEdgeMaterial: THREE.LineBasicMaterial;
  private readonly atlasImageGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly atlasImageMaterial: THREE.MeshBasicMaterial;
  private readonly cubeImageMaterial: THREE.MeshBasicMaterial;
  private readonly cubeEdgeMaterial = new THREE.LineBasicMaterial({ color: 0x7d8993, transparent: true, opacity: 0.76 });
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly lpsToWorld = lpsRotation();
  private readonly worldBounds = new THREE.Box3();
  private readonly boundsHelper = new THREE.Box3Helper(this.worldBounds, 0xabb4bc);
  private readonly axisGroup = new THREE.Group();
  private readonly axisTextures: THREE.CanvasTexture[] = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly motionQuery: MediaQueryList | null;
  private callbacks: RuntimeCallbacks;
  private mode: "atlas" | "cube" = "atlas";
  private theme: "light" | "dark" = "light";
  private atlasSpacing = ATLAS_STACK_STEP;
  private activeId: string | undefined;
  private hoveredId: string | undefined;
  private animationFrame = 0;
  private inspectTimer: number | null = null;
  private disposed = false;
  private dragOrigin: { x: number; y: number } | null = null;
  private dragPointerId: number | null = null;
  private dragged = false;
  private atlasLayoutKey = "";
  private lastCubeGeometryKey = "";
  private cubeFrameOfReference: string | null = null;
  private pendingInspectId: string | undefined;
  private defaultPosition = new THREE.Vector3(0, 7.8, 13.4);
  private defaultTarget = new THREE.Vector3(0, 0, 0);
  private readonly onPointerMove = (event: PointerEvent) => this.handlePointerMove(event);
  private readonly onPointerDown = (event: PointerEvent) => this.handlePointerDown(event);
  private readonly onPointerUp = (event: PointerEvent) => this.handlePointerUp(event);
  private readonly onPointerCancel = (event: PointerEvent) => this.handlePointerCancel(event);
  private readonly onPointerLeave = () => this.handlePointerLeave();
  private readonly onDoubleClick = (event: MouseEvent) => this.handleDoubleClick(event);
  private readonly onContextMenu = (event: MouseEvent) => event.preventDefault();
  private readonly onMotionPreferenceChange = () => {
    this.controls.enableDamping = !this.motionQuery?.matches;
  };
  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.failRenderer("图形上下文已丢失。二维影像仍可继续浏览。");
  };

  private constructor(host: HTMLElement, renderer: RendererSurface, backend: RuntimeBackend, callbacks: RuntimeCallbacks) {
    this.host = host;
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    this.backend = backend;
    this.callbacks = callbacks;
    this.motionQuery = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    this.canvas.className = "glass-canvas";
    this.canvas.setAttribute("aria-label", "CMR 玻璃切片场景");
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.canvas.style.touchAction = "none";
    this.host.prepend(this.canvas);

    this.shadowTexture = createSoftShadowTexture();
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      map: this.shadowTexture,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      toneMapped: false
    });
    this.reflectionTexture = createGlassReflectionTexture();
    this.reflectionMaterial = new THREE.MeshBasicMaterial({
      map: this.reflectionTexture,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide
    });
    this.cardGeometry = new RoundedBoxGeometry(ATLAS_CARD_WIDTH, ATLAS_CARD_HEIGHT, ATLAS_CARD_DEPTH, 5, 0.11);
    this.cardEdgeGeometry = new THREE.EdgesGeometry(this.cardGeometry, 18);
    this.glassMaterial = new THREE.MeshBasicMaterial({
      color: 0xf8fcfc,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide
    });
    this.cardEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xaac4c5, transparent: true, opacity: 0.56 });
    this.atlasImageMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false });
    this.cubeImageMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      toneMapped: false
    });

    this.camera.position.copy(this.defaultPosition);
    this.camera.lookAt(this.defaultTarget);
    this.scene.background = new THREE.Color(0xffffff);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc7ced3, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(-4, 9, 7);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xe5edf3, 0.55);
    fill.position.set(7, 2, -5);
    this.scene.add(fill);
    this.scene.add(this.world);
    this.world.add(this.atlasRoot, this.cubeRoot);
    const boundsMaterial = this.boundsHelper.material as THREE.LineBasicMaterial;
    boundsMaterial.transparent = true;
    boundsMaterial.opacity = 0.54;
    this.cubeRoot.add(this.boundsHelper, this.axisGroup);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = !this.motionQuery?.matches;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = true;
    this.controls.enableZoom = false;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN
    };
    this.controls.rotateSpeed = 0.56;
    this.controls.panSpeed = 0.8;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 150;
    this.controls.target.copy(this.defaultTarget);
    this.controls.update();

    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.motionQuery?.addEventListener("change", this.onMotionPreferenceChange);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  static async create(host: HTMLElement, callbacks: RuntimeCallbacks): Promise<GlassRuntime> {
    let renderer: RendererSurface | null = null;
    let backend: RuntimeBackend = "WebGL2";
    let gpuFailure: unknown;

    if (typeof navigator !== "undefined" && "gpu" in navigator) {
      const canvas = document.createElement("canvas");
      let webgpu: WebGPURenderer | null = null;
      try {
        webgpu = new WebGPURenderer({ canvas, antialias: true, alpha: false });
        await webgpu.init();
        const gpuRenderer = webgpu as unknown as RendererWithBackend;
        const onDeviceLost = gpuRenderer.onDeviceLost;
        if (onDeviceLost) {
          gpuRenderer.onDeviceLost = (info) => {
            onDeviceLost.call(gpuRenderer, info);
            callbacks.onUnavailable?.(`WebGPU 设备已丢失：${info.message || info.reason || "未知原因"}`);
          };
        }
        renderer = webgpu;
        backend = (webgpu.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "WebGPU" : "WebGL2";
      } catch (error) {
        gpuFailure = error;
        if (webgpu) disposeRendererAndOwnedDevice(webgpu);
        canvas.remove();
      }
    }

    if (!renderer) {
      const canvas = document.createElement("canvas");
      try {
        renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          alpha: false,
          powerPreference: "low-power"
        });
        backend = "WebGL2";
      } catch (error) {
        canvas.remove();
        const detail = error instanceof Error ? error.message : String(error);
        const gpuDetail = gpuFailure instanceof Error ? ` WebGPU: ${gpuFailure.message}` : "";
        throw new Error(`无法创建 WebGPU 或 WebGL2 玻璃场景。${detail}${gpuDetail}`);
      }
    }

    try {
      return new GlassRuntime(host, renderer, backend, callbacks);
    } catch (error) {
      disposeRendererAndOwnedDevice(renderer);
      renderer.domElement.remove();
      throw error;
    }
  }

  setCallbacks(callbacks: RuntimeCallbacks): void {
    this.callbacks = callbacks;
  }

  update(items: GlassItem[], mode: "atlas" | "cube", activeId?: string, atlasSpacing = ATLAS_STACK_STEP, theme: "light" | "dark" = "light"): void {
    if (this.disposed) return;
    const previousMode = this.mode;
    const nextIds = new Set(items.map((item) => item.id));
    for (const [id, visual] of this.visuals) {
      if (!nextIds.has(id)) {
        this.releaseVisual(visual);
        this.atlasRoot.remove(visual.atlas);
        this.cubeRoot.remove(visual.cube);
        this.visuals.delete(id);
      }
    }

    const ids = items.map((item) => item.id);
    this.setTheme(theme);
    this.atlasSpacing = atlasSpacing;
    const nextLayoutKey = `${atlasSpacing}:${ids.join("|")}`;
    for (const item of items) {
      let visual = this.visuals.get(item.id);
      if (!visual) {
        visual = this.createVisual(item);
        this.visuals.set(item.id, visual);
        this.atlasRoot.add(visual.atlas);
        this.cubeRoot.add(visual.cube);
      }
      this.updateVisual(visual, item);
    }

    this.mode = mode;
    this.activeId = activeId;
    this.atlasRoot.visible = mode === "atlas";
    this.cubeRoot.visible = mode === "cube";
    this.controls.enableRotate = true;
    this.controls.enablePan = mode === "atlas";
    this.controls.enableZoom = false;

    const layoutChanged = nextLayoutKey !== this.atlasLayoutKey;
    if (layoutChanged) {
      this.layoutAtlas(ids);
      this.atlasLayoutKey = nextLayoutKey;
    } else if (mode === "atlas" && previousMode !== "atlas") {
      this.resetCamera();
    }

    const cubeKey = items.map((item) => `${item.id}:${geometryKey(item.geometry ?? item.frame?.descriptor.geometry)}`).join("|");
    if (mode === "cube" && (cubeKey !== this.lastCubeGeometryKey || previousMode !== "cube")) {
      this.layoutCube(items);
      this.lastCubeGeometryKey = cubeKey;
    }

    for (const [id, visual] of this.visuals) {
      const isActive = id === activeId || visual.item.selected === true;
      const hovered = id === this.hoveredId || id === this.pendingInspectId;
      visual.atlas.scale.setScalar(1);
      visual.atlasEdges.material.opacity = isActive || hovered ? 0.85 : 0.5;
      const geometry = visual.item.geometry ?? visual.item.frame?.descriptor.geometry;
      visual.cube.visible = mode === "cube" && hasPatientGeometry(geometry) && geometry.frameOfReferenceUid === this.cubeFrameOfReference;
    }
    this.refreshAtlasLift();
  }

  private setTheme(theme: "light" | "dark"): void {
    if (this.theme === theme) return;
    this.theme = theme;
    this.scene.background = new THREE.Color(theme === "dark" ? 0x11171e : 0xffffff);
    this.glassMaterial.color.set(theme === "dark" ? 0x263542 : 0xf8fcfc);
    this.glassMaterial.opacity = theme === "dark" ? 0.72 : 0.86;
    this.cardEdgeMaterial.color.set(theme === "dark" ? 0x819eaa : 0xaac4c5);
    for (const visual of this.visuals.values()) {
      visual.atlasEdges.material.color.copy(this.cardEdgeMaterial.color);
      if (visual.labelCanvas && visual.labelTexture) {
        drawLabel(visual.labelCanvas, visual.item.label, theme === "dark");
        visual.labelTexture.needsUpdate = true;
      }
    }
  }

  zoomBy(factor: number): void {
    if (this.disposed || !Number.isFinite(factor) || factor <= 0) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    if (offset.lengthSq() > 0) offset.setLength(distance);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  resetCamera(): void {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    this.camera.position.copy(this.defaultPosition);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(this.defaultTarget);
    this.controls.saveState();
    this.controls.reset();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationFrame);
    if (this.inspectTimer !== null) window.clearTimeout(this.inspectTimer);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.motionQuery?.removeEventListener("change", this.onMotionPreferenceChange);
    for (const visual of this.visuals.values()) this.releaseVisual(visual);
    this.visuals.clear();
    this.clearAxisGroup();
    this.shadowGeometry.dispose();
    this.shadowTexture.dispose();
    this.shadowMaterial.dispose();
    this.reflectionGeometry.dispose();
    this.reflectionTexture.dispose();
    this.reflectionMaterial.dispose();
    this.cardGeometry.dispose();
    this.cardEdgeGeometry.dispose();
    this.glassMaterial.dispose();
    this.cardEdgeMaterial.dispose();
    this.atlasImageGeometry.dispose();
    this.atlasImageMaterial.dispose();
    this.cubeImageMaterial.dispose();
    this.cubeEdgeMaterial.dispose();
    this.boundsHelper.geometry.dispose();
    if (Array.isArray(this.boundsHelper.material)) this.boundsHelper.material.forEach((material) => material.dispose());
    else this.boundsHelper.material.dispose();
    disposeRendererAndOwnedDevice(this.renderer);
    this.canvas.remove();
  }

  private createVisual(item: GlassItem): ItemVisual {
    const atlas = new THREE.Group();
    atlas.userData.itemId = item.id;
    const motion = new THREE.Group();
    motion.userData.velocity = new THREE.Vector3();
    motion.userData.targetLift = new THREE.Vector3();
    atlas.add(motion);

    const shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
    shadow.position.set(0, 0, -(ATLAS_CARD_DEPTH / 2 + 0.08));
    motion.add(shadow);

    const body = new THREE.Mesh(this.cardGeometry, this.glassMaterial);
    body.userData.itemId = item.id;
    body.castShadow = false;
    body.receiveShadow = false;
    motion.add(body);
    const atlasEdges = new THREE.LineSegments(this.cardEdgeGeometry, this.cardEdgeMaterial.clone());
    motion.add(atlasEdges);

    const imageMaterial = this.atlasImageMaterial.clone();
    const atlasImage = new THREE.Mesh(this.atlasImageGeometry, imageMaterial);
    atlasImage.position.set(0, 0.11, ATLAS_CARD_DEPTH / 2 + 0.003);
    atlasImage.userData.itemId = item.id;
    motion.add(atlasImage);

    const atlasLabel = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.21), new THREE.MeshBasicMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      depthWrite: false
    }));
    atlasLabel.position.set(0, -1.42, ATLAS_CARD_DEPTH / 2 + 0.003);
    atlasLabel.renderOrder = 3;
    atlasLabel.userData.itemId = item.id;
    motion.add(atlasLabel);

    const atlasReflection = new THREE.Group();
    for (const x of [-1.455, 1.455]) {
      const edgeReflection = new THREE.Mesh(this.reflectionGeometry, this.reflectionMaterial);
      edgeReflection.position.set(x, 0.08, ATLAS_CARD_DEPTH / 2 + 0.012);
      edgeReflection.renderOrder = 2;
      atlasReflection.add(edgeReflection);
    }
    motion.add(atlasReflection);

    const cube = new THREE.Group();
    cube.userData.itemId = item.id;
    const cubeImageMaterial = this.cubeImageMaterial.clone();
    const cubeImage = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cubeImageMaterial);
    cubeImage.userData.itemId = item.id;
    cube.add(cubeImage);
    const seedCubeGeometry = new THREE.PlaneGeometry(1, 1);
    const cubeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(seedCubeGeometry), this.cubeEdgeMaterial.clone());
    seedCubeGeometry.dispose();
    cubeEdges.userData.itemId = item.id;
    cube.add(cubeEdges);

    return {
      atlas,
      motion,
      atlasEdges,
      atlasImage,
      atlasLabel,
      atlasReflection,
      cube,
      cubeImage,
      cubeEdges,
      texture: null,
      labelTexture: null,
      labelCanvas: null,
      geometryKey: "",
      item
    };
  }

  private updateVisual(visual: ItemVisual, item: GlassItem): void {
    visual.item = item;
    const geometry = item.geometry ?? item.frame?.descriptor.geometry;
    const newGeometryKey = geometryKey(geometry);
    if (newGeometryKey !== visual.geometryKey) {
      visual.geometryKey = newGeometryKey;
      this.updateCubePlane(visual, geometry);
    }

    const aspect = getFrameAspect(item.frame);
    const [atlasWidth, atlasHeight] = fitImage(aspect, 1, ATLAS_IMAGE_WIDTH, ATLAS_IMAGE_HEIGHT);
    visual.atlasImage.scale.set(atlasWidth, atlasHeight, 1);
    if (item.frame) {
      const { frame, window } = item;
      if (!visual.texture) {
        visual.texture = createDataTexture(frame, window);
        (visual.atlasImage.material as THREE.MeshBasicMaterial).map = visual.texture;
        (visual.cubeImage.material as THREE.MeshBasicMaterial).map = visual.texture;
        (visual.atlasImage.material as THREE.MeshBasicMaterial).needsUpdate = true;
        (visual.cubeImage.material as THREE.MeshBasicMaterial).needsUpdate = true;
      } else if (!updateDataTexture(visual.texture, frame, window)) {
        visual.texture.dispose();
        visual.texture = createDataTexture(frame, window);
        (visual.atlasImage.material as THREE.MeshBasicMaterial).map = visual.texture;
        (visual.cubeImage.material as THREE.MeshBasicMaterial).map = visual.texture;
        (visual.atlasImage.material as THREE.MeshBasicMaterial).needsUpdate = true;
        (visual.cubeImage.material as THREE.MeshBasicMaterial).needsUpdate = true;
      }
      visual.atlasImage.visible = true;
      visual.cubeImage.visible = true;
    } else {
      visual.atlasImage.visible = false;
      visual.cubeImage.visible = false;
    }

    if (!visual.labelTexture || !visual.labelCanvas) {
      const label = createLabelTexture(item.label, this.theme === "dark");
      visual.labelTexture = label.texture;
      visual.labelCanvas = label.canvas;
      visual.labelCanvas.dataset.label = item.label;
      (visual.atlasLabel.material as THREE.MeshBasicMaterial).map = label.texture;
      (visual.atlasLabel.material as THREE.MeshBasicMaterial).needsUpdate = true;
    } else if (visual.labelCanvas.dataset.label !== item.label) {
      drawLabel(visual.labelCanvas, item.label, this.theme === "dark");
      visual.labelCanvas.dataset.label = item.label;
      visual.labelTexture.needsUpdate = true;
    }

    visual.atlas.userData.itemId = item.id;
    const body = visual.motion.children[1] as THREE.Mesh;
    body.userData.itemId = item.id;
    visual.cube.userData.itemId = item.id;
  }

  private updateCubePlane(visual: ItemVisual, geometry?: PlaneGeometry): void {
    if (!hasUsableGeometry(geometry)) {
      visual.cube.visible = false;
      return;
    }
    const [width, height] = dimensionsFor(geometry);
    const oldImageGeometry = visual.cubeImage.geometry;
    const oldEdgeGeometry = visual.cubeEdges.geometry;
    visual.cubeImage.geometry = new THREE.PlaneGeometry(width, height);
    visual.cubeEdges.geometry = new THREE.EdgesGeometry(visual.cubeImage.geometry);
    oldImageGeometry.dispose();
    oldEdgeGeometry.dispose();

    visual.cube.quaternion.copy(orientedPlaneQuaternion(geometry, new THREE.Matrix4()));
    visual.cube.position.copy(planeCenter(geometry));
    visual.cubeImage.position.set(0, 0, 0.002);
    visual.cubeEdges.position.set(0, 0, 0.003);
    visual.cube.visible = true;
  }

  private layoutAtlas(ids: string[]): void {
    const count = ids.length;
    if (!count) return;
    ids.forEach((id, index) => {
      const visual = this.visuals.get(id);
      if (!visual) return;
      visual.atlas.position.set(0, 0, (index - (count - 1) / 2) * this.atlasSpacing);
    });
    this.atlasRoot.position.set(0, 0, 0);
    // Leave headroom for upward extraction while fitting the resting stack.
    this.defaultTarget.set(0, 0.85, 0);
    const fit = Math.max(1.14, (count - 1) * this.atlasSpacing / 4.8);
    this.defaultPosition.set(4.4 * fit, 4.6 * fit + 0.85, 8.3 * fit);
    if (this.mode === "atlas") this.resetCamera();
  }

  private setAtlasLift(visual: ItemVisual, isActive: boolean, hovered: boolean): void {
    const target = visual.motion.userData.targetLift as THREE.Vector3;
    // Extract vertically in its original stack slot; never reorder depth.
    target.set(0, hovered ? 2.35 : isActive ? 1.9 : 0, 0);
  }

  private refreshAtlasLift(): void {
    // One extraction owner: a new hover/click lowers the previously raised card.
    const liftedId = [this.pendingInspectId, this.hoveredId, this.activeId,
      [...this.visuals.values()].find((visual) => visual.item.selected)?.item.id]
      .find((id) => id && this.visuals.has(id));
    for (const [id, visual] of this.visuals) {
      this.setAtlasLift(visual, id === liftedId, id === liftedId && (id === this.hoveredId || id === this.pendingInspectId));
    }
  }

  private layoutCube(items: GlassItem[]): void {
    this.worldBounds.makeEmpty();
    const cornersWorld: THREE.Vector3[] = [];
    const geometries = items
      .map((item) => item.geometry ?? item.frame?.descriptor.geometry)
      .filter(hasPatientGeometry);
    this.cubeFrameOfReference = geometries[0]?.frameOfReferenceUid ?? null;
    for (const item of items) {
      const geometry = item.geometry ?? item.frame?.descriptor.geometry;
      if (!hasPatientGeometry(geometry) || geometry.frameOfReferenceUid !== this.cubeFrameOfReference) continue;
      const corners = planeCorners(geometry);
      for (const corner of corners) {
        // spaceTime.planeCorners supplies the outer pixel edges in patient LPS.
        const point = asThreeVector(corner).applyMatrix4(this.lpsToWorld);
        cornersWorld.push(point);
        this.worldBounds.expandByPoint(point);
      }
    }
    if (this.worldBounds.isEmpty()) {
      this.cubeRoot.visible = false;
      return;
    }

    const center = this.worldBounds.getCenter(new THREE.Vector3());
    const size = this.worldBounds.getSize(new THREE.Vector3());
    const largest = Math.max(size.x, size.y, size.z, 1);
    const scale = 11.5 / largest;
    const transform = new THREE.Matrix4()
      .makeTranslation(-center.x * scale, -center.y * scale, -center.z * scale)
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
      .multiply(this.lpsToWorld);

    // The same global affine transform is applied to every plane and every corner.
    for (const visual of this.visuals.values()) {
      const geometry = visual.item.geometry ?? visual.item.frame?.descriptor.geometry;
      if (!hasPatientGeometry(geometry) || geometry.frameOfReferenceUid !== this.cubeFrameOfReference) {
        visual.cube.visible = false;
        continue;
      }
      visual.cube.position.copy(planeCenter(geometry)).applyMatrix4(transform);
      visual.cube.quaternion.copy(orientedPlaneQuaternion(geometry, this.lpsToWorld));
      visual.cube.scale.setScalar(scale);
    }

    const transformedBounds = new THREE.Box3();
    for (const corner of cornersWorld) transformedBounds.expandByPoint(corner.sub(center).multiplyScalar(scale));
    this.worldBounds.copy(transformedBounds);
    this.boundsHelper.updateMatrixWorld(true);
    this.clearAxisGroup();
    this.addPatientAxes();

    this.defaultTarget.set(0, 0, 0);
    const diagonal = transformedBounds.getSize(new THREE.Vector3()).length();
    const fitDistance = Math.max(4, (diagonal / 2 / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.18);
    const viewDirection = new THREE.Vector3(0.48, 0.38, 0.79).normalize();
    this.defaultPosition.copy(viewDirection.multiplyScalar(fitDistance));
    this.camera.near = Math.max(0.01, fitDistance / 1000);
    this.camera.far = Math.max(100, fitDistance * 8);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(this.defaultTarget);
    this.controls.minDistance = Math.max(2, fitDistance * 0.16);
    this.controls.maxDistance = Math.max(40, fitDistance * 5);
    this.resetCamera();
  }

  private addPatientAxes(): void {
    const extent = this.worldBounds.getSize(new THREE.Vector3());
    const origin = new THREE.Vector3(
      this.worldBounds.min.x - extent.x * 0.13,
      this.worldBounds.min.y - extent.y * 0.13,
      this.worldBounds.min.z - extent.z * 0.13
    );
    const axisLength = Math.max(0.7, Math.min(1.8, extent.length() * 0.15));
    const patientAxes: Array<[string, Vec3]> = [
      ["L", [1, 0, 0]],
      ["P", [0, 1, 0]],
      ["S", [0, 0, 1]]
    ];
    const colors = [0x8f9ba4, 0x788690, 0x667680];
    patientAxes.forEach(([label, patientDirection], index) => {
      const direction = asThreeVector(patientDirection).transformDirection(this.lpsToWorld).normalize();
      const start = origin.clone();
      const end = start.clone().addScaledVector(direction, axisLength);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([start, end]), new THREE.LineBasicMaterial({ color: colors[index], transparent: true, opacity: 0.86 }));
      this.axisGroup.add(line);
      const spriteTexture = this.createAxisLabel(label, colors[index]);
      this.axisTextures.push(spriteTexture);
      const spriteMaterial = new THREE.SpriteMaterial({ map: spriteTexture, transparent: true, depthTest: false, toneMapped: false });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.position.copy(end);
      sprite.scale.set(0.48, 0.34, 1);
      this.axisGroup.add(sprite);
    });
    this.axisGroup.position.set(0, 0, 0);
  }

  private clearAxisGroup(): void {
    for (const child of this.axisGroup.children) {
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material.dispose();
      } else if (child instanceof THREE.Sprite) {
        child.material.dispose();
      }
    }
    this.axisGroup.clear();
    for (const texture of this.axisTextures) texture.dispose();
    this.axisTextures.length = 0;
  }

  private createAxisLabel(label: string, color: number): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 72;
    const context = canvas.getContext("2d");
    if (context) {
      context.clearRect(0, 0, 96, 72);
      context.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
      context.font = "700 52px Inter, ui-sans-serif, system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, 48, 37);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private releaseVisual(visual: ItemVisual): void {
    visual.texture?.dispose();
    visual.labelTexture?.dispose();
    (visual.atlasImage.material as THREE.Material).dispose();
    visual.atlasEdges.material.dispose();
    (visual.atlasLabel.geometry as THREE.BufferGeometry).dispose();
    (visual.atlasLabel.material as THREE.Material).dispose();
    (visual.cubeImage.geometry as THREE.BufferGeometry).dispose();
    (visual.cubeImage.material as THREE.Material).dispose();
    (visual.cubeEdges.geometry as THREE.BufferGeometry).dispose();
    (visual.cubeEdges.material as THREE.Material).dispose();
  }

  private resize(): void {
    if (this.disposed) return;
    const bounds = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.animationFrame = requestAnimationFrame(this.animate);
    for (const visual of this.visuals.values()) {
      const motion = visual.motion;
      const target = motion.userData.targetLift as THREE.Vector3;
      const velocity = motion.userData.velocity as THREE.Vector3;
      const position = motion.position;
      if (this.motionQuery?.matches) {
        position.copy(target);
        velocity.set(0, 0, 0);
        continue;
      }
      const deltaX = target.x - position.x;
      const deltaY = target.y - position.y;
      const deltaZ = target.z - position.z;
      velocity.set(
        (velocity.x + deltaX * 0.09) * 0.78,
        (velocity.y + deltaY * 0.09) * 0.78,
        (velocity.z + deltaZ * 0.09) * 0.78
      );
      position.add(velocity);
      if (Math.abs(deltaX) < 0.0008 && Math.abs(deltaY) < 0.0008 && Math.abs(deltaZ) < 0.0008 && velocity.lengthSq() < 0.000002) {
        position.copy(target);
        velocity.set(0, 0, 0);
      }
    }
    this.controls.update();
    try {
      this.renderer.render(this.scene, this.camera);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.failRenderer(`三维场景渲染失败：${detail}`);
    }
  };

  private failRenderer(reason: string): void {
    if (this.disposed) return;
    this.callbacks.onUnavailable?.(reason);
    this.dispose();
  }

  private intersectedItem(event: PointerEvent | MouseEvent): string | undefined {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const root = this.mode === "atlas" ? this.atlasRoot : this.cubeRoot;
    const hits = this.raycaster.intersectObjects(root.children, true);
    for (const hit of hits) {
      let object: THREE.Object3D | null = hit.object;
      while (object && object !== root) {
        const id = object.userData.itemId as string | undefined;
        if (id) return id;
        object = object.parent;
      }
    }
    return undefined;
  }

  private handlePointerMove(event: PointerEvent): void {
    if (this.dragOrigin && event.pointerId === this.dragPointerId) {
      const dx = event.clientX - this.dragOrigin.x;
      const dy = event.clientY - this.dragOrigin.y;
      if (Math.hypot(dx, dy) >= POINTER_DRAG_THRESHOLD) this.dragged = true;
    }
    const id = !this.dragged && this.mode === "atlas" ? this.intersectedItem(event) : undefined;
    this.setHovered(id);
    if (this.dragged) this.canvas.style.cursor = "grabbing";
  }

  private setHovered(id?: string): void {
    this.canvas.style.cursor = id ? "pointer" : this.mode === "cube" ? "grab" : "default";
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.refreshAtlasLift();
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.dragPointerId !== null) return;
    if (this.inspectTimer !== null) window.clearTimeout(this.inspectTimer);
    this.inspectTimer = null;
    this.pendingInspectId = undefined;
    this.refreshAtlasLift();
    this.dragOrigin = { x: event.clientX, y: event.clientY };
    this.dragPointerId = event.pointerId;
    this.dragged = false;
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.dragPointerId !== event.pointerId) return;
    const dx = event.clientX - (this.dragOrigin?.x ?? event.clientX);
    const dy = event.clientY - (this.dragOrigin?.y ?? event.clientY);
    const wasDragged = this.dragged || Math.hypot(dx, dy) >= POINTER_DRAG_THRESHOLD;
    this.dragOrigin = null;
    this.dragPointerId = null;
    this.dragged = false;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    if (wasDragged || event.button !== 0) {
      this.setHovered(event.button === 0 && this.mode === "atlas" ? this.intersectedItem(event) : undefined);
      return;
    }
    const id = this.intersectedItem(event);
    if (!id) return;
    if (this.mode === "cube") {
      this.callbacks.onSelect(id);
      return;
    }
    this.callbacks.onSelect(id);
    if (this.callbacks.onInspect) {
      if (this.inspectTimer !== null) window.clearTimeout(this.inspectTimer);
      this.pendingInspectId = id;
      this.refreshAtlasLift();
      this.inspectTimer = window.setTimeout(() => {
        this.inspectTimer = null;
        if (this.disposed) return;
        this.pendingInspectId = undefined;
        this.callbacks.onInspect?.(id);
      }, 260);
    }
  }

  private handlePointerCancel(event: PointerEvent): void {
    if (this.dragPointerId !== event.pointerId) return;
    this.dragOrigin = null;
    this.dragPointerId = null;
    this.dragged = false;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.setHovered(undefined);
  }

  private handlePointerLeave(): void {
    if (this.dragPointerId !== null) return;
    this.setHovered(undefined);
  }

  private handleDoubleClick(event: MouseEvent): void {
    if (this.mode !== "cube") return;
    const id = this.intersectedItem(event);
    if (id) this.callbacks.onInspect?.(id);
  }
}

export async function createGlassRuntime(host: HTMLElement, callbacks: RuntimeCallbacks): Promise<GlassRuntime> {
  return GlassRuntime.create(host, callbacks);
}
