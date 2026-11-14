import type { AnatomyModel, Vec3 } from "./types";

/**
 * HRA v1.3 GLB world axes: +X left, +Y superior, +Z anterior.
 * The supplied prototype is the same geometry in millimetres, translated by
 * [-27, -461, 66], then quantized to 0.05 mm. All 26 meshes have identical
 * vertex/index ordering to the official GLBs; their nodes have identity transforms.
 * See docs/ANATOMY.md for source links and independent anatomical checks.
 * This rotation establishes anatomical directions, never a DICOM registration.
 */
export const HRA_COORDINATE_EVIDENCE = {
  source: "https://cdn.humanatlas.io/digital-objects/ref-organ/heart-female/v1.3/assets/3d-vh-f-heart.glb",
  vascularSource: "https://cdn.humanatlas.io/digital-objects/ref-organ/blood-vasculature-female/v1.3/assets/3d-vh-f-blood-vasculature.glb",
  referenceViewer: "https://kalanimd.com/cardio-atlas/index.html",
  prototypeTranslationMm: [-27, -461, 66] as Vec3,
  sourceScaleToMm: 1000,
  quantizationMm: .05,
};

/** Proper rotation (determinant +1): LSA → LPS, preserving mesh winding. */
export function hraPrototypeToLps([x, y, z]: Vec3): Vec3 {
  return [x, -z, y];
}

type HraSource = AnatomyModel & { sourcePlane?: { origin: Vec3; normal: Vec3; up?: Vec3 } };

/** Return a normalized copy; retain the original public asset and apply once. */
export function alignHraToLps<T extends HraSource>(source: T): T {
  if (source.id !== "hra" || source.space.axes === "LPS") return source;
  const rotatePlane = <P extends { origin: Vec3; normal: Vec3; up: Vec3 }>(plane: P): P => ({
    ...plane, origin: hraPrototypeToLps(plane.origin), normal: hraPrototypeToLps(plane.normal), up: hraPrototypeToLps(plane.up),
  });
  return {
    ...source,
    space: { ...source.space, axes: "LPS", description: "HRA v1.3 source GLB axes verified against its nodes and anatomical landmarks; prototype LSA rotated to LPS millimetres. Atlas origin only; no DICOM Frame of Reference or subject registration." },
    meshes: source.meshes.map(mesh => {
      const positions = new Array<number>(mesh.positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] = mesh.positions[i]; positions[i + 1] = -mesh.positions[i + 2]; positions[i + 2] = mesh.positions[i + 1];
      }
      return { ...mesh, positions };
    }),
    landmarks: Object.fromEntries(Object.entries(source.landmarks).map(([key, point]) => [key, hraPrototypeToLps(point)])),
    presets: source.presets.map(rotatePlane),
    sourcePlane: source.sourcePlane ? rotatePlane({ ...source.sourcePlane, up: source.sourcePlane.up ?? [0, 1, 0] }) : undefined,
  };
}
