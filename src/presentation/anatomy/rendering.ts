import type { AnatomyMesh, AnatomyModel, AnatomyPlane, AnatomySection, PlaneFrame, Vec2, Vec3 } from "@/core/anatomy/types";
import { computeSections, planeFrame } from "@/core/anatomy/geometry";

export interface AnatomyRenderOptions {
  positive: boolean;
  negative: boolean;
  showPlane: boolean;
  showVessels: boolean;
  showCavities: boolean;
  fill3D: boolean;
  fill2D: boolean;
  showLabels: boolean;
  hiddenIds?: string[];
}

export const DEFAULT_ANATOMY_OPTIONS: AnatomyRenderOptions = {
  positive: true, negative: true, showPlane: true, showVessels: true,
  showCavities: false, fill3D: true, fill2D: true, showLabels: true
};

export type RenderPlane = AnatomyPlane | PlaneFrame;
export type SectionDrawing = { section: AnatomySection; path: Path2D; openPath: Path2D };
const sectionCache = new WeakMap<AnatomyModel, Map<string, AnatomySection[]>>();
const boundsCache = new WeakMap<AnatomyModel, { center: Vec3; span: number }>();

export function getPlaneFrame(plane: RenderPlane): PlaneFrame {
  return "right" in plane ? plane : planeFrame(plane);
}

/** Reused by the three views; cache is bounded and released with the model. */
export function getSections(model: AnatomyModel, plane: RenderPlane): AnatomySection[] {
  const f = getPlaneFrame(plane);
  const key = [...f.origin, ...f.normal, ...f.up].map(value => value.toPrecision(10)).join(",");
  let cache = sectionCache.get(model);
  if (!cache) { cache = new Map(); sectionCache.set(model, cache); }
  const cached = cache.get(key);
  if (cached) return cached;
  const sections = computeSections(model, f);
  if (cache.size >= 20) cache.delete(cache.keys().next().value!);
  cache.set(key, sections);
  return sections;
}

export function modelBounds(model: AnatomyModel): { center: Vec3; span: number } {
  const existing = boundsCache.get(model);
  if (existing) return existing;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const mesh of model.meshes) for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      min[j] = Math.min(min[j], mesh.positions[i + j]);
      max[j] = Math.max(max[j], mesh.positions[i + j]);
    }
  }
  const bounds = {
    center: min.map((v, i) => (v + max[i]) / 2) as Vec3,
    span: Math.max(1, ...min.map((v, i) => max[i] - v))
  };
  boundsCache.set(model, bounds);
  return bounds;
}

export function enabledSection(section: Pick<AnatomySection | AnatomyMesh, "id" | "group">, options: AnatomyRenderOptions): boolean {
  return !options.hiddenIds?.includes(section.id) && (section.group !== "vessel" || options.showVessels);
}

export function sectionExtent(sections: AnatomySection[], model: AnatomyModel): number {
  let extent = 0;
  for (const section of sections) for (const path of [...section.loops, ...section.paths]) {
    for (const p of path) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]));
  }
  return Math.max(modelBounds(model).span * 0.25, extent * 1.1);
}

/** Fit the cardiac region to the viewport aspect ratio, retaining a physical millimetre scale. */
export function sectionViewport(sections: AnatomySection[], model: AnatomyModel, plane: RenderPlane): { center: Vec2; width: number; height: number } {
  const includeVessels = "id" in plane && ["rvot", "lvot", "3ch", "scout-coronal", "scout-sagittal"].includes(plane.id);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const section of sections) {
    if (section.group === "vessel" && !includeVessels) continue;
    for (const path of [...section.loops, ...section.paths]) for (const point of path) {
      minX = Math.min(minX, point[0]); maxX = Math.max(maxX, point[0]);
      minY = Math.min(minY, point[1]); maxY = Math.max(maxY, point[1]);
    }
  }
  if (!Number.isFinite(minX)) return { center: [0, 0], width: 100, height: 100 };
  // SAX maintains a minimum field of view so a tiny apical lumen does not look falsely enlarged.
  const minimum = "id" in plane && plane.id.startsWith("sax-") ? modelBounds(model).span * 0.6 : 48;
  return { center: [(minX + maxX) / 2, (minY + maxY) / 2], width: Math.max(minimum, (maxX - minX) * 1.15), height: Math.max(minimum, (maxY - minY) * 1.15) };
}

export function makePath(paths: Vec2[][], closed: boolean): Path2D {
  const path = new Path2D();
  for (const points of paths) {
    if (points.length < 2) continue;
    path.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) path.lineTo(points[i][0], points[i][1]);
    if (closed) path.closePath();
  }
  return path;
}

const order = { vessel: 0, cavity: 1, wall: 2, papillary: 3, valve: 4 };
export function sectionDrawings(sections: AnatomySection[]): SectionDrawing[] {
  return [...sections].sort((a, b) => order[a.group] - order[b.group]).map(section => ({
    section, path: makePath(section.loops, true), openPath: makePath(section.paths, false)
  }));
}

