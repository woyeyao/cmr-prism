import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareAnatomyModel, surfaceCenter } from "./data";
import { cross, dot, planeFrame, pointPlaneDistance, projectPoint, subtract } from "./geometry";
import { alignHraToLps, hraPrototypeToLps } from "./hraCoordinates";
import type { AnatomyModel, Vec3 } from "./types";

type RawHra = AnatomyModel & { sourcePlane: { origin: Vec3; normal: Vec3; up?: Vec3 } };
const readSource = (): RawHra => JSON.parse(readFileSync(new URL("../../../public/anatomy/hra.json", import.meta.url), "utf8"));
const raw = readSource(), model = prepareAnatomyModel(raw, "hra");
const center = (id: string) => surfaceCenter(model.meshes.find(mesh => mesh.id === id)!);

describe("verified HRA anatomical coordinates", () => {
  it("uses a proper rigid rotation, retaining millimetres, handedness and triangle winding", () => {
    const [left, superior, anterior] = [[1,0,0], [0,1,0], [0,0,1]].map(p => hraPrototypeToLps(p as Vec3));
    expect(left).toEqual([1, -0, 0]);
    expect(superior).toEqual([0, -0, 1]);
    expect(anterior).toEqual([0, -1, 0]);
    expect(dot(cross(left, superior), anterior)).toBe(1);
    expect(Math.hypot(...subtract(model.meshes[0].positions.slice(0,3) as Vec3, model.meshes[0].positions.slice(3,6) as Vec3)))
      .toBeCloseTo(Math.hypot(...subtract(raw.meshes[0].positions.slice(0,3) as Vec3, raw.meshes[0].positions.slice(3,6) as Vec3)), 10);
    expect(model.meshes[0].indices).toEqual(raw.meshes[0].indices);
  });

  it("leaves the source asset intact and never transforms an already normalized model twice", () => {
    expect(raw.space.axes).toBe("specimen");
    expect(raw.meshes[0].positions).toEqual(readSource().meshes[0].positions);
    expect(model.space.axes).toBe("LPS");
    expect(alignHraToLps(model)).toBe(model);
    const originalPositions = [...model.meshes[0].positions];
    expect(prepareAnatomyModel(model, "hra").meshes[0].positions).toEqual(originalPositions);
  });

  it("independently checks left/right, head/foot and anterior/posterior using named anatomy", () => {
    expect(center("pulmonary_artery_L")[0]).toBeGreaterThan(center("pulmonary_artery_R")[0] + 40);
    expect(center("pulmonary_vein_L_sup")[0]).toBeGreaterThan(center("pulmonary_vein_R_sup")[0] + 60);
    expect(center("superior_vena_cava")[2]).toBeGreaterThan(center("inferior_vena_cava_a")[2] + 90);
    expect(center("aortic_arch")[2]).toBeGreaterThan(center("left_ventricle")[2] + 80);
    expect(center("left_cardiac_atrium")[1]).toBeGreaterThan(center("right_ventricle")[1] + 35);
    expect(center("descending_aorta_a")[1]).toBeGreaterThan(center("ascending_aorta")[1] + 50);
  });

  it("retains every sampled original SAX screen coordinate while rotating its origin, normal and up", () => {
    const originalFrame = planeFrame({ ...raw.sourcePlane, up: [0,1,0] });
    const normalizedFrame = planeFrame(model.presets.find(plane => plane.id === "sax-mid")!);
    for (let i = 0; i < raw.meshes[0].positions.length; i += 81) {
      const before = raw.meshes[0].positions.slice(i, i+3) as Vec3;
      const after = model.meshes[0].positions.slice(i, i+3) as Vec3;
      const a = projectPoint(before, originalFrame), b = projectPoint(after, normalizedFrame);
      expect(b[0]).toBeCloseTo(a[0], 9); expect(b[1]).toBeCloseTo(a[1], 9);
      expect(pointPlaneDistance(after, normalizedFrame)).toBeCloseTo(pointPlaneDistance(before, originalFrame), 9);
    }
  });

  it("provides orthogonal body scouts and preliminary long axes anchored in this specimen", () => {
    const preset = (id: string) => model.presets.find(plane => plane.id === id)!;
    expect(preset("scout-axial").normal).toEqual([0,0,-1]);
    expect(preset("scout-coronal").normal).toEqual([0,-1,0]);
    expect(preset("scout-sagittal").normal).toEqual([1,0,0]);
    expect(dot(preset("p2ch").normal, preset("scout-axial").normal)).toBeCloseTo(0, 10);
    expect(dot(preset("p2ch").normal, preset("p4ch").normal)).toBeCloseTo(0, 10);
    for (const id of ["p2ch", "p4ch"]) for (const landmark of ["MV", "LV_apex"]) {
      expect(pointPlaneDistance(model.landmarks[landmark], preset(id))).toBeCloseTo(0, 9);
    }
    const axial = planeFrame(preset("scout-axial"));
    expect(dot(axial.right, [1,0,0])).toBe(1); // Patient left is screen right.
    expect(dot(axial.up, [0,-1,0])).toBe(1); // Anterior is screen up.
    expect(model.presets.some(plane => plane.id === "2ch")).toBe(false);
  });
});
