import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { aortaSource, loadAortaSources } from './bodyparts-source.mjs';

const model = JSON.parse(await readFile(new URL('../public/anatomy/bodyparts3d.json', import.meta.url), 'utf8'));
const source = await loadAortaSources(); // Verifies uncompressed official OBJ hashes.
const arch = model.meshes.find(m => m.id === 'FJ3411');
const descending = model.meshes.find(m => m.id === 'FJ3427');
assert(arch && descending && !model.meshes.some(m => m.id === 'FJ1931'), 'Use the reviewed, correctly identified descending-aorta source');
assert.deepEqual(arch.positions, source.FJ3411.positions, 'The restored arch must retain source coordinates');
assert.deepEqual(arch.indices, source.FJ3411.indices);

const points = mesh => Array.from({ length: mesh.positions.length / 3 }, (_, i) => mesh.positions.slice(i * 3, i * 3 + 3));
const bounds = mesh => points(mesh).reduce((b, p) => ({ min: b.min.map((v, k) => Math.min(v, p[k])), max: b.max.map((v, k) => Math.max(v, p[k])) }), { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
function boundary(mesh) {
  const edges = new Map();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const face = mesh.indices.slice(i, i + 3);
    for (let j = 0; j < 3; j++) {
      const a = face[j], b = face[(j + 1) % 3], key = [Math.min(a, b), Math.max(a, b)].join(',');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const open = [...edges].filter(([, n]) => n === 1).map(([key]) => key.split(',').map(Number));
  const nonManifoldEdges = [...edges.values()].filter(n => n > 2).length;
  const adjacency = new Map();
  for (const [a, b] of open) for (const [i, j] of [[a, b], [b, a]]) adjacency.set(i, [...(adjacency.get(i) ?? []), j]);
  const seen = new Set();
  let loops = 0;
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    loops++;
    const pending = [start];
    while (pending.length) {
      const vertex = pending.pop();
      if (seen.has(vertex)) continue;
      seen.add(vertex);
      pending.push(...adjacency.get(vertex).filter(i => !seen.has(i)));
    }
  }
  return { open, nonManifoldEdges, loops, simple: [...adjacency.values()].every(neighbors => neighbors.length === 2) };
}
function hull(points) {
  const p = [...new Map(points.map(p => [p.slice(0, 2).join(','), p.slice(0, 2)])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = points => {
    const h = [];
    for (const p of points) { while (h.length > 1 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); }
    return h.slice(0, -1);
  };
  return [...half(p), ...half(p.toReversed())];
}
function sample(ring) {
  return ring.flatMap((a, i) => {
    const b = ring[(i + 1) % ring.length], steps = Math.max(2, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) * 10));
    return Array.from({ length: steps }, (_, k) => a.map((v, axis) => v + (b[axis] - v) * k / steps));
  });
}
function distanceToRing(p, ring) {
  return Math.min(...ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length], v = b.map((x, k) => x - a[k]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * v[0] + (p[1] - a[1]) * v[1]) / (v[0] ** 2 + v[1] ** 2)));
    return Math.hypot(...p.map((x, k) => x - a[k] - t * v[k]));
  }));
}
function areaCentroid(ring) {
  let area2 = 0, x = 0, y = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], cross = a[0] * b[1] - b[0] * a[1];
    area2 += cross; x += (a[0] + b[0]) * cross; y += (a[1] + b[1]) * cross;
  }
  return { areaMm2: Math.abs(area2 / 2), centerXYMm: [x / (3 * area2), y / (3 * area2)] };
}

const a = bounds(arch), d = bounds(descending), ab = boundary(arch), db = boundary(descending);
const originalDescendingPoints = new Set(points(source.FJ3427).map(p => p.join(',')));
assert(points(descending).every(p => p[2] === aortaSource.distalCropZMm || originalDescendingPoints.has(p.join(','))), 'Retained descending-aorta vertices must remain in exact source coordinates');
for (let i = 0; i < descending.indices.length; i += 3) {
  assert(descending.indices.slice(i, i + 3).some(index => descending.positions[index * 3 + 2] > aortaSource.distalCropZMm), 'The distal teaching crop must not acquire an invented cap');
}
assert.equal(a.min[2], 1281.9);
assert.equal(d.max[2], 1281.91);
assert.equal(d.min[2], aortaSource.distalCropZMm, 'Do not include the abdominal segment in the heart workspace');
assert.equal(ab.open.length, 0, 'Restore the source arch, including its previously cropped posterior rim');
assert.equal(ab.nonManifoldEdges + db.nonManifoldEdges, 0);
assert(db.loops === 1 && db.simple, 'The distal crop must form one simple ring without cracks');
assert(db.open.length > 0 && db.open.every(edge => edge.every(i => Math.abs(descending.positions[i * 3 + 2] - aortaSource.distalCropZMm) < 1e-8)), 'Only the distal teaching crop may be open');

// Source surfaces have independently rounded closed ends, not shared topology.
// Compare the projected outer rims of their 1 mm end slabs (posterior arch only),
// sampled every <= 0.11 mm. These are display-seam metrics, not clinical accuracy.
const ar = hull(points(arch).filter(p => p[2] < a.min[2] + 1 && p[1] > -95));
const dr = hull(points(descending).filter(p => p[2] > d.max[2] - 1));
const residual = [...sample(ar).map(p => distanceToRing(p, dr)), ...sample(dr).map(p => distanceToRing(p, ar))].sort((a, b) => a - b);
const quantile = q => { const p = (residual.length - 1) * q, i = Math.floor(p); return residual[i] + (residual[Math.ceil(p)] - residual[i]) * (p - i); };
const metrics = { median: quantile(0.5), p95: quantile(0.95), max: residual.at(-1) };
assert(metrics.max < 1 && metrics.p95 < 0.8, 'The reviewed source interface should remain within its observed sub-millimetre projected mismatch');
console.log(JSON.stringify({
  source: aortaSource.url,
  sourceCoordinatesPreserved: true,
  axialEndDifferenceMm: a.min[2] - d.max[2],
  projectedRimDistanceMm: metrics,
  arch: { id: arch.id, vertices: arch.positions.length / 3, triangles: arch.indices.length / 3, openEdges: ab.open.length, ...areaCentroid(ar) },
  descending: { id: descending.id, vertices: descending.positions.length / 3, triangles: descending.indices.length / 3, openEdges: db.open.length, openBoundaryLoops: db.loops, distalCropZMm: d.min[2], ...areaCentroid(dr) },
  limitation: 'The independently capped source components are not a welded manifold. No bridge, cap, translation or smoothing has been invented.',
}, null, 2));
