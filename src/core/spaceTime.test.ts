import { describe, expect, it } from "vitest";
import {
  buildCollections,
  frameIndexAtPhase,
  mergeCollections,
  patientToPixel,
  phaseAt,
  pixelToPatient,
  planeCorners,
  planeNormal,
  referenceLine,
  resolveFrame,
  splitCollection,
} from "./spaceTime";
import { inferGeometryViews } from "./viewInference";
import type { CmrCollection, CmrPlane, FrameDescriptor, PlaneGeometry, StudyCatalog } from "./types";

function geometry(z: number, overrides: Partial<PlaneGeometry> = {}): PlaneGeometry {
  return {
    origin: [0, 0, z],
    rowCosines: [1, 0, 0],
    columnCosines: [0, 1, 0],
    pixelSpacing: [1, 1],
    rows: 11,
    columns: 11,
    thickness: 8,
    frameOfReferenceUid: "FOR-1",
    ...overrides,
  };
}

function frame(id: string, overrides: Partial<FrameDescriptor> = {}): FrameDescriptor {
  return {
    id,
    instanceId: id,
    frameNumber: 1,
    studyUid: "STUDY-1",
    seriesId: "SERIES-1",
    seriesDescription: "SAX Cine bSSFP",
    protocolName: "CMR CINE SAX",
    sequenceName: "bSSFP",
    imageType: ["ORIGINAL", "PRIMARY"],
    rows: 11,
    columns: 11,
    geometry: geometry(0),
    photometric: "MONOCHROME2",
    parameters: {},
    rescaleSlope: 1,
    rescaleIntercept: 0,
    ...overrides,
  };
}

function catalogFor(frames: FrameDescriptor[]): StudyCatalog {
  const collections = buildCollections(frames);
  return {
    id: "catalog-1",
    collections,
    frames: Object.fromEntries(frames.map((item) => [item.id, item])),
    report: { acceptedInstances: frames.length, acceptedFrames: frames.length, skippedObjects: 0, failedFiles: 0, warnings: [] },
  };
}

describe("patient-space geometry", () => {
  it("round-trips an oblique pixel using DICOM row/column spacing and orientation", () => {
    const oblique = geometry(22, {
      origin: [10, -4, 22],
      rowCosines: [0.8, 0.6, 0],
      columnCosines: [-0.3, 0.4, 0.8660254037844386],
      pixelSpacing: [2.5, 1.2],
    });
    const patient = pixelToPatient(oblique, [13, 8]);
    const pixel = patientToPixel(oblique, patient);
    expect(pixel[0]).toBeCloseTo(13, 8);
    expect(pixel[1]).toBeCloseTo(8, 8);
    expect(planeNormal(oblique).every(Number.isFinite)).toBe(true);
    expect(planeCorners(oblique)).toHaveLength(4);
  });

  it("clips a crosshair to the finite target and source planes", () => {
    const target = geometry(0);
    const source = geometry(0, {
      origin: [5, 0, 0],
      rowCosines: [0, 1, 0],
      columnCosines: [0, 0, 1],
    });
    const line = referenceLine(source, target);
    expect(line).not.toBeNull();
    expect(line!.from[0]).toBeCloseTo(5, 7);
    expect(line!.to[0]).toBeCloseTo(5, 7);
    expect(new Set([line!.from[1], line!.to[1]].map((value) => Number(value.toFixed(1))))).toEqual(new Set([-0.5, 10.5]));
    expect(referenceLine({ ...source, origin: [15, 0, 0] }, target)).toBeNull();
    expect(planeCorners(target).map((point) => point.slice(0, 2))).toEqual([[-0.5, -0.5], [10.5, -0.5], [10.5, 10.5], [-0.5, 10.5]]);
  });

  it("rejects parallel planes and different Frames of Reference", () => {
    const target = geometry(0);
    expect(referenceLine(geometry(5), target)).toBeNull();
    expect(referenceLine(geometry(0, { frameOfReferenceUid: "FOR-2", rowCosines: [0, 1, 0], columnCosines: [0, 0, 1] }), target)).toBeNull();
  });
});

