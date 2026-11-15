import { spawn } from 'node:child_process';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/cmr-prism';
if (!/^(?:\/[A-Za-z0-9._~-]+)*$/.test(basePath)) throw new Error('Invalid NEXT_PUBLIC_BASE_PATH');

// Only configuration and route selection differ. No source file or API route is
// moved, copied or temporarily removed. Stop the local Next server before build.
const nextEnv = resolve(root, 'next-env.d.ts');
const originalNextEnv = await readFile(nextEnv);
try {
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'node_modules/next/dist/bin/next'), 'build'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NEXT_PUBLIC_STATIC_CLASSROOM: '1', NEXT_PUBLIC_BASE_PATH: basePath },
    });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`Static classroom build failed (${code})`);
  // Relative CSS font imports are bundled under _next/static/media. Avoid
  // publishing second copies from public/fonts, but retain every license file.
  const bundledFonts = new Set();
  const media = resolve(root, 'artifacts/pages/_next/static/media');
  for (const name of await readdir(media)) if (name.endsWith('.woff2')) {
    bundledFonts.add(createHash('sha256').update(await readFile(resolve(media, name))).digest('hex'));
  }
  for (const name of ['MiSans-Regular.woff2', 'MiSans-Light.woff2', 'MiSans-Bold.woff2']) {
    const path = resolve(root, 'artifacts/pages/fonts', name);
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (!bundledFonts.has(digest)) throw new Error(`Missing bundled font: ${name}`);
    await unlink(path);
  }
  await writeFile(resolve(root, 'artifacts/pages/.nojekyll'), '');
  await writeFile(resolve(root, 'artifacts/pages/build-info.json'), JSON.stringify({
    version: JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version,
    basePath,
    application: 'anatomy-classroom',
    revision: process.env.GITHUB_SHA ?? null,
  }) + '\n');
  console.log(`Static classroom: artifacts/pages (base path: ${basePath || '/'})`);
} finally {
  // Keep the normal local project's generated declaration byte-for-byte stable.
  if (!(await readFile(nextEnv)).equals(originalNextEnv)) await writeFile(nextEnv, originalNextEnv);
}
