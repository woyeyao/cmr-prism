import { chromium, expect } from '@playwright/test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Local performance evidence only. No filenames, UIDs or pixels in output.
const files = (await readdir(resolve('..', 'cmr-eg'))).filter(name => name.endsWith('.dcm')).map(name => resolve('..', 'cmr-eg', name));
const base = process.env.CMR_BASE_URL ?? 'http://127.0.0.1:3001';
const label = process.env.CMR_AUDIT_LABEL ?? 'optimized';
const browser = await chromium.launch({ executablePath: process.env.CMR_BROWSER_EXECUTABLE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const completed = new Set();
let requested = 0;
let lastFrameResponse = 0;
let studyId;
page.on('request', request => { if (/\/frames\//.test(request.url())) requested++; });
page.on('response', async response => {
  if (response.ok() && /\/frames\//.test(response.url())) {
    await response.finished();
    completed.add(decodeURIComponent(response.url().split('/').at(-1)));
    lastFrameResponse = performance.now();
  }
});
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  const responsePromise = page.waitForResponse(r => r.url() === `${base}/api/studies` && r.request().method() === 'POST');
  const started = performance.now();
  await page.getByLabel('选择 DICOM 文件或 ZIP').setInputFiles(files);
  const response = await responsePromise;
  if (response.status() !== 201) throw new Error('Sample import failed');
  const catalog = await response.json();
  studyId = catalog.id;
  const importMs = performance.now() - started;
  const cine = catalog.collections.filter(c => c.kind === 'cine' && c.view === 'SAX').sort((a,b) => b.planes.length - a.planes.length)[0];
  if (!cine) throw new Error('No SAX Cine benchmark');
  const firstCount = Math.min(7,cine.planes.length);
  const firstIds = Array.from({length: firstCount}, (_,i) => cine.planes[firstCount === 1 ? 0 : Math.round(i*(cine.planes.length-1)/(firstCount-1))].frameIds[0]).filter(Boolean);
  await expect.poll(() => firstIds.every(id => completed.has(id)), {timeout: 30000}).toBe(true);
  const firstVisiblePayloadMs = performance.now() - started;
  await page.getByTestId('time-slider').waitFor();
  // Let optional warmup finish; do not include this wait in interactive navigation timing.
  await expect.poll(() => performance.now() - lastFrameResponse > 900, {timeout: 60000}).toBe(true);
  const backgroundSettledMs = performance.now() - started;
  const requestsBeforeCycle = requested;
  const cachedBeforeCycle = completed.size;
  const cycleStarted = performance.now();
  for (let frame = 0; frame < 25; frame++) {
    await page.getByTestId('time-slider').fill(String(frame));
    await expect(page.locator('.stage-load-indicator')).toHaveCount(0, {timeout:15000});
  }
  const cycleMs = performance.now() - cycleStarted;
  const cycleFrameRequests = requested - requestsBeforeCycle;
  const metrics = { files: files.length, acceptedFrames: catalog.report.acceptedFrames, importMs: Math.round(importMs), firstVisiblePayloadMs: Math.round(firstVisiblePayloadMs), backgroundSettledMs: Math.round(backgroundSettledMs), cachedBeforeCycle, cycleSteps:25, cycleMs:Math.round(cycleMs), cycleFrameRequests, totalFrameRequests:requested };
  await mkdir('artifacts',{recursive:true});
  await writeFile(join('artifacts',`fluidity-${label}.json`),JSON.stringify(metrics,null,2));
  console.log(JSON.stringify(metrics,null,2));
} finally {
  if (studyId) await page.request.delete(`${base}/api/studies/${encodeURIComponent(studyId)}`).catch(()=>{});
  await browser.close();
}
