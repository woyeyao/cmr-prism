import { add, cross, dot, normalize, planeFrame, scale, subtract } from "./geometry";
import { alignHraToLps } from "./hraCoordinates";
import { publicAsset } from "../publicAsset";
import type { AnatomyCineCatalog, AnatomyMesh, AnatomyModel, AnatomyModelId, AnatomyPlane, AnatomyView, AnatomyViewId, Vec3 } from "./types";

export const ANATOMY_MODELS = [
  { id: "bodyparts3d" as const, label: "BodyParts3D", description: "41 个结构 · 瓣叶与血池 · 人体方位" },
  { id: "hra" as const, label: "HRA 女性心脏", description: "26 个结构 · 两组左室乳头肌 · 人体方位" },
];

export const ANATOMY_VIEWS: AnatomyView[] = [
  { id: "scout-axial", label: "横断定位", shortLabel: "横断", group: "定位", lesson: "先从人体横断方向认识四腔与大血管的位置，再切换到心脏自己的长轴。", expected: "心室、心房、房室交界", referenceViewId: "scout-coronal" },
  { id: "scout-coronal", label: "冠状定位", shortLabel: "冠状", group: "定位", lesson: "观察心脏与大血管的左右、头足关系；人体冠状面与心脏长轴面并不相同。", expected: "四腔与大血管", referenceViewId: "scout-axial" },
  { id: "scout-sagittal", label: "矢状定位", shortLabel: "矢状", group: "定位", lesson: "先辨认前后关系，再比较向肺动脉瓣偏转的 RVOT 面。", expected: "前后关系与流出道", referenceViewId: "scout-coronal" },
  { id: "p2ch", label: "初步二腔定位", shortLabel: "初步 2CH", group: "定位", lesson: "在横断参考上连接左室心尖与二尖瓣中心，形成初步长轴。", expected: "左房、二尖瓣、左室", referenceViewId: "scout-axial" },
  { id: "p4ch", label: "初步四腔定位", shortLabel: "初步 4CH", group: "定位", lesson: "保持左室长轴，与初步二腔垂直；还需在短轴上检查右室展开和房室瓣。", expected: "左室长轴与右室范围", referenceViewId: "p2ch" },
  { id: "4ch", label: "四腔长轴", shortLabel: "4CH", group: "长轴", lesson: "从心尖沿室间隔追到两侧房室瓣；在基底短轴复核右室展开，并避免误切入 LVOT。", expected: "左室（LV）、右室（RV）、左房（LA）、右房（RA），以及二尖瓣、三尖瓣", referenceViewId: "sax-basal" },
  { id: "2ch", label: "二腔长轴", shortLabel: "2CH", group: "长轴", lesson: "显示左房、二尖瓣与左室心尖。绕长轴的角度要用短轴上的前、下壁独立核对。", expected: "左房、二尖瓣、左室；前壁与下壁待复核", referenceViewId: "sax-mid" },
  { id: "3ch", label: "三腔 / 矢状 LVOT", shortLabel: "3CH", group: "长轴", lesson: "沿左室腔追到流出道、主动脉瓣与根部；相交结构本身不能证明流出道中心连续。", expected: "左房、左室、二尖瓣、主动脉瓣与根部", referenceViewId: "sax-basal" },
  { id: "sax-basal", label: "基底心室短轴", shortLabel: "基底 SAX", group: "短轴", lesson: "在两张长轴上核对层位。这一层移到心房以下，辨认完整心室肌环；仍可能切到延长的瓣下结构。", expected: "基底心室肌、左室腔与右室腔", referenceViewId: "4ch" },
  { id: "sax-mid", label: "乳头肌水平短轴", shortLabel: "中段 SAX", group: "短轴", lesson: "观察心肌与乳头肌，保留中间腔隙。两个图谱的乳头肌命名粒度不同。", expected: "左室、右室、乳头肌实体", referenceViewId: "4ch" },
  { id: "sax-apical", label: "心尖短轴", shortLabel: "心尖 SAX", group: "短轴", lesson: "在乳头肌主体以远保留可辨认的左室腔，避免把极小的尖端断面当作代表心尖层。", expected: "缩小但仍开放的左室腔", referenceViewId: "4ch" },
  { id: "lvot", label: "冠状 LVOT", shortLabel: "LVOT", group: "流出道", lesson: "从与三腔正交的方向观察主动脉根，检查流出道、瓣口和近端升主动脉。", expected: "左室流出道、主动脉瓣、升主动脉", referenceViewId: "3ch" },
  { id: "rvot", label: "斜矢状 RVOT", shortLabel: "RVOT", group: "流出道", lesson: "沿肺动脉瓣追向肺动脉干；用另一参考面确认瓣下漏斗部是否居中。", expected: "右室漏斗部、肺动脉瓣、肺动脉干", referenceViewId: "scout-axial" },
  { id: "rv-inout", label: "右室流入–流出道", shortLabel: "RV 流入流出", group: "流出道", lesson: "以三尖瓣、右室心尖和肺动脉瓣定位，在同一面追踪右室的入口与出口。", expected: "右室、三尖瓣、肺动脉瓣", referenceViewId: "sax-basal" },
];

