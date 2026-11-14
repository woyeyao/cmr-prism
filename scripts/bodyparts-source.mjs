import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

// Small, byte-exact source extracts, retained compressed for offline reproduction.
// Their original OBJ headers are preserved. The current database license is CC BY 4.0.
export const aortaSource = {
  url: 'https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/isa_BP3D_4.0_obj_99.zip',
  archiveBytes: 142903898,
  distalCropZMm: 1158.19,
  meshes: [
    { id: 'FJ3411', archiveEntry: 'isa_BP3D_4.0_obj_99/FJ3411.obj', bytes: 41743, sha256: '9eeb5e5a627e8145f03961c661c9c66d8fdc55ed1234d04b84212b87a21d902c', derivation: 'Original aortic arch; restore the posterior rim removed by prototype cropping. No geometric transform.' },
    { id: 'FJ3427', archiveEntry: 'isa_BP3D_4.0_obj_99/FJ3427.obj', bytes: 289230, sha256: '386a80f191338beee23e83c33800ba17d4990123b41c648b9919764578505f7a', derivation: 'Descending aorta, clipped at z >= 1158.19 mm to retain the thoracic teaching region. Replaces the distinct FJ1931 entity; no translation, deformation, invented bridge or distal cap.' },
  ],
};

export function parseObj(text) {
  const vertices = [], faces = [];
  for (const line of text.split(/\r?\n/)) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    if (kind === 'v') vertices.push(fields.slice(0, 3).map(Number));
    if (kind === 'f') {
      const polygon = fields.map(value => Number(value.split('/')[0]) - 1);
      for (let i = 1; i + 1 < polygon.length; i++) faces.push([polygon[0], polygon[i], polygon[i + 1]]);
    }
  }
  if (!vertices.length || !faces.length || vertices.some(p => p.length !== 3 || !p.every(Number.isFinite))
    || faces.some(f => f.some(i => !Number.isInteger(i) || i < 0 || i >= vertices.length))) throw new Error('Invalid official OBJ');
  // OBJ repeats vertices at normal discontinuities. Weld positions without altering them.
  return triangulate(faces.map(face => face.map(i => vertices[i])));
}

function triangulate(polygons) {
  const positions = [], indices = [], lookup = new Map();
  const indexOf = p => {
    const key = p.map(v => Math.round(v * 1e8)).join(',');
    if (!lookup.has(key)) { lookup.set(key, positions.length / 3); positions.push(...p); }
    return lookup.get(key);
  };
  for (const polygon of polygons) {
    const ids = polygon.map(indexOf);
    for (let i = 1; i + 1 < ids.length; i++) {
      if (new Set([ids[0], ids[i], ids[i + 1]]).size === 3) indices.push(ids[0], ids[i], ids[i + 1]);
    }
  }
  return { positions, indices };
}

export function clipBelowZ(mesh, z) {
  const polygons = [];
  const vertex = i => mesh.positions.slice(i * 3, i * 3 + 3);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const face = mesh.indices.slice(i, i + 3).map(vertex), clipped = [];
    for (let j = 0; j < face.length; j++) {
      const a = face[j], b = face[(j + 1) % face.length], insideA = a[2] >= z, insideB = b[2] >= z;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) {
        const t = (z - a[2]) / (b[2] - a[2]);
        clipped.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z]);
      }
    }
    if (clipped.length >= 3) polygons.push(clipped);
  }
  // Only trim source triangles. The artificial distal boundary deliberately stays open.
  return triangulate(polygons);
}

export async function loadAortaSources() {
  const result = {};
  for (const source of aortaSource.meshes) {
    const bytes = gunzipSync(await readFile(new URL(`./sources/bodyparts3d/${source.id}.obj.gz`, import.meta.url)));
    if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Unreviewed source OBJ: ${source.id}`);
    result[source.id] = parseObj(bytes.toString('utf8'));
  }
  return result;
}
