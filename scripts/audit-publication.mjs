import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

// Default: inspect only Git objects reachable from the exact refs to publish.
// --worktree reviews unstaged/new files before a commit, not eventual history.
// Diagnostics contain paths/reasons only, never a matched secret or identity.
const arguments_ = process.argv.slice(2);
const worktree = arguments_[0] === '--worktree';
if (worktree && arguments_.length !== 1) throw new Error('--worktree cannot be combined with refs');
const refs = worktree ? [] : arguments_.length ? arguments_ : ['HEAD'];
if (refs.some(ref => ref.startsWith('-'))) throw new Error('Expected explicit Git refs or --worktree');
const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
const identity = 'CMR Prism Contributors';
const email = 'cmr-prism@users.noreply.github.com';
const binaryAssets = new Map([
  ['public/fonts/MiSans-Bold.woff2', { bytes: 5081104, sha256: '1c5a7515b61bc82baaa2e2c2fdae2032479fb9a99e09d4d021dc17314fc5939b' }],
  ['public/fonts/MiSans-Light.woff2', { bytes: 4810368, sha256: '2d1502a1cf0e41917844b512fb64be547cfb737e593d0da782c6b6762ea71c33' }],
  ['public/fonts/MiSans-Regular.woff2', { bytes: 4858624, sha256: 'd704c1a932c0bd7e8a071d276cd81c0ed0c9fecfa26ac234f4bed0559fe1cb2d' }],
  ['public/fonts/MiSans-license.pdf', { bytes: 79535, sha256: '4a93a27cd2bd81b3b5ecfd0a853144a876fa26938a93a68443c67d74172fcb86' }],
  ['scripts/sources/bodyparts3d/FJ3411.obj.gz', { bytes: 14150, sha256: 'aa3b3825aa8f3b8303d3672a3c489470f012a60b0a92a79c31383ae173ac0bd9', uncompressed: { bytes: 41743, sha256: '9eeb5e5a627e8145f03961c661c9c66d8fdc55ed1234d04b84212b87a21d902c' } }],
  ['scripts/sources/bodyparts3d/FJ3427.obj.gz', { bytes: 86614, sha256: '49535ca40fb119b51b51ec672df2e1f7d2632eb5d73e6fa2483c1ffcc1883a6e', uncompressed: { bytes: 289230, sha256: '386a80f191338beee23e83c33800ba17d4990123b41c648b9919764578505f7a' } }],
]);
const provenancePath = 'public/anatomy/provenance.json';
const anatomyJson = new Set(['public/anatomy/bodyparts3d.json', 'public/anatomy/hra.json', 'public/anatomy/cine.json']);
const reviewedPrototypes = {
  bodyparts3d: '2093e638a274d57b3cc6d3e95a6f7a6b2d03980d56347c18a23c92e8cfb64f1a',
  hra: '5179adf74386938a96b6d3b69108d89809a4cd9797b1c6dcb3e397f33d4df9f1',
};
// Fingerprint of sorted {path,sha256,bytes} records for all 230 reviewed assets.
// Editing a manifest alone must never authorize a newly added private image.
// A new reviewed corpus requires an explicit fingerprint update here.
const reviewedAnatomyAssets = 'c9056597e8943a33f3fcbf5ee08f7c77108070b90f0b2e6b61de7eda5a062bf6';
// Canonical aortaCorrection metadata: official archive URL/size, crop, and the
// two exact OBJ entries, raw hashes/sizes and documented derivations.
const reviewedAortaCorrection = '6a05d295b889a71bf662ba634bf31712dbb3094413c3c1fe6b5110a5d10b6f54';
const patterns = [
  ['home-directory', /(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s`]+|\/Users\/[^/\s`]+|\/home\/[^/\s`]+)/i],
  ['private-email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['api-token', /(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})/],
];
const findings = [];
const report = (path, reason) => findings.push({ path, reason });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const commits = worktree ? [] : git('rev-list', ...refs).toString('utf8').trim().split('\n').filter(Boolean);
const blobs = new Map();
const scanned = new Set();
let worktreeFiles = 0;

function scanText(text, path) {
  for (const [reason, pattern] of patterns) {
    pattern.lastIndex = 0;
    const matches = reason === 'private-email'
      ? [...text.matchAll(pattern)].some(match => match[0] !== email) : pattern.test(text);
    if (matches) report(path, reason);
  }
}

function getBlob(sha) {
  if (!blobs.has(sha)) blobs.set(sha, git('cat-file', 'blob', sha));
  return blobs.get(sha);
}

function scanContent(path, content, approvedImage) {
  const key = `${path}:${digest(content)}:${approvedImage}`;
  if (scanned.has(key)) return;
  scanned.add(key);
  if (content.subarray(128, 132).toString('ascii') === 'DICM') report(path, 'dicom-preamble');
  if (/^(?:artifacts|test-results|playwright-report|node_modules|\.next|cmr-eg|OS-03-P)\//i.test(path)
    || /(?:^|\/)\.env(?:\.|$)/i.test(path)
    || /\.(?:dcm|dicom|ima|nii(?:\.gz)?|roi|rtstruct|seg|sr|zip|7z|tar|pem|key|p12|pfx|log|bak|tsbuildinfo)$/i.test(path)) {
    report(path, 'excluded-data-or-generated-file');
  }
  const binary = binaryAssets.get(path);
  if (binary) {
    if (content.length !== binary.bytes || digest(content) !== binary.sha256) {
      report(path, 'unreviewed-binary-asset');
      return;
    }
    if (binary.uncompressed) {
      try {
        const source = gunzipSync(content, { maxOutputLength: binary.uncompressed.bytes });
        if (source.length !== binary.uncompressed.bytes || digest(source) !== binary.uncompressed.sha256) report(path, 'invalid-anatomy-source');
      } catch { report(path, 'invalid-anatomy-source'); }
    }
    return;
  }
  if (approvedImage) return;
  if (path !== '.gitignore' && !/\.(?:ts|tsx|css|svg|json|mjs|md|txt)$/.test(path)) report(path, 'unreviewed-file-type');
  if (content.includes(0)) { report(path, 'unexpected-binary'); return; }
  scanText(content.toString('utf8'), path);
}

/** Only the reviewed JPEG derivative format is accepted, without EXIF/comments. */
function isPlainJpeg(bytes) {
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 0xff) return false;
    const marker = bytes[position + 1];
    if (marker === 0xda) return true;
    if (marker === 0xfe || marker >= 0xe1 && marker <= 0xef) return false;
    const size = bytes.readUInt16BE(position + 2);
    if (size < 2 || position + 2 + size > bytes.length) return false;
    position += size + 2;
  }
  return false;
}

function validSources(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources) || manifest.sources.length !== 3) return false;
  if (manifest.sources.some(source => !source || typeof source !== 'object')) return false;
  const sources = Object.fromEntries(manifest.sources.map(source => [source.model, source]));
  const bp = sources.bodyparts3d, hra = sources.hra, cine = sources.cine;
  return bp?.version === '4.0' && bp.url === 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html'
    && bp.license === 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html'
    && Array.isArray(bp.attribution) && bp.attribution.includes('BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International')
    && bp.aortaCorrection && digest(JSON.stringify(canonical(bp.aortaCorrection))) === reviewedAortaCorrection
    && hra?.version === '1.3' && hra.url === 'https://apps.humanatlas.io/kg-explorer/ref-organ/heart-female/v1.3'
    && hra.license === 'https://creativecommons.org/licenses/by/4.0/'
    && hra.doi === 'https://doi.org/10.48539/HBM449.SHRV.225' && hra.vesselsDoi === 'https://doi.org/10.48539/HBM322.KKFC.394'
    && Array.isArray(hra.attribution) && hra.attribution.some(value => typeof value === 'string' && value.includes('Kristen Browne and Heidi Schlehlein'))
    && cine?.url === 'https://www.cardiacatlas.org/amrg-cardiac-atlas/'
    && cine.license === 'Public domain, as stated by the AMRG Cardiac Atlas distribution page'
    && cine.attribution === 'Auckland MRI Research Group, Auckland, New Zealand'
    && Object.entries(reviewedPrototypes).every(([id, hash]) => manifest.prototypeSha256?.[id] === hash);
}

function auditSnapshot(files) {
  const anatomyPaths = [...files.keys()].filter(path => path.startsWith('public/anatomy/'));
  const approvedImages = new Set();
  if (anatomyPaths.length) {
    for (const [path, asset] of binaryAssets) if (asset.uncompressed && !files.has(path)) report(path, 'missing-anatomy-source');
    const entries = new Map();
    let manifest;
    try { manifest = JSON.parse(files.get(provenancePath)?.().toString('utf8') ?? 'null'); }
    catch { /* Report malformed JSON without printing potentially private values. */ }
    if (!manifest || !validSources(manifest) || !Array.isArray(manifest.files)) {
      report(provenancePath, 'invalid-or-missing-anatomy-provenance');
    } else {
      for (const entry of manifest.files) {
        const path = entry?.path;
        if (typeof path !== 'string' || !anatomyJson.has(path) && !/^public\/anatomy\/cine\/[a-f0-9]{20}\.jpg$/.test(path)
          || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 32 * 1024 * 1024) {
          report(provenancePath, 'invalid-anatomy-file-record');
          continue;
        }
        if (entries.has(path)) { report(provenancePath, 'duplicate-anatomy-file-record'); continue; }
        entries.set(path, entry);
        const read = files.get(path);
        if (!read) { report(path, 'missing-anatomy-asset'); continue; }
        const content = read();
        if (content.length !== entry.bytes || digest(content) !== entry.sha256) { report(path, 'anatomy-hash-or-size-mismatch'); continue; }
        if (path.endsWith('.jpg')) {
          if (!path.endsWith(`/${entry.sha256.slice(0, 20)}.jpg`) || !isPlainJpeg(content)) report(path, 'invalid-anatomy-jpeg');
          else approvedImages.add(path);
        }
      }
      for (const path of anatomyJson) if (!entries.has(path)) report(path, 'missing-anatomy-file-record');
      for (const path of anatomyPaths) if (path !== provenancePath && !entries.has(path)) report(path, 'unlisted-anatomy-asset');
      const records = [...entries.values()].map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      if (digest(JSON.stringify(records)) !== reviewedAnatomyAssets) {
        report(provenancePath, 'unreviewed-anatomy-corpus');
        approvedImages.clear();
      }
      try {
        const cine = JSON.parse(files.get('public/anatomy/cine.json')?.().toString('utf8') ?? 'null');
        const frames = new Set(Object.values(cine).flatMap(sequence => sequence.frames));
        if (!frames.size || [...frames].some(path => typeof path !== 'string' || !approvedImages.has(`public${path}`))
          || [...approvedImages].some(path => !frames.has(path.slice('public'.length)))) report('public/anatomy/cine.json', 'unverified-cine-reference');
      } catch { report('public/anatomy/cine.json', 'invalid-cine-catalog'); }
    }
  }
  for (const [path, read] of files) scanContent(path, read(), approvedImages.has(path));
}

for (const commit of commits) {
  scanText(git('cat-file', '-p', commit).toString('utf8'), `commit:${commit.slice(0, 12)}`);
  const metadata = git('show', '-s', '--format=%an%n%ae%n%cn%n%ce', commit).toString('utf8').trim().split('\n');
  if (metadata[0] !== identity || metadata[2] !== identity || metadata[1] !== email || metadata[3] !== email) report(`commit:${commit.slice(0, 12)}`, 'non-anonymous-commit-identity');
  const files = new Map();
  for (const entry of git('ls-tree', '-r', '-z', commit).toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/s.exec(entry);
    if (!match) throw new Error('Invalid Git tree entry');
    const [, mode, type, sha, path] = match;
    if (mode !== '100644' && mode !== '100755' || type !== 'blob') { report(path, 'link-or-submodule'); continue; }
    files.set(path, () => getBlob(sha));
  }
  auditSnapshot(files);
}

if (worktree) {
  const root = realpathSync(git('rev-parse', '--show-toplevel').toString('utf8').trim());
  const files = new Map();
  for (const path of new Set(git('-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean))) {
    const absolute = resolve(root, path);
    let stat;
    try { stat = lstatSync(absolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) { report(path, 'link-or-submodule'); continue; }
    const resolvedRelative = relative(root, realpathSync(absolute));
    if (isAbsolute(resolvedRelative) || resolvedRelative === '..' || resolvedRelative.startsWith(`..${sep}`)) {
      report(path, 'link-or-submodule'); continue;
    }
    if (stat.size > 32 * 1024 * 1024) { report(path, 'oversized-unreviewed-file'); continue; }
    let content;
    files.set(path, () => content ??= readFileSync(absolute));
  }
  worktreeFiles = files.size;
  auditSnapshot(files);
}

// Annotated tag metadata is published too; inspect the exact tag refs supplied.
for (const ref of refs) {
  if (git('cat-file', '-t', ref).toString('utf8').trim() === 'tag') {
    const tag = git('cat-file', '-p', ref).toString('utf8');
    scanText(tag, ref);
    if (!tag.includes(`\ntagger ${identity} <${email}> `)) report(ref, 'non-anonymous-tag-identity');
  }
}

const unique = [...new Map(findings.map(finding => [`${finding.path}:${finding.reason}`, finding])).values()];
console.log(JSON.stringify({ mode: worktree ? 'worktree' : 'history', commits: commits.length, blobs: blobs.size, ...(worktree ? { files: worktreeFiles } : {}), findings: unique }, null, 2));
if (unique.length) process.exitCode = 1;