interface SourcePlane { id: AnatomyViewId; origin: Vec3; normal: Vec3; up: Vec3; description: string; anchorKeys: string[]; required: string[] }
interface SourceModel extends AnatomyModel { sourcePresets?: SourcePlane[]; sourcePlane?: { origin: Vec3; normal: Vec3; up?: Vec3 } }
const modelCache = new Map<AnatomyModelId, AnatomyModel>();
let cineCache: AnatomyCineCatalog | undefined;

export function getAnatomyPreset(model: AnatomyModel, id: string): AnatomyPlane | undefined {
  return model.presets.find(preset => preset.id === id);
}

function makePreset(source: SourcePlane, overrides: Partial<AnatomyPlane> = {}): AnatomyPlane {
  const view = ANATOMY_VIEWS.find(item => item.id === source.id)!;
  const frame = planeFrame(source);
  return {
    ...source, origin: frame.origin, normal: frame.normal, up: frame.up,
    label: view.label, status: "candidate", version: "2026.11.15-r4",
    description: view.lesson, basis: "标本地标推算的候选面。", review: "需要独立解剖与处方复核；几何相交不等于选面准确。",
    referenceViewId: view.referenceViewId,
    sideA: source.id.startsWith("sax-") ? "A · 心尖侧" : "A · 法线正侧",
    sideB: source.id.startsWith("sax-") ? "B · 心底侧" : "B · 法线负侧",
    offsetRange: [-28, 28], ...overrides,
  };
}

