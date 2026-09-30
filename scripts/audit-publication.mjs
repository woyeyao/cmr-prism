import { execFileSync } from 'node:child_process';

// Read only Git objects reachable from the exact refs being published.
// Diagnostics contain paths/reasons only, never a matched secret or identity.
const refs = process.argv.slice(2);
if (!refs.length) refs.push('HEAD');
if (refs.some(ref => ref.startsWith('-'))) throw new Error('Expected explicit Git refs');
const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
const identity = 'CMR Prism Contributors';
const email = 'cmr-prism@users.noreply.github.com';
const binaryAssets = new Set([
  'public/fonts/MiSans-Bold.woff2',
  'public/fonts/MiSans-Light.woff2',
  'public/fonts/MiSans-Regular.woff2',
  'public/fonts/MiSans-license.pdf',
]);
const findings = [];
const commits = git('rev-list', ...refs).toString('utf8').trim().split('\n').filter(Boolean);
const blobs = new Map();
const patterns = [
  ['home-directory', /(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s`]+|\/Users\/[^/\s`]+|\/home\/[^/\s`]+)/i],
  ['private-email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['api-token', /(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})/],
];

function scanText(text, paths) {
  for (const [reason, pattern] of patterns) {
    pattern.lastIndex = 0;
    const matches = reason === 'private-email' ? [...text.matchAll(pattern)].filter(match => match[0] !== email) : pattern.test(text) ? [true] : [];
    if (matches.length) for (const path of paths) findings.push({ path, reason });
  }
}

for (const commit of commits) {
  scanText(git('cat-file', '-p', commit).toString('utf8'), [`commit:${commit.slice(0, 12)}`]);
  const metadata = git('show', '-s', '--format=%an%n%ae%n%cn%n%ce', commit).toString('utf8').trim().split('\n');
  if (metadata[0] !== identity || metadata[2] !== identity || metadata[1] !== email || metadata[3] !== email) {
    findings.push({ path: `commit:${commit.slice(0, 12)}`, reason: 'non-anonymous-commit-identity' });
  }
  const entries = git('ls-tree', '-r', '-z', commit).toString('utf8').split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(entry);
    if (!match) throw new Error('Invalid Git tree entry');
    const [, mode, type, sha, path] = match;
    if (mode !== '100644' && mode !== '100755' || type !== 'blob') {
      findings.push({ path, reason: 'link-or-submodule' });
      continue;
    }
    if (/^(?:artifacts|test-results|playwright-report|node_modules|\.next|cmr-eg|OS-03-P)\//i.test(path)
      || /(?:^|\/)\.env(?:\.|$)/i.test(path)
      || /\.(?:dcm|dicom|ima|nii(?:\.gz)?|roi|rtstruct|seg|sr|zip|7z|tar|pem|key|p12|pfx|log|bak|tsbuildinfo)$/i.test(path)) {
      findings.push({ path, reason: 'excluded-data-or-generated-file' });
    }
    if (!binaryAssets.has(path) && path !== '.gitignore' && !/\.(?:ts|tsx|css|svg|json|mjs|md|txt)$/.test(path)) {
      findings.push({ path, reason: 'unreviewed-file-type' });
    }
    const paths = blobs.get(sha) ?? new Set();
    paths.add(path);
    blobs.set(sha, paths);
  }
}

for (const [sha, paths] of blobs) {
  const content = git('cat-file', 'blob', sha);
  if (content.subarray(128, 132).toString('ascii') === 'DICM') {
    for (const path of paths) findings.push({ path, reason: 'dicom-preamble' });
  }
  const textPaths = [...paths].filter(path => !binaryAssets.has(path));
  if (!textPaths.length) continue;
  if (content.includes(0)) {
    for (const path of textPaths) findings.push({ path, reason: 'unexpected-binary' });
    continue;
  }
  const text = content.toString('utf8');
  scanText(text, textPaths);
}

// Annotated tag metadata is published too; inspect the exact tag refs supplied.
for (const ref of refs) {
  const kind = git('cat-file', '-t', ref).toString('utf8').trim();
  if (kind === 'tag') {
    const tag = git('cat-file', '-p', ref).toString('utf8');
    scanText(tag, [ref]);
    if (!tag.includes(`\ntagger ${identity} <${email}> `)) findings.push({ path: ref, reason: 'non-anonymous-tag-identity' });
  }
}

const unique = [...new Map(findings.map(finding => [`${finding.path}:${finding.reason}`, finding])).values()];
console.log(JSON.stringify({ commits: commits.length, blobs: blobs.size, findings: unique }, null, 2));
if (unique.length) process.exitCode = 1;
