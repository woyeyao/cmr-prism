import { describe, expect, it } from "vitest";
import { comparisonViewLabel, initialComparisonPlane, recommendComparisonCollection } from "./localComparison";
import type { CmrCollection, StudyCatalog, ViewLabel } from "./types";

function collection(id: string, view: ViewLabel, kind: CmrCollection["kind"] = "cine", count = 1): CmrCollection {
  return { id, view, kind, studyUid: "synthetic", label: id, axisKind: "cardiac", axisLabel: "心动相位",
    sourceSeriesIds: [id], phaseMatching: "none", defaultWindow: { center: 100, width: 200 }, warnings: [],
    planes: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, positionMm: index,
      frameIds: [`${id}-${index}-f0`], phases: [0] })) };
}
const catalog = (collections: CmrCollection[]): StudyCatalog => ({ id: "synthetic", collections, frames: {},
  report: { acceptedInstances: 0, acceptedFrames: 0, skippedObjects: 0, failedFiles: 0, warnings: [] } });

describe("local atlas comparison", () => {
  it("suggests an explicitly labelled cine instead of a similarly named sequence", () => {
    const entries = [collection("lge-four", "4CH", "lge"), collection("four", "4CH")];
    expect(recommendComparisonCollection(catalog(entries), "4ch")?.id).toBe("four");
    expect(recommendComparisonCollection(catalog([entries[0]]), "4ch")).toBeUndefined();
    expect(recommendComparisonCollection(catalog([collection("three", "3CH")]), "lvot")).toBeUndefined();
  });
  it("does not present preliminary scouts or right inflow/outflow as confirmed long-axis views", () => {
    for (const view of ["p2ch", "p4ch", "rv-inout", "scout-coronal", "scout-sagittal", "missing"]) {
      expect(comparisonViewLabel(view)).toBeNull();
    }
  });
  it("starts all SAX comparisons at the directory middle without guessing basal/apical order", () => {
    const sax = collection("short", "SAX", "cine", 11);
    for (const view of ["sax-basal", "sax-mid", "sax-apical"]) {
      expect(recommendComparisonCollection(catalog([sax]), view)).toBe(sax);
      expect(initialComparisonPlane(sax)).toBe(5);
    }
    expect(initialComparisonPlane(collection("long", "4CH", "cine", 3))).toBe(0);
  });
  it("prefers a complete SAX stack over a single-plane Cine listed first", () => {
    const single = collection("single-short", "SAX");
    const stack = collection("short-stack", "SAX", "cine", 11);
    for (const view of ["sax-basal", "sax-mid", "sax-apical"]) {
      expect(recommendComparisonCollection(catalog([single, stack]), view)).toBe(stack);
    }
  });
  it("counts usable SAX layers and preserves directory order for equal coverage", () => {
    const sparse = collection("mostly-empty", "SAX", "cine", 20);
    sparse.planes.slice(1).forEach((plane, index) => { plane.frameIds = index % 2 ? [] : [null, null]; });
    const firstStack = collection("first-stack", "SAX", "cine", 3);
    const secondStack = collection("second-stack", "SAX", "cine", 3);
    expect(recommendComparisonCollection(catalog([sparse, firstStack, secondStack]), "sax-mid")).toBe(firstStack);
    expect(recommendComparisonCollection(catalog([sparse, secondStack, firstStack]), "sax-mid")).toBe(secondStack);
    sparse.planes[0].frameIds = [null];
    expect(recommendComparisonCollection(catalog([sparse]), "sax-mid")).toBeUndefined();
  });
  it("does not recommend an empty collection and selects explicit localizers for axial reference", () => {
    const empty = collection("empty", "4CH"); empty.planes[0].frameIds = [null];
    expect(recommendComparisonCollection(catalog([empty]), "4ch")).toBeUndefined();
    const axial = collection("axial", "AXIAL", "localizer");
    expect(recommendComparisonCollection(catalog([collection("cine-axial", "AXIAL"), axial]), "scout-axial")).toBe(axial);
  });
});
