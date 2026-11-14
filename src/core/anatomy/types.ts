export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
export type AnatomyModelId = "bodyparts3d" | "hra";
export type AnatomyViewId = "scout-axial" | "scout-coronal" | "scout-sagittal" | "p2ch" | "p4ch" | "2ch" | "4ch" | "3ch" | "sax-basal" | "sax-mid" | "sax-apical" | "lvot" | "rvot" | "rv-inout";
export type AnatomyGroup = "wall" | "papillary" | "valve" | "vessel" | "cavity";

export interface AnatomyMesh {
  id: string;
  label: string;
  group: AnatomyGroup;
  color: string;
  positions: number[];
  indices: number[];
}

/** All geometry remains in this specimen's millimetres, never in a DICOM frame. */
export interface AnatomyPlane {
  id: AnatomyViewId;
  label: string;
  origin: Vec3;
  normal: Vec3;
  up: Vec3;
  status: "candidate";
  version: string;
  description: string;
  basis: string;
  review: string;
  anchorKeys: string[];
  required: string[];
  referenceViewId: AnatomyViewId;
  sideA: string;
  sideB: string;
  offsetRange: [number, number];
}

export interface AnatomyModel {
  id: AnatomyModelId;
  label: string;
  version: string;
  space: { units: "mm"; axes: "LPS" | "specimen"; description: string };
  meshes: AnatomyMesh[];
  presets: AnatomyPlane[];
  landmarks: Record<string, Vec3>;
  attribution: string[];
}

export interface AnatomyView {
  id: AnatomyViewId;
  label: string;
  shortLabel: string;
  group: "定位" | "长轴" | "短轴" | "流出道";
  lesson: string;
  expected: string;
  referenceViewId: AnatomyViewId;
}

export interface AnatomyCine {
  name: string;
  frames: string[];
  series: number;
  triggerTimesMs: number[];
}

export type AnatomyCineCatalog = Partial<Record<AnatomyViewId, AnatomyCine>>;

/** Coordinates are relative to plane.origin, x=right, y=up, in mm. */
export interface AnatomySection {
  id: string;
  label: string;
  group: AnatomyGroup;
  color: string;
  loops: Vec2[][];
  paths: Vec2[][];
  /** Unambiguous closed contours can fill with even-odd winding. Vessels never fill. */
  fillable: boolean;
  segmentCount: number;
  branchCount: number;
}

export interface PlaneFrame {
  origin: Vec3;
  normal: Vec3;
  up: Vec3;
  right: Vec3;
}
