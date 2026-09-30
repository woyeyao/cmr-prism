import { chromium } from "@playwright/test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Local-only acceptance. Artifacts and real DICOM pixels are never committed.
const root = process.cwd();
const sample = resolve(root, "..", "cmr-eg");
const forceWebGL = process.env.CMR_FORCE_WEBGL === "1";
const artifactPrefix = forceWebGL ? "sample-webgl" : "sample";
const files = (await readdir(sample)).filter((name) => name.toLowerCase().endsWith(".dcm")).map((name) => join(sample, name));
await mkdir("artifacts", { recursive: true });
const executablePath = process.env.CMR_BROWSER_EXECUTABLE ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  const live = { textures: 0, buffers: 0, gpuTextures: 0, gpuBuffers: 0, gpuDevices: 0 };
  window.__prismResourceAudit = live;
  const glResources = new WeakMap();
  const glOwners = new WeakMap();
  for (const [create, remove, key] of [["createTexture", "deleteTexture", "textures"], ["createBuffer", "deleteBuffer", "buffers"]]) {
    const prototype = WebGL2RenderingContext.prototype;
    const allocate = prototype[create];
    const release = prototype[remove];
    prototype[create] = function (...args) {
      const object = allocate.apply(this, args);
      if (!glResources.has(this)) {
        glResources.set(this, new Map());
        this.canvas.addEventListener("webglcontextlost", () => {
          for (const [resource, resourceKey] of glResources.get(this) ?? []) { live[resourceKey]--; glOwners.delete(resource); }
          glResources.get(this)?.clear();
        });
      }
      if (object) { glResources.get(this).set(object, key); glOwners.set(object, this); live[key]++; }
      return object;
    };
    prototype[remove] = function (object) {
      const owner = object && glOwners.get(object);
      if (owner && glResources.get(owner)?.delete(object)) { live[key]--; glOwners.delete(object); }
      return release.call(this, object);
    };
  }
  if (typeof GPUDevice !== "undefined") {
    const resources = new WeakMap();
    const owners = new WeakMap();
    const devices = new WeakSet();
    const requestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await requestDevice.apply(this, args);
      devices.add(device); live.gpuDevices++;
      return device;
    };
    const destroyDevice = GPUDevice.prototype.destroy;
    GPUDevice.prototype.destroy = function () {
      // destroy() releases every resource owned by this device, even when an
      // individual GPUTexture/GPUBuffer.destroy() was not invoked separately.
      for (const [object, key] of resources.get(this) ?? []) {
        live[key]--; owners.delete(object);
      }
      resources.delete(this);
      if (devices.delete(this)) live.gpuDevices--;
      return destroyDevice.call(this);
    };
    for (const [create, Class, key] of [["createTexture", GPUTexture, "gpuTextures"], ["createBuffer", GPUBuffer, "gpuBuffers"]]) {
      const allocate = GPUDevice.prototype[create];
      const release = Class.prototype.destroy;
      GPUDevice.prototype[create] = function (...args) {
        const object = allocate.apply(this, args);
        const owned = resources.get(this) ?? new Map();
        owned.set(object, key); resources.set(this, owned); owners.set(object, this);
        live[key]++;
        return object;
      };
      Class.prototype.destroy = function () {
        const device = owners.get(this);
        if (device && resources.get(device)?.delete(this)) { live[key]--; owners.delete(this); }
        return release.call(this);
      };
    }
  }
});
if (forceWebGL) await page.addInitScript(() => { delete Navigator.prototype.gpu; });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const base = process.env.CMR_BASE_URL ?? "http://127.0.0.1:3001";
let catalog;
page.on("response", async (response) => {
  if (response.url() === `${base}/api/studies` && response.request().method() === "POST" && response.ok()) catalog = await response.json();
});
try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.screenshot({ path: `artifacts/${artifactPrefix}-cover.png`, fullPage: true });
  await page.locator('input[aria-label="选择 DICOM 文件或 ZIP"]').setInputFiles(files);
  await page.getByTestId("time-slider").waitFor({ timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector(".import-overlay"), null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  const backend = await page.getByTestId("glass-stage").getAttribute("data-backend").catch(() => "2D fallback");
  await page.screenshot({ path: `artifacts/${artifactPrefix}-atlas.png`, fullPage: true });
  await page.getByRole("button", { name: "隐藏影像目录", exact: true }).click();
  await page.getByRole("button", { name: "隐藏参数面板", exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `artifacts/${artifactPrefix}-atlas-expanded.png`, fullPage: true });
  await page.getByRole("button", { name: "展开影像目录", exact: true }).click();
  await page.getByRole("button", { name: "展开参数面板", exact: true }).click();
  await page.getByTestId("mode-inspect").click();
  await page.getByTestId("image-viewport").first().waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `artifacts/${artifactPrefix}-inspect.png`, fullPage: true });
  await page.getByTestId("frame-note").fill("演示备注：当前切面");
  await page.getByRole("button", { name: "＋ 加入空间立方体", exact: true }).click();
  const oldPlane = Number(await page.getByTestId("layer-slider").inputValue());
  await page.getByTestId("layer-slider").fill(String(oldPlane === 2 ? 4 : 2));
  await page.getByRole("button", { name: "＋ 加入空间立方体", exact: true }).click();
  await page.getByTestId("mode-split").click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `artifacts/${artifactPrefix}-split.png`, fullPage: true });
  const referenceLines = await page.locator(".image-overlay line").count();
  const selections = await page.getByRole("combobox", { name: "视口 2 序列", exact: true }).inputValue();
  if (selections) await page.getByRole("button", { name: "加入视口 2 切片到立方体", exact: true }).click();
  await page.getByTestId("mode-cube").click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `artifacts/${artifactPrefix}-cube.png`, fullPage: true });
  await page.getByTestId("play-button").click();
  await page.waitForTimeout(10000);
  await page.getByTestId("play-button").click();
  await page.waitForFunction(() => !document.querySelector(".stage-load-indicator"));
  await page.waitForTimeout(700);
  const firstResources = await page.evaluate(() => ({ ...window.__prismResourceAudit }));
  const cycleResources = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    await page.getByTestId("mode-inspect").click();
    await page.waitForFunction(() => {
      const resources = window.__prismResourceAudit;
      return Object.values(resources).every((count) => count === 0);
    }, null, { timeout: 5000 });
    await page.getByTestId("mode-split").click();
    await page.getByTestId("mode-atlas").click();
    await page.waitForTimeout(300);
    await page.getByTestId("mode-cube").click();
    await page.waitForFunction(() => !document.querySelector(".stage-load-indicator"));
    await page.waitForTimeout(700);
    cycleResources.push(await page.evaluate(() => ({ ...window.__prismResourceAudit })));
  }
  const finalResources = await page.evaluate(() => ({ ...window.__prismResourceAudit }));
  const metrics = {
    importedFiles: files.length,
    acceptedFrames: catalog?.report.acceptedFrames,
    collections: catalog?.collections.length,
    skippedObjects: catalog?.report.skippedObjects,
    renderer: backend,
    referenceLines,
    cubeSelections: await page.locator(".selection-chip").count(),
    finalFrameIndex: await page.getByTestId("time-slider").inputValue(),
    errors,
    firstResources,
    finalResources,
    cycleResources,
    releasedOnInspect: true,
  };
  await writeFile(`artifacts/${artifactPrefix}-browser.json`, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
  if (errors.length) throw new Error("Browser acceptance recorded console/runtime errors");
  if (referenceLines < 1) throw new Error("Real SAX/LAX views did not generate locator lines");
  // Initial atlas→cube reuse can have a different warmed shader/material set
  // from a fresh cube renderer. Compare repeated identical cycles after warmup.
  const baseline = cycleResources[0];
  if (finalResources.textures > baseline.textures + 2 || finalResources.buffers > baseline.buffers + 4) {
    throw new Error("WebGL resources grew after repeated mode switches");
  }
  if (finalResources.gpuTextures > baseline.gpuTextures + 2 || finalResources.gpuBuffers > baseline.gpuBuffers + 4 || finalResources.gpuDevices > baseline.gpuDevices) {
    throw new Error("WebGPU resources grew after repeated mode switches");
  }
} finally {
  if (catalog?.id) await page.request.delete(`${base}/api/studies/${catalog.id}`).catch(() => {});
  await browser.close();
}
