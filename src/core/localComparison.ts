import type { CmrCollection, StudyCatalog, ViewLabel } from "./types";

/** Teaching-view labels are suggestions, never a spatial registration. */
export function comparisonViewLabel(viewId: string): ViewLabel | null {
  if (viewId.startsWith("sax-")) return "SAX";
  const labels: Record<string, ViewLabel> = {
    "2ch": "2CH", "3ch": "3CH", "4ch": "4CH", lvot: "LVOT", rvot: "RVOT",
    "scout-axial": "AXIAL",
  };
  return labels[viewId] ?? null;
}

export function recommendComparisonCollection(catalog: StudyCatalog, viewId: string): CmrCollection | undefined {
  const label = comparisonViewLabel(viewId);
  if (!label) return undefined;
  const candidates = catalog.collections.filter((collection) => collection.view === label
    && (label === "AXIAL" ? collection.kind === "localizer" : collection.kind === "cine"));
  if (label !== "SAX") return candidates.find((collection) => collection.planes.some((plane) => plane.frameIds.some(Boolean)));

  // Prefer actual stack coverage; empty slots must not outrank a useful Cine stack.
  // Strictly greater preserves directory order when two candidates cover equal layers.
  let recommendation: CmrCollection | undefined;
  let coverage = 0;
  for (const candidate of candidates) {
    const usablePlanes = candidate.planes.filter((plane) => plane.frameIds.some(Boolean)).length;
    if (usablePlanes > coverage) {
      recommendation = candidate;
      coverage = usablePlanes;
    }
  }
  return recommendation;
}

/** DICOM order alone cannot identify the basal/apical anatomical level. */
export function initialComparisonPlane(collection?: CmrCollection): number {
  return collection?.view === "SAX" ? Math.floor(Math.max(0, collection.planes.length - 1) / 2) : 0;
}
