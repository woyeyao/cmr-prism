import {
  frameIndexAtPhase,
  mergeCollections,
  phaseAt,
  splitCollection,
} from "./spaceTime";
import { setManualView } from "./viewInference";
import { FIT_IMAGE, normalizeImageTransform } from "./imageTransform";
import type {
  CmrCollection,
  ImageTransform,
  CmrPlane,
  PlaneGeometry,
  PlaneSelection,
  StudyCatalog,
  ViewLabel,
  ViewerCursor,
  ViewerState,
  ViewportState,
  WindowLevel,
} from "./types";

export type ViewerAction =
  | { type: "load"; catalog: StudyCatalog }
  | { type: "mode"; mode: ViewerState["mode"] }
  | { type: "layout"; count: 2 | 3 | 4 }
  | { type: "active"; viewportId: string }
  | { type: "collection"; viewportId: string; collectionId: string }
  | { type: "plane"; viewportId: string; index: number }
  | { type: "frame"; viewportId: string; index: number }
  | { type: "step"; axis: "time" | "space"; delta: number }
  | { type: "tick" }
  | { type: "playing"; playing: boolean }
  | { type: "fps"; fps: number }
  | { type: "window"; viewportId: string; window: WindowLevel }
  | { type: "resetWindow"; viewportId: string }
  | { type: "link"; viewportId: string; linked: boolean }
  | { type: "note"; frameId: string; text: string }
  | { type: "atlasCount"; count: number }
  | { type: "atlasSpacing"; spacing: number }
  | { type: "imageTransform"; viewportId: string; transform: ImageTransform }
  | { type: "inspectViewport"; viewportId: string }
  | { type: "returnToSplit" }
  | { type: "selectPlane"; viewportId: string }
  | { type: "removePlane"; selectionId: string }
  | { type: "activateSelection"; selectionId: string }
  | { type: "relabel"; collectionId: string; view: ViewLabel }
  | { type: "merge"; collectionIds: string[] }
  | { type: "splitCollection"; collectionId: string };

const VIEWPORT_IDS = ["viewport-0", "viewport-1", "viewport-2", "viewport-3"] as const;
const PREFERRED_VIEWS: ViewLabel[] = ["SAX", "2CH", "3CH", "4CH"];
const MIN_FPS = 1;
const MAX_FPS = 60;
const MIN_ATLAS_COUNT = 1;
const MAX_ATLAS_COUNT = 20;
const GEOMETRY_TOLERANCE = 1e-4;

export function initialViewerState(): ViewerState {
  return {
    catalog: null,
    mode: "atlas",
    splitCount: 4,
    viewports: VIEWPORT_IDS.map((id) => ({
      id,
      cursor: { collectionId: "", planeIndex: 0, frameIndex: 0 },
      linked: false,
      window: { center: 0, width: 1 },
      imageTransform: { ...FIT_IMAGE },
    })),
    activeViewportId: VIEWPORT_IDS[0],
    selectedPlanes: [],
    notes: {},
    playing: false,
    playbackFps: 25,
    phase: 0,
    atlasCount: 7,
    atlasSpacing: 0.46,
    inspectionOrigin: null,
  };
}

export function getActiveViewport(state: ViewerState): ViewportState | undefined {
  return state.viewports.find((viewport) => viewport.id === state.activeViewportId);
}

/**
 * Resolve the selected cube planes against the shared cardiac phase. A source
 * gap stays a gap: frameIndexAtPhase returns the sparse timeline slot, and the
 * consumer can then resolve it to a null descriptor without silently skipping.
 */
