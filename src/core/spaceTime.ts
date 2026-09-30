import type {
  AxisKind,
  CmrCollection,
  CmrPlane,
  FrameDescriptor,
  PlaneGeometry,
  ReferenceLine,
  ResolvedFrame,
  SequenceKind,
  StudyCatalog,
  Vec3,
  ViewLabel,
  ViewerCursor,
} from "./types";
import { inferGeometryViews } from "./viewInference";

const PLANE_TOLERANCE_MM = 0.5;
const ORIENTATION_DOT_TOLERANCE = 0.9995;
const PHASE_EPSILON = 1e-9;

type Vector2 = [number, number];
type Interval = [number, number];
type PhaseMatch = "measured" | "approximate" | "none";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, amount: number): Vec3 {
  return [a[0] * amount, a[1] * amount, a[2] * amount];
}

function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}

function normalize(a: Vec3): Vec3 | null {
  const size = length(a);
  if (!finite(size) || size < 1e-12) return null;
  return scale(a, 1 / size);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function geometryValid(g: PlaneGeometry | undefined): g is PlaneGeometry {
  return !!g &&
    g.origin.every(finite) &&
    g.rowCosines.every(finite) &&
    g.columnCosines.every(finite) &&
    finite(g.pixelSpacing[0]) && g.pixelSpacing[0] > 0 &&
    finite(g.pixelSpacing[1]) && g.pixelSpacing[1] > 0 &&
    finite(g.rows) && g.rows > 0 &&
    finite(g.columns) && g.columns > 0 &&
    !!normalize(cross(g.rowCosines, g.columnCosines));
}

/** Pixel tuple is SVG/display order [column, row]. DICOM IOP's first vector runs along columns; PixelSpacing is [row, column]. */
export function pixelToPatient(geometry: PlaneGeometry, pixel: [number, number]): Vec3 {
  const [column, row] = pixel;
  const rowOffset = scale(geometry.columnCosines, row * geometry.pixelSpacing[0]);
  const columnOffset = scale(geometry.rowCosines, column * geometry.pixelSpacing[1]);
  return add(geometry.origin, add(rowOffset, columnOffset));
}

export function patientToPixel(geometry: PlaneGeometry, patient: Vec3): [number, number] {
  const displacement = sub(patient, geometry.origin);
  const rowLengthSquared = dot(geometry.columnCosines, geometry.columnCosines);
  const columnLengthSquared = dot(geometry.rowCosines, geometry.rowCosines);
  if (rowLengthSquared < 1e-12 || columnLengthSquared < 1e-12) return [Number.NaN, Number.NaN];
  return [
    dot(displacement, geometry.rowCosines) / columnLengthSquared / geometry.pixelSpacing[1],
    dot(displacement, geometry.columnCosines) / rowLengthSquared / geometry.pixelSpacing[0],
  ];
}

export function planeNormal(geometry: PlaneGeometry): Vec3 {
  return normalize(cross(geometry.rowCosines, geometry.columnCosines)) ?? [Number.NaN, Number.NaN, Number.NaN];
}

export function planeCorners(geometry: PlaneGeometry): Vec3[] {
  if (!geometryValid(geometry)) return [];
  // ImagePositionPatient marks the first pixel centre, so the finite image edges are half a pixel beyond it.
  const firstRow = -0.5;
  const lastRow = Math.max(0, geometry.rows - 1) + 0.5;
  const firstColumn = -0.5;
  const lastColumn = Math.max(0, geometry.columns - 1) + 0.5;
  return [
    pixelToPatient(geometry, [firstColumn, firstRow]),
    pixelToPatient(geometry, [lastColumn, firstRow]),
    pixelToPatient(geometry, [lastColumn, lastRow]),
    pixelToPatient(geometry, [firstColumn, lastRow]),
  ];
}

function planeCoordinate(g: PlaneGeometry): number {
  return dot(g.origin, planeNormal(g));
}

function lineIntervalInGeometry(point: Vec3, direction: Vec3, geometry: PlaneGeometry): Interval | null {
  const originPixel = patientToPixel(geometry, point);
  const delta = [
    dot(direction, geometry.rowCosines) / dot(geometry.rowCosines, geometry.rowCosines) / geometry.pixelSpacing[1],
    dot(direction, geometry.columnCosines) / dot(geometry.columnCosines, geometry.columnCosines) / geometry.pixelSpacing[0],
  ] as Vector2;
  const bounds: [number, number, number, number] = [-0.5, Math.max(0, geometry.columns - 1) + 0.5, -0.5, Math.max(0, geometry.rows - 1) + 0.5];
  let low = Number.NEGATIVE_INFINITY;
  let high = Number.POSITIVE_INFINITY;

  for (const [coordinate, slope, min, max] of [
    [originPixel[0], delta[0], bounds[0], bounds[1]],
    [originPixel[1], delta[1], bounds[2], bounds[3]],
  ] as Array<[number, number, number, number]>) {
    if (Math.abs(slope) < 1e-12) {
      if (coordinate < min - 1e-8 || coordinate > max + 1e-8) return null;
      continue;
    }
    const a = (min - coordinate) / slope;
    const b = (max - coordinate) / slope;
    low = Math.max(low, Math.min(a, b));
    high = Math.min(high, Math.max(a, b));
    if (low > high + 1e-8) return null;
  }
  return finite(low) && finite(high) ? [low, high] : null;
}

/** Returns the crosshair segment in target pixel coordinates, clipped to both images. */
export function referenceLine(source: PlaneGeometry, target: PlaneGeometry): ReferenceLine | null {
  if (!geometryValid(source) || !geometryValid(target)) return null;
  if (!source.frameOfReferenceUid || source.frameOfReferenceUid !== target.frameOfReferenceUid) return null;

  const sourceNormal = planeNormal(source);
  const targetNormal = planeNormal(target);
  const directionRaw = cross(sourceNormal, targetNormal);
  const directionSizeSquared = dot(directionRaw, directionRaw);
  if (directionSizeSquared < 1e-12) return null;

  const sourceD = dot(sourceNormal, source.origin);
  const targetD = dot(targetNormal, target.origin);
  const point = scale(
    add(scale(cross(targetNormal, directionRaw), sourceD), scale(cross(directionRaw, sourceNormal), targetD)),
    1 / directionSizeSquared,
  );
  const direction = normalize(directionRaw);
  if (!direction) return null;

  const sourceInterval = lineIntervalInGeometry(point, direction, source);
  const targetInterval = lineIntervalInGeometry(point, direction, target);
  if (!sourceInterval || !targetInterval) return null;
  const low = Math.max(sourceInterval[0], targetInterval[0]);
  const high = Math.min(sourceInterval[1], targetInterval[1]);
  if (!finite(low) || !finite(high) || high - low < 1e-8) return null;

  const fromPatient = add(point, scale(direction, low));
  const toPatient = add(point, scale(direction, high));
  const from = patientToPixel(target, fromPatient);
  const to = patientToPixel(target, toPatient);
  if (![...from, ...to].every(finite)) return null;
  return { from, to };
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function descriptionText(frames: FrameDescriptor[]): string {
  return frames.map((frame) => [frame.seriesDescription, frame.protocolName, frame.sequenceName, ...frame.imageType].filter(Boolean).join(" ")).join(" ").toLowerCase();
}

function classifyView(text: string): ViewLabel {
  const normalized = text.replace(/[_-]+/g, " ");
  if (/\b(sax|short\s*axis|sa)\b/.test(normalized)) return "SAX";
  if (/\b(2\s*ch|2\s*chamber|two\s*chamber|2ch)\b/.test(normalized)) return "2CH";
  if (/\b(3\s*ch|3\s*chamber|three\s*chamber|3ch)\b/.test(normalized)) return "3CH";
  if (/\b(4\s*ch|4\s*chamber|four\s*chamber|4ch)\b/.test(normalized)) return "4CH";
  if (/\b(lvot|left\s*ventricular\s*outflow)\b/.test(normalized)) return "LVOT";
  if (/\b(rvot|right\s*ventricular\s*outflow)\b/.test(normalized)) return "RVOT";
  if (/\b(axial|transverse)\b/.test(normalized)) return "AXIAL";
  return "UNKNOWN";
}

function classifyKind(text: string, frames: FrameDescriptor[]): SequenceKind {
  const normalized = text.replace(/[_-]+/g, " ");
  if (/\b(mapping|map|molli|shmolli|sasha|t1\s*map|t2\s*map|t1.?t2\s*map|parametric)\b/.test(normalized)) return "mapping";
  if (isLookLockerOrTiScoutName(normalized)) return "localizer";
  if (/\b(locali[sz]er|scout|survey|locator|planning)\b/.test(normalized)) return "localizer";
  if (/\b(perfusion|first.?pass|stress perf|myocardial blood flow)\b/.test(normalized) || /\b(?:dyn|dynamic)\b.*\bstfe\b.*\bmulti\s*plane\b/.test(normalized)) return "perfusion";
  if (/\b(lge|late gadolinium|s?psir|phase sensitive|ir.?gre|inversion recovery)\b/.test(normalized)) return "lge";
  if (/\b(cine|b.?ssfp|balanced ssfp|truefisp|fiesta|bffe)\b/.test(normalized)) return "cine";
  const cardiacDimensionFields: Array<(frame: FrameDescriptor) => number | undefined> = [
    (frame) => finite(frame.temporalPosition) ? frame.temporalPosition : undefined,
    (frame) => finite(frame.nominalPhase) ? frame.nominalPhase : undefined,
    temporalDimensionValue,
  ];
  const dynamic = createGeometryGroups(frames).some((orientationGroup) => positionGroups(orientationGroup).some((plane) =>
    cardiacDimensionFields.some((field) => new Set(plane.frames.map(field).filter(finite)).size > 1),
  ));
  return dynamic ? "cine" : "other";
}

function isLookLockerOrTiScoutName(normalized: string): boolean {
  const hasLookLocker = /\blook\s*locker\b/.test(normalized);
  const hasTiScout = /\bti\b.*\bscout\b|\bscout\b.*\bti\b/.test(normalized);
  const hasIndependentLl = /\bll\b/.test(normalized);
  const hasIrTfeOrPsir = /\b(?:ir|tfe|s?psir)\b/.test(normalized);
  return hasLookLocker || hasTiScout || (hasIndependentLl && hasIrTfeOrPsir);
}

function isTemporalDimensionKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("acquisition")) return false;
  return normalized.includes("temporalposition") || normalized.includes("cardiacphase") || normalized.includes("cardiaccycleposition") || normalized.includes("phaseindex");
}

