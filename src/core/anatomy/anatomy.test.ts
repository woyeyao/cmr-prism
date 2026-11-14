import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANATOMY_VIEWS, prepareAnatomyModel } from "./data";
import { computeSections, dot, intersectMesh, planeFrame, planeIntersection, pointPlaneDistance, projectPoint, signedArea, stitchContours, subtract, unprojectPoint } from "./geometry";
import type { AnatomyMesh, AnatomyModel, AnatomyModelId, Vec2 } from "./types";

const cube: AnatomyMesh = {
  id: "cube", label: "wall", group: "wall", color: "#fff",
  positions: [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1],
  indices: [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7],
};
const axial = planeFrame({ origin: [0,0,0], normal: [0,0,1], up: [0,1,0] });
const cache = new Map<AnatomyModelId, AnatomyModel>();
function asset(id: AnatomyModelId) {
  if (!cache.has(id)) cache.set(id, prepareAnatomyModel(JSON.parse(readFileSync(new URL(`../../../public/anatomy/${id}.json`, import.meta.url), "utf8")), id));
  return cache.get(id)!;
}

describe("specimen plane geometry", () => {
  it("keeps an orthonormal, right-handed frame through two oblique rotations and an offset", () => {
    const f = planeFrame({ origin: [10,-20,30], normal: [1,2,3], up: [0,0,1] }, 12, 22, -17);
    for (const vector of [f.normal, f.up, f.right]) expect(Math.hypot(...vector)).toBeCloseTo(1, 12);
    expect(dot(f.normal, f.up)).toBeCloseTo(0, 12);
    expect(dot(f.normal, f.right)).toBeCloseTo(0, 12);
    const point = unprojectPoint([14,-8], f);
    expect(projectPoint(point, f)[0]).toBeCloseTo(14, 10);
    expect(projectPoint(point, f)[1]).toBeCloseTo(-8, 10);
    expect(pointPlaneDistance(point, f)).toBeCloseTo(0, 10);
  });
  it("rejects nonfinite parameters and zero normals", () => {
    expect(() => planeFrame({ origin: [0,0,0], normal: [0,0,0], up: [0,1,0] })).toThrow();
    expect(() => planeFrame(axial, NaN)).toThrow();
    expect(() => planeFrame(axial, 0, 0, 0, [0, Infinity, 0])).toThrow();
  });
  it("translates in model XYZ independently of tilt and preserves the common 2D/3D frame", () => {
    const preset = { origin: [10,-20,30] as [number,number,number], normal: [1,2,3] as [number,number,number], up: [0,0,1] as [number,number,number] };
    const initial = planeFrame(preset, 7, 23, -19);
    const translated = planeFrame(preset, 7, 23, -19, [12,-16,9]);
    expect(subtract(translated.origin, initial.origin)).toEqual([12,-16,9]);
    expect(translated.normal).toEqual(initial.normal);
    expect(translated.up).toEqual(initial.up);
    expect(translated.right).toEqual(initial.right);
    const point = unprojectPoint([5,-8], translated);
    expect(pointPlaneDistance(point, translated)).toBeCloseTo(0, 10);
    expect(projectPoint(point, translated)[0]).toBeCloseTo(5, 10);
    expect(projectPoint(point, translated)[1]).toBeCloseTo(-8, 10);
    expect(planeFrame(preset)).toEqual(planeFrame(preset, 0, 0, 0, [0,0,0]));
  });
  it("intersects a closed volume into a closed square including a coplanar face", () => {
    for (const offset of [0,1]) {
      const section = intersectMesh(cube, planeFrame(axial, offset));
      expect(section.paths).toHaveLength(0);
      expect(section.loops).toHaveLength(1);
      expect(Math.abs(signedArea(section.loops[0]))).toBeCloseTo(4, 10);
    }
  });
  it("does not seal a cropped surface", () => {
    const open = { ...cube, indices: cube.indices.slice(0, -6) };
    const section = intersectMesh(open, axial);
    expect(section.loops).toHaveLength(0);
    expect(section.paths).toHaveLength(1);
  });
  it("preserves separate nested loops for even-odd cavity filling", () => {
    const inner = cube.positions.map(v => v * .5);
    const hollow = { ...cube, positions: [...cube.positions, ...inner], indices: [...cube.indices, ...cube.indices.map(i => i + 8)] };
    const section = intersectMesh(hollow, axial);
    expect(section.loops).toHaveLength(2);
    expect(section.loops.map(loop => Math.abs(signedArea(loop))).sort((a,b) => a-b)).toEqual([1,4]);
  });
  it("keeps ambiguous branching as open paths and deduplicates shared triangle edges", () => {
    const segments: [Vec2,Vec2][] = [[[0,0],[1,0]],[[1,0],[0,0]],[[0,0],[-1,0]],[[0,0],[0,1]]];
    const section = stitchContours(segments);
    expect(section.branchCount).toBe(1);
    expect(section.loops).toHaveLength(0);
    expect(section.paths).toHaveLength(3);
  });
  it("joins endpoint noise across spatial hash boundaries", () => {
    const section = stitchContours([[[0,0],[1.000049,0]],[[1.000051,0],[1,1]],[[1,1],[0,0]]]);
    expect(section.loops).toHaveLength(1);
    expect(section.paths).toHaveLength(0);
  });
  it("never marks lumen-only vascular meshes fillable", () => {
    expect(intersectMesh({ ...cube, group: "vessel" }, axial).fillable).toBe(false);
  });
  it("draws a locator from the same physical plane and excludes parallel or out-of-field pairs", () => {
    const target = planeFrame({ origin: [0,.4,0], normal: [0,1,1], up: [1,0,0] });
    const line = planeIntersection(axial, target, 1)!;
    expect(line).toHaveLength(2);
    for (const point of line) expect(pointPlaneDistance(unprojectPoint(point, axial), target)).toBeCloseTo(0, 10);
    expect(planeIntersection(axial, planeFrame(axial, 2))).toBeNull();
    expect(planeIntersection(axial, planeFrame({ origin: [0,20,0], normal: [0,1,0], up: [0,0,1] }), 1)).toBeNull();
  });
});

