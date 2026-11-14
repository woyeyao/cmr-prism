import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aortaSource, clipBelowZ, loadAortaSources } from './bodyparts-source.mjs';

// Reproducible extraction from the public teaching prototypes and two reviewed
// official BodyParts3D aorta source meshes; all inputs are available offline.
// This script never reads cmr-eg, DICOM files, or the local viewer session.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? join(project, '..', 'demos'));
const output = join(project, 'public', 'anatomy');
const digest = value => createHash('sha256').update(value).digest('hex');
const extract = (html, id) => {
  const match = html.match(new RegExp(`<script[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`));
  if (!match) throw new Error(`Missing prototype data: ${id}`);
  return JSON.parse(match[1]);
};
const bpHtml = await readFile(join(source, 'CMR_Prism_BodyParts3D.html'), 'utf8');
const hraHtml = await readFile(join(source, 'CMR_Prism_Anatomy_Prototype.html'), 'utf8');
const bp = extract(bpHtml, 'geometry');
const bpPresets = extract(bpHtml, 'presets');
const hra = extract(hraHtml, 'geom');
const officialAorta = await loadAortaSources();
const correctedAorta = {
  FJ3411: officialAorta.FJ3411,
  FJ3427: clipBelowZ(officialAorta.FJ3427, aortaSource.distalCropZMm),
};
const colors = {
  wall: '#cd776b', papillary: '#f1a893', valve: '#e8d9a2', vessel: '#8f9cca', cavity: '#5fa6b3',
  FJ2438: '#bc7774', FJ2439: '#b67788', FJ2420: '#ffc67b', FJ2432: '#cedc8c',
  FJ2421: '#e9ca9d', FJ2433: '#debfa2', FJ2436: '#f3d9b0',
  FJ2417: '#abdbc9', FJ2427: '#bce2cd', FJ2434: '#8fd5c2',
  FJ2426: '#eddca8', FJ2431: '#efdfaf', FJ2435: '#f4e1b6', FJ2429: '#eaa494',
  FJ3413: '#dc8b79', FJ3411: '#e89986', FJ3427: '#bc786c',
  FJ3417: '#d48d79', FJ3483: '#d68f81', FJ3479: '#d99084',
  FJ3019: '#929cc5', FJ2924: '#8999c6', FJ3645: '#7fa6bd', FJ3441: '#769ab3',
  FJ2422: '#d99689', FJ2423: '#8cade0', FJ2424: '#82a4c3', FJ2425: '#d8a49b',
};
const bpLabels = {
  FJ2428: '心室壁', FJ2438: '左房壁', FJ2439: '右房壁',
  FJ2422: '左室血池', FJ2423: '右室血池', FJ2424: '右房血池', FJ2425: '左房血池',
  FJ2420: '二尖瓣前叶', FJ2432: '二尖瓣后叶', FJ2421: '三尖瓣前叶',
  FJ2433: '三尖瓣后叶', FJ2436: '三尖瓣隔叶',
  FJ2426: '主动脉瓣左后瓣尖', FJ2431: '主动脉瓣右后瓣尖', FJ2435: '主动脉瓣前瓣尖',
  FJ2417: '肺动脉瓣左前瓣尖', FJ2427: '肺动脉瓣后瓣尖', FJ2434: '肺动脉瓣右前瓣尖',
  FJ2418: '左室外侧乳头肌前外侧头', FJ2429: '左室外侧乳头肌',
  FJ2419: '右室前乳头肌', FJ2430: '右室后乳头肌', FJ2437: '右室隔乳头肌',
  FJ3413: '升主动脉', FJ3411: '主动脉弓', FJ3427: '降主动脉 · 胸段',
  FJ3417: '头臂干', FJ3483: '左颈总动脉', FJ3479: '左锁骨下动脉',
  FJ2966: '肺动脉干', FJ3019: '右肺动脉', FJ2924: '左肺动脉',
  FJ3040: '右下肺静脉', FJ2944: '左下肺静脉 · 1', FJ2950: '左下肺静脉 · 2',
  FJ2955: '左下肺静脉 · 3', FJ3020: '右上肺静脉', FJ2925: '左上肺静脉 · 1',
  FJ2933: '左上肺静脉 · 2', FJ3645: '上腔静脉', FJ3441: '下腔静脉',
};
const hraLabels = {
  interventricular_septum: '室间隔', left_cardiac_atrium: '左房壁', left_ventricle: '左室壁',
  right_cardiac_atrium: '右房壁', right_ventricle: '右室壁',
  papillary_muscle_of_heart_ant: '前乳头肌', papillary_muscle_of_heart_antlat: '前外侧乳头肌',
  papillary_muscle_of_heart_med: '内侧乳头肌', papillary_muscle_of_heart_pos: '后乳头肌',
  papillary_muscle_of_heart_posmed: '后内侧乳头肌',
  aortic_valve: '主动脉瓣', pulmonary_valve: '肺动脉瓣', mitral_valve: '二尖瓣', tricuspid_valve: '三尖瓣',
  ascending_aorta: '升主动脉', aortic_arch: '主动脉弓', descending_aorta_a: '降主动脉',
  pulmonary_trunk: '肺动脉干', pulmonary_artery_L: '左肺动脉', pulmonary_artery_R: '右肺动脉',
  superior_vena_cava: '上腔静脉', inferior_vena_cava_a: '下腔静脉',
  pulmonary_vein_L_sup: '左上肺静脉', pulmonary_vein_L_inf: '左下肺静脉',
  pulmonary_vein_R_sup: '右上肺静脉', pulmonary_vein_R_inf: '右下肺静脉',
};
const hraColors = ['#df9588', '#c5857c', '#c89a91', '#e9a391', '#f3c26a', '#e8d7b9', '#e38371', '#649fcb', '#7694b7', '#d99ca8'];
const hraGroups = ['wall', 'wall', 'wall', 'wall', 'papillary', 'valve', 'vessel', 'vessel', 'vessel', 'vessel'];
const decode = (encoded, signed, divisor = 1) => {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length % 2) throw new Error('Invalid int16 prototype payload');
  return Array.from({ length: bytes.length / 2 }, (_, i) => (signed ? bytes.readInt16LE(i * 2) : bytes.readUInt16LE(i * 2)) / divisor);
};
const attributions = {
  bodyparts3d: ['BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International', 'BodyParts3D v4.0 IS-A; teaching derivative. Aortic arch FJ3411 restored from official OBJ and descending aorta FJ3427 replaces FJ1931, cropped only distally at z=1158.19 mm; other vessel branches cropped upstream.'],
  hra: ['Kristen Browne and Heidi Schlehlein; HRA female heart and blood vasculature v1.3; CC BY 4.0; derived from the NLM Visible Human Dataset.', 'Teaching derivative extracted from supplied prototype display coordinates; positions quantized upstream to 0.05 mm; nearby vessels retained.'],
};
const models = [
  {
    id: 'bodyparts3d', label: 'BodyParts3D', version: '4.0-teaching-2',
    space: { units: 'mm', axes: 'LPS', description: 'BodyParts3D v4 shared physical coordinates; no DICOM Frame of Reference or subject registration.' },
    meshes: bp.meshes.map(m => {
      const id = m.id === 'FJ1931' ? 'FJ3427' : m.id;
      return { id, label: bpLabels[id] ?? m.label, sourceLabel: id === 'FJ3427' ? 'Descending aorta (thoracic crop)' : m.label, group: m.group, color: colors[id] ?? colors[m.group], positions: correctedAorta[id]?.positions ?? m.p, indices: correctedAorta[id]?.indices ?? m.t };
    }),
    presets: [], landmarks: bpPresets.landmarks, sourcePresets: bpPresets.planes, sourceEvidence: bpPresets.evidence, attribution: attributions.bodyparts3d,
  },
  {
    id: 'hra', label: 'HRA 女性心脏', version: '1.3-teaching-1',
    space: { units: 'mm', axes: 'specimen', description: 'Preserved HRA prototype display coordinates; patient LPS orientation is not established; no subject registration.' },
    meshes: hra.meshes.map(([id, group, positions, indices]) => ({ id, label: hraLabels[id] ?? id.replaceAll('_', ' '), sourceLabel: id, group: hraGroups[group], color: hraColors[group], positions: decode(positions, true, 20), indices: decode(indices, false) })),
    presets: [], landmarks: {}, sourcePlane: { origin: hra.origin, normal: hra.normal }, attribution: attributions.hra,
  },
];
await mkdir(join(output, 'cine'), { recursive: true });
const files = [];
async function save(name, value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
  await writeFile(join(output, name), bytes);
  files.push({ path: `public/anatomy/${name.replaceAll('\\', '/')}`, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) });
}
for (const model of models) {
  for (const mesh of model.meshes) {
    if (mesh.positions.length % 3 || mesh.indices.length % 3 || !mesh.positions.every(Number.isFinite)
      || mesh.indices.some(i => !Number.isInteger(i) || i < 0 || i >= mesh.positions.length / 3)) throw new Error(`Invalid mesh ${mesh.id}`);
  }
  await save(`${model.id}.json`, model);
}
const cine = {};
const framePaths = new Map();
for (const [viewId, sequence] of Object.entries(extract(bpHtml, 'mrs'))) {
  const frames = [];
  for (const uri of sequence.frames) {
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(uri);
    if (!match) throw new Error(`Invalid public frame for ${viewId}`);
    const bytes = Buffer.from(match[2], 'base64');
    const hash = digest(bytes);
    let path = framePaths.get(hash);
    if (!path) {
      path = `cine/${hash.slice(0, 20)}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
      framePaths.set(hash, path);
      await save(path, bytes);
    }
    frames.push(`/anatomy/${path}`);
  }
  cine[viewId] = { name: sequence.name, frames, series: sequence.series, triggerTimesMs: sequence.time };
}
await save('cine.json', cine);
await save('provenance.json', {
  schemaVersion: 1,
  sources: [
    { model: 'bodyparts3d', version: '4.0', url: 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html', license: 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html', attribution: attributions.bodyparts3d, aortaCorrection: aortaSource },
    { model: 'hra', version: '1.3', url: 'https://apps.humanatlas.io/kg-explorer/ref-organ/heart-female/v1.3', doi: 'https://doi.org/10.48539/HBM449.SHRV.225', vessels: 'https://lod.humanatlas.io/ref-organ/blood-vasculature-female/v1.3/', vesselsDoi: 'https://doi.org/10.48539/HBM322.KKFC.394', license: 'https://creativecommons.org/licenses/by/4.0/', attribution: attributions.hra },
    { model: 'cine', url: 'https://www.cardiacatlas.org/amrg-cardiac-atlas/', license: 'Public domain, as stated by the AMRG Cardiac Atlas distribution page', attribution: 'Auckland MRI Research Group, Auckland, New Zealand', relationship: 'Different volunteer from both static atlases. View-type teaching comparison only; not spatially or temporally registered.' },
  ],
  prototypeSha256: { bodyparts3d: digest(bpHtml), hra: digest(hraHtml) },
  files,
});
const expectedFrames = new Set(framePaths.values());
const stale = (await readdir(join(output, 'cine'))).filter(name => !expectedFrames.has(`cine/${name}`));
if (stale.length) throw new Error(`Unexpected pre-existing cine files: ${stale.join(', ')}. Review them before removing.`);
console.log(JSON.stringify({ models: models.map(m => ({ id: m.id, meshes: m.meshes.length, vertices: m.meshes.reduce((n, x) => n + x.positions.length / 3, 0), triangles: m.meshes.reduce((n, x) => n + x.indices.length / 3, 0) })), cineViews: Object.keys(cine).length, uniqueFrames: framePaths.size, assetBytes: files.reduce((n, f) => n + f.bytes, 0) }, null, 2));
