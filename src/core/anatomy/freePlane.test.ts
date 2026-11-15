import { describe, expect, it } from "vitest";
import { freePlaneFrame, freePlaneFromNormal, freePlanePose } from "./freePlane";
import { cross, dot, pointPlaneDistance, unprojectPoint } from "./geometry";
import type { Vec3 } from "./types";

describe("unrestricted plane placement", () => {
  it("rotates about the chosen centre and permits positions outside preset slider limits", () => {
    const origin: Vec3 = [712.25, -1405.5, 3810];
    const plane = freePlaneFrame({ origin, rotation: [137, -82, 275] });
    expect(plane.origin).toEqual(origin);
    expect(pointPlaneDistance(unprojectPoint([160, -72], plane), plane)).toBeCloseTo(0, 9);
    for (const vector of [plane.normal, plane.up, plane.right]) expect(Math.hypot(...vector)).toBeCloseTo(1, 12);
    expect(dot(plane.normal, plane.up)).toBeCloseTo(0, 12);
    expect(dot(cross(plane.right, plane.up), plane.normal)).toBeCloseTo(1, 12);
  });

  it("represents any dragged orientation, including both Euler poles, without moving the plane", () => {
    const rotations: Vec3[] = [[173, 90, -67], [-149, -90, 38], [45, 134, -178], [355, 721, -1075]];
    for (const rotation of rotations) {
      const original = freePlaneFrame({ origin: [12, -44, 1301], rotation });
      const restored = freePlaneFrame(freePlanePose(original));
      expect(restored.origin).toEqual(original.origin);
      for (const key of ["normal", "up", "right"] as const) for (let axis = 0; axis < 3; axis++) {
        expect(restored[key][axis]).toBeCloseTo(original[key][axis], 9);
      }
    }
  });

  it("wraps full turns without restricting direction or changing the source pose", () => {
    const pose = { origin: [0, 0, 0] as Vec3, rotation: [90, 0, 0] as Vec3 };
    const frame = freePlaneFrame(pose);
    expect(frame.normal[1]).toBeCloseTo(-1, 12);
    expect(frame.up[2]).toBeCloseTo(1, 12);
    const fullTurns = freePlaneFrame({ ...pose, rotation: [810, -1080, 360] });
    expect(fullTurns).toEqual(frame);
    expect(pose.rotation).toEqual([90, 0, 0]);
  });

  it("accepts an arbitrary normal and handles a parallel preferred up vector", () => {
    const pose = freePlaneFromNormal([7, 9, -3], [0, 0, -8], [0, 0, 1]);
    const frame = freePlaneFrame(pose);
    expect(frame.normal[2]).toBeCloseTo(-1, 12);
    expect(dot(frame.normal, frame.up)).toBeCloseTo(0, 12);
    expect(() => freePlaneFromNormal([0, 0, 0], [0, 0, 0], [0, 1, 0])).toThrow();
    expect(() => freePlaneFrame({ origin: [0, Infinity, 0], rotation: [0, 0, 0] })).toThrow();
    expect(() => freePlaneFrame({ origin: [0, 0, 0], rotation: [0, NaN, 0] })).toThrow();
  });
});