function bodyPartsPresets(source: SourceModel): AnatomyPlane[] {
  const lm = source.landmarks, axis = normalize(subtract(lm.LV_apex, lm.MV)), length = Math.hypot(...subtract(lm.LV_apex, lm.MV));
  return (source.sourcePresets ?? []).map(preset => {
    const p = makePreset(preset);
    const bases: Partial<Record<AnatomyViewId, string>> = {
      "4ch": "左室心尖代理点、二尖瓣与三尖瓣中心三点定面。",
      "2ch": "围绕左室心尖–二尖瓣轴，从四腔候选旋转90°得到起始方向；90°不是最终准确性的证据。",
      "3ch": "左室心尖代理点、二尖瓣与主动脉瓣中心三点定面。",
      "rvot": "肺动脉瓣中心与其头侧18 mm的肺动脉干截面中心，取近矢状方向。",
      "lvot": "主动脉瓣中心及头侧16 mm的升主动脉截面中心，方向与三腔候选正交。",
      "rv-inout": "三尖瓣中心、右室心尖代理点与肺动脉瓣中心三点定面。",
      "sax-mid": "垂直左室代理长轴，层位取两个左室外侧乳头肌部件中心在轴上的平均投影（约67.7%）。",
      "p2ch": "经左室心尖与二尖瓣中心，垂直人体横断参考面。",
      "p4ch": "经过同一左室长轴，并与初步二腔正交。",
    };
    p.basis = bases[p.id] ?? "通过心区的标本人体轴定位面。";
    if (p.id === "sax-basal" || p.id === "sax-apical") {
      const fraction = p.id === "sax-basal" ? .30 : .95;
      const oldDistance = dot(subtract(p.origin, lm.MV), axis);
      // Preserve the in-plane field-of-view center. Only translate along the LV axis.
      p.origin = add(p.origin, scale(axis, length * fraction - oldDistance));
      p.basis = p.id === "sax-basal"
        ? "垂直左室代理长轴，层位从19%（14.03 mm）移到30%（22.16 mm），本模型两房与主动脉瓣不再相交。"
        : "垂直左室代理长轴，层位从96.8%（71.47 mm）回撤到95%（70.16 mm）；仍越过两左室乳头肌部件，保留更清楚左室腔。";
      p.review = "同一网格的扫层优化；仍须在2CH与4CH双长轴检查真实心尖、LV体部长轴及肌环，不能当成独立临床验证。";
    }
    if (p.id === "rvot") p.review = "缺少独立漏斗部中心标注；RV、肺动脉瓣与肺动脉干相交尚不能证明连续居中。";
    if (p.id === "4ch") p.review = "在基底SAX检查RV急缘、室间隔交角与LVOT避让；心尖、瓣环仍是代理地标，防止长轴缩短。";
    return p;
  });
}

/** Surface-area weighting avoids bias from locally denser tessellation. */
export function surfaceCenter(mesh: AnatomyMesh): Vec3 {
  let weight = 0, total: Vec3 = [0, 0, 0];
  const v = (id: number): Vec3 => mesh.positions.slice(id * 3, id * 3 + 3) as Vec3;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = v(mesh.indices[i]), b = v(mesh.indices[i + 1]), c = v(mesh.indices[i + 2]);
    const area = Math.hypot(...cross(subtract(b, a), subtract(c, a)));
    total = add(total, scale(add(add(a, b), c), area / 3)); weight += area;
  }
  if (weight < 1e-9) throw new Error("解剖网格没有有效表面积");
  return scale(total, 1 / weight);
}

function apexProxy(mesh: AnatomyMesh, valve: Vec3): Vec3 {
  const points: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) points.push(mesh.positions.slice(i, i + 3) as Vec3);
  points.sort((a, b) => Math.hypot(...subtract(b, valve)) - Math.hypot(...subtract(a, valve)));
  const selected = points.slice(0, Math.ceil(points.length * .01));
  return scale(selected.reduce((sum, p) => add(sum, p), [0, 0, 0] as Vec3), 1 / selected.length);
}