export function getSelectedCursors(state: ViewerState): ViewportState[] {
  if (!state.catalog) return [];
  return state.selectedPlanes.flatMap((selection) => {
    const collection = getCollection(state.catalog!, selection.collectionId);
    const plane = collection?.planes[selection.planeIndex];
    if (!collection || !plane) return [];

    const samePlaneViewport = state.viewports.find(
      (viewport) =>
        viewport.cursor.collectionId === collection.id &&
        viewport.cursor.planeIndex === selection.planeIndex,
    );
    let frameIndex = 0;
    if (collection.kind === "cine" && collection.phaseMatching !== "none") {
      frameIndex = frameIndexAtPhase(collection, selection.planeIndex, state.phase);
      if (frameIndex < 0) frameIndex = 0;
    } else if (samePlaneViewport && collection.kind !== "cine") {
      frameIndex = clampIndex(samePlaneViewport.cursor.frameIndex, plane.frameIds.length);
    } else if (samePlaneViewport && collection.kind === "cine") {
      frameIndex = clampIndex(samePlaneViewport.cursor.frameIndex, plane.frameIds.length);
    }

    return [{
      id: `cube:${selection.id}`,
      cursor: { collectionId: collection.id, planeIndex: selection.planeIndex, frameIndex },
      linked: false,
      window: selection.window,
    }];
  });
}

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  if (!state || !action || typeof action !== "object") return state;
  switch (action.type) {
    case "load":
      return isCatalog(action.catalog) ? loadCatalog(action.catalog) : state;
    case "mode":
      if (!isMode(action.mode)) return state;
      if (action.mode === "cube" && state.selectedPlanes.length < 2) return state;
      if (state.mode === action.mode) return state;
      return { ...state, mode: action.mode, inspectionOrigin: action.mode === "inspect" && state.mode === "split" ? "split" : null };
    case "layout":
      return isSplitCount(action.count) ? { ...state, splitCount: action.count } : state;
    case "active":
      return state.viewports.some((viewport) => viewport.id === action.viewportId)
        ? { ...state, activeViewportId: action.viewportId }
        : state;
    case "collection":
      return changeCollection(state, action.viewportId, action.collectionId);
    case "plane":
      return changePlane(state, action.viewportId, action.index);
    case "frame":
      return changeFrame(state, action.viewportId, action.index, true);
    case "step":
      return step(state, action.axis, action.delta);
    case "tick":
      return tick(state);
    case "playing":
      return typeof action.playing === "boolean" ? setPlaying(state, action.playing) : state;
    case "fps":
      return Number.isFinite(action.fps)
        ? { ...state, playbackFps: Math.min(MAX_FPS, Math.max(MIN_FPS, action.fps)) }
        : state;
    case "window":
      return setWindow(state, action.viewportId, action.window);
    case "resetWindow":
      return resetWindow(state, action.viewportId);
    case "link":
      return setLink(state, action.viewportId, action.linked);
    case "note":
      return setNote(state, action.frameId, action.text);
    case "atlasCount":
      return Number.isInteger(action.count)
        ? { ...state, atlasCount: Math.min(MAX_ATLAS_COUNT, Math.max(MIN_ATLAS_COUNT, action.count)) }
        : state;
    case "atlasSpacing":
      return Number.isFinite(action.spacing) ? { ...state, atlasSpacing: Math.max(0.16, Math.min(1.4, action.spacing)) } : state;
    case "imageTransform": {
      const viewport = getViewport(state, action.viewportId);
      return viewport ? replaceViewport(state, { ...viewport, imageTransform: normalizeImageTransform(action.transform) }) : state;
    }
    case "inspectViewport": {
      const viewport = state.viewports.slice(0, state.splitCount).find((item) => item.id === action.viewportId);
      if (!state.catalog || state.mode !== "split" || !viewport) return state;
      return { ...state, mode: "inspect", activeViewportId: viewport.id, inspectionOrigin: "split" };
    }
    case "returnToSplit":
      return state.mode === "inspect" && state.inspectionOrigin === "split"
        ? { ...state, mode: "split", inspectionOrigin: null }
        : state;
    case "selectPlane":
      return togglePlaneSelection(state, action.viewportId);
    case "removePlane":
      return removePlaneSelection(state, action.selectionId);
    case "activateSelection":
      return activateSelection(state, action.selectionId);
    case "relabel":
      return relabel(state, action.collectionId, action.view);
    case "merge":
      return merge(state, action.collectionIds);
    case "splitCollection":
      return split(state, action.collectionId);
    default:
      return state;
  }
}

function isCatalog(value: StudyCatalog | null | undefined): value is StudyCatalog {
  return Boolean(value && typeof value.id === "string" && Array.isArray(value.collections) && value.frames);
}

function isMode(value: unknown): value is ViewerState["mode"] {
  return value === "atlas" || value === "inspect" || value === "split" || value === "cube";
}

function isSplitCount(value: unknown): value is 2 | 3 | 4 {
  return value === 2 || value === 3 || value === 4;
}

function getCollection(catalog: StudyCatalog, id: string): CmrCollection | undefined {
  return catalog.collections.find((collection) => collection.id === id);
}

function getViewport(state: ViewerState, id: string): ViewportState | undefined {
  return state.viewports.find((viewport) => viewport.id === id);
}

