import { describe, expect, it } from "vitest";
import { frameIndexAtPhase, phaseAt, resolveFrame } from "./spaceTime";
import { getSelectedCursors, initialViewerState, viewerReducer } from "./viewerSession";
import type {
  CmrCollection,
  FrameDescriptor,
  PlaneGeometry,
  StudyCatalog,
  ViewLabel,
} from "./types";

type CollectionOptions = {
  id: string;
  view?: ViewLabel;
  kind?: CmrCollection["kind"];
  axisKind?: CmrCollection["axisKind"];
  planeCount?: number;
  phases?: number[][];
  frameCounts?: number[];
  gaps?: Array<[number, number]>;
  studyUid?: string;
  frameOfReferenceUid?: string;
  basePosition?: number;
  phaseMatching?: CmrCollection["phaseMatching"];
  temporalPositionConstant?: boolean;
};

function geometry(position: number, frameOfReferenceUid = "for-1"): PlaneGeometry {
  return {
    origin: [0, 0, position],
    rowCosines: [1, 0, 0],
    columnCosines: [0, 1, 0],
    pixelSpacing: [1.1, 0.9],
    rows: 32,
    columns: 28,
    thickness: 6,
    frameOfReferenceUid,
  };
}

function makeCollection(options: CollectionOptions): { collection: CmrCollection; frames: FrameDescriptor[] } {
  const planeCount = options.planeCount ?? 1;
  const kind = options.kind ?? "cine";
  const frames: FrameDescriptor[] = [];
  const planes = Array.from({ length: planeCount }, (_, planeIndex) => {
    const count = options.frameCounts?.[planeIndex] ?? options.phases?.[planeIndex]?.length ?? 8;
    const phases = options.phases?.[planeIndex] ?? Array.from({ length: count }, (_, index) => index / count);
    const g = geometry((options.basePosition ?? 0) + planeIndex * 7, options.frameOfReferenceUid ?? "for-1");
    const frameIds: Array<string | null> = Array.from({ length: count }, (_, frameIndex) => {
      if (options.gaps?.some(([gapPlane, gapFrame]) => gapPlane === planeIndex && gapFrame === frameIndex)) return null;
      const id = `${options.id}-p${planeIndex}-f${frameIndex}`;
      frames.push({
        id,
        instanceId: id,
        frameNumber: 1,
        studyUid: options.studyUid ?? "study-1",
        seriesId: options.id,
        seriesDescription: `${options.view ?? "SAX"} ${kind}`,
        protocolName: "CMR cine protocol",
        sequenceName: "balanced SSFP",
        imageType: ["ORIGINAL", "PRIMARY"],
        rows: g.rows,
        columns: g.columns,
        geometry: g,
        photometric: "MONOCHROME2",
        temporalPosition: options.temporalPositionConstant ? 1 : frameIndex + 1,
        triggerMs: frameIndex * 40 + planeIndex * 0.7,
        nominalPhase: phases[frameIndex],
        parameters: {},
        rescaleSlope: 1,
        rescaleIntercept: 0,
      });
      return id;
    });
    return {
      id: `${options.id}-plane-${planeIndex}`,
      positionMm: (options.basePosition ?? 0) + planeIndex * 7,
      geometry: g,
      frameIds,
      phases: [...phases],
    };
  });
  const collection: CmrCollection = {
    id: options.id,
    studyUid: options.studyUid ?? "study-1",
    label: `${options.view ?? "SAX"} ${kind}`,
    view: options.view ?? "SAX",
    kind,
    axisKind: options.axisKind ?? (kind === "cine" ? "cardiac" : kind === "mapping" ? "parameter" : "static"),
    axisLabel: kind === "cine" ? "Cardiac phase" : "Source frame",
    sourceSeriesIds: [options.id],
    planes,
    phaseMatching: options.phaseMatching ?? (kind === "cine" ? "measured" : "none"),
    defaultWindow: { center: 180, width: 480 },
    warnings: [],
  };
  return { collection, frames };
}

