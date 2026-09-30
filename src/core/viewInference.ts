import type { CmrCollection, PlaneGeometry, Vec3, ViewLabel } from "./types";

const INFERRED_WARNING_PREFIX = "Geometric view inference:";
const UNKNOWN_VIEW_WARNING = "View was not recognized from the DICOM descriptions and can be labeled manually.";
const ALLOWED_VIEWS: ViewLabel[] = ["SAX", "2CH", "3CH", "4CH", "LVOT"];
const DIRECTION_COSINE_MIN = Math.cos(5 * Math.PI / 180);
const MIN_OVERLAP_RATIO = 0.5;
const LONG_AXIS_POSITION_TOLERANCE_MM = 3;
const SAX_STACK_MARGIN_MM = 5;

/** Replace view evidence without changing original frame metadata or geometry. */
export function setManualView(collection: CmrCollection, view: ViewLabel): CmrCollection {
  return {
    ...collection,
    view,
    warnings: collection.warnings.filter((warning) =>
      !warning.startsWith(INFERRED_WARNING_PREFIX) &&
      !warning.startsWith("View was not recognized from the DICOM descriptions") &&
      !warning.startsWith("View labeled manually:"),
    ).concat(`View labeled manually: ${view}. Original DICOM geometry and descriptions retained.`),
  };
}