describe("bundled atlas calibration", () => {
  it("keeps a shared view catalog and model-specific availability", () => {
    expect(new Set(ANATOMY_VIEWS.map(v => v.id)).size).toBe(14);
    expect(asset("bodyparts3d").presets).toHaveLength(14);
    expect(asset("hra").presets).toHaveLength(11);
    expect(asset("hra").presets.some(p => p.id === "rvot")).toBe(false);
    expect(asset("hra").presets.some(p => p.id === "2ch")).toBe(false);
    expect(asset("hra").space.axes).toBe("LPS");
    for (const id of ["bodyparts3d", "hra"] as const) for (const p of asset(id).presets) {
      expect(p.status).toBe("candidate");
      expect(Math.hypot(...p.normal)).toBeCloseTo(1, 10);
      expect(dot(p.normal, p.up)).toBeCloseTo(0, 10);
    }
  });
  it("moves BP basal below both atria and away from the aortic valve while retaining both ventricles", () => {
    const model = asset("bodyparts3d"), plane = model.presets.find(p => p.id === "sax-basal")!;
    const sections = computeSections(model, plane), section = (id: string) => sections.find(s => s.id === id)!;
    for (const id of ["FJ2424","FJ2425","FJ2426","FJ2431","FJ2435"]) expect(section(id).segmentCount).toBe(0);
    expect(section("FJ2422").loops.length).toBeGreaterThan(0);
    expect(section("FJ2423").loops.length).toBeGreaterThan(0);
    const axisLength = Math.hypot(...model.landmarks.LV_apex.map((v,i) => v-model.landmarks.MV[i]));
    expect(-pointPlaneDistance(model.landmarks.MV, plane) / axisLength).toBeCloseTo(.30, 6);
  });
  it("retains an apical LV cavity beyond both BP LV papillary components", () => {
    const model = asset("bodyparts3d"), plane = model.presets.find(p => p.id === "sax-apical")!;
    const sections = computeSections(model, plane), section = (id: string) => sections.find(s => s.id === id)!;
    expect(section("FJ2418").segmentCount).toBe(0);
    expect(section("FJ2429").segmentCount).toBe(0);
    const area = section("FJ2422").loops.reduce((sum, loop) => sum + Math.abs(signedArea(loop)),0);
    expect(area).toBeGreaterThan(190);
    expect(area).toBeLessThan(210);
  });
  it("uses HRA's own valve and apex proxies without copying the BP plane", () => {
    const model = asset("hra"), plane = model.presets.find(p => p.id === "4ch")!;
    for (const key of ["MV","TV","LV_apex"]) expect(pointPlaneDistance(model.landmarks[key], plane)).toBeCloseTo(0, 8);
    expect(plane.origin).not.toEqual(asset("bodyparts3d").presets.find(p => p.id === "4ch")!.origin);
    const sections = computeSections(model, plane);
    for (const id of ["left_ventricle", "right_ventricle", "left_cardiac_atrium", "right_cardiac_atrium", "mitral_valve", "tricuspid_valve"]) expect(sections.find(s => s.id === id)!.segmentCount).toBeGreaterThan(0);
    for (const id of ["aortic_valve", "ascending_aorta"]) expect(sections.find(s => s.id === id)!.segmentCount).toBe(0);
  });
  it("shows the tricuspid side left and the LV apex below the mitral valve in both four-chamber views", () => {
    for (const id of ["bodyparts3d", "hra"] as const) {
      const model = asset(id), plane = model.presets.find(p => p.id === "4ch")!, frame = planeFrame(plane);
      expect(dot(subtract(model.landmarks.TV, model.landmarks.MV), frame.right)).toBeLessThan(0);
      expect(dot(subtract(model.landmarks.LV_apex, model.landmarks.MV), frame.up)).toBeLessThan(0);
    }
  });
  it("rejects asset identity mismatches and malformed mesh indices", () => {
    expect(() => prepareAnatomyModel({ ...asset("bodyparts3d"), id: "hra" }, "bodyparts3d")).toThrow();
    expect(() => prepareAnatomyModel({ ...asset("bodyparts3d"), meshes: [{...cube,indices:[0,1,99]}] }, "bodyparts3d")).toThrow();
  });
});