function classifyAxis(kind: SequenceKind, planeFrames: FrameDescriptor[][]): { axisKind: AxisKind; axisLabel: string } {
  if (kind === "cine") return { axisKind: "cardiac", axisLabel: "Cardiac phase" };
  if (kind === "perfusion") return { axisKind: "acquisition", axisLabel: "Acquisition time" };
  if (kind === "mapping") {
    const all = planeFrames.flat();
    const ti = new Set(all.map((frame) => frame.parameters.tiMs).filter(finite));
    const te = new Set(all.map((frame) => frame.parameters.teMs).filter(finite));
    if (ti.size > 1) return { axisKind: "parameter", axisLabel: "Inversion time (ms)" };
    if (te.size > 1) return { axisKind: "parameter", axisLabel: "Echo time (ms)" };
    return { axisKind: "static", axisLabel: "Map source" };
  }
  if (kind === "localizer") return { axisKind: "acquisition", axisLabel: "Localizer frame" };
  return { axisKind: "static", axisLabel: "Frame" };
}

function normalFor(g: PlaneGeometry): Vec3 | null {
  return normalize(cross(g.rowCosines, g.columnCosines));
}

function geometryClusterCompatible(a: FrameDescriptor, b: FrameDescriptor): boolean {
  const ga = a.geometry;
  const gb = b.geometry;
  if (!geometryValid(ga) || !geometryValid(gb)) return false;
  if (ga.frameOfReferenceUid !== gb.frameOfReferenceUid || a.rows !== b.rows || a.columns !== b.columns) return false;
  if (Math.abs(ga.pixelSpacing[0] - gb.pixelSpacing[0]) > 0.01 || Math.abs(ga.pixelSpacing[1] - gb.pixelSpacing[1]) > 0.01) return false;
  if (Math.abs(ga.thickness - gb.thickness) > 0.01) return false;
  const rowA = normalize(ga.rowCosines);
  const rowB = normalize(gb.rowCosines);
  const colA = normalize(ga.columnCosines);
  const colB = normalize(gb.columnCosines);
  return !!rowA && !!rowB && !!colA && !!colB && dot(rowA, rowB) >= ORIENTATION_DOT_TOLERANCE && dot(colA, colB) >= ORIENTATION_DOT_TOLERANCE;
}