function catalogOf(...collections: Array<{ collection: CmrCollection; frames: FrameDescriptor[] }>): StudyCatalog {
  return {
    id: "study-catalog",
    collections: collections.map((item) => item.collection),
    frames: Object.fromEntries(collections.flatMap((item) => item.frames.map((frame) => [frame.id, frame]))),
    report: { acceptedInstances: 0, acceptedFrames: 0, skippedObjects: 0, failedFiles: 0, warnings: [] },
  };
}

function loaded(catalog: StudyCatalog) {
  return viewerReducer(initialViewerState(), { type: "load", catalog });
}

describe("ViewerSession", () => {
  it("keeps 2D transforms through navigation and inspection, resetting on collection replacement", () => {
    const sax = makeCollection({ id: "sax", view: "SAX", planeCount: 2 });
    const lax = makeCollection({ id: "lax", view: "2CH" });
    let state = loaded(catalogOf(sax, lax));
    const transform = { zoom: 2.2, panX: 0.1, panY: -0.2 };
    state = viewerReducer(state, { type: "imageTransform", viewportId: "viewport-0", transform });
    state = viewerReducer(state, { type: "frame", viewportId: "viewport-0", index: 1 });
    state = viewerReducer(state, { type: "plane", viewportId: "viewport-0", index: 1 });
    state = viewerReducer(state, { type: "mode", mode: "split" });
    state = viewerReducer(state, { type: "inspectViewport", viewportId: "viewport-0" });
    state = viewerReducer(state, { type: "returnToSplit" });
    expect(state.viewports[0].imageTransform).toEqual(transform);
    expect(state.viewports[1].imageTransform).toEqual({ zoom: 1, panX: 0, panY: 0 });
    state = viewerReducer(state, { type: "collection", viewportId: "viewport-0", collectionId: "lax" });
    expect(state.viewports[0].imageTransform).toEqual({ zoom: 1, panX: 0, panY: 0 });
    expect(viewerReducer(state, { type: "atlasSpacing", spacing: 100 }).atlasSpacing).toBe(1.4);
    expect(viewerReducer(state, { type: "atlasSpacing", spacing: NaN })).toBe(state);
  });
  it("replaces inferred view evidence when a view is manually confirmed or corrected", () => {
    const inferred = makeCollection({ id: "mapping", kind: "mapping", view: "SAX" });
    inferred.collection.warnings = ["Geometric view inference: SAX from same-study Cine plane geometry; not anatomically validated.", "Unrelated acquisition warning"];
    const catalog = catalogOf(inferred);
    let state = loaded(catalog);
    state = viewerReducer(state, { type: "relabel", collectionId: "mapping", view: "SAX" });
    expect(state.catalog!.collections[0].warnings).toEqual(["Unrelated acquisition warning", "View labeled manually: SAX. Original DICOM geometry and descriptions retained."]);
    state = viewerReducer(state, { type: "relabel", collectionId: "mapping", view: "4CH" });
    expect(state.catalog!.collections[0].view).toBe("4CH");
    expect(state.catalog!.collections[0].warnings).toEqual(["Unrelated acquisition warning", "View labeled manually: 4CH. Original DICOM geometry and descriptions retained."]);
    expect(state.catalog!.frames).toBe(catalog.frames);
    expect(catalog.collections[0].view).toBe("SAX");
  });
  it("expands the clicked split viewport and restores its layout without resetting image state", () => {
    const sax = makeCollection({ id: "sax", view: "SAX", planeCount: 3 });
    const two = makeCollection({ id: "2ch", view: "2CH" });
    let state = loaded(catalogOf(sax, two));
    state = viewerReducer(state, { type: "layout", count: 2 });
    state = viewerReducer(state, { type: "mode", mode: "split" });
    state = viewerReducer(state, { type: "link", viewportId: "viewport-1", linked: false });
    state = viewerReducer(state, { type: "frame", viewportId: "viewport-1", index: 3 });
    state = viewerReducer(state, { type: "window", viewportId: "viewport-1", window: { center: 210, width: 360 } });
    const targetFrame = two.collection.planes[0].frameIds[3]!;
    state = viewerReducer(state, { type: "note", frameId: targetFrame, text: "长轴备注" });
    const originalViewports = state.viewports;
    state = viewerReducer(state, { type: "inspectViewport", viewportId: "viewport-1" });
    expect(state.mode).toBe("inspect");
    expect(state.activeViewportId).toBe("viewport-1");
    expect(state.viewports).toBe(originalViewports);
    expect(state.notes[targetFrame]).toBe("长轴备注");
    expect(state.inspectionOrigin).toBe("split");
    state = viewerReducer(state, { type: "returnToSplit" });
    expect(state.mode).toBe("split");
    expect(state.splitCount).toBe(2);
    expect(state.viewports).toBe(originalViewports);
    expect(state.inspectionOrigin).toBeNull();
  });

  it("rejects expanding a hidden split viewport and clears the return origin when leaving inspection", () => {
    let state = loaded(catalogOf(makeCollection({ id: "sax" })));
    state = viewerReducer(state, { type: "layout", count: 2 });
    state = viewerReducer(state, { type: "mode", mode: "split" });
    expect(viewerReducer(state, { type: "inspectViewport", viewportId: "viewport-3" })).toBe(state);
    state = viewerReducer(state, { type: "inspectViewport", viewportId: "viewport-1" });
    state = viewerReducer(state, { type: "mode", mode: "atlas" });
    expect(state.inspectionOrigin).toBeNull();
    expect(viewerReducer(state, { type: "returnToSplit" })).toBe(state);
  });

  it("loads the largest SAX cine as the anchor and initializes distinct standard views", () => {
    const sax = makeCollection({ id: "sax", view: "SAX", planeCount: 11, frameCounts: Array(11).fill(25), temporalPositionConstant: true });
    const extraSax = makeCollection({ id: "sax-extra", view: "SAX", frameCounts: [50], basePosition: 100 });
    const two = makeCollection({ id: "2ch", view: "2CH", frameCounts: [25] });
    const three = makeCollection({ id: "3ch", view: "3CH", frameCounts: [25] });
    const four = makeCollection({ id: "4ch", view: "4CH", frameCounts: [25] });
    const state = loaded(catalogOf(sax, extraSax, two, three, four));

    expect(state.viewports.map((viewport) => viewport.cursor.collectionId)).toEqual(["sax", "2ch", "3ch", "4ch"]);
    expect(state.viewports[0].cursor.planeIndex).toBe(5);
    expect(state.playbackFps).toBe(25);
    expect(state.atlasCount).toBe(7);
    expect(state.viewports.every((viewport) => viewport.linked)).toBe(true);
    // Mirrors the sample: TemporalPosition stays at 1 while plane-local phase and trigger time vary.
    expect(sax.frames.every((frame) => frame.temporalPosition === 1)).toBe(true);
    expect(new Set(sax.frames.map((frame) => frame.triggerMs)).size).toBe(25 * 11);
    expect(phaseAt(sax.collection, 0, 12)).toBeCloseTo(12 / 25);
  });

  it("matches unequal cine phase counts by normalized phase and preserves plane independence", () => {
    const sax = makeCollection({ id: "sax", view: "SAX", planeCount: 3, frameCounts: [25, 25, 25] });
    const two = makeCollection({ id: "2ch", view: "2CH", frameCounts: [4] });
    const three = makeCollection({ id: "3ch", view: "3CH", frameCounts: [25] });
    const four = makeCollection({ id: "4ch", view: "4CH", frameCounts: [25] });
    let state = loaded(catalogOf(sax, two, three, four));

    state = viewerReducer(state, { type: "frame", viewportId: "viewport-0", index: 13 });
    expect(state.viewports[0].cursor.frameIndex).toBe(13);
    expect(state.viewports[1].cursor.frameIndex).toBe(
      frameIndexAtPhase(two.collection, 0, phaseAt(sax.collection, 1, 13)),
    );
    expect(state.viewports[0].cursor.planeIndex).toBe(1);
    expect(state.viewports[0].cursor.planeIndex).not.toBe(state.viewports[1].cursor.planeIndex);

    state = viewerReducer(state, { type: "link", viewportId: "viewport-1", linked: false });
    const independentIndex = state.viewports[1].cursor.frameIndex;
    state = viewerReducer(state, { type: "frame", viewportId: "viewport-0", index: 19 });
    expect(state.viewports[1].cursor.frameIndex).toBe(independentIndex);
    state = viewerReducer(state, { type: "active", viewportId: "viewport-0" });
    state = viewerReducer(state, { type: "step", axis: "space", delta: 1 });
    expect(state.viewports[0].cursor.planeIndex).toBe(2);
    expect(state.viewports[1].cursor.planeIndex).toBe(0);
  });

  it("leaves Mapping and perfusion cursors untouched by linked cine changes", () => {
    const sax = makeCollection({ id: "sax", view: "SAX", planeCount: 2, frameCounts: [8, 8] });
    const two = makeCollection({ id: "2ch", view: "2CH", frameCounts: [8] });
    const mapping = makeCollection({ id: "t1-map", view: "SAX", kind: "mapping", axisKind: "parameter", frameCounts: [3] });
    const perfusion = makeCollection({ id: "perfusion", view: "SAX", kind: "perfusion", axisKind: "acquisition", frameCounts: [5] });
    const four = makeCollection({ id: "4ch", view: "4CH", frameCounts: [8] });
    let state = loaded(catalogOf(sax, two, mapping, perfusion, four));
    state = viewerReducer(state, { type: "collection", viewportId: "viewport-2", collectionId: "t1-map" });
    state = viewerReducer(state, { type: "frame", viewportId: "viewport-2", index: 2 });
    expect(state.viewports[2].linked).toBe(false);
    state = viewerReducer(state, { type: "link", viewportId: "viewport-2", linked: true });
    expect(state.viewports[2].linked).toBe(false);
    state = viewerReducer(state, { type: "frame", viewportId: "viewport-0", index: 5 });
    expect(state.viewports[2].cursor.frameIndex).toBe(2);
  });

  it("navigates into known gap slots without skipping them and preserves their phase", () => {
    const sax = makeCollection({
      id: "sax",
      planeCount: 2,
      frameCounts: [4, 4],
      phases: [[0, 0.25, 0.5, 0.75], [0, 0.25, 0.5, 0.75]],
      gaps: [[0, 1], [1, 2]],
    });
    const two = makeCollection({ id: "2ch", view: "2CH", frameCounts: [4] });
    const three = makeCollection({ id: "3ch", view: "3CH", frameCounts: [4] });
    const four = makeCollection({ id: "4ch", view: "4CH", frameCounts: [4] });
    let state = loaded(catalogOf(sax, two, three, four));

    state = viewerReducer(state, { type: "frame", viewportId: "viewport-0", index: 0 });
    state = viewerReducer(state, { type: "step", axis: "time", delta: 1 });
    expect(state.viewports[0].cursor.frameIndex).toBe(1);
    expect(state.phase).toBeCloseTo(0.25);
    expect(resolveFrame(state.catalog!, state.viewports[0].cursor)?.descriptor).toBeNull();
    expect(state.viewports[1].cursor.frameIndex).toBe(1);
  });

  it("resolves fixed cube planes at the shared cine phase and keeps non-cine frames local", () => {
    const sax = makeCollection({
      id: "sax",
      planeCount: 2,
      phases: [[0, 0.1, 0.45, 0.7], [0, 0.25, 0.5, 0.75]],
    });
    const two = makeCollection({ id: "2ch", view: "2CH", frameCounts: [4] });
    const three = makeCollection({ id: "3ch", view: "3CH", frameCounts: [4] });
    const four = makeCollection({ id: "4ch", view: "4CH", frameCounts: [4] });
    let state = loaded(catalogOf(sax, two, three, four));
    state = viewerReducer(state, { type: "frame", viewportId: "viewport-0", index: 2 });
    state = viewerReducer(state, { type: "selectPlane", viewportId: "viewport-0" });
    state = viewerReducer(state, { type: "plane", viewportId: "viewport-0", index: 1 });
    state = viewerReducer(state, { type: "selectPlane", viewportId: "viewport-0" });
    const selectedIds = state.selectedPlanes.map((selection) => selection.id);
    expect(getSelectedCursors(state).map((viewport) => viewport.cursor.frameIndex)).toEqual([2, 2]);

    state = viewerReducer(state, { type: "frame", viewportId: "viewport-0", index: 3 });
    expect(state.selectedPlanes.map((selection) => selection.id)).toEqual(selectedIds);
    expect(getSelectedCursors(state).map((viewport) => viewport.cursor.frameIndex)).toEqual([3, 3]);

    const mapping = makeCollection({ id: "mapping", view: "SAX", kind: "mapping", planeCount: 2, frameCounts: [3, 2] });
    let mappingState = loaded(catalogOf(mapping, two, three, four));
    mappingState = viewerReducer(mappingState, { type: "collection", viewportId: "viewport-0", collectionId: "mapping" });
    mappingState = viewerReducer(mappingState, { type: "frame", viewportId: "viewport-0", index: 2 });
    mappingState = viewerReducer(mappingState, { type: "selectPlane", viewportId: "viewport-0" });
    expect(getSelectedCursors(mappingState)[0].cursor.frameIndex).toBe(2);
    mappingState = viewerReducer(mappingState, { type: "collection", viewportId: "viewport-0", collectionId: "2ch" });
    expect(getSelectedCursors(mappingState)[0].cursor.frameIndex).toBe(0);
  });

  it("pauses on manual time navigation, wraps cine time, and clamps space at the stack edge", () => {
    const sax = makeCollection({ id: "sax", planeCount: 2, frameCounts: [4, 4] });
    const two = makeCollection({ id: "2ch", view: "2CH", frameCounts: [4] });
    const three = makeCollection({ id: "3ch", view: "3CH", frameCounts: [4] });
    const four = makeCollection({ id: "4ch", view: "4CH", frameCounts: [4] });
    let state = loaded(catalogOf(sax, two, three, four));
    state = viewerReducer(state, { type: "playing", playing: true });
    state = viewerReducer(state, { type: "frame", viewportId: "viewport-0", index: 3 });
    expect(state.playing).toBe(false);
    state = viewerReducer(state, { type: "playing", playing: true });
    state = viewerReducer(state, { type: "tick" });
    expect(state.viewports[0].cursor.frameIndex).toBe(0);
    expect(state.playing).toBe(true);
    state = viewerReducer(state, { type: "active", viewportId: "viewport-0" });
    state = viewerReducer(state, { type: "step", axis: "space", delta: -50 });
    expect(state.viewports[0].cursor.planeIndex).toBe(0);
    expect(state.viewports[1].cursor.planeIndex).toBe(0);
    state = viewerReducer(state, { type: "step", axis: "time", delta: 1 });
    expect(state.playing).toBe(false);
    expect(state.viewports[0].cursor.frameIndex).toBe(1);
  });

  it("keeps frame-keyed notes across modes and clears them only when deleted or a new study loads", () => {
    const sax = makeCollection({ id: "sax", frameCounts: [4] });
    const two = makeCollection({ id: "2ch", view: "2CH", frameCounts: [4] });
    const three = makeCollection({ id: "3ch", view: "3CH", frameCounts: [4] });
    const four = makeCollection({ id: "4ch", view: "4CH", frameCounts: [4] });
    const catalog = catalogOf(sax, two, three, four);
    const frameId = Object.keys(catalog.frames)[0];
    let state = loaded(catalog);
    state = viewerReducer(state, { type: "note", frameId, text: "Check basal motion" });
    state = viewerReducer(state, { type: "mode", mode: "inspect" });
    state = viewerReducer(state, { type: "mode", mode: "split" });
    expect(state.notes[frameId]).toBe("Check basal motion");
    state = viewerReducer(state, { type: "note", frameId, text: "" });
    expect(state.notes[frameId]).toBeUndefined();
    state = viewerReducer(state, { type: "note", frameId, text: "Temporary" });
    state = viewerReducer(state, { type: "load", catalog: catalogOf(makeCollection({ id: "new-sax" })) });
    expect(state.notes).toEqual({});
  });

  it("enforces the 2–5 plane cube rules, same-study and same-Frame-of-Reference geometry", () => {
    const sax = makeCollection({ id: "sax", planeCount: 7, frameCounts: Array(7).fill(4) });
    const two = makeCollection({ id: "2ch", view: "2CH", frameCounts: [4] });
    const three = makeCollection({ id: "3ch", view: "3CH", frameCounts: [4] });
    const four = makeCollection({ id: "4ch", view: "4CH", frameCounts: [4] });
    const wrongFor = makeCollection({ id: "wrong-for", view: "SAX", frameOfReferenceUid: "for-2", basePosition: 90 });
    const wrongStudy = makeCollection({ id: "wrong-study", view: "SAX", studyUid: "study-2", basePosition: 120 });
    let state = loaded(catalogOf(sax, two, three, four, wrongFor));
    state = viewerReducer(state, { type: "mode", mode: "cube" });
    expect(state.mode).toBe("atlas");

    for (let index = 0; index < 5; index += 1) {
      state = viewerReducer(state, { type: "plane", viewportId: "viewport-0", index });
      state = viewerReducer(state, { type: "selectPlane", viewportId: "viewport-0" });
    }
    expect(state.selectedPlanes).toHaveLength(5);
    state = viewerReducer(state, { type: "mode", mode: "cube" });
    expect(state.mode).toBe("cube");
    state = viewerReducer(state, { type: "plane", viewportId: "viewport-0", index: 5 });
    expect(state.selectedPlanes.some((selection) => selection.planeIndex === 5)).toBe(true);
    state = viewerReducer(state, { type: "collection", viewportId: "viewport-0", collectionId: "2ch" });
    state = viewerReducer(state, { type: "selectPlane", viewportId: "viewport-0" });
    expect(state.selectedPlanes).toHaveLength(5);

    let separateStudyState = loaded(catalogOf(sax, two, three, four, wrongStudy));
    separateStudyState = viewerReducer(separateStudyState, { type: "selectPlane", viewportId: "viewport-0" });
    separateStudyState = viewerReducer(separateStudyState, { type: "collection", viewportId: "viewport-0", collectionId: "wrong-study" });
    separateStudyState = viewerReducer(separateStudyState, { type: "selectPlane", viewportId: "viewport-0" });
    expect(separateStudyState.selectedPlanes).toHaveLength(1);

    const noGeometry = makeCollection({ id: "no-geometry", view: "SAX" });
    noGeometry.collection.planes[0].geometry = undefined;
    let noGeometryState = loaded(catalogOf(noGeometry));
    noGeometryState = viewerReducer(noGeometryState, { type: "selectPlane", viewportId: "viewport-0" });
    expect(noGeometryState.selectedPlanes).toHaveLength(0);
    expect(viewerReducer(state, { type: "mode", mode: "cube" })).toBe(state);

    state = viewerReducer(state, { type: "collection", viewportId: "viewport-0", collectionId: "wrong-for" });
    state = viewerReducer(state, { type: "selectPlane", viewportId: "viewport-0" });
    expect(state.selectedPlanes).toHaveLength(5);
  });

  it("remaps cursors through valid merge/split operations and preserves state on rejected merges", () => {
    const first = makeCollection({ id: "series-a", view: "SAX", basePosition: 0, frameCounts: [4] });
    const second = makeCollection({ id: "series-b", view: "SAX", basePosition: 12, frameCounts: [4] });
    const catalog = catalogOf(first, second);
    let state = loaded(catalog);
    state = viewerReducer(state, { type: "merge", collectionIds: ["series-a", "series-b"] });
    const merged = state.catalog!.collections.find((collection) => collection.sourceSeriesIds.length === 2)!;
    expect(merged).toBeDefined();
    expect(state.viewports.slice(0, 2).every((viewport) => viewport.cursor.collectionId === merged.id)).toBe(true);
    state = viewerReducer(state, { type: "splitCollection", collectionId: merged.id });
    expect(state.catalog!.collections.filter((collection) => collection.sourceSeriesIds.length === 1)).toHaveLength(2);
    expect(state.viewports.slice(0, 2).every((viewport) => state.catalog!.collections.some((collection) => collection.id === viewport.cursor.collectionId))).toBe(true);

    const duplicate = makeCollection({ id: "series-c", view: "SAX", basePosition: 0, frameCounts: [4] });
    const rejected = loaded(catalogOf(first, duplicate));
    expect(viewerReducer(rejected, { type: "merge", collectionIds: ["series-a", "series-c"] })).toBe(rejected);
  });

  it("keeps an active selected plane on its orientation when one Series is split", () => {
    const withOrientation = (
      source: ReturnType<typeof makeCollection>,
      rowCosines: [number, number, number],
      columnCosines: [number, number, number],
    ) => {
      const seriesId = "shared-series";
      const frames = source.frames.map((frame) => ({
        ...frame,
        seriesId,
        geometry: frame.geometry && { ...frame.geometry, rowCosines, columnCosines },
      }));
      const planes = source.collection.planes.map((plane) => ({
        ...plane,
        geometry: plane.geometry && { ...plane.geometry, rowCosines, columnCosines },
      }));
      return {
        frames,
        collection: { ...source.collection, sourceSeriesIds: [seriesId], planes },
      };
    };
    const sax = withOrientation(
      makeCollection({ id: "sax-source", view: "SAX", basePosition: 0, frameCounts: [4] }),
      [1, 0, 0], [0, 1, 0],
    );
    const longAxis = withOrientation(
      makeCollection({ id: "lax-source", view: "2CH", basePosition: 0, frameCounts: [4] }),
      [0, 0, 1], [0, 1, 0],
    );
    const secondFrameId = longAxis.collection.planes[0].frameIds[0]!;
    let state = loaded(catalogOf(sax, longAxis));
    state = viewerReducer(state, {
      type: "collection",
      viewportId: "viewport-1",
      collectionId: longAxis.collection.id,
    });
    state = viewerReducer(state, { type: "selectPlane", viewportId: "viewport-1" });
    state = viewerReducer(state, { type: "active", viewportId: "viewport-1" });
    state = viewerReducer(state, { type: "merge", collectionIds: [sax.collection.id, longAxis.collection.id] });

    const merged = state.catalog!.collections.find((collection) => collection.sourceSeriesIds.includes("shared-series"))!;
    const mergedSecondPlane = merged.planes.findIndex((plane) => plane.frameIds.includes(secondFrameId));
    expect(state.viewports[1].cursor).toMatchObject({ collectionId: merged.id, planeIndex: mergedSecondPlane });
    expect(state.activeViewportId).toBe("viewport-1");
    expect(state.selectedPlanes).toHaveLength(1);
    expect(state.selectedPlanes[0]).toMatchObject({ collectionId: merged.id, planeIndex: mergedSecondPlane });

    state = viewerReducer(state, { type: "splitCollection", collectionId: merged.id });
    const splitLongAxis = state.catalog!.collections.find((collection) =>
      collection.planes.some((plane) => plane.frameIds.includes(secondFrameId)),
    )!;
    const splitSecondPlane = splitLongAxis.planes.findIndex((plane) => plane.frameIds.includes(secondFrameId));
    expect(state.activeViewportId).toBe("viewport-1");
    expect(state.viewports[1].cursor).toMatchObject({ collectionId: splitLongAxis.id, planeIndex: splitSecondPlane });
    expect(state.selectedPlanes).toHaveLength(1);
    expect(state.selectedPlanes[0]).toMatchObject({ collectionId: splitLongAxis.id, planeIndex: splitSecondPlane });
  });

  it("treats malformed actions and invalid cursor/window inputs as no-ops", () => {
    const sax = makeCollection({ id: "sax", planeCount: 2, frameCounts: [4, 4] });
    let state = loaded(catalogOf(sax));
    expect(viewerReducer(state, { type: "plane", viewportId: "viewport-0", index: 99 })).toBe(state);
    expect(viewerReducer(state, { type: "frame", viewportId: "viewport-0", index: 99 })).toBe(state);
    expect(viewerReducer(state, { type: "window", viewportId: "viewport-0", window: { center: 0, width: 0 } })).toBe(state);
    expect(viewerReducer(state, { type: "note", frameId: "unknown-frame", text: "ignored" })).toBe(state);
    expect(viewerReducer(state, { type: "fps", fps: Number.NaN })).toBe(state);
    expect(viewerReducer(state, { type: "step", axis: "invalid" as "time", delta: 1 })).toBe(state);
    expect(viewerReducer(state, { type: "playing", playing: "yes" as unknown as boolean })).toBe(state);
    state = viewerReducer(state, { type: "fps", fps: 500 });
    expect(state.playbackFps).toBe(60);
  });
});
