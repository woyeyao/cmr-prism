import type { AnatomyMesh, AnatomyModel, AnatomyPlane, AnatomySection, PlaneFrame, Vec2, Vec3 } from "./types";

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(...a);
  if (!Number.isFinite(length) || length < 1e-12) throw new Error("切面方向不是有效向量");
  return scale(a, 1 / length);
}
export function rotate(v: Vec3, axis: Vec3, radians: number): Vec3 {
  const a = normalize(axis), c = Math.cos(radians), s = Math.sin(radians);
  return add(add(scale(v, c), scale(cross(a, v), s)), scale(a, dot(a, v) * (1 - c)));
}

/** XYZ translation is in model coordinates (mm); offset follows the tilted normal. */
export function planeFrame(plane: Pick<AnatomyPlane, "origin" | "normal" | "up">, offset = 0, tiltX = 0, tiltY = 0, translation: Vec3 = [0, 0, 0]): PlaneFrame {
  if (![...plane.origin, ...translation, offset, tiltX, tiltY].every(Number.isFinite)) throw new Error("切面参数必须为有限数值");
  let normal = normalize(plane.normal);
  let up = subtract(plane.up, scale(normal, dot(plane.up, normal)));
  if (Math.hypot(...up) < 1e-8) {
    const fallback: Vec3 = Math.abs(normal[2]) < .8 ? [0, 0, 1] : [0, 1, 0];
    up = subtract(fallback, scale(normal, dot(fallback, normal)));
  }
  up = normalize(up);
  let right = normalize(cross(up, normal));
  normal = rotate(normal, right, tiltX * Math.PI / 180);
  up = rotate(up, right, tiltX * Math.PI / 180);
  normal = normalize(rotate(normal, up, tiltY * Math.PI / 180));
  right = normalize(cross(up, normal));
  up = normalize(cross(normal, right));
  return { origin: add(add(plane.origin, translation), scale(normal, offset)), normal, up, right };
}

export function projectPoint(point: Vec3, plane: PlaneFrame): Vec2 {
  const relative = subtract(point, plane.origin);
  return [dot(relative, plane.right), dot(relative, plane.up)];
}
export function unprojectPoint(point: Vec2, plane: PlaneFrame): Vec3 {
  return add(plane.origin, add(scale(plane.right, point[0]), scale(plane.up, point[1])));
}
export function pointPlaneDistance(point: Vec3, plane: Pick<AnatomyPlane, "origin" | "normal">): number {
  return dot(subtract(point, plane.origin), normalize(plane.normal));
}

type Segment = [Vec2, Vec2];
interface Node { point: Vec2; edges: Edge[]; id: number }
interface Edge { a: Node; b: Node; used: boolean }