function createGeometryGroups(frames: FrameDescriptor[]): FrameDescriptor[][] {
  const groups: FrameDescriptor[][] = [];
  const withoutGeometry: FrameDescriptor[] = [];
  for (const frame of frames) {
    if (!geometryValid(frame.geometry)) {
      withoutGeometry.push(frame);
      continue;
    }
    const group = groups.find((candidate) => geometryClusterCompatible(candidate[0], frame));
    if (group) group.push(frame);
    else groups.push([frame]);
  }
  if (withoutGeometry.length) groups.push(withoutGeometry);
  return groups;
}

function positionGroups(frames: FrameDescriptor[]): Array<{ positionMm: number; geometry?: PlaneGeometry; frames: FrameDescriptor[] }> {
  const geometric = frames.filter((frame) => geometryValid(frame.geometry));
  if (geometric.length !== frames.length) {
    return [{ positionMm: 0, frames: sortStaticFrames(frames) }];
  }
  if (!frames.length) return [];
  const referenceNormal = normalFor(frames[0].geometry!);
  if (!referenceNormal) return [{ positionMm: 0, frames: sortStaticFrames(frames) }];
  const ordered = frames.map((frame) => ({ frame, coordinate: dot(frame.geometry!.origin, referenceNormal) })).sort((a, b) => a.coordinate - b.coordinate || compareFrameIdentity(a.frame, b.frame));
  const groups: Array<{ positionMm: number; geometry?: PlaneGeometry; frames: FrameDescriptor[]; total: number }> = [];
  for (const item of ordered) {
    const tail = groups[groups.length - 1];
    if (tail && Math.abs(item.coordinate - tail.positionMm) <= PLANE_TOLERANCE_MM) {
      tail.frames.push(item.frame);
      tail.total += item.coordinate;
      tail.positionMm = tail.total / tail.frames.length;
    } else {
      groups.push({ positionMm: item.coordinate, geometry: item.frame.geometry, frames: [item.frame], total: item.coordinate });
    }
  }
  return groups.map(({ total: _total, ...group }) => group);
}

