import { planeFrame, rotate } from "./geometry";
import type { PlaneFrame, Vec3 } from "./types";

/** Extrinsic X → Y → Z rotations about the plane's own origin, in degrees. */
export interface FreePlanePose {
  origin: Vec3;
  rotation: Vec3;
}

export function wrapDegrees(value: number): number {
  if (!Number.isFinite(value)) throw new Error("切面参数必须为有限数值");
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/** No preset limits: position and rotation remain independent. */
export function freePlaneFrame(pose: FreePlanePose): PlaneFrame {
  if (![...pose.origin, ...pose.rotation].every(Number.isFinite)) throw new Error("切面参数必须为有限数值");
  const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const turn = (vector: Vec3): Vec3 => axes.reduce((result, axis, index) =>
    rotate(result, axis, wrapDegrees(pose.rotation[index]) * Math.PI / 180), vector);
  return planeFrame({ origin: [...pose.origin], normal: turn([0, 0, 1]), up: turn([0, 1, 0]) });
}

/** Canonical Euler readout of a dragged frame, including either gimbal-lock pole. */
export function freePlanePose(frame: Pick<PlaneFrame, "origin" | "normal" | "up">): FreePlanePose {
  const basis = planeFrame(frame);
  const y = Math.asin(Math.max(-1, Math.min(1, -basis.right[2])));
  const pole = Math.abs(Math.cos(y)) < 1e-7;
  const x = pole ? Math.atan2(-basis.normal[1], basis.up[1]) : Math.atan2(basis.up[2], basis.normal[2]);
  const z = pole ? 0 : Math.atan2(basis.right[1], basis.right[0]);
  return { origin: [...basis.origin], rotation: [x, y, z].map(value => value * 180 / Math.PI) as Vec3 };
}

/** A zero direction is rejected; a parallel up vector gets a stable orthogonal basis. */
export function freePlaneFromNormal(origin: Vec3, normal: Vec3, preferredUp: Vec3): FreePlanePose {
  return freePlanePose({ origin, normal, up: preferredUp });
}
