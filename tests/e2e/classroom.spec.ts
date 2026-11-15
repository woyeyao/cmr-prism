import { expect, test, type Locator, type Page } from "@playwright/test";
import dcmjs from "dcmjs";
import { createSyntheticStudyUploads } from "./syntheticDicom";
import { trackGraphicsResources, graphicsResources, zeroGraphicsResources } from "./graphicsResources";

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Missing visible bounds: ${locator}`);
  return box;
}

async function openClassroom(page: Page) {
  await page.goto("/");
  await page.getByTestId("mode-anatomy").click();
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
}

async function dragSeparator(page: Page, id: string, dx: number, dy = 0) {
  const separator = page.getByTestId(`resize-${id}`);
  await separator.scrollIntoViewIfNeeded();
  const box = await bounds(separator);
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

async function readDownload(page: Page, button: Locator) {
  const pending = page.waitForEvent("download");
  await button.click();
  const download = await pending;
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Plane download was not readable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await download.delete();
  return value;
}

const coursePlane = (page: Page) => readDownload(page, page.locator(".anatomy-adjustment-actions button").last());
const freePlane = (page: Page) => readDownload(page, page.locator(".free-slice-actions button").last());
const sceneScreenshot = (canvas: Locator) => canvas.screenshot({
  // A canvas locator screenshot also captures overlaid DOM controls; their text
  // should translate, while the actual 3D scene/camera must stay unchanged.
  style: ".anatomy-stage > :not([data-testid='anatomy-webgl']), .anatomy-scene-bottom, .free-slice-drag-hint { visibility: hidden !important; }",
});

async function assertImageAspect(image: Locator, aspect: number, offset = 0) {
  await expect.poll(async () => {
    const box = await bounds(image);
    return Math.abs(box.height - (box.width / aspect + offset));
  }).toBeLessThanOrEqual(2);
}

async function findGizmoHandle(page: Page, allowed: RegExp) {
  const stage = page.getByTestId("anatomy-stage"), canvas = page.getByTestId("anatomy-webgl");
  const box = await bounds(canvas);
  const points = [];
  for (let y = -14; y <= 14; y++) for (let x = -14; x <= 14; x++) points.push({ x: x * 22, y: y * 22 });
  points.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  for (const point of points) {
    const x = box.x + box.width / 2 + point.x, y = box.y + box.height / 2 + point.y;
    if (x < box.x + 25 || x > box.x + box.width - 25 || y < box.y + 45 || y > box.y + box.height - 70) continue;
    await page.mouse.move(x, y);
    const axis = await stage.getAttribute("data-plane-axis");
    if (axis && allowed.test(axis)) return { x, y, axis };
  }
  throw new Error(`No visible gizmo handle matched ${allowed}`);
}

/** A non-square physical pixel size catches matrix-ratio-only layouts. */
function anisotropicStudy() {
  const data = (dcmjs as any).data;
  return createSyntheticStudyUploads().map(upload => {
    if (!upload.name.includes("4ch")) return upload;
    const bytes = upload.buffer;
    const parsed = data.DicomMessage.readFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    parsed.dict["00280030"].Value = [2, 1];
    const writer = new data.DicomDict(parsed.meta);
    writer.dict = parsed.dict;
    return { ...upload, buffer: Buffer.from(writer.write()) };
  });
}

test("CMR width resizing scales image height by its aspect, including anisotropic local pixels", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await openClassroom(page);
  const image = page.locator(".anatomy-cine-image");
  const bitmap = image.locator("img");
  await expect.poll(() => bitmap.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const aspect = await bitmap.evaluate(element => (element as HTMLImageElement).naturalWidth / (element as HTMLImageElement).naturalHeight);
  await assertImageAspect(image, aspect);
  const initial = await bounds(image);
  await dragSeparator(page, "inspectorWidth", -110);
  await expect.poll(async () => (await bounds(image)).width - initial.width).toBeGreaterThan(80);
  const larger = await bounds(image);
  expect(larger.height - initial.height).toBeCloseTo((larger.width - initial.width) / aspect, 0);
  await assertImageAspect(image, aspect);
  expect(await bitmap.evaluate(element => getComputedStyle(element).objectFit)).toBe("contain");

  await dragSeparator(page, "referenceHeight", 0, 50);
  const offset = Number(await page.getByTestId("resize-referenceHeight").getAttribute("aria-valuenow"));
  expect(offset).toBeGreaterThan(30);
  await assertImageAspect(image, aspect, offset);
  const beforeSecondWidth = await bounds(image);
  await dragSeparator(page, "inspectorWidth", -55);
  const afterSecondWidth = await bounds(image);
  expect(afterSecondWidth.height - beforeSecondWidth.height).toBeCloseTo((afterSecondWidth.width - beforeSecondWidth.width) / aspect, 0);
  await page.getByTestId("resize-referenceHeight").dblclick();
  await assertImageAspect(image, aspect);
  const beforeEnlarge = await bounds(image);
  const node = await bitmap.elementHandle();
  await page.getByRole("button", { name: "放大 CMR 对照", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "放大 CMR 对照", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await bitmap.evaluate((element, original) => element === original, node)).toBe(true);
  await expect.poll(async () => Math.abs((await bounds(image)).height - beforeEnlarge.height)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "重置工作台布局", exact: true }).click();

  const imported = page.waitForResponse(response => response.url().endsWith("/api/studies") && response.request().method() === "POST");
  await page.getByLabel("选择 DICOM 文件或 ZIP", { exact: true }).setInputFiles(anisotropicStudy());
  const catalog = await (await imported).json();
  try {
    await page.getByRole("button", { name: "本机病例", exact: true }).click();
    const local = page.getByTestId("local-comparison");
    await expect(local.getByTestId("image-viewport")).toBeVisible();
    const localImage = local.locator(".local-comparison-image");
    // The synthetic image is 8×8, with row spacing 2 mm and column spacing 1 mm.
    await assertImageAspect(localImage, 0.5);
    const before = await bounds(localImage);
    await dragSeparator(page, "inspectorWidth", -85);
    const after = await bounds(localImage);
    expect(after.width - before.width).toBeGreaterThan(60);
    expect(after.height - before.height).toBeCloseTo((after.width - before.width) * 2, 0);
    await assertImageAspect(localImage, 0.5);
  } finally {
    if (catalog.id) await request.delete(`/api/studies/${encodeURIComponent(catalog.id)}`);
  }
});

test("language changes preserve the course plane, camera, cine and saved preference", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openClassroom(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const webgl = page.getByTestId("anatomy-webgl");
  const originalCanvas = await webgl.elementHandle();
  const box = await bounds(webgl);
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .61, box.y + box.height * .56, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(0, 0);
  await page.locator(".anatomy-adjustments > summary").click();
  const coordinate = page.getByLabel("X 轴平移数值", { exact: true });
  await coordinate.fill("");
  await coordinate.pressSequentially("-12.5");
  await coordinate.press("Tab");
  await expect(coordinate).toHaveValue("-12.5");
  expect((await coursePlane(page)).adjustments.translationXYZ[0]).toBe(-12.5);
  await page.getByLabel("X 轴平移数值", { exact: true }).fill("6.5");
  await page.getByLabel("X 轴平移数值", { exact: true }).press("Tab");
  const planeBefore = await coursePlane(page);
  const cine = page.getByTestId("anatomy-reference-cine");
  await cine.getByRole("slider").fill("7");
  const cineNode = await cine.elementHandle();
  const cameraBefore = await sceneScreenshot(webgl);
  await page.getByTestId("language-switch").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("language-switch")).toHaveText("中文");
  await expect(page.getByRole("group", { name: "Anatomy atlas", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enlarge CMR comparison", exact: true })).toBeVisible();
  await expect(page.getByLabel("X translation value", { exact: true })).toHaveValue("6.5");
  expect(await webgl.evaluate((element, original) => element === original, originalCanvas)).toBe(true);
  expect((await coursePlane(page)).effectivePlane).toEqual(planeBefore.effectivePlane);
  expect((await coursePlane(page)).originalPreset).toEqual(planeBefore.originalPreset);
  expect(await cine.evaluate((element, original) => element === original, cineNode)).toBe(true);
  await expect(cine.getByRole("slider")).toHaveValue("7");
  try {
    await expect.poll(async () => Buffer.compare(await sceneScreenshot(webgl), cameraBefore)).toBe(0);
  } catch (error) {
    await test.info().attach("scene-before", { body: cameraBefore, contentType: "image/png" });
    await test.info().attach("scene-after", { body: await sceneScreenshot(webgl), contentType: "image/png" });
    throw error;
  }
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("language-switch")).toHaveText("中文");
  expect(await page.evaluate(() => localStorage.getItem("cmr-prism-locale"))).toBe("en");
  await page.getByTestId("language-switch").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  expect(errors).toEqual([]);
});

test("free slicing accepts unrestricted positions and full rotations without changing course presets", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openClassroom(page);
  await page.locator(".anatomy-adjustments > summary").click();
  const courseBefore = await coursePlane(page);
  await page.getByTestId("classroom-free").click();
  const free = page.getByTestId("free-slice-workspace");
  await expect(free).toBeVisible();
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("anatomy-workspace")).toHaveCount(0);
  await expect(page.getByTestId("anatomy-reference-cine")).toHaveCount(0);
  await expect(page.getByTestId("anatomy-section")).toHaveCount(0);
  await expect(page.getByTestId("anatomy-locator")).toHaveCount(0);
  const initial = await freePlane(page);
  expect(initial).toMatchObject({ mode: "free", modelId: "bodyparts3d" });
  const newOrigin = initial.effectivePlane.origin.map((value: number, index: number) => value + [350, -270, 190][index]);
  for (const [index, axis] of ["X", "Y", "Z"].entries()) {
    const field = page.getByLabel(`自由切面 ${axis} 坐标`, { exact: true });
    expect(await field.getAttribute("min")).toBeNull();
    expect(await field.getAttribute("max")).toBeNull();
    await field.fill(String(newOrigin[index]));
    await field.press("Tab");
  }
  const translated = await freePlane(page);
  translated.effectivePlane.origin.forEach((value: number, index: number) => expect(value).toBeCloseTo(newOrigin[index], 5));
  expect(translated.effectivePlane.normal).toEqual(initial.effectivePlane.normal);
  await page.getByRole("button", { name: "复位切面", exact: true }).click();
  const webgl = page.getByTestId("anatomy-webgl");
  const initialImage = await webgl.screenshot();
  for (const [index, axis] of ["X", "Y", "Z"].entries()) {
    await page.getByLabel(`自由切面绕 ${axis} 轴角度`, { exact: true }).fill(String([137, -62, 405][index]));
    await page.getByLabel(`自由切面绕 ${axis} 轴角度`, { exact: true }).press("Tab");
  }
  const rotated = await freePlane(page);
  expect(rotated.pose.rotation).toEqual([137, -62, 405]);
  expect(rotated.effectivePlane.origin).toEqual(initial.effectivePlane.origin);
  expect(rotated.effectivePlane.normal).not.toEqual(initial.effectivePlane.normal);
  for (const axis of ["normal", "up", "right"]) expect(Math.hypot(...rotated.effectivePlane[axis])).toBeCloseTo(1, 10);
  expect(rotated.effectivePlane.normal.reduce((sum: number, value: number, index: number) => sum + value * rotated.effectivePlane.up[index], 0)).toBeCloseTo(0, 10);
  expect(Buffer.compare(await webgl.screenshot(), initialImage)).not.toBe(0);
  await page.getByRole("button", { name: "复位切面", exact: true }).click();
  expect((await freePlane(page)).effectivePlane).toEqual(initial.effectivePlane);
  await page.getByRole("button", { name: "仅断面", exact: true }).click();
  await expect(page.getByRole("button", { name: "仅断面", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "解剖图谱", exact: true }).getByRole("button", { name: /HRA/ }).click();
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
  expect((await freePlane(page)).modelId).toBe("hra");
  await page.getByTestId("classroom-course").click();
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
  await page.locator(".anatomy-adjustments > summary").click();
  expect((await coursePlane(page)).originalPreset).toEqual(courseBefore.originalPreset);
});

test("free plane gizmos translate and rotate the real cut, then release their GPU resources", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await trackGraphicsResources(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openClassroom(page);
  await page.getByTestId("classroom-free").click();
  const stage = page.getByTestId("anatomy-stage"), canvas = page.getByTestId("anatomy-webgl");
  await expect(stage).toHaveAttribute("data-state", "ready");
  await expect(stage).toHaveAttribute("data-plane-control", "translate");
  await page.getByRole("button", { name: "正对切面", exact: true }).click();
  const initial = await freePlane(page);
  const move = await findGizmoHandle(page, /^(X|Y|Z|XY|XZ|YZ)$/);
  await page.mouse.down();
  await expect(stage).toHaveAttribute("data-plane-dragging", "true");
  await page.mouse.move(move.x + 38, move.y - 26, { steps: 8 });
  await page.mouse.up();
  await expect(stage).toHaveAttribute("data-plane-dragging", "false");
  const moved = await freePlane(page);
  expect(Math.hypot(...moved.effectivePlane.origin.map((value: number, index: number) => value - initial.effectivePlane.origin[index]))).toBeGreaterThan(.1);
  moved.effectivePlane.normal.forEach((value: number, index: number) => expect(value).toBeCloseTo(initial.effectivePlane.normal[index], 8));

  await page.getByRole("button", { name: "复位切面", exact: true }).click();
  await page.getByRole("button", { name: "旋转切面", exact: true }).click();
  await expect(stage).toHaveAttribute("data-plane-control", "rotate");
  const beforeRotationImage = await sceneScreenshot(canvas);
  const rotate = await findGizmoHandle(page, /^(X|Y|Z)$/);
  await page.mouse.down();
  await expect(stage).toHaveAttribute("data-plane-dragging", "true");
  await page.mouse.move(rotate.x + 45, rotate.y + 32, { steps: 8 });
  await page.mouse.up();
  await expect(stage).toHaveAttribute("data-plane-dragging", "false");
  const rotated = await freePlane(page);
  rotated.effectivePlane.origin.forEach((value: number, index: number) => expect(value).toBeCloseTo(initial.effectivePlane.origin[index], 8));
  expect(Math.hypot(...rotated.effectivePlane.normal.map((value: number, index: number) => value - initial.effectivePlane.normal[index]))).toBeGreaterThan(.01);
  expect(Buffer.compare(await sceneScreenshot(canvas), beforeRotationImage)).not.toBe(0);

  await page.getByRole("button", { name: "观察模型", exact: true }).click();
  await expect(stage).toHaveAttribute("data-plane-control", "orbit");
  const planeBeforeOrbit = await freePlane(page);
  const orbitBefore = await sceneScreenshot(canvas);
  const box = await bounds(canvas);
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .67, box.y + box.height * .44, { steps: 8 });
  await page.mouse.up();
  expect((await freePlane(page)).effectivePlane).toEqual(planeBeforeOrbit.effectivePlane);
  expect(Buffer.compare(await sceneScreenshot(canvas), orbitBefore)).not.toBe(0);
  await page.getByTestId("mode-anatomy").click();
  await expect(page.getByTestId("free-slice-workspace")).toHaveCount(0);
  await expect.poll(() => graphicsResources(page)).toEqual(zeroGraphicsResources);
  expect(errors).toEqual([]);
});