function compareFrameIdentity(a: FrameDescriptor, b: FrameDescriptor): number {
  return (a.instanceNumber ?? Number.MAX_SAFE_INTEGER) - (b.instanceNumber ?? Number.MAX_SAFE_INTEGER) || a.frameNumber - b.frameNumber || a.id.localeCompare(b.id);
}

function sortStaticFrames(frames: FrameDescriptor[]): FrameDescriptor[] {
  return [...frames].sort((a, b) => compareFrameIdentity(a, b));
}

function temporalDimensionValue(frame: FrameDescriptor): number | undefined {
  for (const [key, value] of Object.entries(frame.dimensionValues ?? {})) {
    if (isTemporalDimensionKey(key) && finite(value)) return value;
  }
  return undefined;
}

function sparseIndexTimeline(frames: FrameDescriptor[]): { ids: Array<string | null>; phases: number[]; matching: PhaseMatch } | null {
  const values = frames.map((frame) => finite(temporalDimensionValue(frame)) ? temporalDimensionValue(frame)! : frame.temporalPosition);
  if (values.some((value) => !finite(value)) || new Set(values as number[]).size < 2) return null;
  const numericValues = values as number[];
  const min = Math.min(...numericValues);
  const max = Math.max(...numericValues);
  const integerLike = numericValues.every((value) => Math.abs(value - Math.round(value)) < 1e-5);
  const range = integerLike ? Math.round(max - min + 1) : new Set(numericValues).size;
  if (range < 1 || range > 512) return null;
  const ids = Array<string | null>(range).fill(null);
  const phases = Array.from({ length: range }, (_, index) => index / range);
  const extras: Array<{ frame: FrameDescriptor; phase: number }> = [];
  frames.forEach((frame, index) => {
    const value = numericValues[index];
    const slot = integerLike ? Math.round(value - min) : [...new Set(numericValues)].sort((a, b) => a - b).indexOf(value);
    if (slot < 0 || slot >= range) return;
    if (ids[slot] === null) ids[slot] = frame.id;
    else extras.push({ frame, phase: phases[slot] });
  });
  const phaseArray = [...phases, ...extras.map((extra) => extra.phase)];
  return { ids: [...ids, ...extras.map((extra) => extra.frame.id)], phases: phaseArray, matching: "approximate" };
}

function normalizedOrdinalTimeline(frames: FrameDescriptor[], sortBy: (a: FrameDescriptor, b: FrameDescriptor) => number, matching: PhaseMatch): { ids: Array<string | null>; phases: number[]; matching: PhaseMatch } {
  const ordered = [...frames].sort(sortBy);
  const phases = ordered.map((_, index) => ordered.length > 1 ? index / ordered.length : Number.NaN);
  return { ids: ordered.map((frame) => frame.id), phases, matching };
}

function nominalPhaseTimeline(frames: FrameDescriptor[]): { ids: Array<string | null>; phases: number[]; matching: PhaseMatch } | null {
  if (frames.length < 2 || frames.some((frame) => !finite(frame.nominalPhase))) return null;
  const values = frames.map((frame) => frame.nominalPhase!);
  if (new Set(values).size < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const scaleBy = max <= 1.000001 ? 1 : 100;
  const ordered = [...frames].sort((a, b) => a.nominalPhase! - b.nominalPhase! || compareFrameIdentity(a, b));
  return { ids: ordered.map((frame) => frame.id), phases: ordered.map((frame) => {
    const raw = frame.nominalPhase! / scaleBy;
    return ((raw % 1) + 1) % 1;
  }), matching: "measured" };
}

function triggerTimeline(frames: FrameDescriptor[]): { ids: Array<string | null>; phases: number[]; matching: PhaseMatch } | null {
  if (frames.length < 2 || frames.some((frame) => !finite(frame.triggerMs))) return null;
  const ordered = [...frames].sort((a, b) => a.triggerMs! - b.triggerMs! || compareFrameIdentity(a, b));
  const measuredPhases = ordered.map((frame) => frame.triggerMs! / (frame.rrMs ?? Number.NaN));
  const hasUsableRr = ordered.every((frame) =>
    finite(frame.rrMs) && frame.rrMs! > 0 && frame.triggerMs! >= 0 && frame.triggerMs! < frame.rrMs!,
  );
  const phasesAreMonotonic = measuredPhases.every((phase, index) => index === 0 || phase >= measuredPhases[index - 1]);
  if (hasUsableRr && new Set(ordered.map((frame) => frame.triggerMs)).size > 1 && phasesAreMonotonic) {
    return { ids: ordered.map((frame) => frame.id), phases: measuredPhases, matching: "measured" };
  }
  // Keep the original TriggerTime order. If RR normalization would wrap or reorder frames, use
  // local ordinal phase instead of sorting by a modulo-derived phase.
  return { ids: ordered.map((frame) => frame.id), phases: ordered.map((_, index) => index / ordered.length), matching: "approximate" };
}

function timelineForPlane(frames: FrameDescriptor[], kind: SequenceKind): { ids: Array<string | null>; phases: number[]; matching: PhaseMatch } {
  if (kind !== "cine") return { ids: sortForKind(frames, kind).map((frame) => frame.id), phases: [], matching: "none" };
  const sparse = sparseIndexTimeline(frames);
  if (sparse) return sparse;
  const nominal = nominalPhaseTimeline(frames);
  if (nominal) return nominal;
  const trigger = triggerTimeline(frames);
  if (trigger) return trigger;
  const ordered = sortForKind(frames, kind);
  if (ordered.length < 2) return { ids: ordered.map((frame) => frame.id), phases: [Number.NaN].slice(0, ordered.length), matching: "none" };
  return normalizedOrdinalTimeline(ordered, compareFrameIdentity, "approximate");
}

function sortForKind(frames: FrameDescriptor[], kind: SequenceKind): FrameDescriptor[] {
  if (kind === "mapping") {
    const hasTi = frames.some((frame) => finite(frame.parameters.tiMs));
    const hasTe = frames.some((frame) => finite(frame.parameters.teMs));
    const field = hasTi ? "tiMs" : hasTe ? "teMs" : null;
    if (field) return [...frames].sort((a, b) => (a.parameters[field] ?? Number.POSITIVE_INFINITY) - (b.parameters[field] ?? Number.POSITIVE_INFINITY) || compareFrameIdentity(a, b));
  }
  if (kind === "perfusion") return [...frames].sort((a, b) => (a.acquisitionMs ?? a.triggerMs ?? Number.POSITIVE_INFINITY) - (b.acquisitionMs ?? b.triggerMs ?? Number.POSITIVE_INFINITY) || compareFrameIdentity(a, b));
  return sortStaticFrames(frames);
}

function defaultWindow(frames: FrameDescriptor[]): { center: number; width: number } {
  const windows = frames.map((frame) => frame.window).filter((window): window is { center: number; width: number } => !!window && finite(window.center) && finite(window.width) && window.width > 0);
  if (!windows.length) return { center: 0, width: 1 };
  return {
    center: windows.reduce((sum, window) => sum + window.center, 0) / windows.length,
    width: windows.reduce((sum, window) => sum + window.width, 0) / windows.length,
  };
}

function stableId(parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part || "unknown")).join("::");
}