/** Draw in millimetres with an existing right/up canvas transform. */
export function drawSections(
  ctx: CanvasRenderingContext2D, drawings: SectionDrawing[], options: AnatomyRenderOptions,
  scale: number, fill: boolean, selectedId?: string | null, cap = false
): void {
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const { section, path, openPath } of drawings) {
    if (!enabledSection(section, options)) continue;
    if (cap && section.group === "cavity" && !options.showCavities) continue;
    const selected = selectedId === section.id;
    ctx.fillStyle = section.color;
    ctx.strokeStyle = selected ? "#fff4bb" : section.color;
    const tissue = section.group !== "cavity" && section.group !== "vessel";
    if (fill && section.fillable && (tissue || section.group === "cavity" && options.showCavities)) {
      ctx.globalAlpha = section.group === "cavity" ? 0.28 : 1;
      ctx.fill(path, "evenodd");
    }
    ctx.globalAlpha = section.group === "cavity" ? 0.34 : 1;
    ctx.lineWidth = (selected ? 2.8 : section.group === "cavity" ? 0.65 : 1.1) / scale;
    ctx.stroke(path);
    if (section.group === "wall") ctx.lineWidth = Math.max(ctx.lineWidth, 1.55 / scale);
    ctx.stroke(openPath);
  }
  ctx.globalAlpha = 1;
}

export function directionLabel(direction: Vec3, axes: AnatomyModel["space"]["axes"]): string {
  if (axes !== "LPS") return "";
  const names = [["R", "L"], ["A", "P"], ["I", "S"]];
  return direction.map((value, index) => ({ value: Math.abs(value), label: names[index][value >= 0 ? 1 : 0] }))
    .sort((a, b) => b.value - a.value).filter((entry, index) => index === 0 || entry.value > 0.4)
    .map(entry => entry.label).join("");
}

export function shortLabel(section: AnatomySection): string {
  const byId: Record<string, string> = {
    FJ2422: "LV", FJ2423: "RV", FJ2424: "RA", FJ2425: "LA",
    FJ2420: "MV-A", FJ2432: "MV-P", FJ2421: "TV-A", FJ2433: "TV-P", FJ2436: "TV-S",
    FJ2418: "LV-PM", FJ2429: "LV-PM", FJ2419: "RV-PM", FJ2430: "RV-PM", FJ2437: "RV-PM",
    FJ3645: "SVC", FJ3441: "IVC",
    FJ3019: "RPA", FJ2924: "LPA",
    left_cardiac_atrium: "LA", right_cardiac_atrium: "RA", left_ventricle: "LV", right_ventricle: "RV",
    papillary_muscle_of_heart_antlat: "PM-AL", papillary_muscle_of_heart_posmed: "PM-PM",
    superior_vena_cava: "SVC", inferior_vena_cava_a: "IVC", pulmonary_artery_R: "RPA", pulmonary_artery_L: "LPA"
  };
  if (byId[section.id]) return byId[section.id];
  const name = section.label;
  const aliases: Array<[RegExp, string]> = [
    [/left ventricular cavity|left ventricle blood|左(?:心)?室血池/i, "LV"],
    [/right ventricular cavity|right ventricle blood|右(?:心)?室血池/i, "RV"],
    [/left atrial cavity|left atrium blood|左(?:心)?房血池/i, "LA"],
    [/right atrial cavity|right atrium blood|右(?:心)?房血池/i, "RA"],
    [/ascending aorta|升主动脉/i, "AAo"], [/pulmonary trunk|肺动脉干/i, "MPA"],
    [/mitral|二尖瓣/i, "MV"], [/tricuspid|三尖瓣/i, "TV"],
    [/aortic valve|主动脉瓣/i, "AV"], [/pulmonary valve|肺动脉瓣/i, "PV"],
    [/papillary|乳头肌/i, "PM"], [/septum|室间隔/i, "IVS"]
  ];
  return aliases.find(([pattern]) => pattern.test(name))?.[1] ?? (name.length > 17 ? `${name.slice(0, 16)}…` : name);
}

export function labelPriority(section: AnatomySection, plane: RenderPlane): number {
  const byView: Record<string, string[]> = {
    rvot: ["PV", "MPA", "RV", "RPA", "LPA", "TV"],
    "rv-inout": ["RV", "TV", "PV", "MPA", "RA"],
    lvot: ["LV", "AV", "AAo", "MV", "LA"],
    "3ch": ["LV", "AV", "AAo", "MV", "LA"],
    "4ch": ["LV", "RV", "LA", "RA", "MV", "TV"],
    p4ch: ["LV", "RV", "LA", "RA", "MV", "TV"],
    "2ch": ["LV", "LA", "MV", "LV-PM", "PM"],
    p2ch: ["LV", "LA", "MV", "LV-PM", "PM"],
    "sax-basal": ["LV", "RV", "MV", "TV", "LV-PM", "PM"],
    "sax-mid": ["LV", "RV", "LV-PM", "PM-AL", "PM-PM", "PM"],
    "sax-apical": ["LV", "RV", "LV-PM", "PM"]
  };
  const priorities = "id" in plane ? byView[plane.id] : undefined;
  const label = shortLabel(section);
  const index = priorities?.findIndex(key => label === key || label.startsWith(`${key}-`)) ?? -1;
  if (index >= 0) return index;
  return 20 + (section.group === "cavity" || section.group === "wall" ? 0 : section.group === "valve" ? 1 : section.group === "papillary" ? 2 : 3);
}