function loadCatalog(catalog: StudyCatalog): ViewerState {
  const state = initialViewerState();
  const anchor = chooseAnchor(catalog);
  const chosen = chooseViewportCollections(catalog, anchor);
  const viewports = VIEWPORT_IDS.map((id, index) => {
    const collection = chosen[index];
    if (!collection) return state.viewports[index];
    const planeIndex = initialPlaneIndex(collection);
    const frameIndex = initialFrameIndex(collection, planeIndex);
    return {
      ...state.viewports[index],
      cursor: { collectionId: collection.id, planeIndex, frameIndex },
      linked: canSharePhase(collection),
      window: collection.defaultWindow,
    };
  });
  const first = viewports[0];
  const firstCollection = getCollection(catalog, first.cursor.collectionId);
  const firstPhase = firstCollection
    ? phaseAt(firstCollection, first.cursor.planeIndex, first.cursor.frameIndex)
    : Number.NaN;
  return {
    ...state,
    catalog,
    viewports,
    phase: Number.isFinite(firstPhase) ? normalizePhase(firstPhase) : 0,
  };
}

function chooseAnchor(catalog: StudyCatalog): CmrCollection | undefined {
  const collections = catalog.collections;
  const bySize = (a: CmrCollection, b: CmrCollection) => frameCount(b) - frameCount(a);
  return (
    collections.filter((collection) => collection.kind === "cine" && collection.view === "SAX").sort(bySize)[0] ??
    collections.filter((collection) => collection.kind === "cine").sort(bySize)[0] ??
    [...collections].sort(bySize)[0]
  );
}

function chooseViewportCollections(
  catalog: StudyCatalog,
  anchor: CmrCollection | undefined,
): Array<CmrCollection | undefined> {
  if (!anchor) return [undefined, undefined, undefined, undefined];
  const selected: CmrCollection[] = [anchor];
  const anchorFrameOfReference = anchor.planes.find((plane) => plane.geometry?.frameOfReferenceUid.trim())
    ?.geometry?.frameOfReferenceUid;
  for (const view of PREFERRED_VIEWS) {
    if (selected.length >= VIEWPORT_IDS.length) break;
    if (selected.some((item) => item.view === view)) continue;
    const match = catalog.collections
      .filter((collection) =>
        collection.view === view &&
        collection.kind === "cine" &&
        collection.studyUid === anchor.studyUid &&
        anchorFrameOfReference !== undefined &&
        collection.planes.some((plane) => plane.geometry?.frameOfReferenceUid === anchorFrameOfReference),
      )
      .sort((a, b) => frameCount(b) - frameCount(a))[0];
    if (match) selected.push(match);
  }
  const sameSpaceCine = (collection: CmrCollection) =>
    collection.kind === "cine" &&
    collection.studyUid === anchor.studyUid &&
    anchorFrameOfReference !== undefined &&
    collection.planes.some((plane) => plane.geometry?.frameOfReferenceUid === anchorFrameOfReference);
  for (const collection of [...catalog.collections].sort((a, b) =>
    Number(sameSpaceCine(b)) - Number(sameSpaceCine(a)) || frameCount(b) - frameCount(a),
  )) {
    if (selected.length >= VIEWPORT_IDS.length) break;
    if (!selected.some((item) => item.id === collection.id)) selected.push(collection);
  }
  while (selected.length < VIEWPORT_IDS.length) selected.push(anchor);
  return selected.slice(0, VIEWPORT_IDS.length);
}

function frameCount(collection: CmrCollection): number {
  return collection.planes.reduce(
    (sum, plane) => sum + plane.frameIds.reduce((count, id) => count + Number(id !== null), 0),
    0,
  );
}

function initialPlaneIndex(collection: CmrCollection): number {
  return collection.planes.length > 0 ? Math.floor((collection.planes.length - 1) / 2) : 0;
}

function initialFrameIndex(collection: CmrCollection, planeIndex: number): number {
  const plane = collection.planes[planeIndex];
  if (!plane || plane.frameIds.length === 0) return 0;
  const firstAvailable = plane.frameIds.findIndex((id) => id !== null);
  return firstAvailable < 0 ? 0 : firstAvailable;
}

function canSharePhase(collection: CmrCollection | undefined): boolean {
  return collection?.kind === "cine" && collection.phaseMatching !== "none";
}

function changeCollection(state: ViewerState, viewportId: string, collectionId: string): ViewerState {
  if (!state.catalog) return state;
  const viewport = getViewport(state, viewportId);
  const collection = getCollection(state.catalog, collectionId);
  if (!viewport || !collection) return state;
  const planeIndex = initialPlaneIndex(collection);
  const frameIndex = frameForPhase(collection, planeIndex, state.phase) ?? initialFrameIndex(collection, planeIndex);
  const nextViewport: ViewportState = {
    ...viewport,
    cursor: { collectionId, planeIndex, frameIndex },
    linked: canSharePhase(collection),
    window: collection.defaultWindow,
    imageTransform: { ...FIT_IMAGE },
  };
  return replaceViewport(state, nextViewport, { playing: false });
}