function orientationToken(frames: FrameDescriptor[]): string {
  const geometry = frames.find((frame) => geometryValid(frame.geometry))?.geometry;
  if (!geometry) return "unknown-orientation";
  return [...normalize(geometry.rowCosines)!, ...normalize(geometry.columnCosines)!]
    .map((value) => Math.round(value * 10000))
    .join("_");
}

function collectionForFrames(frames: FrameDescriptor[], forceSeries?: string): CmrCollection {
  const sortedFrames = [...frames].sort(compareFrameIdentity);
  const text = descriptionText(sortedFrames);
  const kind = classifyKind(text, sortedFrames);
  const view = classifyView(text);
  const planeGroups = positionGroups(sortedFrames);
  const planeTimelines = planeGroups.map((group) => timelineForPlane(group.frames, kind));
  const phaseMatching: PhaseMatch = planeTimelines.some((item) => item.matching === "approximate")
    ? "approximate"
    : planeTimelines.some((item) => item.matching === "measured") ? "measured" : "none";
  const orientationId = orientationToken(sortedFrames);
  const seriesId = forceSeries ?? sortedFrames[0]?.seriesId ?? "unknown";
  const planes: CmrPlane[] = planeGroups.map((group, index) => {
    const locationId = geometryValid(group.geometry)
      ? `${orientationId}:${Math.round(group.positionMm * 1000)}`
      : `unknown:${group.frames[0]?.id ?? "empty"}`;
    return {
      id: `plane:${sortedFrames[0]?.studyUid ?? "unknown"}:${seriesId}:${locationId}`,
      positionMm: group.positionMm,
      geometry: group.geometry,
      frameIds: planeTimelines[index].ids,
      phases: planeTimelines[index].phases,
    };
  });
  const { axisKind, axisLabel } = classifyAxis(kind, planeGroups.map((group) => group.frames));
  const baseId = stableId([sortedFrames[0]?.studyUid ?? "unknown", forceSeries ?? sortedFrames[0]?.seriesId ?? "unknown"]);
  const id = stableId([sortedFrames[0]?.studyUid ?? "unknown", forceSeries ?? sortedFrames[0]?.seriesId ?? "unknown", orientationId]);
  const sourceSeriesIds = [...new Set(sortedFrames.map((frame) => frame.seriesId))].sort();
  const warnings: string[] = [];
  if (sortedFrames.some((frame) => !geometryValid(frame.geometry))) warnings.push("Some frames have no usable patient-space geometry; spatial linking is unavailable for those frames.");
  if (view === "UNKNOWN") warnings.push("View was not recognized from the DICOM descriptions and can be labeled manually.");
  if (kind === "localizer" && isLookLockerOrTiScoutName(text.replace(/[_-]+/g, " "))) {
    warnings.push("Sequence naming suggests a Look-Locker/TI scout; verify this classification. No DICOM inversion-time field confirms scout status.");
  }
  if (phaseMatching === "approximate") warnings.push("Cardiac phase was normalized independently within each plane and is approximate.");
  return {
    id,
    studyUid: sortedFrames[0]?.studyUid ?? "",
    label: sortedFrames[0]?.seriesDescription?.trim() || sortedFrames[0]?.protocolName?.trim() || "Unnamed acquisition",
    view,
    kind,
    axisKind,
    axisLabel,
    sourceSeriesIds,
    planes,
    phaseMatching,
    defaultWindow: defaultWindow(sortedFrames),
    warnings,
  };
}