function hraPresets(source: SourceModel): AnatomyPlane[] {
  if (!source.sourcePlane) throw new Error("HRA 缺少原始短轴平面");
  const mesh = (id: string) => { const found = source.meshes.find(item => item.id === id); if (!found) throw new Error(`HRA 缺少结构 ${id}`); return found; };
  const lm: Record<string, Vec3> = {
    MV: surfaceCenter(mesh("mitral_valve")), TV: surfaceCenter(mesh("tricuspid_valve")),
    AV: surfaceCenter(mesh("aortic_valve")), PV: surfaceCenter(mesh("pulmonary_valve")),
    LV: surfaceCenter(mesh("left_ventricle")), RV: surfaceCenter(mesh("right_ventricle")),
    LA: surfaceCenter(mesh("left_cardiac_atrium")), RA: surfaceCenter(mesh("right_cardiac_atrium")),
    LVPM1: surfaceCenter(mesh("papillary_muscle_of_heart_antlat")), LVPM2: surfaceCenter(mesh("papillary_muscle_of_heart_posmed")),
  };
  lm.LV_apex = apexProxy(mesh("left_ventricle"), lm.MV);
  lm.RV_apex = apexProxy(mesh("right_ventricle"), lm.TV);
  source.landmarks = lm;
  const axis = normalize(subtract(lm.LV_apex, lm.MV)), length = Math.hypot(...subtract(lm.LV_apex, lm.MV));
  const center = scale(add(add(lm.LV, lm.RV), add(lm.LA, lm.RA)), .25);
  let n4 = normalize(cross(axis, subtract(lm.TV, lm.MV)));
  const n3 = normalize(cross(axis, subtract(lm.AV, lm.MV)));
  const up = scale(axis, -1);
  // Match the BP four-chamber viewing convention: TV/RV left, apex down.
  // Flipping the normal changes the viewing side, never the physical plane.
  if (dot(subtract(lm.TV, lm.MV), cross(up, n4)) > 0) n4 = scale(n4, -1);
  const make = (id: AnatomyViewId, origin: Vec3, normal: Vec3, inPlaneUp: Vec3, anchorKeys: string[], basis: string) => {
    const centered = subtract(center, scale(normal, dot(subtract(center, origin), normal)));
    return makePreset({ id, origin: centered, normal, up: inPlaneUp, description: "", anchorKeys, required: [] }, {
      basis,
      review: "新增标本候选；心尖取心室壁最远1%顶点均值、瓣膜取整体表面中心，均不是人工标注的真心尖或瓣环。需独立复核。",
    });
  };
  const old = source.sourcePlane, oldFrame = planeFrame({ ...old, up: old.up ?? [0, 0, 1] });
  const mid = makePreset({ id: "sax-mid", ...old, up: oldFrame.up, description: "", anchorKeys: ["LVPM1", "LVPM2"], required: [] }, {
    basis: "保留交接原型的乳头肌短轴平面；基于二尖瓣–心尖长轴和两组乳头肌投影。",
    review: "原型心尖算法未完整保留。由当前网格重新推算的长轴与原法线约差0.31°，这是重复性检查，不是独立精度验证。",
  });
  const superior: Vec3 = [0, 0, 1], anterior: Vec3 = [0, -1, 0], left: Vec3 = [1, 0, 0];
  const scoutCenter = scale(add(add(lm.LV, lm.RV), add(lm.MV, lm.TV)), .25);
  const scout = (id: AnatomyViewId, normal: Vec3, inPlaneUp: Vec3, sideA: string, sideB: string) => makePreset({
    id, origin: scoutCenter, normal, up: inPlaneUp, description: "", anchorKeys: [], required: [],
  }, {
    basis: "官方 HRA v1.3 GLB 与原型逐点核对，结合左右肺动脉、上下腔静脉和前后腔室关系确认人体轴；通过心区作体轴定位。",
    review: "已核实标本人体轴。此层位是教学起点，可用 XYZ 调整；不是病例定位像，也未与真实 CMR 配准。",
    sideA, sideB,
  });
  let preliminary2 = normalize(cross(axis, superior));
  if (dot(cross(superior, preliminary2), left) < 0) preliminary2 = scale(preliminary2, -1);
  let preliminary4 = normalize(cross(axis, preliminary2));
  if (dot(cross(up, preliminary4), left) < 0) preliminary4 = scale(preliminary4, -1);
  return [
    scout("scout-axial", [0, 0, -1], anterior, "A · 足侧", "B · 头侧"),
    scout("scout-coronal", anterior, superior, "A · 前侧", "B · 后侧"),
    scout("scout-sagittal", left, superior, "A · 左侧", "B · 右侧"),
    make("p2ch", lm.MV, preliminary2, superior, ["MV", "LV_apex"], "通过本标本二尖瓣中心与左室心尖代理点，垂直已核实的人体横断面；仅作初步长轴定位，不能替代正式二腔。"),
    make("p4ch", lm.MV, preliminary4, up, ["MV", "LV_apex"], "通过同一左室代理长轴，与初步二腔正交；仍须在短轴上调整至右室与三尖瓣，不能替代正式四腔。"),
    make("4ch", lm.MV, n4, up, ["LV_apex", "MV", "TV"], "由本标本左室心尖代理点、二尖瓣与三尖瓣整体表面中心定面。"),
    make("3ch", lm.MV, n3, up, ["LV_apex", "MV", "AV"], "由本标本左室心尖代理点、二尖瓣与主动脉瓣整体表面中心定面。"),
    make("sax-basal", add(lm.MV, scale(axis, .15 * length)), axis, oldFrame.up, [], "本标本左室代理长轴15%处（约13.23 mm）；扫层显示此处无心房与二尖瓣网格相交。比例未从另一模型搬用。"),
    mid,
    make("sax-apical", add(lm.MV, scale(axis, .75 * length)), axis, oldFrame.up, [], "本标本左室代理长轴75%处（约66.13 mm）；两组左室乳头肌已无相交，保留心室壁断面。"),
    make("rv-inout", lm.TV, normalize(cross(subtract(lm.TV, lm.RV_apex), subtract(lm.PV, lm.RV_apex))), up, ["RV_apex", "TV", "PV"], "由本标本右室心尖代理点、三尖瓣与肺动脉瓣表面中心定面。"),
  ];
}