function changePlane(state: ViewerState, viewportId: string, planeIndex: number): ViewerState {
  if (!state.catalog || !Number.isInteger(planeIndex)) return state;
  const viewport = getViewport(state, viewportId);
  const collection = viewport && getCollection(state.catalog, viewport.cursor.collectionId);
  if (!viewport || !collection || !collection.planes[planeIndex]) return state;
  if (planeIndex === viewport.cursor.planeIndex) return state;
  const frameIndex = frameForPhase(collection, planeIndex, state.phase) ??
    clampIndex(viewport.cursor.frameIndex, collection.planes[planeIndex].frameIds.length);
  let next = replaceViewport(state, {
    ...viewport,
    cursor: { ...viewport.cursor, planeIndex, frameIndex },
  });
  if (state.mode !== "cube") return next;

  const selectedIndex = state.selectedPlanes.findIndex(
    (selection) =>
      selection.collectionId === viewport.cursor.collectionId &&
      selection.planeIndex === viewport.cursor.planeIndex,
  );
  if (selectedIndex < 0) return next;
  const targetGeometry = collection.planes[planeIndex].geometry;
  const oldSelection = state.selectedPlanes[selectedIndex];
  const duplicatesAnotherSlot = state.selectedPlanes.some(
    (selection, index) =>
      index !== selectedIndex && selection.collectionId === collection.id && selection.planeIndex === planeIndex,
  );
  // In cube mode the active selected plane follows layer navigation when the
  // target remains geometrically compatible and unique. Otherwise the cube
  // keeps the prior selected plane fixed while the viewport cursor moves.
  if (!isValidGeometry(targetGeometry) || duplicatesAnotherSlot || !canJoinSelections(state, collection, targetGeometry)) {
    return next;
  }
  const selectedPlanes = [...state.selectedPlanes];
  selectedPlanes[selectedIndex] = {
    ...oldSelection,
    id: selectionKey(collection.id, planeIndex),
    collectionId: collection.id,
    planeIndex,
  };
  next = { ...next, selectedPlanes };
  return next;
}

function changeFrame(state: ViewerState, viewportId: string, frameIndex: number, manual: boolean): ViewerState {
  if (!state.catalog || !Number.isInteger(frameIndex)) return state;
  const viewport = getViewport(state, viewportId);
  const collection = viewport && getCollection(state.catalog, viewport.cursor.collectionId);
  const plane = collection?.planes[viewport!.cursor.planeIndex];
  if (!viewport || !collection || !plane || frameIndex < 0 || frameIndex >= plane.frameIds.length) return state;

  let next: ViewerState = replaceViewport(state, {
    ...viewport,
    cursor: { ...viewport.cursor, frameIndex },
  }, manual ? { playing: false } : undefined);
  if (collection.kind !== "cine" || collection.phaseMatching === "none") return next;

  const phase = phaseAt(collection, viewport.cursor.planeIndex, frameIndex);
  if (!Number.isFinite(phase)) return next;
  next = { ...next, phase: normalizePhase(phase) };
  if (viewport.linked) next = syncLinkedCine(next, viewportId, next.phase);
  return next;
}

function step(state: ViewerState, axis: "time" | "space", delta: number): ViewerState {
  if ((axis !== "time" && axis !== "space") || !Number.isFinite(delta)) return state;
  const amount = Math.trunc(delta);
  if (amount === 0) return state;
  const viewport = getActiveViewport(state);
  if (!state.catalog || !viewport) return state;
  const collection = getCollection(state.catalog, viewport.cursor.collectionId);
  if (!collection) return state;
  if (axis === "space") {
    const planes = collection.planes.length;
    if (planes === 0) return state;
    const planeIndex = Math.min(planes - 1, Math.max(0, viewport.cursor.planeIndex + amount));
    if (planeIndex === viewport.cursor.planeIndex) return state;
    return changePlane(state, viewport.id, planeIndex);
  }

  const plane = collection.planes[viewport.cursor.planeIndex];
  if (!plane || plane.frameIds.length === 0) return state.playing ? { ...state, playing: false } : state;
  const index = modulo(viewport.cursor.frameIndex + amount, plane.frameIds.length);
  return changeFrame(state, viewport.id, index, true);
}

function tick(state: ViewerState): ViewerState {
  if (!state.playing) return state;
  const viewport = getActiveViewport(state);
  const collection = state.catalog && viewport
    ? getCollection(state.catalog, viewport.cursor.collectionId)
    : undefined;
  const plane = collection?.planes[viewport!.cursor.planeIndex];
  if (!viewport || !collection || collection.kind !== "cine" || !plane || plane.frameIds.length === 0) {
    return { ...state, playing: false };
  }
  const index = modulo(viewport.cursor.frameIndex + 1, plane.frameIds.length);
  return changeFrame(state, viewport.id, index, false);
}