function initialCollections(frames: FrameDescriptor[]): CmrCollection[] {
  const series = new Map<string, FrameDescriptor[]>();
  for (const frame of frames) {
    const key = `${frame.studyUid}\u0000${frame.seriesId}`;
    const bucket = series.get(key) ?? [];
    bucket.push(frame);
    series.set(key, bucket);
  }
  const result: CmrCollection[] = [];
  for (const [, items] of series) {
    const orientationGroups = createGeometryGroups(items);
    orientationGroups.forEach((group) => result.push(collectionForFrames(group)));
  }
  return result;
}

function representativeFrame(collection: CmrCollection, frames: Record<string, FrameDescriptor>): FrameDescriptor | undefined {
  for (const plane of collection.planes) {
    for (const frameId of plane.frameIds) {
      if (frameId && frames[frameId]) return frames[frameId];
    }
  }
  return undefined;
}

function collectionProtocol(frame: FrameDescriptor | undefined): string | null {
  if (!frame) return null;
  const protocol = normalizeText(frame.protocolName);
  if (!protocol) return null;
  return [protocol, normalizeText(frame.sequenceName), normalizeText(frame.seriesDescription)].join("|");
}

function framesForCollection(collection: CmrCollection, frames: Record<string, FrameDescriptor>): FrameDescriptor[] {
  const ids = new Set(collection.planes.flatMap((plane) => plane.frameIds.filter((id): id is string => !!id)));
  return [...ids].map((id) => frames[id]).filter((frame): frame is FrameDescriptor => !!frame);
}

function consistentNumber(
  frames: FrameDescriptor[],
  valueOf: (frame: FrameDescriptor) => number | undefined,
): number | undefined | null {
  let value: number | undefined;
  let hasValue = false;
  let hasMissing = false;
  for (const frame of frames) {
    const current = valueOf(frame);
    if (!finite(current)) {
      hasMissing = true;
      continue;
    }
    if (!hasValue) {
      value = current;
      hasValue = true;
    } else if (Math.abs(value! - current) > 0.001) {
      return null;
    }
  }
  if (hasValue && hasMissing) return null;
  return hasValue ? value : undefined;
}

function sameRecordedNumber(
  framesA: FrameDescriptor[],
  framesB: FrameDescriptor[],
  valueOf: (frame: FrameDescriptor) => number | undefined,
): boolean {
  const valueA = consistentNumber(framesA, valueOf);
  const valueB = consistentNumber(framesB, valueOf);
  if (valueA === null || valueB === null) return false;
  if (valueA === undefined || valueB === undefined) return valueA === valueB;
  return Math.abs(valueA - valueB) <= 0.001;
}

function compatibleRecordedAcquisition(
  a: CmrCollection,
  b: CmrCollection,
  frames: Record<string, FrameDescriptor>,
): boolean {
  const framesA = framesForCollection(a, frames);
  const framesB = framesForCollection(b, frames);
  if (framesA.length === 0 || framesB.length === 0) return false;
  const numericParameters: Array<(frame: FrameDescriptor) => number | undefined> = [
    (frame) => frame.parameters.trMs,
    (frame) => frame.parameters.teMs,
    (frame) => frame.parameters.tiMs,
    (frame) => frame.parameters.flipAngle,
  ];
  if (numericParameters.some((valueOf) => !sameRecordedNumber(framesA, framesB, valueOf))) return false;
  const photometricA = framesA[0].photometric;
  const photometricB = framesB[0].photometric;
  return photometricA === photometricB && framesA.every((frame) => frame.photometric === photometricA) &&
    framesB.every((frame) => frame.photometric === photometricB);
}

function collectionGeometry(collection: CmrCollection): PlaneGeometry | undefined {
  return collection.planes.find((plane) => geometryValid(plane.geometry))?.geometry;
}

function samePhysicalPlane(a: PlaneGeometry, b: PlaneGeometry): boolean {
  if (a.frameOfReferenceUid !== b.frameOfReferenceUid) return false;
  const normalA = planeNormal(a);
  const normalB = planeNormal(b);
  if (Math.abs(dot(normalA, normalB)) < ORIENTATION_DOT_TOLERANCE) return false;
  return Math.abs(dot(sub(b.origin, a.origin), normalA)) <= PLANE_TOLERANCE_MM;
}

