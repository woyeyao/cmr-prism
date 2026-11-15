import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { AnatomyMesh, AnatomyModel, PlaneFrame } from "@/core/anatomy/types";
import { drawSections, enabledSection, getPlaneFrame, getSections, modelBounds, sectionDrawings, sectionExtent, type AnatomyRenderOptions, type RenderPlane } from "./rendering";

export interface AnatomyRuntime {
  update: (plane: RenderPlane, options: AnatomyRenderOptions, selectedId?: string | null) => void;
  setTheme: (theme: "light" | "dark") => void;
  setPlaneControl: (mode: PlaneControlMode) => void;
  resetView: () => void;
  alignView: () => void;
  flipView: () => void;
  zoomBy: (factor: number) => void;
  dispose: () => void;
}

export type PlaneControlMode = "translate" | "rotate" | null;

type BodyMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

/** The patient/specimen coordinates never move; only the camera and clip plane change. */
export function createAnatomyRuntime(
  host: HTMLDivElement, model: AnatomyModel,
  callbacks: { onHover: (mesh: AnatomyMesh | null) => void; onSelect: (id: string | null) => void; onUnavailable: () => void; onPlaneChange?: (frame: PlaneFrame) => void }
): AnatomyRuntime {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  const scene = new THREE.Scene();
  let failureControls: OrbitControls | undefined, failureObserver: ResizeObserver | undefined;
  let failureCompass: HTMLCanvasElement | undefined;
  let cancelFailedRender: (() => void) | undefined;
  let disposeFailedPlaneControl: (() => void) | undefined;
  try {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0b1921, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.localClippingEnabled = true;
  renderer.domElement.setAttribute("aria-label", "可旋转的三维心脏图谱");
  renderer.domElement.setAttribute("data-testid", "anatomy-webgl");
  renderer.domElement.style.touchAction = "none";
  host.prepend(renderer.domElement);

  const { center, span } = modelBounds(model);
  const camera = new THREE.OrthographicCamera(-span, span, span, -span, 0.1, span * 25);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  failureControls = controls;
  controls.enableDamping = false;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.minZoom = 0.35; controls.maxZoom = 5;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;
  controls.target.fromArray(center);
  const ambient = new THREE.HemisphereLight(0xe4f6ff, 0x686062, 1.65);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffeddf, 2.5);
  const rim = new THREE.DirectionalLight(0xa4c9eb, 1.8);
  scene.add(key, key.target, rim, rim.target);
  key.target.position.fromArray(center); rim.target.position.fromArray(center);
  rim.position.set(center[0] - span, center[1] + span, center[2] + span * 0.8);
  const clip = new THREE.Plane();
  const bodies: BodyMesh[] = [];
  for (const item of model.meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(item.positions, 3));
    geometry.setIndex(item.indices);
    geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: item.color, roughness: 0.66, metalness: 0.03, side: THREE.DoubleSide,
      emissive: item.color, emissiveIntensity: 0.025, clippingPlanes: [clip]
    });
    const body = new THREE.Mesh(geometry, material);
    body.userData.anatomy = item;
    bodies.push(body); scene.add(body);
  }

  const slice = new THREE.Group(); scene.add(slice);
  const capCanvas = document.createElement("canvas");
  capCanvas.width = capCanvas.height = 1536;
  const capContext = capCanvas.getContext("2d");
  if (!capContext) {
    throw new Error("二维切口画布不可用");
  }
  const capTexture = new THREE.CanvasTexture(capCanvas);
  capTexture.colorSpace = THREE.SRGBColorSpace;
  capTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const planeGeometry = new THREE.PlaneGeometry(2, 2);
  const capMaterial = new THREE.MeshBasicMaterial({
    map: capTexture, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide,
    depthWrite: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
  });
  const cap = new THREE.Mesh(planeGeometry, capMaterial);
  cap.renderOrder = 1; slice.add(cap);
  const sheetMaterial = new THREE.MeshBasicMaterial({
    color: 0x91d0c4, transparent: true, opacity: 0.055, side: THREE.DoubleSide, depthWrite: false
  });
  const sheet = new THREE.Mesh(planeGeometry, sheetMaterial);
  sheet.renderOrder = 2; slice.add(sheet);
  const edgeGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, -1, 0),
    new THREE.Vector3(1, 1, 0), new THREE.Vector3(-1, 1, 0), new THREE.Vector3(-1, -1, 0)
  ]);
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x8ed1c2, transparent: true, opacity: 0.8 });
  const edge = new THREE.Line(edgeGeometry, edgeMaterial); slice.add(edge);
  const compass = document.createElement("canvas");
  failureCompass = compass;
  compass.className = "anatomy-compass";
  compass.width = 224; compass.height = 176;
  compass.setAttribute("aria-hidden", "true");
  host.append(compass);
  const compassContext = compass.getContext("2d");
  let disposed = false, raf = 0, currentFrame: PlaneFrame | null = null;
  cancelFailedRender = () => { disposed = true; if (raf) cancelAnimationFrame(raf); };
  let currentTheme: "light" | "dark" = "dark";
  let currentOptions: AnatomyRenderOptions | null = null, selected: string | null = null, hovered: string | null = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const down = { x: 0, y: 0 };
  let planeControl: TransformControls | null = null;
  let planeProxy: THREE.Object3D | null = null;
  let pendingPlane: PlaneFrame | null = null, planeRaf = 0, suppressSelection = false;

  function syncPlaneProxy(frame: PlaneFrame) {
    if (!planeProxy || planeControl?.dragging) return;
    planeProxy.position.fromArray(frame.origin);
    planeProxy.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...frame.right), new THREE.Vector3(...frame.up), new THREE.Vector3(...frame.normal)
    ));
    planeProxy.updateMatrixWorld(true);
  }
  function flushPlaneChange() {
    if (planeRaf) cancelAnimationFrame(planeRaf);
    planeRaf = 0;
    const frame = pendingPlane; pendingPlane = null;
    if (frame && !disposed) callbacks.onPlaneChange?.(frame);
  }
  function planeObjectChanged() {
    if (disposed || !planeProxy || !planeControl?.dragging) return;
    const quaternion = planeProxy.quaternion.clone().normalize();
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
    const right = new THREE.Vector3().crossVectors(up, normal).normalize();
    up.crossVectors(normal, right).normalize();
    const frame: PlaneFrame = {
      origin: planeProxy.position.toArray(), normal: normal.toArray(), up: up.toArray(), right: right.toArray()
    };
    if (![...frame.origin, ...frame.normal, ...frame.up, ...frame.right].every(Number.isFinite)) return;
    pendingPlane = frame;
    // Coalesce pointer events without changing the cut independently of React's
    // single authoritative frame. Pointer-up flushes the final position.
    if (!planeRaf) planeRaf = requestAnimationFrame(flushPlaneChange);
    request();
  }
  function planeDraggingChanged() {
    const dragging = !!planeControl?.dragging;
    controls.enabled = !dragging;
    host.dataset.planeDragging = String(dragging);
    if (dragging) {
      suppressSelection = true;
      hovered = null; callbacks.onHover(null); updateHighlight();
    } else flushPlaneChange();
  }
  function planeAxisChanged() {
    host.dataset.planeAxis = planeControl?.axis ?? "none";
    if (planeControl?.axis && hovered) {
      hovered = null; callbacks.onHover(null); updateHighlight();
    }
  }
  function cancelPlaneDrag() {
    if (planeControl?.dragging) planeControl.pointerUp(null);
  }
  function disposePlaneControl() {
    if (planeRaf) cancelAnimationFrame(planeRaf);
    planeRaf = 0; pendingPlane = null;
    if (planeControl) {
      planeControl.removeEventListener("change", request);
      planeControl.removeEventListener("objectChange", planeObjectChanged);
      planeControl.removeEventListener("dragging-changed", planeDraggingChanged);
      planeControl.removeEventListener("axis-changed", planeAxisChanged);
      scene.remove(planeControl.getHelper());
      planeControl.detach(); planeControl.dispose(); planeControl = null;
    }
    if (planeProxy) { scene.remove(planeProxy); planeProxy = null; }
    renderer.domElement.removeEventListener("pointercancel", cancelPlaneDrag);
    renderer.domElement.removeEventListener("lostpointercapture", cancelPlaneDrag);
    window.removeEventListener("blur", cancelPlaneDrag);
    controls.enabled = true; suppressSelection = false;
    delete host.dataset.planeDragging;
    delete host.dataset.planeAxis;
    renderer.domElement.style.touchAction = "none";
  }
  disposeFailedPlaneControl = disposePlaneControl;
  function setPlaneControl(mode: PlaneControlMode) {
    if (disposed) return;
    if (!mode || !callbacks.onPlaneChange) { disposePlaneControl(); request(); return; }
    if (!planeControl) {
      planeProxy = new THREE.Object3D(); scene.add(planeProxy);
      planeControl = new TransformControls(camera, renderer.domElement);
      planeControl.setSpace("world"); planeControl.setSize(0.85);
      planeControl.attach(planeProxy); scene.add(planeControl.getHelper());
      planeControl.addEventListener("change", request);
      planeControl.addEventListener("objectChange", planeObjectChanged);
      planeControl.addEventListener("dragging-changed", planeDraggingChanged);
      planeControl.addEventListener("axis-changed", planeAxisChanged);
      renderer.domElement.addEventListener("pointercancel", cancelPlaneDrag);
      renderer.domElement.addEventListener("lostpointercapture", cancelPlaneDrag);
      window.addEventListener("blur", cancelPlaneDrag);
      // Run the gizmo's pointer-down before OrbitControls so a handle drag never
      // starts a camera gesture that could survive a lost pointer or window blur.
      controls.disconnect(); controls.connect(renderer.domElement);
      planeAxisChanged();
    }
    cancelPlaneDrag();
    planeControl.setMode(mode);
    if (currentFrame) syncPlaneProxy(currentFrame);
    request();
  }

  function drawCompass() {
    if (!compassContext) return;
    const ctx = compassContext;
    ctx.clearRect(0, 0, compass.width, compass.height);
    const matrix = camera.matrixWorldInverse;
    const names = model.space.axes === "LPS" ? ["X·L", "Y·P", "Z·S"] : ["X", "Y", "Z"];
    const colors = currentTheme === "light" ? ["#9b4036", "#386940", "#2d6291"] : ["#e7ab9f", "#b6ccb1", "#9fc5df"];
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    const entries = axes.map((axis, index) => ({ axis: axis.transformDirection(matrix), index })).sort((a, b) => a.axis.z - b.axis.z);
    ctx.font = "600 19px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const { axis, index } of entries) {
      ctx.strokeStyle = colors[index]; ctx.fillStyle = colors[index]; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(112, 88); ctx.lineTo(112 + axis.x * 44, 88 - axis.y * 44); ctx.stroke();
      ctx.fillText(names[index], 112 + axis.x * 64, 88 - axis.y * 64);
    }
  }

  function render() {
    raf = 0;
    if (disposed) return;
    key.position.copy(camera.position).add(new THREE.Vector3(-span * 0.4, 0, span * 0.5));
    camera.updateMatrixWorld();
    renderer.render(scene, camera); drawCompass();
  }
  function request() { if (!disposed && !raf) raf = requestAnimationFrame(render); }
  controls.addEventListener("change", request);
  function resize() {
    if (disposed) return;
    const { width, height } = host.getBoundingClientRect();
    if (width < 1 || height < 1) return;
    renderer.setSize(width, height, false);
    const aspect = width / height;
    const half = span * 0.61;
    camera.left = -half * Math.max(1, aspect); camera.right = -camera.left;
    camera.top = half * Math.max(1, 1 / aspect); camera.bottom = -camera.top;
    camera.updateProjectionMatrix(); request();
  }
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host);
  failureObserver = resizeObserver;
  function resetView() {
    controls.target.fromArray(center);
    const direction = model.space.axes === "LPS" ? new THREE.Vector3(-0.24, -1, 0.27) : new THREE.Vector3(0.6, -1, 0.45);
    camera.position.copy(controls.target).add(direction.normalize().multiplyScalar(span * 3));
    camera.up.set(0, 0, 1); camera.zoom = 1; camera.updateProjectionMatrix();
    camera.lookAt(controls.target); controls.update(); request();
  }
  function alignView() {
    if (!currentFrame || !currentOptions) return;
    const frame = currentFrame, options = currentOptions;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const include = (x: number, y: number) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    };
    // Fit the retained vertices and actual cut boundary, rather than assuming the
    // preset origin is the centre of the heart. This matters especially for scouts.
    for (const body of bodies) {
      if (!body.visible) continue;
      const positions = (body.userData.anatomy as AnatomyMesh).positions;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i] - frame.origin[0], y = positions[i + 1] - frame.origin[1], z = positions[i + 2] - frame.origin[2];
        if (body.material.clippingPlanes?.length && clip.normal.x * x + clip.normal.y * y + clip.normal.z * z < -1e-4) continue;
        include(x * frame.right[0] + y * frame.right[1] + z * frame.right[2], x * frame.up[0] + y * frame.up[1] + z * frame.up[2]);
      }
    }
    for (const section of getSections(model, frame)) {
      if (!enabledSection(section, options) || section.group === "cavity" && !options.showCavities) continue;
      for (const path of [...section.loops, ...section.paths]) for (const point of path) include(point[0], point[1]);
    }
    if (!Number.isFinite(minX)) {
      const extent = options.showPlane ? slice.scale.x : span / 2;
      include(-extent, -extent); include(extent, extent);
    }
    // Keep the plane's origin in view even when it is translated beyond the heart.
    if (options.showPlane) include(0, 0);
    controls.target.fromArray(frame.origin)
      .addScaledVector(new THREE.Vector3(...frame.right), (minX + maxX) / 2)
      .addScaledVector(new THREE.Vector3(...frame.up), (minY + maxY) / 2);
    const from = currentOptions.positive && !currentOptions.negative ? -1 : 1;
    camera.position.copy(controls.target).add(new THREE.Vector3(...frame.normal).multiplyScalar(span * 3 * from));
    camera.zoom = THREE.MathUtils.clamp(Math.min(
      (camera.right - camera.left) / (Math.max(span * 0.1, maxX - minX) * 1.18),
      (camera.top - camera.bottom) / (Math.max(span * 0.1, maxY - minY) * 1.18)
    ), controls.minZoom, controls.maxZoom);
    camera.updateProjectionMatrix();
    camera.up.fromArray(frame.up); camera.lookAt(controls.target); controls.update(); request();
  }
  function flipView() {
    const offset = camera.position.clone().sub(controls.target).negate();
    camera.position.copy(controls.target).add(offset); camera.lookAt(controls.target); controls.update(); request();
  }
  function zoomBy(factor: number) {
    camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom);
    camera.updateProjectionMatrix(); request();
  }
  function updateHighlight() {
    for (const body of bodies) {
      const id = (body.userData.anatomy as AnatomyMesh).id;
      body.material.emissiveIntensity = id === hovered ? 0.33 : id === selected ? 0.22 : 0.025;
    }
    request();
  }
  function hit(event: PointerEvent): AnatomyMesh | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    for (const intersection of raycaster.intersectObjects(bodies)) {
      const mesh = intersection.object as BodyMesh;
      if (!mesh.visible) continue;
      if (mesh.material.clippingPlanes?.length && clip.distanceToPoint(intersection.point) < -1e-4) continue;
      return mesh.userData.anatomy as AnatomyMesh;
    }
    return null;
  }
  function pointerMove(event: PointerEvent) {
    if (event.buttons || planeControl?.dragging || planeControl?.axis) return;
    const item = hit(event);
    if (hovered === (item?.id ?? null)) return;
    hovered = item?.id ?? null; callbacks.onHover(item); updateHighlight();
  }
  function pointerLeave() { hovered = null; callbacks.onHover(null); updateHighlight(); }
  function pointerDown(event: PointerEvent) { down.x = event.clientX; down.y = event.clientY; }
  function pointerUp(event: PointerEvent) {
    if (suppressSelection || planeControl?.dragging || planeControl?.axis) { suppressSelection = false; return; }
    if (event.button !== 0 || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    callbacks.onSelect(hit(event)?.id ?? null);
  }
  function doubleClick() { if (!planeControl?.axis && !planeControl?.dragging) resetView(); }
  function contextLost(event: Event) { event.preventDefault(); callbacks.onUnavailable(); }
  const canvas = renderer.domElement;
  canvas.addEventListener("pointermove", pointerMove); canvas.addEventListener("pointerleave", pointerLeave);
  canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("dblclick", doubleClick); canvas.addEventListener("webglcontextlost", contextLost);
  resetView(); resize();

  return {
    setTheme(theme) {
      if (disposed || currentTheme === theme) return;
      currentTheme = theme;
      // The transparent canvas exposes the matching CSS background. Only overlay
      // contrast changes; specimen colors, clipping and camera stay untouched.
      renderer.setClearColor(theme === "light" ? 0xe6eeeb : 0x0b1921, 0);
      sheetMaterial.color.setHex(theme === "light" ? 0x4d9d90 : 0x91d0c4);
      sheetMaterial.opacity = theme === "light" ? 0.045 : 0.055;
      edgeMaterial.color.setHex(theme === "light" ? 0x357c76 : 0x8ed1c2);
      request();
    },
    update(plane, options, selectedId) {
      if (disposed) return;
      const frame = getPlaneFrame(plane);
      currentFrame = frame; currentOptions = options; selected = selectedId ?? null;
      syncPlaneProxy(frame);
      const side = options.positive && options.negative ? 0 : options.positive ? 1 : -1;
      clip.normal.fromArray(frame.normal).multiplyScalar(side || 1);
      clip.constant = -clip.normal.dot(new THREE.Vector3(...frame.origin));
      for (const body of bodies) {
        const item = body.userData.anatomy as AnatomyMesh;
        body.visible = (options.positive || options.negative) && enabledSection(item, options) && (item.group !== "cavity" || options.showCavities);
        const oldCount = body.material.clippingPlanes?.length ?? 0;
        body.material.clippingPlanes = side === 0 ? [] : [clip];
        if (oldCount !== body.material.clippingPlanes.length) body.material.needsUpdate = true;
      }
      const sections = getSections(model, plane);
      const extent = sectionExtent(sections, model);
      const orientation = new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.right), new THREE.Vector3(...frame.up), new THREE.Vector3(...frame.normal));
      slice.quaternion.setFromRotationMatrix(orientation);
      slice.position.fromArray(frame.origin); slice.scale.set(extent, extent, 1);
      sheet.visible = edge.visible = options.showPlane;
      const ctx = capContext!;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, capCanvas.width, capCanvas.height);
      const factor = capCanvas.width / (2 * extent);
      ctx.setTransform(factor, 0, 0, -factor, capCanvas.width / 2, capCanvas.height / 2);
      drawSections(ctx, sectionDrawings(sections), options, factor, options.fill3D, selected, true);
      capTexture.needsUpdate = true;
      updateHighlight();
    },
    setPlaneControl, resetView, alignView, flipView, zoomBy,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      disposePlaneControl();
      resizeObserver.disconnect(); controls.removeEventListener("change", request); controls.dispose();
      canvas.removeEventListener("pointermove", pointerMove); canvas.removeEventListener("pointerleave", pointerLeave);
      canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("dblclick", doubleClick); canvas.removeEventListener("webglcontextlost", contextLost);
      for (const body of bodies) { body.geometry.dispose(); body.material.dispose(); }
      capTexture.dispose(); planeGeometry.dispose(); capMaterial.dispose(); sheetMaterial.dispose();
      edgeGeometry.dispose(); edgeMaterial.dispose(); renderer.dispose(); renderer.forceContextLoss();
      canvas.remove(); compass.remove();
    }
  };
  } catch (error) {
    cancelFailedRender?.();
    disposeFailedPlaneControl?.();
    failureControls?.dispose(); failureObserver?.disconnect(); failureCompass?.remove();
    scene.traverse(object => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if ("map" in material && material.map instanceof THREE.Texture) material.map.dispose();
        material.dispose();
      }
    });
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    throw error;
  }
}