function setPlaying(state: ViewerState, playing: boolean): ViewerState {
  if (playing !== true) return state.playing ? { ...state, playing: false } : state;
  const viewport = getActiveViewport(state);
  const collection = state.catalog && viewport
    ? getCollection(state.catalog, viewport.cursor.collectionId)
    : undefined;
  const plane = collection?.planes[viewport!.cursor.planeIndex];
  if (!collection || collection.kind !== "cine" || !plane || plane.frameIds.length < 2) return state;
  return { ...state, playing: true };
}

function syncLinkedCine(state: ViewerState, sourceId: string, phase: number): ViewerState {
  if (!state.catalog) return state;
  let changed = false;
  const viewports = state.viewports.map((viewport) => {
    if (viewport.id === sourceId || !viewport.linked) return viewport;
    const collection = getCollection(state.catalog!, viewport.cursor.collectionId);
    if (!collection || collection.kind !== "cine" || collection.phaseMatching === "none") return viewport;
    const plane = collection.planes[viewport.cursor.planeIndex];
    const frameIndex = frameIndexAtPhase(collection, viewport.cursor.planeIndex, phase);
    if (!plane || frameIndex < 0 || frameIndex >= plane.frameIds.length || frameIndex === viewport.cursor.frameIndex) {
      return viewport;
    }
    changed = true;
    return { ...viewport, cursor: { ...viewport.cursor, frameIndex } };
  });
  return changed ? { ...state, viewports } : state;
}

function frameForPhase(collection: CmrCollection, planeIndex: number, phase: number): number | undefined {
  if (collection.kind !== "cine" || collection.phaseMatching === "none") return undefined;
  const frameIndex = frameIndexAtPhase(collection, planeIndex, phase);
  const plane = collection.planes[planeIndex];
  return plane && frameIndex >= 0 && frameIndex < plane.frameIds.length ? frameIndex : undefined;
}

function setWindow(state: ViewerState, viewportId: string, window: WindowLevel): ViewerState {
  if (!isWindow(window)) return state;
  const viewport = getViewport(state, viewportId);
  if (!viewport) return state;
  let next = replaceViewport(state, { ...viewport, window: { ...window } });
  const selectedPlanes = next.selectedPlanes.map((selection) =>
    selection.collectionId === viewport.cursor.collectionId && selection.planeIndex === viewport.cursor.planeIndex
      ? { ...selection, window: { ...window } }
      : selection,
  );
  if (selectedPlanes.some((selection, index) => selection !== next.selectedPlanes[index])) {
    next = { ...next, selectedPlanes };
  }
  return next;
}

function resetWindow(state: ViewerState, viewportId: string): ViewerState {
  if (!state.catalog) return state;
  const viewport = getViewport(state, viewportId);
  const collection = viewport && getCollection(state.catalog, viewport.cursor.collectionId);
  if (!viewport || !collection) return state;
  return setWindow(state, viewportId, collection.defaultWindow);
}

function isWindow(value: WindowLevel | null | undefined): value is WindowLevel {
  return Boolean(value && Number.isFinite(value.center) && Number.isFinite(value.width) && value.width > 0);
}

function setLink(state: ViewerState, viewportId: string, linked: boolean): ViewerState {
  if (!state.catalog || typeof linked !== "boolean") return state;
  const viewport = getViewport(state, viewportId);
  const collection = viewport && getCollection(state.catalog, viewport.cursor.collectionId);
  if (!viewport || !collection) return state;
  const canLink = collection.kind === "cine" && collection.phaseMatching !== "none";
  if (viewport.linked === (linked && canLink)) return state;
  return replaceViewport(state, { ...viewport, linked: linked && canLink });
}

function setNote(state: ViewerState, frameId: string, text: string): ViewerState {
  if (!state.catalog || typeof frameId !== "string" || typeof text !== "string") return state;
  if (!Object.prototype.hasOwnProperty.call(state.catalog.frames, frameId)) return state;
  if (text.length === 0) {
    if (!Object.prototype.hasOwnProperty.call(state.notes, frameId)) return state;
    const notes = { ...state.notes };
    delete notes[frameId];
    return { ...state, notes };
  }
  if (state.notes[frameId] === text) return state;
  return { ...state, notes: { ...state.notes, [frameId]: text } };
}