function canAutoMerge(a: CmrCollection, b: CmrCollection, frames: Record<string, FrameDescriptor>): boolean {
  if (a.studyUid !== b.studyUid || a.view !== "SAX" || b.view !== "SAX" || a.kind !== "cine" || b.kind !== "cine" ||
    a.axisKind !== "cardiac" || b.axisKind !== "cardiac" || a.sourceSeriesIds.length !== 1 || b.sourceSeriesIds.length !== 1) return false;
  if (a.sourceSeriesIds[0] === b.sourceSeriesIds[0]) return false;
  const representativeA = representativeFrame(a, frames);
  const representativeB = representativeFrame(b, frames);
  const protocolA = collectionProtocol(representativeA);
  const protocolB = collectionProtocol(representativeB);
  if (!protocolA || protocolA !== protocolB) return false;
  if (!compatibleRecordedAcquisition(a, b, frames)) return false;
  const geometryA = collectionGeometry(a);
  const geometryB = collectionGeometry(b);
  if (!geometryValid(geometryA) || !geometryValid(geometryB) || geometryA.frameOfReferenceUid !== geometryB.frameOfReferenceUid) return false;
  if (!representativeA || !representativeB || !geometryClusterCompatible(representativeA, representativeB)) return false;
  return !a.planes.some((planeA) => {
    const geometryA = planeA.geometry;
    return geometryValid(geometryA) && b.planes.some((planeB) => {
      const geometryB = planeB.geometry;
      return geometryValid(geometryB) && samePhysicalPlane(geometryA, geometryB);
    });
  });
}

function combineCollections(collections: CmrCollection[], id: string, warning: string): CmrCollection {
  const first = collections[0];
  const sameView = collections.every((collection) => collection.view === first.view);
  const sameKind = collections.every((collection) => collection.kind === first.kind);
  const sameAxis = collections.every((collection) => collection.axisKind === first.axisKind);
  const warnings = [...new Set(collections.flatMap((collection) => collection.warnings).concat(warning))];
  return {
    ...first,
    id,
    label: sameView && sameKind ? first.label : "Combined acquisition",
    view: sameView ? first.view : "UNKNOWN",
    kind: sameKind ? first.kind : "other",
    axisKind: sameAxis ? first.axisKind : "unknown",
    axisLabel: sameAxis ? first.axisLabel : "Mixed acquisition",
    sourceSeriesIds: [...new Set(collections.flatMap((collection) => collection.sourceSeriesIds))].sort(),
    planes: collections.flatMap((collection) => collection.planes),
    phaseMatching: collections.some((collection) => collection.phaseMatching === "approximate")
      ? "approximate"
      : collections.some((collection) => collection.phaseMatching === "measured") ? "measured" : "none",
    defaultWindow: {
      center: collections.reduce((sum, collection) => sum + collection.defaultWindow.center, 0) / collections.length,
      width: collections.reduce((sum, collection) => sum + collection.defaultWindow.width, 0) / collections.length,
    },
    warnings,
  };
}

function autoMergeCollections(collections: CmrCollection[], frames: Record<string, FrameDescriptor>): CmrCollection[] {
  const remaining = [...collections];
  const result: CmrCollection[] = [];
  while (remaining.length) {
    const seed = remaining.shift()!;
    const group = [seed];
    let expanded = true;
    while (expanded) {
      expanded = false;
      const index = remaining.findIndex((candidate) => group.every((member) => canAutoMerge(member, candidate, frames)));
      if (index >= 0) {
        group.push(remaining.splice(index, 1)[0]);
        expanded = true;
      }
    }
    if (group.length === 1) result.push(seed);
    else {
      const seriesIds = group.flatMap((collection) => collection.sourceSeriesIds).sort();
      const combined = combineCollections(group, stableId([seed.studyUid, ...seriesIds]), "Automatically combined compatible series at distinct plane positions.");
      combined.planes.sort((a, b) => a.positionMm - b.positionMm);
      result.push(combined);
    }
  }
  return result;
}

/** Creates spatial plane collections, keeping distinct series separate unless their acquisition geometry is unambiguous. */
export function buildCollections(frames: FrameDescriptor[]): CmrCollection[] {
  const usable = frames.filter((frame) => !!frame.id && !!frame.studyUid && !!frame.seriesId);
  return inferGeometryViews(autoMergeCollections(initialCollections(usable), Object.fromEntries(usable.map((frame) => [frame.id, frame]))));
}

export function resolveFrame(catalog: StudyCatalog, cursor: ViewerCursor): ResolvedFrame | null {
  const collection = catalog.collections.find((item) => item.id === cursor.collectionId);
  if (!collection || !Number.isInteger(cursor.planeIndex) || !Number.isInteger(cursor.frameIndex)) return null;
  const plane = collection.planes[cursor.planeIndex];
  if (!plane || cursor.frameIndex < 0 || cursor.frameIndex >= plane.frameIds.length) return null;
  const frameId = plane.frameIds[cursor.frameIndex];
  return {
    descriptor: frameId ? catalog.frames[frameId] ?? null : null,
    collection,
    plane,
    cursor: { ...cursor },
    approximate: collection.phaseMatching === "approximate",
  };
}

