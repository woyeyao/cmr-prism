/** Shared contracts. DICOM geometry is patient LPS, millimetres, pixel centres. */
export type Vec3 = [number, number, number];
export type ViewLabel = "SAX" | "2CH" | "3CH" | "4CH" | "LVOT" | "RVOT" | "AXIAL" | "UNKNOWN";
export type SequenceKind = "cine" | "lge" | "perfusion" | "mapping" | "localizer" | "other";
export type AxisKind = "cardiac" | "acquisition" | "parameter" | "static" | "unknown";
export type WindowLevel = { center: number; width: number };
export type PlaneGeometry = {
  origin: Vec3;
  rowCosines: Vec3;
  columnCosines: Vec3;
  /** DICOM order: row spacing, column spacing. */
  pixelSpacing: [number, number];
  rows: number;
  columns: number;
  thickness: number;
  frameOfReferenceUid: string;
};
export type FrameDescriptor = {
  id: string;
  instanceId: string;
  /** DICOM frame numbers start at one. */
  frameNumber: number;
  studyUid: string;
  seriesId: string;
  seriesDescription: string;
  protocolName?: string;
  sequenceName?: string;
  imageType: string[];
  rows: number;
  columns: number;
  geometry?: PlaneGeometry;
  photometric: "MONOCHROME1" | "MONOCHROME2";
  instanceNumber?: number;
  temporalPosition?: number;
  triggerMs?: number;
  nominalPhase?: number;
  rrMs?: number;
  acquisitionMs?: number;
  /** Enhanced MR dimension values resolved through Dimension Index Pointers. */
  dimensionValues?: Record<string, number>;
  parameters: { trMs?: number; teMs?: number; tiMs?: number; flipAngle?: number; heartRate?: number };
  rescaleSlope: number;
  rescaleIntercept: number;
  window?: WindowLevel;
};
export type CmrPlane = {
  id: string;
  positionMm: number;
  geometry?: PlaneGeometry;
  /** Sparse slots: null explicitly means a known missing frame. */
  frameIds: Array<string | null>;
  phases: number[];
};
export type CmrCollection = {
  id: string;
  studyUid: string;
  label: string;
  view: ViewLabel;
  kind: SequenceKind;
  axisKind: AxisKind;
  axisLabel: string;
  sourceSeriesIds: string[];
  planes: CmrPlane[];
  phaseMatching: "measured" | "approximate" | "none";
  defaultWindow: WindowLevel;
  warnings: string[];
};
export type ImportReport = {
  acceptedInstances: number;
  acceptedFrames: number;
  skippedObjects: number;
  failedFiles: number;
  warnings: string[];
};
export type StudyCatalog = {
  id: string;
  collections: CmrCollection[];
  frames: Record<string, FrameDescriptor>;
  report: ImportReport;
};
export type ViewerCursor = { collectionId: string; planeIndex: number; frameIndex: number };
export type ImageTransform = { zoom: number; panX: number; panY: number };
export type ViewportState = {
  id: string;
  cursor: ViewerCursor;
  linked: boolean;
  window: WindowLevel;
  imageTransform?: ImageTransform;
};
export type PlaneSelection = { id: string; collectionId: string; planeIndex: number; window: WindowLevel };
export type ViewerState = {
  catalog: StudyCatalog | null;
  mode: "atlas" | "inspect" | "split" | "cube";
  splitCount: 2 | 3 | 4;
  viewports: ViewportState[];
  activeViewportId: string;
  selectedPlanes: PlaneSelection[];
  notes: Record<string, string>;
  playing: boolean;
  playbackFps: number;
  phase: number;
  atlasCount: number;
  atlasSpacing: number;
  inspectionOrigin: "split" | null;
};
export type ResolvedFrame = {
  descriptor: FrameDescriptor | null;
  collection: CmrCollection;
  plane: CmrPlane;
  cursor: ViewerCursor;
  approximate: boolean;
};
export type ReferenceLine = { from: [number, number]; to: [number, number]; sourcePlaneId?: string };
/** Samples have already been rescaled once. No presentation or colour mapping. */
export type ScalarFrame = { descriptor: FrameDescriptor; pixels: Float32Array };
export type ApiError = { code: string; message: string };