function togglePlaneSelection(state: ViewerState, viewportId: string): ViewerState {
  if (!state.catalog) return state;
  const viewport = getViewport(state, viewportId);
  const collection = viewport && getCollection(state.catalog, viewport.cursor.collectionId);
  const plane = collection?.planes[viewport!.cursor.planeIndex];
  if (!viewport || !collection || !plane || !isValidGeometry(plane.geometry)) return state;
  const selectionId = selectionKey(collection.id, viewport.cursor.planeIndex);
  const existing = state.selectedPlanes.find((selection) => selection.id === selectionId);
  if (existing) return removePlaneSelection(state, selectionId);
  if (state.selectedPlanes.length >= 5 || !canJoinSelections(state, collection, plane.geometry)) return state;
  const selection: PlaneSelection = {
    id: selectionId,
    collectionId: collection.id,
    planeIndex: viewport.cursor.planeIndex,
    window: { ...viewport.window },
  };
  return { ...state, selectedPlanes: [...state.selectedPlanes, selection] };
}

function selectionKey(collectionId: string, planeIndex: number): string {
  return `plane:${encodeURIComponent(JSON.stringify([collectionId, planeIndex]))}`;
}

function canJoinSelections(state: ViewerState, collection: CmrCollection, geometry: PlaneGeometry): boolean {
  if (!state.catalog) return false;
  if (state.selectedPlanes.length === 0) return true;
  return state.selectedPlanes.every((selection) => {
    const selectedCollection = getCollection(state.catalog!, selection.collectionId);
    const selectedGeometry = selectedCollection?.planes[selection.planeIndex]?.geometry;
    return Boolean(
      selectedCollection &&
      selectedCollection.studyUid === collection.studyUid &&
      isValidGeometry(selectedGeometry) &&
      selectedGeometry.frameOfReferenceUid === geometry.frameOfReferenceUid,
    );
  });
}

function isValidGeometry(geometry: PlaneGeometry | undefined): geometry is PlaneGeometry {
  if (!geometry || !geometry.frameOfReferenceUid.trim()) return false;
  if (!Number.isFinite(geometry.rows) || !Number.isFinite(geometry.columns) || geometry.rows <= 0 || geometry.columns <= 0) {
    return false;
  }
  if (geometry.pixelSpacing.some((value) => !Number.isFinite(value) || value <= 0)) return false;
  if (![...geometry.origin, ...geometry.rowCosines, ...geometry.columnCosines].every(Number.isFinite)) return false;
  const rowLength = vectorLength(geometry.rowCosines);
  const columnLength = vectorLength(geometry.columnCosines);
  return rowLength > 1e-6 && columnLength > 1e-6 && vectorLength(cross(geometry.rowCosines, geometry.columnCosines)) > 1e-6;
}

function removePlaneSelection(state: ViewerState, selectionId: string): ViewerState {
  const selectedPlanes = state.selectedPlanes.filter((selection) => selection.id !== selectionId);
  if (selectedPlanes.length === state.selectedPlanes.length) return state;
  const mode = state.mode === "cube" && selectedPlanes.length < 2 ? "inspect" : state.mode;
  return { ...state, selectedPlanes, mode };
}

function activateSelection(state: ViewerState, selectionId: string): ViewerState {
  if (!state.catalog) return state;
  const selection = state.selectedPlanes.find((candidate) => candidate.id === selectionId);
  const viewport = getActiveViewport(state);
  const collection = selection && getCollection(state.catalog, selection.collectionId);
  const plane = collection?.planes[selection!.planeIndex];
  if (!selection || !viewport || !collection || !plane) return state;
  const frameIndex = collection.kind === "cine" && collection.phaseMatching !== "none"
    ? frameForPhase(collection, selection.planeIndex, state.phase) ?? 0
    : samePlaneFrame(state, selection.collectionId, selection.planeIndex, plane.frameIds.length);
  return replaceViewport(state, {
    ...viewport,
    cursor: { collectionId: collection.id, planeIndex: selection.planeIndex, frameIndex },
    window: { ...selection.window },
    linked: canSharePhase(collection),
  });
}

function samePlaneFrame(state: ViewerState, collectionId: string, planeIndex: number, frameCount: number): number {
  const matching = state.viewports.find(
    (viewport) => viewport.cursor.collectionId === collectionId && viewport.cursor.planeIndex === planeIndex,
  );
  return matching ? clampIndex(matching.cursor.frameIndex, frameCount) : 0;
}

function relabel(state: ViewerState, collectionId: string, view: ViewLabel): ViewerState {
  if (!state.catalog || !isViewLabel(view)) return state;
  const collection = getCollection(state.catalog, collectionId);
  if (!collection) return state;
  const catalog = {
    ...state.catalog,
    collections: state.catalog.collections.map((item) => item.id === collectionId ? setManualView(item, view) : item),
  };
  return { ...state, catalog };
}

