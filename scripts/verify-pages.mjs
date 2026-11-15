import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'artifacts/pages');
const info = JSON.parse(await readFile(resolve(output, 'build-info.json'), 'utf8'));
assert.equal(info.application, 'anatomy-classroom');
assert.match(info.basePath, /^(?:\/[A-Za-z0-9._~-]+)*$/);
const files = [];
async function walk(directory) {
  for (const name of await readdir(directory)) {
    const path = resolve(directory, name), stat = await lstat(path);
    assert(!stat.isSymbolicLink(), `Static artifact must not contain links: ${name}`);
    if (stat.isDirectory()) await walk(path);
    else {
      assert.equal(stat.nlink, 1, `Static artifact must not contain hard links: ${name}`);
      files.push({ path, relative: relative(output, path).split(sep).join('/'), bytes: stat.size });
    }
  }
}
await walk(output);
for (const file of files) {
  assert(!/^(api|src|scripts|node_modules|\.next|server)\//.test(file.relative), `Unexpected deployed directory: ${file.relative}`);
  assert(!/\.(dcm|dicom|ima|nii|zip|gz|ts|tsx|map)$/i.test(file.relative), `Unexpected deployed file: ${file.relative}`);
}

const html = await readFile(resolve(output, 'index.html'), 'utf8');
assert(html.includes('CMR'), 'The exported entry must contain the classroom');
assert(!/<input[^>]*type=["']file["']/i.test(html), 'The public classroom must not offer DICOM upload');
assert(!html.includes('/api/studies'), 'The public entry must not depend on local study APIs');
const scriptAndStyleUrls = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map(match => match[1]);
assert(scriptAndStyleUrls.length > 0, 'Missing generated client assets');
for (const url of scriptAndStyleUrls) {
  assert(url.startsWith(`${info.basePath}/_next/`), `Unprefixed client asset: ${url}`);
  const path = resolve(output, url.slice(info.basePath.length + 1).split('?')[0]);
  assert(path.startsWith(output + sep), 'Client asset escaped output');
  await lstat(path);
}
for (const file of files.filter(file => file.relative.endsWith('.js'))) {
  const js = await readFile(file.path, 'utf8');
  assert(!js.includes('/api/studies'), `Local study client accidentally bundled: ${file.relative}`);
}
for (const file of files.filter(file => file.relative.endsWith('.css'))) {
  const css = await readFile(file.path, 'utf8');
  for (const [, reference] of css.matchAll(/url\(["']?([^"'()]+)["']?\)/g)) {
    if (reference.startsWith('data:')) continue;
    assert(!/^(?:https?:)?\/\//.test(reference), `Unexpected external CSS asset: ${reference}`);
    if (reference.startsWith('/')) assert(reference.startsWith(`${info.basePath}/`), `Unprefixed CSS asset: ${reference}`);
    const path = reference.startsWith('/')
      ? resolve(output, reference.slice(info.basePath.length + 1))
      : resolve(dirname(file.path), reference);
    assert(path.startsWith(output + sep), 'CSS asset escaped output');
    await lstat(path);
  }
}
const manifest = JSON.parse(await readFile(resolve(root, 'public/anatomy/provenance.json'), 'utf8'));
for (const asset of manifest.files) {
  assert(asset.path.startsWith('public/anatomy/'));
  const bytes = await readFile(resolve(output, asset.path.slice('public/'.length)));
  assert.equal(bytes.length, asset.bytes, `Wrong static asset size: ${asset.path}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, `Changed static asset: ${asset.path}`);
}
console.log(JSON.stringify({
  staticClassroom: true, basePath: info.basePath, files: files.length,
  publicAssetsVerified: manifest.files.length,
  megabytes: Number((files.reduce((total, file) => total + file.bytes, 0) / 1e6).toFixed(2)),
  localStudyApiBundled: false,
}, null, 2));