export function phaseAt(collection: CmrCollection, planeIndex: number, frameIndex: number): number {
  const plane = collection.planes[planeIndex];
  if (!plane || !Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= plane.phases.length) return Number.NaN;
  return plane.phases[frameIndex];
}

/** Chooses the nearest recorded timeline slot, including an explicit null slot for a known acquisition gap. */
export function frameIndexAtPhase(collection: CmrCollection, planeIndex: number, phase: number): number {
  const plane = collection.planes[planeIndex];
  if (!plane || !finite(phase) || !plane.phases.length) return -1;
  const normalized = ((phase % 1) + 1) % 1;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  plane.phases.forEach((candidate, index) => {
    if (!finite(candidate)) return;
    let distance = Math.abs(candidate - normalized);
    distance = Math.min(distance, 1 - distance);
    if (distance < bestDistance - PHASE_EPSILON) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function assertMergeable(collections: CmrCollection[]): void {
  if (collections.length < 2) throw new Error("Select at least two collections to merge.");
  const study = collections[0].studyUid;
  if (collections.some((collection) => collection.studyUid !== study)) throw new Error("Collections from different studies cannot be merged.");
  const geometries = collections.flatMap((collection) => collection.planes.map((plane) => plane.geometry));
  if (!geometries.length || geometries.some((geometry) => !geometryValid(geometry) || !geometry.frameOfReferenceUid)) {
    throw new Error("Manual spatial merge requires patient-space geometry and a Frame of Reference UID for every plane.");
  }
  const frameOfReference = geometries[0]!.frameOfReferenceUid;
  if (geometries.some((geometry) => geometry!.frameOfReferenceUid !== frameOfReference)) throw new Error("Collections with different Frames of Reference cannot be spatially merged.");
  const seenIds = new Set<string>();
  const seenPlanes: PlaneGeometry[] = [];
  for (const collection of collections) {
    for (const plane of collection.planes) {
      for (const frameId of plane.frameIds) {
        if (!frameId) continue;
        if (seenIds.has(frameId)) throw new Error(`Conflicting duplicate frame ${frameId} in the selected collections.`);
        seenIds.add(frameId);
      }
      const geometry = plane.geometry!;
      if (seenPlanes.some((existing) => samePhysicalPlane(existing, geometry))) throw new Error("Collections contain the same physical plane; repeated acquisitions must remain separate.");
      seenPlanes.push(geometry);
    }
  }
}

export function mergeCollections(catalog: StudyCatalog, collectionIds: string[]): StudyCatalog {
  const ids = [...new Set(collectionIds)];
  const chosen = ids.map((id) => catalog.collections.find((collection) => collection.id === id)).filter((collection): collection is CmrCollection => !!collection);
  if (chosen.length !== ids.length) throw new Error("One or more selected collections no longer exist.");
  assertMergeable(chosen);
  const mergedId = `manual:${ids.map(encodeURIComponent).sort().join("+")}`;
  const merged = combineCollections(chosen, mergedId, "Manually combined; original series provenance is retained.");
  const insertAt = Math.min(...chosen.map((collection) => catalog.collections.indexOf(collection)));
  const chosenSet = new Set(ids);
  const collections = catalog.collections.filter((collection) => !chosenSet.has(collection.id));
  collections.splice(Math.min(insertAt, collections.length), 0, merged);
  return { ...catalog, collections: inferGeometryViews(collections) };
}

export function splitCollection(catalog: StudyCatalog, collectionId: string): StudyCatalog {
  const collection = catalog.collections.find((item) => item.id === collectionId);
  if (!collection) return catalog;
  const includedIds = new Set(collection.planes.flatMap((plane) => plane.frameIds.filter((id): id is string => !!id)));
  const framesBySeries = new Map<string, FrameDescriptor[]>();
  for (const id of includedIds) {
    const descriptor = catalog.frames[id];
    if (!descriptor || !collection.sourceSeriesIds.includes(descriptor.seriesId)) continue;
    const bucket = framesBySeries.get(descriptor.seriesId) ?? [];
    bucket.push(descriptor);
    framesBySeries.set(descriptor.seriesId, bucket);
  }
  const split = [...framesBySeries.values()].flatMap((frames) => createGeometryGroups(frames).map((group) => collectionForFrames(group)));
  if (split.length < 2) return catalog;
  const occupied = new Set(catalog.collections.filter((item) => item.id !== collectionId).map((item) => item.id));
  for (const item of split) {
    if (occupied.has(item.id)) item.id = `${item.id}::split-${encodeURIComponent(collectionId)}`;
    occupied.add(item.id);
    item.warnings = [...new Set(item.warnings.concat(`Split from collection ${collection.label}; source-series provenance retained.`))];
  }
  const index = catalog.collections.indexOf(collection);
  const collections = catalog.collections.filter((item) => item.id !== collectionId);
  collections.splice(Math.min(index, collections.length), 0, ...split);
  return { ...catalog, collections: inferGeometryViews(collections) };
}