function isViewLabel(value: unknown): value is ViewLabel {
  return value === "SAX" || value === "2CH" || value === "3CH" || value === "4CH" ||
    value === "LVOT" || value === "RVOT" || value === "AXIAL" || value === "UNKNOWN";
}

function merge(state: ViewerState, collectionIds: string[]): ViewerState {
  if (!state.catalog || !Array.isArray(collectionIds)) return state;
  const ids = [...new Set(collectionIds.filter((id): id is string => typeof id === "string"))];
  if (ids.length < 2 || ids.some((id) => !getCollection(state.catalog!, id))) return state;
  let catalog: StudyCatalog;
  try {
    catalog = mergeCollections(state.catalog, ids);
  } catch {
    return state;
  }
  if (!isCatalog(catalog) || catalog === state.catalog) return state;
  const oldCollections = ids.map((id) => getCollection(state.catalog!, id)!);
  const target = findReplacementCollection(catalog, oldCollections, ids);
  if (!target) return state;
  return remapCollections(state, catalog, new Map(ids.map((id) => [id, target])));
}

function split(state: ViewerState, collectionId: string): ViewerState {
  if (!state.catalog) return state;
  const source = getCollection(state.catalog, collectionId);
  if (!source) return state;
  let catalog: StudyCatalog;
  try {
    catalog = splitCollection(state.catalog, collectionId);
  } catch {
    return state;
  }
  if (!isCatalog(catalog) || catalog === state.catalog) return state;
  const replacements = catalog.collections.filter(
    (candidate) => candidate.sourceSeriesIds.some((seriesId) => source.sourceSeriesIds.includes(seriesId)),
  );
  if (replacements.length === 0) return state;
  return remapCollections(state, catalog, new Map([[collectionId, replacements]]));
}

function findReplacementCollection(
  catalog: StudyCatalog,
  oldCollections: CmrCollection[],
  oldIds: string[],
): CmrCollection | undefined {
  const wantedSeries = new Set(oldCollections.flatMap((collection) => collection.sourceSeriesIds));
  const candidates = catalog.collections.filter((collection) =>
    collection.sourceSeriesIds.some((seriesId) => wantedSeries.has(seriesId)),
  );
  const full = candidates.find((candidate) => [...wantedSeries].every((seriesId) => candidate.sourceSeriesIds.includes(seriesId)));
  if (full) return full;
  return candidates.find((candidate) => oldIds.includes(candidate.id)) ?? (candidates.length === 1 ? candidates[0] : undefined);
}

function remapCollections(
  state: ViewerState,
  catalog: StudyCatalog,
  mapping: Map<string, CmrCollection | CmrCollection[]>,
): ViewerState {
  const choose = (oldId: string, frameId?: string, oldPlane?: CmrPlane): CmrCollection | undefined => {
    const mapped = mapping.get(oldId);
    const candidates = mapped ? (Array.isArray(mapped) ? mapped : [mapped]) : [];
    if (candidates.length === 0) return getCollection(catalog, oldId);
    const byFrame = frameId && candidates.find((candidate) =>
      candidate.planes.some((plane) => plane.frameIds.includes(frameId)),
    );
    if (byFrame) return byFrame;
    const byGeometry = oldPlane && candidates.find((candidate) =>
      candidate.planes.some((plane) => sameGeometry(plane.geometry, oldPlane.geometry)),
    );
    if (byGeometry) return byGeometry;
    const frameSeries = frameId ? catalog.frames[frameId]?.seriesId : undefined;
    return candidates.find((candidate) => frameSeries && candidate.sourceSeriesIds.includes(frameSeries)) ?? candidates[0];
  };
  const viewports = state.viewports.map((viewport) => {
    const oldCollection = getCollection(state.catalog!, viewport.cursor.collectionId);
    if (!oldCollection) return viewport;
    const oldPlane = oldCollection.planes[viewport.cursor.planeIndex];
    const oldFrameId = oldPlane?.frameIds[viewport.cursor.frameIndex] ?? undefined;
    const collection = choose(oldCollection.id, oldFrameId, oldPlane);
    if (!collection) return viewport;
    const planeIndex = findPlaneIndex(collection, oldPlane, viewport.cursor.planeIndex);
    const oldFrame = oldFrameId ? catalog.frames[oldFrameId] : undefined;
    const compatibleFrameIndex = oldFrame
      ? collection.planes[planeIndex]?.frameIds.findIndex((frameId) => frameId === oldFrameId) ?? -1
      : -1;
    const frameIndex = compatibleFrameIndex >= 0
      ? compatibleFrameIndex
      : frameForPhase(collection, planeIndex, state.phase) ??
        clampIndex(viewport.cursor.frameIndex, collection.planes[planeIndex]?.frameIds.length ?? 0);
    return {
      ...viewport,
      cursor: { collectionId: collection.id, planeIndex, frameIndex },
      linked: canSharePhase(collection) ? viewport.linked : false,
    };
  });
  const selectedPlanes = state.selectedPlanes.flatMap((selection) => {
    const oldCollection = getCollection(state.catalog!, selection.collectionId);
    const oldPlane = oldCollection?.planes[selection.planeIndex];
    if (!oldCollection || !oldPlane) return [];
    const frameId = oldPlane.frameIds.find((id) => id !== null) ?? undefined;
    const collection = choose(oldCollection.id, frameId, oldPlane);
    if (!collection) return [];
    const planeIndex = findPlaneIndex(collection, oldPlane, selection.planeIndex);
    const plane = collection.planes[planeIndex];
    if (!plane || !isValidGeometry(plane.geometry)) return [];
    return [{ ...selection, id: selectionKey(collection.id, planeIndex), collectionId: collection.id, planeIndex }];
  });
  const uniqueSelections = selectedPlanes.filter(
    (selection, index) => selectedPlanes.findIndex((other) => other.id === selection.id) === index,
  );
  const compatibleSelections = keepCompatibleSelections(catalog, uniqueSelections);
  const mode = state.mode === "cube" && compatibleSelections.length < 2 ? "inspect" : state.mode;
  return {
    ...state,
    catalog,
    viewports,
    selectedPlanes: compatibleSelections,
    mode,
  };
}