describe("CMR collections and phase navigation", () => {
  it("recognizes underscore-delimited SAX and Cine_SA descriptions", () => {
    const sax = buildCollections([frame("sax", { seriesDescription: "Cine_SAX_BH" })])[0];
    const shortAxisAlias = buildCollections([frame("sa", { seriesDescription: "Cine_SA_BH" })])[0];
    expect(sax).toMatchObject({ view: "SAX", kind: "cine" });
    expect(shortAxisAlias).toMatchObject({ view: "SAX", kind: "cine" });
  });

  it("recognizes vendor-prefixed PSIR, non-cine SA views, and scout precedence", () => {
    const psir = buildCollections([frame("psir", {
      seriesDescription: "sPSIR_CR",
      protocolName: "Cardiac IR",
      sequenceName: "",
    })])[0];
    const shortAxisMap = buildCollections([frame("sa-map", {
      seriesDescription: "SA T1 Map",
      protocolName: "T1 Mapping",
      sequenceName: "",
    })])[0];
    const scout = buildCollections([frame("ti-scout", {
      seriesDescription: "LL_TI_Scout_LGE",
      protocolName: "Cardiac IR",
      sequenceName: "",
    })])[0];
    const irLookLocker = buildCollections([frame("ir-ll-psir", {
      seriesDescription: "IR_TFE_LL_PSIR",
      protocolName: "Cardiac IR",
      sequenceName: "",
    })])[0];
    const molliScout = buildCollections([frame("molli-scout", {
      seriesDescription: "IR_TFE_MOLLI_TI_Scout",
      protocolName: "Cardiac T1 Mapping",
      sequenceName: "",
    })])[0];
    const mapScout = buildCollections([frame("map-scout", {
      seriesDescription: "T1_Map_TI_Scout",
      protocolName: "Cardiac T1 Mapping",
      sequenceName: "",
    })])[0];

    expect(psir).toMatchObject({ kind: "lge", view: "UNKNOWN" });
    expect(shortAxisMap).toMatchObject({ kind: "mapping", view: "SAX" });
    expect(scout).toMatchObject({ kind: "localizer", view: "UNKNOWN" });
    expect(irLookLocker).toMatchObject({ kind: "localizer", view: "UNKNOWN" });
    expect(irLookLocker.warnings.some((warning) => warning.includes("verify this classification") && warning.includes("No DICOM inversion-time field confirms"))).toBe(true);
    expect(molliScout.kind).toBe("mapping");
    expect(mapScout.kind).toBe("mapping");
    expect(molliScout.warnings.some((warning) => warning.includes("Look-Locker/TI scout"))).toBe(false);
    expect(mapScout.warnings.some((warning) => warning.includes("Look-Locker/TI scout"))).toBe(false);
  });

  it("does not let an ineligible mixed SAX plane expand the inferred stack range", () => {
    const anchorFrame = frame("stack-anchor", {
      seriesId: "SAX-STACK",
      seriesDescription: "SAX Cine bSSFP",
      protocolName: "CMR SAX cine",
      geometry: geometry(0),
      triggerMs: 0,
    });
    const targetFrame = frame("far-map", {
      seriesId: "FAR-MAP",
      seriesDescription: "T1 Mapping",
      protocolName: "T1 Mapping",
      sequenceName: "",
      geometry: geometry(100),
    });
    const sax = buildCollections([anchorFrame])[0];
    const mapping = buildCollections([targetFrame])[0];
    const tilted = 15 * Math.PI / 180;
    const outlierGeometry = geometry(100, {
      rowCosines: [Math.cos(tilted), 0, Math.sin(tilted)],
      columnCosines: [0, 1, 0],
    });
    const outlierPlane: CmrPlane = {
      id: "outlier-plane",
      positionMm: 100,
      geometry: outlierGeometry,
      frameIds: ["outlier-frame"],
      phases: [],
    };
    const mixedAnchor: CmrCollection = { ...sax, planes: [...sax.planes, outlierPlane] };

    const [, result] = inferGeometryViews([mixedAnchor, mapping]);
    expect(result.view).toBe("UNKNOWN");
  });

  it("infers an LGE or mapping view only from matching same-study cine geometry", () => {
    const anchor = [
      frame("sax-anchor-0", { seriesId: "SAX-ANCHOR", seriesDescription: "SAX Cine bSSFP", protocolName: "CMR SAX cine", geometry: geometry(0), triggerMs: 0 }),
      frame("sax-anchor-8", { seriesId: "SAX-ANCHOR", seriesDescription: "SAX Cine bSSFP", protocolName: "CMR SAX cine", geometry: geometry(8), triggerMs: 0 }),
    ];
    const catalog = buildCollections([
      ...anchor,
      frame("map-source", { seriesId: "T1-MAP", seriesDescription: "T1 Mapping source", protocolName: "T1 Mapping", sequenceName: "", geometry: geometry(4), parameters: { tiMs: 450 } }),
      frame("psir-source", { seriesId: "LGE-PSIR", seriesDescription: "sPSIR_CR", protocolName: "Cardiac IR", sequenceName: "", geometry: geometry(0) }),
    ]);
    const mapping = catalog.find((item) => item.sourceSeriesIds.includes("T1-MAP"))!;
    const lge = catalog.find((item) => item.sourceSeriesIds.includes("LGE-PSIR"))!;

    expect(mapping).toMatchObject({ kind: "mapping", view: "SAX", sourceSeriesIds: ["T1-MAP"] });
    expect(lge).toMatchObject({ kind: "lge", view: "SAX", sourceSeriesIds: ["LGE-PSIR"] });
    expect(mapping.warnings.some((warning) => warning.includes("Geometric view inference:") && warning.includes("not anatomically validated"))).toBe(true);
  });

  it("infers a long-axis view only when the finite plane overlaps at the same position and coordinate frame", () => {
    const longAxis = geometry(0, { origin: [0, 0, 0], rowCosines: [1, 0, 0], columnCosines: [0, 0, 1] });
    const catalog = buildCollections([
      frame("4ch-anchor", { seriesId: "4CH-CINE", seriesDescription: "4CH Cine bSSFP", protocolName: "CMR 4CH cine", sequenceName: "", geometry: longAxis, triggerMs: 0 }),
      frame("near-plane", { seriesId: "NEAR-MAP", seriesDescription: "T1 Mapping", protocolName: "T1 Mapping", sequenceName: "", geometry: { ...longAxis, origin: [0, -2, 0] } }),
      frame("far-plane", { seriesId: "FAR-MAP", seriesDescription: "T1 Mapping", protocolName: "T1 Mapping", sequenceName: "", geometry: { ...longAxis, origin: [0, -20, 0] } }),
      frame("other-for", { seriesId: "OTHER-FOR", seriesDescription: "sPSIR_CR", protocolName: "Cardiac IR", sequenceName: "", geometry: { ...longAxis, frameOfReferenceUid: "FOR-2" } }),
      frame("outside-fov", { seriesId: "OUTSIDE-FOV", seriesDescription: "sPSIR_CR", protocolName: "Cardiac IR", sequenceName: "", geometry: { ...longAxis, origin: [100, 0, 0] } }),
    ]);

    expect(catalog.find((item) => item.sourceSeriesIds.includes("NEAR-MAP"))?.view).toBe("4CH");
    for (const seriesId of ["FAR-MAP", "OTHER-FOR", "OUTSIDE-FOV"]) {
      expect(catalog.find((item) => item.sourceSeriesIds.includes(seriesId))?.view).toBe("UNKNOWN");
    }
  });

  it("keeps ambiguous view conflicts unknown and never chains an inferred view as an anchor", () => {
    const rotated = (angleDegrees: number) => {
      const angle = angleDegrees * Math.PI / 180;
      return geometry(0, {
        rowCosines: [Math.cos(angle), Math.sin(angle), 0],
        columnCosines: [-Math.sin(angle), Math.cos(angle), 0],
      });
    };
    const ambiguous = buildCollections([
      frame("amb-sax", { seriesId: "AMB-SAX", seriesDescription: "SAX Cine", protocolName: "CMR SAX cine", sequenceName: "", geometry: rotated(0), triggerMs: 0 }),
      frame("amb-4ch", { seriesId: "AMB-4CH", seriesDescription: "4CH Cine", protocolName: "CMR 4CH cine", sequenceName: "", geometry: rotated(4), triggerMs: 0 }),
      frame("amb-map", { seriesId: "AMB-MAP", seriesDescription: "T1 Mapping", protocolName: "T1 Mapping", sequenceName: "", geometry: rotated(2) }),
    ]);
    expect(ambiguous.find((item) => item.sourceSeriesIds.includes("AMB-MAP"))?.view).toBe("UNKNOWN");

    const chained = buildCollections([
      frame("chain-anchor", { seriesId: "CHAIN-SAX", seriesDescription: "SAX Cine", protocolName: "CMR SAX cine", sequenceName: "", geometry: rotated(0), triggerMs: 0 }),
      frame("chain-map", { seriesId: "CHAIN-MAP", seriesDescription: "T1 Mapping", protocolName: "T1 Mapping", sequenceName: "", geometry: rotated(4) }),
      frame("chain-lge", { seriesId: "CHAIN-LGE", seriesDescription: "sPSIR_CR", protocolName: "Cardiac IR", sequenceName: "", geometry: rotated(8) }),
    ]);
    expect(chained.find((item) => item.sourceSeriesIds.includes("CHAIN-MAP"))?.view).toBe("SAX");
    expect(chained.find((item) => item.sourceSeriesIds.includes("CHAIN-LGE"))?.view).toBe("UNKNOWN");
  });

  it("classifies dynamic sTFE multiplane acquisitions as perfusion even when TriggerTime varies", () => {
    const frames: FrameDescriptor[] = [];
    for (let plane = 0; plane < 3; plane += 1) {
      for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
        frames.push(frame(`perf-${plane}-${frameIndex}`, {
          seriesDescription: "DYN_sTFE_Multi-Plane_BH",
          protocolName: "Dynamic perfusion",
          geometry: geometry(plane * 8),
          triggerMs: frameIndex * 80,
        }));
      }
    }
    const [collection] = buildCollections(frames);
    expect(collection).toMatchObject({ kind: "perfusion", axisKind: "acquisition", phaseMatching: "none" });
    expect(collection.planes.every((plane) => plane.phases.length === 0)).toBe(true);

    const triggerOnly = buildCollections([
      frame("trigger-a", { seriesDescription: "Unknown acquisition", protocolName: "", sequenceName: "", triggerMs: 0 }),
      frame("trigger-b", { seriesDescription: "Unknown acquisition", protocolName: "", sequenceName: "", triggerMs: 80 }),
    ])[0];
    expect(triggerOnly.kind).toBe("other");
    expect(triggerOnly.phaseMatching).toBe("none");
  });

  it("groups 11 SAX positions with per-plane TriggerTime when TemporalPosition is constant", () => {
    const frames: FrameDescriptor[] = [];
    for (let plane = 0; plane < 11; plane += 1) {
      for (let phase = 0; phase < 25; phase += 1) {
        frames.push(frame(`p${plane}-t${phase}`, {
          frameNumber: phase + 1,
          instanceNumber: plane * 25 + phase + 1,
          geometry: geometry(plane * 8),
          temporalPosition: 1,
          triggerMs: plane * 37 + phase * 28,
        }));
      }
    }
    const [collection] = buildCollections(frames);
    expect(collection.view).toBe("SAX");
    expect(collection.kind).toBe("cine");
    expect(collection.planes).toHaveLength(11);
    expect(collection.planes.every((plane) => plane.frameIds.length === 25)).toBe(true);
    expect(collection.phaseMatching).toBe("approximate");
    expect(phaseAt(collection, 4, 12)).toBeCloseTo(12 / 25, 8);
    expect(frameIndexAtPhase(collection, 9, phaseAt(collection, 4, 12))).toBe(12);
  });

  it("preserves complete TriggerTime order when the recorded RR interval is overshot", () => {
    const timesA = [0, 37, 73, 110, 146, 183, 219, 256, 292, 329, 365, 402, 438, 475, 511, 548, 584, 621, 657, 694, 730, 767, 803, 840, 877];
    const timesB = [0, 40, 79, 119, 158, 198, 237, 277, 316, 356, 395, 435, 474, 514, 553, 593, 632, 672, 711, 751, 790, 830, 870, 909, 948];
    const makeFrames = (seriesId: string, times: number[], rrMs: number): FrameDescriptor[] => times.map((triggerMs, index) => {
      const frameNumber = index + 1;
      return frame(`${seriesId}-F${String(frameNumber).padStart(2, "0")}`, {
        seriesId,
        seriesDescription: "2CH Cine bSSFP",
        protocolName: "CMR CINE 2CH",
        frameNumber,
        instanceNumber: frameNumber,
        temporalPosition: 1,
        triggerMs,
        rrMs,
      });
    });
    const collections = buildCollections([
      ...makeFrames("2CH-A", timesA, 860).reverse(),
      ...makeFrames("2CH-B", timesB, 805).reverse(),
    ]);

    for (const [seriesId, times] of [["2CH-A", timesA], ["2CH-B", timesB]] as const) {
      const collection = collections.find((item) => item.sourceSeriesIds.includes(seriesId))!;
      const expectedIds = times.map((_, index) => `${seriesId}-F${String(index + 1).padStart(2, "0")}`);
      expect(collection.planes).toHaveLength(1);
      expect(collection.planes[0].frameIds).toEqual(expectedIds);
      expect(collection.planes[0].frameIds).toHaveLength(25);
      expect(collection.planes[0].phases).toEqual(times.map((_, index) => index / 25));
      expect(collection.phaseMatching).toBe("approximate");
    }
  });

  it("uses measured phases only for monotonic TriggerTime values inside valid RR intervals", () => {
    const times = [0, 100, 200, 300];
    const valid = buildCollections(times.map((triggerMs, index) => frame(`rr-valid-${index}`, {
      seriesId: "RR-VALID",
      seriesDescription: "2CH Cine bSSFP",
      protocolName: "CMR CINE 2CH",
      frameNumber: index + 1,
      temporalPosition: 1,
      triggerMs,
      rrMs: 1000,
    })))[0];
    expect(valid.planes[0].frameIds).toEqual(["rr-valid-0", "rr-valid-1", "rr-valid-2", "rr-valid-3"]);
    expect(valid.planes[0].phases).toEqual([0, 0.1, 0.2, 0.3]);
    expect(valid.phaseMatching).toBe("measured");

    const missingRr = buildCollections(times.map((triggerMs, index) => frame(`rr-missing-${index}`, {
      seriesId: "RR-MISSING",
      seriesDescription: "2CH Cine bSSFP",
      protocolName: "CMR CINE 2CH",
      frameNumber: index + 1,
      temporalPosition: 1,
      triggerMs,
    })))[0];
    expect(missingRr.planes[0].frameIds).toEqual(["rr-missing-0", "rr-missing-1", "rr-missing-2", "rr-missing-3"]);
    expect(missingRr.planes[0].phases).toEqual([0, 0.25, 0.5, 0.75]);
    expect(missingRr.phaseMatching).toBe("approximate");
  });

  it("uses ordinal phases instead of wrapping negative or nonmonotonic RR-normalized triggers", () => {
    const cases: Array<{ id: string; triggers: number[]; rr: number[] }> = [
      { id: "negative", triggers: [-10, 0, 50], rr: [1000, 1000, 1000] },
      { id: "conflict", triggers: [0, 100, 200], rr: [1000, 250, 1000] },
    ];
    for (const item of cases) {
      const collection = buildCollections(item.triggers.map((triggerMs, index) => frame(`${item.id}-${index}`, {
        seriesId: item.id,
        seriesDescription: "2CH Cine bSSFP",
        protocolName: "CMR CINE 2CH",
        frameNumber: index + 1,
        temporalPosition: 1,
        triggerMs,
        rrMs: item.rr[index],
      })))[0];
      expect(collection.planes[0].frameIds).toEqual(item.triggers.map((_, index) => `${item.id}-${index}`));
      expect(collection.planes[0].phases).toEqual(item.triggers.map((_, index) => index / item.triggers.length));
      expect(collection.phaseMatching).toBe("approximate");
    }
  });

  it("keeps a known missing cardiac slot visible and resolvable as an empty frame", () => {
    const frames = [1, 2, 4].map((position) => frame(`t${position}`, {
      temporalPosition: position,
      triggerMs: undefined,
    }));
    const [collection] = buildCollections(frames);
    expect(collection.planes[0].frameIds).toEqual(["t1", "t2", null, "t4"]);
    expect(phaseAt(collection, 0, 2)).toBeCloseTo(0.5, 8);
    expect(frameIndexAtPhase(collection, 0, 0.5)).toBe(2);
    const resolved = resolveFrame({
      id: "c",
      collections: [collection],
      frames: Object.fromEntries(frames.map((item) => [item.id, item])),
      report: { acceptedInstances: 3, acceptedFrames: 3, skippedObjects: 0, failedFiles: 0, warnings: [] },
    }, { collectionId: collection.id, planeIndex: 0, frameIndex: 2 });
    expect(resolved?.descriptor).toBeNull();
  });

  it("treats TI-varying MOLLI source images as mapping parameters, not Cine phases", () => {
    const frames = [100, 250, 450, 700].map((ti, index) => frame(`m${index}`, {
      seriesId: "MOLLI",
      seriesDescription: "SAX T1 MOLLI Mapping",
      parameters: { tiMs: ti },
      triggerMs: index * 100,
      geometry: geometry(0),
    }));
    const [collection] = buildCollections(frames);
    expect(collection.kind).toBe("mapping");
    expect(collection.axisKind).toBe("parameter");
    expect(collection.axisLabel).toContain("Inversion time");
    expect(collection.planes[0].frameIds).toEqual(["m0", "m1", "m2", "m3"]);
    expect(collection.planes[0].phases).toEqual([]);
    expect(collection.phaseMatching).toBe("none");
  });

  it("keeps mixed acquisitions apart and merges only disjoint, protocol-matched series", () => {
    const distinct = [
      frame("a", { seriesId: "A", protocolName: "same", geometry: geometry(8) }),
      frame("b", { seriesId: "B", protocolName: "same", geometry: geometry(0) }),
      frame("c", { seriesId: "C", protocolName: "", seriesDescription: "T1 MOLLI Map", geometry: geometry(16) }),
    ];
    const collections = buildCollections(distinct);
    expect(collections).toHaveLength(2);
    const combined = collections.find((collection) => collection.sourceSeriesIds.length === 2)!;
    expect(combined.planes).toHaveLength(2);
    expect(combined.planes.map((plane) => plane.positionMm)).toEqual([0, 8]);
    expect(combined.sourceSeriesIds).toEqual(["A", "B"]);
    expect(collections.find((collection) => collection.sourceSeriesIds.includes("C"))?.kind).toBe("mapping");

    const repeated = buildCollections([
      frame("r1", { seriesId: "R1", protocolName: "same", geometry: geometry(0) }),
      frame("r2", { seriesId: "R2", protocolName: "same", geometry: geometry(0) }),
    ]);
    expect(repeated).toHaveLength(2);
  });

  it("keeps automatic SAX Cine merges separate when recorded acquisition parameters or photometric differ", () => {
    const cases: Array<[string, FrameDescriptor, FrameDescriptor]> = [
      ["different TE", frame("te-a", { seriesId: "TE-A", geometry: geometry(0), parameters: { trMs: 30, teMs: 1.2 } }),
        frame("te-b", { seriesId: "TE-B", geometry: geometry(8), parameters: { trMs: 30, teMs: 2.4 } })],
      ["one missing TE", frame("missing-te-a", { seriesId: "MISSING-TE-A", geometry: geometry(0) }),
        frame("missing-te-b", { seriesId: "MISSING-TE-B", geometry: geometry(8), parameters: { teMs: 2.4 } })],
      ["different photometric", frame("photo-a", { seriesId: "PHOTO-A", geometry: geometry(0) }),
        frame("photo-b", { seriesId: "PHOTO-B", geometry: geometry(8), photometric: "MONOCHROME1" })],
    ];

    for (const [label, first, second] of cases) {
      expect(buildCollections([first, second]), label).toHaveLength(2);
    }
  });

  it("keeps compatible non-SAX Cine series separate for manual review", () => {
    const collections = buildCollections([
      frame("2ch-a", { seriesId: "2CH-A", seriesDescription: "2CH Cine bSSFP", protocolName: "CMR CINE 2CH", geometry: geometry(0) }),
      frame("2ch-b", { seriesId: "2CH-B", seriesDescription: "2CH Cine bSSFP", protocolName: "CMR CINE 2CH", geometry: geometry(8) }),
    ]);

    expect(collections).toHaveLength(2);
    expect(collections.every((collection) => collection.view === "2CH" && collection.sourceSeriesIds.length === 1)).toBe(true);
  });

  it("manually merges distinct planes with provenance and can split by source Series", () => {
    const frames = [
      frame("s1", { seriesId: "S1", protocolName: "", geometry: geometry(0) }),
      frame("s2", { seriesId: "S2", protocolName: "", geometry: geometry(20) }),
    ];
    const catalog = catalogFor(frames);
    expect(catalog.collections).toHaveLength(2);
    const merged = mergeCollections(catalog, catalog.collections.map((collection) => collection.id));
    expect(merged.collections).toHaveLength(1);
    expect(merged.collections[0].sourceSeriesIds).toEqual(["S1", "S2"]);
    expect(merged.collections[0].warnings.some((warning) => warning.includes("provenance"))).toBe(true);
    const split = splitCollection(merged, merged.collections[0].id);
    expect(split.collections).toHaveLength(2);
    expect(split.collections.map((collection) => collection.sourceSeriesIds[0]).sort()).toEqual(["S1", "S2"]);
    expect(catalog.collections).toHaveLength(2);
  });

  it("rejects manual merges across Frames of Reference or repeated physical planes", () => {
    const mismatch = catalogFor([
      frame("f1", { seriesId: "F1", protocolName: "", geometry: geometry(0) }),
      frame("f2", { seriesId: "F2", protocolName: "", geometry: geometry(8, { frameOfReferenceUid: "FOR-2" }) }),
    ]);
    expect(() => mergeCollections(mismatch, mismatch.collections.map((collection) => collection.id))).toThrow(/Frames of Reference/);

    const duplicate = catalogFor([
      frame("d1", { seriesId: "D1", protocolName: "", geometry: geometry(0) }),
      frame("d2", { seriesId: "D2", protocolName: "", geometry: geometry(0) }),
    ]);
    expect(() => mergeCollections(duplicate, duplicate.collections.map((collection) => collection.id))).toThrow(/same physical plane/);
  });
});
