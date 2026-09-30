import { chromium, expect } from '@playwright/test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Real pixels and screenshots stay in ignored local artifacts.
const base = process.env.CMR_BASE_URL ?? 'http://127.0.0.1:3001';
const files = (await readdir(resolve('..', 'cmr-eg'))).filter(n => n.toLowerCase().endsWith('.dcm')).map(n => resolve('..', 'cmr-eg', n));
const browser = await chromium.launch({ executablePath: process.env.CMR_BROWSER_EXECUTABLE ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
const page = await browser.newPage({ viewport: { width:1600, height:1000 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
let studyId;
page.on('response', async r => { if(r.url() === `${base}/api/studies` && r.request().method() === 'POST' && r.ok()) studyId = (await r.json()).id; });
await mkdir('artifacts', { recursive:true });
async function difference(first, second) {
  return page.evaluate(async ([a, b]) => {
    async function decode(data) {
      const blob = await (await fetch('data:image/png;base64,' + data)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    }
    const x = await decode(a), y = await decode(b);
    let changed = 0;
    for(let i = 0; i < x.length; i += 4) if(Math.abs(x[i]-y[i])+Math.abs(x[i+1]-y[i+1])+Math.abs(x[i+2]-y[i+2]) > 12) changed++;
    return changed;
  }, [first.toString('base64'), second.toString('base64')]);
}
try {
  await page.goto(base, { waitUntil:'networkidle' });
  await page.screenshot({path:'artifacts/wave-cover-light.png'});
  await page.getByRole('button',{name:'切换暗色模式',exact:true}).click();
  await page.screenshot({path:'artifacts/wave-cover-dark.png'});
  await page.getByRole('button',{name:'切换浅色模式',exact:true}).click();
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForTimeout(1200);
  await page.screenshot({path:'artifacts/wave-cover-moving.png'});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByLabel('选择 DICOM 文件或 ZIP').setInputFiles(files);
  await page.getByTestId('time-slider').waitFor({timeout:120000});
  await page.waitForFunction(()=>!document.querySelector('.stage-load-indicator'),null,{timeout:60000});
  const stage=page.getByTestId('glass-stage'), canvas=stage.locator('canvas');
  await expect.poll(()=>stage.getAttribute('data-backend')).toMatch(/WebGPU|WebGL2/);
  const renderer = await stage.getAttribute('data-backend');
  await page.mouse.move(10,10);
  await page.waitForTimeout(300);
  await page.screenshot({path:'artifacts/upward-atlas-light.png'});
  const baseline=await canvas.screenshot();
  const bounds=(await canvas.boundingBox());
  const drag=async(button,shift=false)=>{
    await page.mouse.move(bounds.x+bounds.width*.08,bounds.y+bounds.height*.78);
    if(shift) await page.keyboard.down('Shift');
    await page.mouse.down({button});
    await page.mouse.move(bounds.x+bounds.width*.08+90,bounds.y+bounds.height*.78+40,{steps:8});
    await page.mouse.up({button});
    if(shift) await page.keyboard.up('Shift');
    await page.mouse.move(10,10);
    await page.waitForTimeout(150);
    await expect(page.getByTestId('mode-atlas')).toHaveAttribute('aria-pressed','true');
  };
  await drag('left',true);
  const shiftPan=await canvas.screenshot();
  await stage.getByRole('button',{name:'重置场景视角'}).click();
  await page.mouse.move(10,10); await page.waitForTimeout(150);
  const reset=await canvas.screenshot();
  await drag('right');
  const rightPan=await canvas.screenshot();
  const panChanged=await difference(baseline,shiftPan);
  const panEquivalence=await difference(shiftPan,rightPan);
  const resetDifference=await difference(baseline,reset);
  if(panChanged<1000||panEquivalence>300||resetDifference>300) throw Error('Pan/reset screenshot comparison failed');
  await stage.getByRole('button',{name:'重置场景视角'}).click();
  await page.getByLabel('阵列层间距').fill('1.1');
  await page.mouse.move(10,10); await page.waitForTimeout(200);
  await page.screenshot({path:'artifacts/upward-atlas-spaced.png'});
  const spacingChanged=await difference(baseline,await canvas.screenshot());
  if(spacingChanged<1000) throw Error('Spacing did not change scene');
  await page.getByRole('button',{name:'切换暗色模式',exact:true}).click();
  await page.mouse.move(10,10); await page.waitForTimeout(200);
  await page.screenshot({path:'artifacts/upward-atlas-dark.png'});
  const corner=await page.evaluate(async data=>{
    const bitmap=await createImageBitmap(await(await fetch('data:image/png;base64,'+data)).blob());
    const c=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
    return [...ctx.getImageData(0,0,1,1).data];
  },(await canvas.screenshot()).toString('base64'));
  if(corner.slice(0,3).some(v=>v>50)) throw Error('Three scene did not adopt dark background');
  await page.getByTestId('mode-inspect').click();
  await page.getByTestId('image-viewport').dispatchEvent('wheel',{deltaY:-200,ctrlKey:true,clientX:800,clientY:400});
  await expect.poll(()=>page.locator('.image-viewport').getAttribute('data-zoom')).not.toBe('1.000');
  await page.screenshot({path:'artifacts/inspect-zoom-dark.png'});
  await page.getByTestId('mode-split').click();
  await page.waitForTimeout(500);
  await page.screenshot({path:'artifacts/split-dark.png'});
  const result={renderer,importedFiles:files.length,panChanged,panEquivalence,resetDifference,spacingChanged,darkSceneCorner:corner,errors};
  await writeFile('artifacts/viewer-controls.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if(errors.length) throw Error('Browser errors recorded');
} finally {
  if(studyId) await page.request.delete(`${base}/api/studies/${encodeURIComponent(studyId)}`).catch(()=>{});
  await browser.close();
}