function findPlaneIndex(collection: CmrCollection, oldPlane: CmrPlane | undefined, fallback: number): number {
  if (oldPlane) {
    const overlappingFrame = collection.planes.findIndex((plane) =>
      plane.frameIds.some((id) => id !== null && oldPlane.frameIds.includes(id)),
    );
    if (overlappingFrame >= 0) return overlappingFrame;
    const byId = collection.planes.findIndex((plane) => plane.id === oldPlane.id);
    if (byId >= 0) return byId;
    const byGeometry = collection.planes.findIndex((plane) => sameGeometry(plane.geometry, oldPlane.geometry));
    if (byGeometry >= 0) return byGeometry;
  }
  return collection.planes.length > 0 ? Math.min(collection.planes.length - 1, Math.max(0, fallback)) : 0;
}

function sameGeometry(a: PlaneGeometry | undefined, b: PlaneGeometry | undefined): boolean {
  if (!isValidGeometry(a) || !isValidGeometry(b)) return false;
  if (a.frameOfReferenceUid !== b.frameOfReferenceUid || a.rows !== b.rows || a.columns !== b.columns) return false;
  const valuesA = [...a.origin, ...a.rowCosines, ...a.columnCosines, ...a.pixelSpacing, a.thickness];
  const valuesB = [...b.origin, ...b.rowCosines, ...b.columnCosines, ...b.pixelSpacing, b.thickness];
  return valuesA.every((value, index) => Math.abs(value - valuesB[index]) <= GEOMETRY_TOLERANCE);
}

function keepCompatibleSelections(catalog: StudyCatalog, selections: PlaneSelection[]): PlaneSelection[] {
  const valid: PlaneSelection[] = [];
  for (const selection of selections) {
    if (valid.length >= 5) break;
    const collection = getCollection(catalog, selection.collectionId);
    const geometry = collection?.planes[selection.planeIndex]?.geometry;
    if (!collection || !isValidGeometry(geometry)) continue;
    if (valid.length === 0) {
      valid.push(selection);
      continue;
    }
    const first = valid[0];
    const firstCollection = getCollection(catalog, first.collectionId);
    const firstGeometry = firstCollection?.planes[first.planeIndex]?.geometry;
    if (
      firstCollection && isValidGeometry(firstGeometry) &&
      firstCollection.studyUid === collection.studyUid &&
      firstGeometry.frameOfReferenceUid === geometry.frameOfReferenceUid
    ) valid.push(selection);
  }
  return valid;
}

function replaceViewport(
  state: ViewerState,
  viewport: ViewportState,
  extra?: Partial<Pick<ViewerState, "playing">>,
): ViewerState {
  const index = state.viewports.findIndex((item) => item.id === viewport.id);
  if (index < 0) return state;
  const viewports = [...state.viewports];
  viewports[index] = viewport;
  return { ...state, ...extra, viewports };
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Number.isFinite(index) ? Math.min(length - 1, Math.max(0, Math.trunc(index))) : 0;
}

function modulo(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function normalizePhase(phase: number): number {
  return modulo(phase, 1);
}

function vectorLength(vector: readonly number[]): number {
  return Math.hypot(...vector);
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