/** Join only coincident endpoints. Open or branched boundaries never gain invented closing edges. */
export function stitchContours(segments: Segment[], tolerance = 1e-4): Pick<AnatomySection, "loops" | "paths" | "branchCount"> {
  const cells = new Map<string, Node[]>(), nodes: Node[] = [], edges: Edge[] = [], seen = new Set<string>();
  const getNode = (point: Vec2): Node => {
    const x = Math.floor(point[0] / tolerance), y = Math.floor(point[1] / tolerance);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const node of cells.get(`${x + dx},${y + dy}`) ?? []) {
        if (Math.hypot(node.point[0] - point[0], node.point[1] - point[1]) <= tolerance) return node;
      }
    }
    const node: Node = { point, edges: [], id: nodes.length };
    nodes.push(node);
    const key = `${x},${y}`, cell = cells.get(key) ?? [];
    cell.push(node); cells.set(key, cell);
    return node;
  };
  for (const [p, q] of segments) {
    const a = getNode(p), b = getNode(q);
    if (a === b) continue;
    const key = a.id < b.id ? `${a.id},${b.id}` : `${b.id},${a.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const edge = { a, b, used: false };
    a.edges.push(edge); b.edges.push(edge); edges.push(edge);
  }
  const loops: Vec2[][] = [], paths: Vec2[][] = [];
  const walk = (start: Node, first: Edge) => {
    const points = [start.point];
    let node = start, edge: Edge | undefined = first;
    while (edge && !edge.used) {
      edge.used = true;
      node = edge.a === node ? edge.b : edge.a;
      if (node === start && start.edges.length === 2) {
        if (points.length > 2) loops.push(points);
        return;
      }
      points.push(node.point);
      if (node.edges.length !== 2) break;
      edge = node.edges.find(candidate => !candidate.used);
    }
    if (points.length > 1) paths.push(points);
  };
  for (const node of nodes) if (node.edges.length !== 2) for (const edge of node.edges) if (!edge.used) walk(node, edge);
  for (const edge of edges) if (!edge.used) walk(edge.a, edge);
  return { loops, paths, branchCount: nodes.filter(node => node.edges.length > 2).length };
}

export function intersectMesh(mesh: AnatomyMesh, plane: PlaneFrame): AnatomySection {
  const { positions: p, indices } = mesh;
  const distances = new Float64Array(p.length / 3), segments: Segment[] = [];
  const constant = dot(plane.normal, plane.origin), epsilon = 1e-7;
  for (let i = 0; i < distances.length; i++) {
    const d = p[i * 3] * plane.normal[0] + p[i * 3 + 1] * plane.normal[1] + p[i * 3 + 2] * plane.normal[2] - constant;
    distances[i] = Math.abs(d) <= epsilon ? 0 : d;
  }
  const vertex = (id: number): Vec3 => [p[id * 3], p[id * 3 + 1], p[id * 3 + 2]];
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i], ib = indices[i + 1], ic = indices[i + 2];
    const da = distances[ia], db = distances[ib], dc = distances[ic];
    // Nearly every triangle is away from the plane. Reject without allocating arrays.
    if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0) || (da === 0 && db === 0 && dc === 0)) continue;
    const ids = [ia, ib, ic], d = [da, db, dc];
    const points: Vec3[] = [];
    for (let j = 0; j < 3; j++) {
      const k = (j + 1) % 3;
      if (d[j] === 0) points.push(vertex(ids[j]));
      if (d[j] * d[k] < 0) {
        const a = vertex(ids[j]), b = vertex(ids[k]);
        points.push(add(a, scale(subtract(b, a), d[j] / (d[j] - d[k]))));
      }
    }
    if (points.length === 2 && Math.hypot(...subtract(points[0], points[1])) > epsilon) {
      segments.push([projectPoint(points[0], plane), projectPoint(points[1], plane)]);
    }
  }
  return { id: mesh.id, label: mesh.label, group: mesh.group, color: mesh.color, ...stitchContours(segments), fillable: mesh.group !== "vessel", segmentCount: segments.length };
}

export function computeSections(model: Pick<AnatomyModel, "meshes">, plane: PlaneFrame | AnatomyPlane): AnatomySection[] {
  const frame = "right" in plane ? plane : planeFrame(plane);
  return model.meshes.map(mesh => intersectMesh(mesh, frame));
}

/** Intersection in reference plane coordinates, clipped to [-extent,+extent]. */
export function planeIntersection(reference: PlaneFrame | AnatomyPlane, target: PlaneFrame | AnatomyPlane, extent = 100): [Vec2, Vec2] | null {
  const ref = "right" in reference ? reference : planeFrame(reference);
  const other = "right" in target ? target : planeFrame(target);
  const a = dot(other.normal, ref.right), b = dot(other.normal, ref.up);
  const c = dot(other.normal, subtract(other.origin, ref.origin));
  if (Math.hypot(a, b) < 1e-8 || extent <= 0) return null;
  const points: Vec2[] = [];
  const addIfInside = (point: Vec2) => {
    if (Math.abs(point[0]) <= extent + 1e-7 && Math.abs(point[1]) <= extent + 1e-7 && !points.some(p => Math.hypot(p[0] - point[0], p[1] - point[1]) < 1e-6)) points.push(point);
  };
  if (Math.abs(b) > 1e-10) for (const x of [-extent, extent]) addIfInside([x, (c - a * x) / b]);
  if (Math.abs(a) > 1e-10) for (const y of [-extent, extent]) addIfInside([(c - b * y) / a, y]);
  return points.length === 2 ? [points[0], points[1]] : null;
}

/** Dominant LPS directions; only call for a specimen with established LPS axes. */
export function orientationLabel(direction: Vec3): string {
  const labels = [["R", "L"], ["A", "P"], ["I", "S"]];
  return direction.map((v, i) => ({ weight: Math.abs(v), label: labels[i][v >= 0 ? 1 : 0] })).sort((a, b) => b.weight - a.weight).filter((v, i) => i === 0 || v.weight > .42).map(v => v.label).join("");
}

export function signedArea(loop: Vec2[]): number {
  return loop.reduce((area, p, i) => { const q = loop[(i + 1) % loop.length]; return area + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
}