type Interval = [number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(vector: Vec3): Vec3 | null {
  const magnitude = Math.hypot(...vector);
  return Number.isFinite(magnitude) && magnitude > 1e-12
    ? [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude]
    : null;
}

function hasPatientGeometry(geometry: PlaneGeometry | undefined): geometry is PlaneGeometry {
  return Boolean(
    geometry && geometry.frameOfReferenceUid.trim() &&
    geometry.origin.every(Number.isFinite) &&
    geometry.rowCosines.every(Number.isFinite) &&
    geometry.columnCosines.every(Number.isFinite) &&
    Number.isFinite(geometry.pixelSpacing[0]) && geometry.pixelSpacing[0] > 0 &&
    Number.isFinite(geometry.pixelSpacing[1]) && geometry.pixelSpacing[1] > 0 &&
    Number.isFinite(geometry.rows) && geometry.rows > 0 &&
    Number.isFinite(geometry.columns) && geometry.columns > 0 &&
    normalize(cross(geometry.rowCosines, geometry.columnCosines)),
  );
}

function normal(geometry: PlaneGeometry): Vec3 | null {
  return normalize(cross(geometry.rowCosines, geometry.columnCosines));
}

function patientPoint(geometry: PlaneGeometry, column: number, row: number): Vec3 {
  return [
    geometry.origin[0] + geometry.rowCosines[0] * column * geometry.pixelSpacing[1] + geometry.columnCosines[0] * row * geometry.pixelSpacing[0],
    geometry.origin[1] + geometry.rowCosines[1] * column * geometry.pixelSpacing[1] + geometry.columnCosines[1] * row * geometry.pixelSpacing[0],
    geometry.origin[2] + geometry.rowCosines[2] * column * geometry.pixelSpacing[1] + geometry.columnCosines[2] * row * geometry.pixelSpacing[0],
  ];
}

function center(geometry: PlaneGeometry): Vec3 {
  return patientPoint(geometry, (geometry.columns - 1) / 2, (geometry.rows - 1) / 2);
}

function corners(geometry: PlaneGeometry): Vec3[] {
  const lastColumn = geometry.columns - 0.5;
  const lastRow = geometry.rows - 0.5;
  return [
    patientPoint(geometry, -0.5, -0.5),
    patientPoint(geometry, lastColumn, -0.5),
    patientPoint(geometry, lastColumn, lastRow),
    patientPoint(geometry, -0.5, lastRow),
  ];
}

function interval(values: number[]): Interval {
  return [Math.min(...values), Math.max(...values)];
}

/** Ratio of the shared projected field of view to the smaller physical image rectangle. */
function overlapRatio(a: PlaneGeometry, b: PlaneGeometry): number {
  const row = normalize(a.rowCosines);
  const column = normalize(a.columnCosines);
  if (!row || !column) return 0;
  const project = (geometry: PlaneGeometry, axis: Vec3): Interval => interval(
    corners(geometry).map((point) => dot(subtract(point, a.origin), axis)),
  );
  const ax = project(a, row), ay = project(a, column);
  const bx = project(b, row), by = project(b, column);
  const overlapWidth = Math.max(0, Math.min(ax[1], bx[1]) - Math.max(ax[0], bx[0]));
  const overlapHeight = Math.max(0, Math.min(ay[1], by[1]) - Math.max(ay[0], by[0]));
  const areaA = (ax[1] - ax[0]) * (ay[1] - ay[0]);
  const areaB = (bx[1] - bx[0]) * (by[1] - by[0]);
  const smallerArea = Math.min(areaA, areaB);
  return smallerArea > 0 ? overlapWidth * overlapHeight / smallerArea : 0;
}

function orientationMatches(a: PlaneGeometry, b: PlaneGeometry): boolean {
  const rowA = normalize(a.rowCosines);
  const columnA = normalize(a.columnCosines);
  const rowB = normalize(b.rowCosines);
  const columnB = normalize(b.columnCosines);
  const normalA = normal(a);
  const normalB = normal(b);
  return !!rowA && !!columnA && !!rowB && !!columnB && !!normalA && !!normalB &&
    Math.abs(dot(rowA, rowB)) >= DIRECTION_COSINE_MIN &&
    Math.abs(dot(columnA, columnB)) >= DIRECTION_COSINE_MIN &&
    Math.abs(dot(normalA, normalB)) >= DIRECTION_COSINE_MIN;
}

function sameCoordinates(target: CmrCollection, anchor: CmrCollection, geometry: PlaneGeometry): PlaneGeometry[] {
  if (target.studyUid !== anchor.studyUid) return [];
  return anchor.planes.flatMap((plane) => {
    const anchorGeometry = plane.geometry;
    return hasPatientGeometry(anchorGeometry) && anchorGeometry.frameOfReferenceUid === geometry.frameOfReferenceUid
      ? [anchorGeometry]
      : [];
  });
}

function supportsSaxStack(target: PlaneGeometry, anchorPlanes: PlaneGeometry[]): boolean {
  const targetNormal = normal(target);
  if (!targetNormal) return false;
  const eligible = anchorPlanes.filter((anchor) => orientationMatches(target, anchor) && overlapRatio(target, anchor) >= MIN_OVERLAP_RATIO);
  if (eligible.length === 0) return false;
  const targetPosition = dot(center(target), targetNormal);
  // Only compatible, overlapping planes establish the physical extent of the SAX stack.
  // An unrelated plane in a mixed/irregular acquisition must not widen this range.
  const anchorPositions = eligible.map((anchor) => dot(center(anchor), targetNormal));
  const low = Math.min(...anchorPositions) - SAX_STACK_MARGIN_MM;
  const high = Math.max(...anchorPositions) + SAX_STACK_MARGIN_MM;
  return targetPosition >= low && targetPosition <= high;
}

function supportsLongAxisPlane(target: PlaneGeometry, anchorPlanes: PlaneGeometry[]): boolean {
  return anchorPlanes.some((anchor) => {
    const anchorNormal = normal(anchor);
    if (!anchorNormal || !orientationMatches(target, anchor) || overlapRatio(target, anchor) < MIN_OVERLAP_RATIO) return false;
    const offset = Math.abs(dot(subtract(center(target), center(anchor)), anchorNormal));
    return offset <= LONG_AXIS_POSITION_TOLERANCE_MM;
  });
}

function targetSupportsView(target: CmrCollection, view: ViewLabel, anchors: CmrCollection[]): boolean {
  if (target.planes.length === 0 || target.planes.some((plane) => !hasPatientGeometry(plane.geometry))) return false;
  return target.planes.every((plane) => {
    const geometry = plane.geometry!;
    return anchors.some((anchor) => {
      if (anchor.view !== view) return false;
      const anchorPlanes = sameCoordinates(target, anchor, geometry);
      if (anchorPlanes.length === 0) return false;
      return view === "SAX" ? supportsSaxStack(geometry, anchorPlanes) : supportsLongAxisPlane(geometry, anchorPlanes);
    });
  });
}

function inferredView(collection: CmrCollection, anchors: CmrCollection[]): ViewLabel | undefined {
  const candidates = ALLOWED_VIEWS.filter((view) => targetSupportsView(collection, view, anchors));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Infer unknown views from unambiguously labeled Cine collections in the same study and
 * Frame of Reference. Inferred collections never become anchors, so labels cannot chain.
 */
export function inferGeometryViews(collections: CmrCollection[]): CmrCollection[] {
  const anchors = collections.filter((collection) =>
    collection.kind === "cine" && ALLOWED_VIEWS.includes(collection.view) &&
    !collection.warnings.some((warning) => warning.startsWith(INFERRED_WARNING_PREFIX)),
  );
  return collections.map((collection) => {
    if (collection.view !== "UNKNOWN") return collection;
    const nextView = inferredView(collection, anchors);
    const warnings = collection.warnings.filter((warning) =>
      !warning.startsWith(INFERRED_WARNING_PREFIX) && !warning.startsWith("View was not recognized from the DICOM descriptions"),
    );
    if (!nextView) {
      warnings.push(UNKNOWN_VIEW_WARNING);
      return { ...collection, warnings: [...new Set(warnings)] };
    }
    warnings.push(`${INFERRED_WARNING_PREFIX} ${nextView} from same-study Cine plane geometry; not anatomically validated.`);
    return { ...collection, view: nextView, warnings: [...new Set(warnings)] };
  });
}