/** Public atlas assets are separate from, and cannot establish registration to, local DICOM. */
export function prepareAnatomyModel(value: unknown, expectedId: AnatomyModelId): AnatomyModel {
  let source = value as SourceModel;
  if (!source || source.id !== expectedId || !Array.isArray(source.meshes) || source.meshes.length === 0 || !source.space) throw new Error("解剖模型数据格式不正确");
  for (const mesh of source.meshes) {
    if (!Array.isArray(mesh.positions) || !Array.isArray(mesh.indices) || mesh.positions.length % 3 !== 0 || mesh.indices.length % 3 !== 0 || !mesh.positions.every(Number.isFinite) || !mesh.indices.every(i => Number.isInteger(i) && i >= 0 && i < mesh.positions.length / 3)) throw new Error("解剖模型包含无效网格");
  }
  if (expectedId === "hra") source = alignHraToLps(source);
  source.presets = expectedId === "bodyparts3d" ? bodyPartsPresets(source) : hraPresets(source);
  return source;
}

export async function loadAnatomyModel(id: AnatomyModelId, signal?: AbortSignal): Promise<AnatomyModel> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const cached = modelCache.get(id);
  if (cached) return cached;
  const response = await fetch(publicAsset(`/anatomy/${id}.json`), { signal });
  if (!response.ok) throw new Error("解剖模型加载失败，请重试");
  const model = prepareAnatomyModel(await response.json(), id);
  modelCache.set(id, model);
  return model;
}

export async function loadAnatomyCines(signal?: AbortSignal): Promise<AnatomyCineCatalog> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (cineCache) return cineCache;
  const response = await fetch(publicAsset("/anatomy/cine.json"), { signal });
  if (!response.ok) throw new Error("参考影像加载失败，请重试");
  const value = await response.json() as AnatomyCineCatalog;
  for (const cine of Object.values(value)) {
    if (!cine || !Array.isArray(cine.frames) || !cine.frames.length || cine.frames.length !== cine.triggerTimesMs.length || !cine.frames.every(path => /^\/anatomy\/cine\/[a-f0-9]+\.(jpg|png|webp)$/.test(path))) throw new Error("参考影像目录格式不正确");
  }
  cineCache = Object.fromEntries(Object.entries(value).map(([id, cine]) => [id, { ...cine, frames: cine.frames.map(publicAsset) }]));
  return cineCache;
}
