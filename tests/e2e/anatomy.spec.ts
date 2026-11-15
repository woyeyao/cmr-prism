import { expect, test, type Locator, type Page } from "@playwright/test";
import { createSyntheticStudyUploads } from "./syntheticDicom";

import { trackGraphicsResources, graphicsResources as resources, zeroGraphicsResources as zeroResources } from "./graphicsResources";

async function openAnatomy(page: Page) {
  await page.getByTestId("mode-anatomy").click();
  await expect(page.getByTestId("anatomy-workspace")).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

async function exportPlane(page: Page) {
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出切面参数/ }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Plane parameter download was not readable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await download.delete();
  return exported;
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`Missing visible bounds: ${locator}`);
  return bounds;
}

async function dragSeparator(page: Page, name: string, dx: number, dy: number) {
  const separator = page.getByRole("separator", { name, exact: true });
  await separator.scrollIntoViewIfNeeded();
  const bounds = await box(separator);
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("anatomy model switches release GPU resources and keep the same teaching view", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await trackGraphicsResources(page);
  const exceptions: string[] = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  await page.goto("/");
  await openAnatomy(page);
  await page.getByTestId("anatomy-view-sax-mid").click();
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
  await expect.poll(async () => (await resources(page)).buffers).toBeGreaterThan(0);

  const bodyCounts = await resources(page);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole("group", { name: "解剖图谱" }).getByRole("button", { name: /HRA/ }).click();
    await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("anatomy-view-sax-mid")).toHaveAttribute("aria-current", "step");
    await page.getByRole("group", { name: "解剖图谱" }).getByRole("button", { name: /BodyParts3D/ }).click();
    await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
    await expect.poll(() => resources(page)).toEqual(bodyCounts);
  }

  await page.getByTestId("mode-anatomy").click();
  await expect(page.getByTestId("anatomy-workspace")).toHaveCount(0);
  await expect.poll(() => resources(page)).toEqual(zeroResources);
  expect(exceptions).toEqual([]);
});

test("XYZ translation updates the shared 3D plane, section and locator without altering the preset", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await openAnatomy(page);
  const stage = page.getByTestId("anatomy-stage");
  await expect(stage).toHaveAttribute("data-state", "ready");
  const section = page.getByTestId("anatomy-section").locator("canvas");
  const locator = page.getByTestId("anatomy-locator").locator("canvas");
  const pixels = (canvas: Locator) => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await expect.poll(() => section.evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(50);
  await page.locator(".anatomy-adjustments > summary").click();
  const original = await exportPlane(page);
  const sectionBefore = await pixels(section), locatorBefore = await pixels(locator);
  const stageBefore = await stage.screenshot();

  // Exercise both precise numeric entry and the directly draggable controls.
  await page.getByLabel("X 轴平移数值", { exact: true }).fill("6.5");
  await page.getByLabel("X 轴平移数值", { exact: true }).press("Tab");
  await page.getByRole("slider", { name: "Y 轴平移", exact: true }).fill("-4");
  await page.getByRole("slider", { name: "Z 轴平移", exact: true }).fill("3");
  await page.getByLabel("沿法线平移", { exact: true }).fill("5");
  await page.getByLabel("绕面内横轴倾斜", { exact: true }).fill("8");
  const translated = await exportPlane(page);
  expect(translated).toMatchObject({ modelId: "bodyparts3d", status: "candidate", adjustments: { translationXYZ: [6.5, -4, 3], offset: 5, tiltX: 8, tiltY: 0 } });
  expect(translated.originalPreset).toEqual(original.originalPreset);
  expect(translated.effectivePlane.normal).not.toEqual(original.effectivePlane.normal);
  translated.effectivePlane.origin.forEach((value: number, index: number) => {
    expect(value).toBeCloseTo(original.originalPreset.origin[index] + [6.5, -4, 3][index] + translated.effectivePlane.normal[index] * 5, 5);
  });
  await expect.poll(() => pixels(section)).not.toBe(sectionBefore);
  await expect.poll(() => pixels(locator)).not.toBe(locatorBefore);
  expect(await stage.screenshot()).not.toEqual(stageBefore);

  await page.getByRole("button", { name: "恢复预设", exact: true }).click();
  for (const axis of ["X", "Y", "Z"]) await expect(page.getByLabel(`${axis} 轴平移数值`, { exact: true })).toHaveValue("0");
  expect((await exportPlane(page)).effectivePlane).toEqual(original.effectivePlane);
  await expect.poll(() => pixels(section)).toBe(sectionBefore);
  await expect.poll(() => pixels(locator)).toBe(locatorBefore);
  await page.getByRole("slider", { name: "X 轴平移", exact: true }).fill("9");
  await page.getByTestId("anatomy-view-sax-mid").click();
  await expect(page.getByLabel("X 轴平移数值", { exact: true })).toHaveValue("0");
  await page.getByRole("slider", { name: "Z 轴平移", exact: true }).fill("7");
  await page.getByRole("group", { name: "解剖图谱" }).getByRole("button", { name: /HRA/ }).click();
  await expect(stage).toHaveAttribute("data-state", "ready");
  await expect(page.getByLabel("Z 轴平移数值", { exact: true })).toHaveValue("0");
});

test("anatomy section controls, locator, Cine and missing presets remain consistent", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const exceptions: string[] = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  await page.goto("/");
  await openAnatomy(page);
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("anatomy-view-4ch")).toHaveAttribute("aria-current", "step");
  const section = page.getByTestId("anatomy-section").locator("canvas");
  const locator = page.getByTestId("anatomy-locator").locator("canvas");
  const pixels = () => section.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await expect.poll(() => section.evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(50);
  const filled = await pixels();
  await page.getByRole("checkbox", { name: "3D 切口填色", exact: true }).uncheck();
  await expect(page.getByRole("checkbox", { name: "2D 断面填色", exact: true })).toBeChecked();
  expect(await pixels()).toBe(filled);
  await page.getByRole("checkbox", { name: "2D 断面填色", exact: true }).uncheck();
  await expect.poll(pixels).not.toBe(filled);
  await page.getByRole("checkbox", { name: "2D 断面填色", exact: true }).check();
  await expect.poll(pixels).toBe(filled);
  await page.getByRole("button", { name: "仅断面", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "显示 A 侧", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "显示 B 侧", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "整心", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "显示 A 侧", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "显示 B 侧", exact: true })).toBeChecked();

  const reference = page.getByRole("combobox", { name: "定位参考面", exact: true });
  await expect(reference).toHaveValue("sax-basal");
  await reference.selectOption("3ch");
  await expect(page.getByTestId("anatomy-locator")).toHaveAttribute("aria-label", /三腔/);
  const enlarge = page.getByRole("button", { name: "放大解剖断面", exact: true });
  await enlarge.click();
  const dialog = page.getByRole("dialog", { name: "放大解剖断面与定位线", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("anatomy-section")).toBeVisible();
  await expect(dialog.getByTestId("anatomy-locator")).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "放大视图定位参考面", exact: true })).toHaveValue("3ch");
  // Both directions must stay within the modal instead of reaching page controls.
  for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(enlarge).toBeFocused();
  await reference.selectOption("sax-basal");

  await page.locator(".anatomy-adjustments > summary").click();
  const locatorBefore = await locator.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await page.getByLabel("沿法线平移", { exact: true }).fill("7");
  await expect.poll(pixels).not.toBe(filled);
  await expect.poll(() => locator.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).not.toBe(locatorBefore);
  await page.getByLabel("沿法线平移", { exact: true }).fill("5");
  const exported = await exportPlane(page);
  expect(exported).toMatchObject({ modelId: "bodyparts3d", status: "candidate", adjustments: { offset: 5, tiltX: 0, tiltY: 0 }, originalPreset: { id: "4ch" }, effectivePlane: { id: "4ch" } });
  const displacement = exported.effectivePlane.origin.map((value: number, index: number) => value - exported.originalPreset.origin[index]);
  expect(Math.hypot(...displacement)).toBeCloseTo(5, 5);
  displacement.forEach((value: number, index: number) => expect(value).toBeCloseTo(exported.effectivePlane.normal[index] * 5, 5));
  await page.getByRole("button", { name: "恢复预设", exact: true }).click();
  await expect(page.getByLabel("沿法线平移", { exact: true })).toHaveValue("0");
  await expect.poll(pixels).toBe(filled);

  const cine = page.getByTestId("anatomy-reference-cine");
  const cineSlider = cine.getByRole("slider", { name: "参考 Cine 帧", exact: true });
  await expect(cine.getByRole("button", { name: "播放参考 Cine", exact: true })).toBeEnabled();
  await cine.getByRole("button", { name: "播放参考 Cine", exact: true }).click();
  await expect.poll(() => cineSlider.inputValue()).not.toBe("0");
  await cine.getByRole("button", { name: "暂停参考 Cine", exact: true }).click();
  await cineSlider.fill("3");
  const cineGroup = cine.getByRole("group");
  await cineGroup.focus();
  await cineGroup.press("ArrowRight");
  await expect(cineSlider).toHaveValue("4");
  await expect(page.getByTestId("anatomy-view-4ch")).toHaveAttribute("aria-current", "step");
  await expect(cine).toContainText("与图谱非同一受试者");
  await cine.getByRole("combobox", { name: "参考 Cine 播放速度", exact: true }).selectOption("12");
  const cineNode = await cine.elementHandle();
  const enlargeCmr = page.getByRole("button", { name: "放大 CMR 对照", exact: true });
  await enlargeCmr.click();
  const cmrDialog = page.getByRole("dialog", { name: "放大 CMR 对照", exact: true });
  await expect(cmrDialog).toBeVisible();
  await expect(cmrDialog.getByTestId("anatomy-reference-cine")).toBeVisible();
  await expect(page.getByTestId("anatomy-reference-cine")).toHaveCount(1);
  expect(await cine.evaluate((element, previous) => element === previous, cineNode)).toBe(true);
  for (const key of ["Shift+Tab", "Tab", "Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect.poll(() => cmrDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await expect(cineSlider).toHaveValue("4");
  await expect(cine.getByRole("combobox", { name: "参考 Cine 播放速度", exact: true })).toHaveValue("12");
  await cine.getByRole("button", { name: "播放参考 Cine", exact: true }).click();
  await expect.poll(() => cineSlider.inputValue()).not.toBe("4");
  await page.keyboard.press("Escape");
  await expect(cmrDialog).toHaveCount(0);
  await expect(enlargeCmr).toBeFocused();
  await expect(cine.getByRole("button", { name: "暂停参考 Cine", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await cine.evaluate((element, previous) => element === previous, cineNode)).toBe(true);
  await cine.getByRole("button", { name: "暂停参考 Cine", exact: true }).click();

  await page.getByLabel("沿法线平移", { exact: true }).fill("5");
  await page.getByLabel("绕面内横轴倾斜", { exact: true }).fill("8");
  await reference.selectOption("3ch");
  await page.getByTestId("anatomy-view-rvot").click();
  await expect(page.getByLabel("沿法线平移", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("绕面内横轴倾斜", { exact: true })).toHaveValue("0");
  await expect(reference).toHaveValue("scout-axial");
  await page.getByRole("group", { name: "解剖图谱" }).getByRole("button", { name: /HRA/ }).click();
  await expect(page.getByRole("heading", { name: /此视图待补标/ })).toBeVisible();
  await expect(page.getByTestId("anatomy-view-rvot")).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("anatomy-stage")).toHaveCount(0);
  // HRA's verified LPS mapping now makes the axial/coronal/sagittal scouts usable.
  for (const id of ["scout-axial", "scout-coronal", "scout-sagittal", "p2ch", "p4ch"]) {
    await page.getByTestId(`anatomy-view-${id}`).click();
    await expect(page.getByTestId(`anatomy-view-${id}`)).toHaveAttribute("aria-current", "step");
    await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("anatomy-section")).not.toContainText("当前平面未与可见结构相交");
    await expect(page.getByTestId("anatomy-section")).not.toContainText("未映射患者方位");
  }
  await page.getByTestId("anatomy-view-sax-mid").click();
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("anatomy-section")).not.toContainText("未映射患者方位");
  await expect(reference).toHaveValue("4ch");
  await reference.selectOption("3ch");
  await page.getByLabel("沿法线平移", { exact: true }).fill("5");
  await page.getByRole("group", { name: "解剖图谱" }).getByRole("button", { name: /BodyParts3D/ }).click();
  await expect(page.getByTestId("anatomy-view-sax-mid")).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
  await expect(reference).toHaveValue("4ch");
  await expect(page.getByLabel("沿法线平移", { exact: true })).toHaveValue("0");
  await page.getByRole("button", { name: "下一个教学视图", exact: true }).click();
  await expect(page.getByTestId("anatomy-view-sax-apical")).toHaveAttribute("aria-current", "step");
  await page.getByRole("button", { name: "上一个教学视图", exact: true }).click();
  await expect(page.getByTestId("anatomy-view-sax-mid")).toHaveAttribute("aria-current", "step");

  await noHorizontalOverflow(page);
  expect(exceptions).toEqual([]);
});

test("the integrated classroom header and 3D theme preserve the current camera and plane", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await openAnatomy(page);
  await expect(page.locator(".prism-header")).toHaveCount(0);
  await expect(page.locator(".anatomy-header")).toHaveCount(1);
  await expect(page.getByText("这一面，看什么", { exact: true })).toHaveCount(0);
  await expect(page.getByText("LOOK FOR", { exact: true })).toHaveCount(0);
  const stage = page.getByTestId("anatomy-stage");
  await expect(stage).toHaveAttribute("data-state", "ready");
  const canvas = stage.getByTestId("anatomy-webgl");
  const originalCanvas = await canvas.elementHandle();
  const bounds = await box(canvas);
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.64, bounds.y + bounds.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(0, 0);
  await page.locator(".anatomy-adjustments > summary").click();
  await page.getByLabel("沿法线平移", { exact: true }).fill("4");
  const planeBefore = await exportPlane(page);
  const initialTheme = await stage.getAttribute("data-theme");
  const background = () => stage.evaluate((element) => getComputedStyle(element).backgroundImage);
  const backgroundBefore = await background();
  const imageBefore = await stage.screenshot();
  const nextTheme = initialTheme === "light" ? "dark" : "light";
  await page.getByRole("button", { name: initialTheme === "light" ? "切换暗色模式" : "切换浅色模式", exact: true }).click();
  await expect(stage).toHaveAttribute("data-theme", nextTheme);
  await expect.poll(background).not.toBe(backgroundBefore);
  expect(Buffer.compare(await stage.screenshot(), imageBefore)).not.toBe(0);
  expect(await canvas.evaluate((element, original) => element === original, originalCanvas)).toBe(true);
  expect((await exportPlane(page)).effectivePlane).toEqual(planeBefore.effectivePlane);
  await page.getByRole("button", { name: nextTheme === "light" ? "切换暗色模式" : "切换浅色模式", exact: true }).click();
  await expect.poll(background).toBe(backgroundBefore);
  // Returning to the original palette must retain the user's rotated camera.
  await expect.poll(async () => Buffer.compare(await stage.screenshot(), imageBefore)).toBe(0);
  await page.locator(".anatomy-sources > summary").click();
  const sources = page.locator(".anatomy-sources");
  await expect(sources).toContainText("The Database Center for Life Science");
  await expect(sources).toContainText("Kristen Browne、Heidi Schlehlein");
  await expect(sources).toContainText("CC BY 4.0");
  for (const url of [
    "https://dbarchive.biosciencedbc.jp/en/bodyparts3d/",
    "https://humanatlas.io/3d-reference-library",
    "https://www.cardiacatlas.org/amrg-cardiac-atlas/",
    "https://kalanimd.com/cardio-atlas/index.html",
  ]) {
    const link = sources.locator(`a[href="${url}"]`);
    await expect(link).toBeVisible();
    await expect(link).toHaveText(new RegExp(new URL(url).hostname.replace(/^www\./, "").replaceAll(".", "\\.")));
  }
  await noHorizontalOverflow(page);
});

test("desktop panels resize, exchange positions and reset without remounting the views", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await openAnatomy(page);
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "ready");
  const panels = {
    course: page.locator(".anatomy-course"), inspector: page.locator(".anatomy-inspector"),
    scene: page.getByTestId("anatomy-scene"), section: page.locator(".anatomy-section-panel"),
    locator: page.locator(".anatomy-locator-panel"), reference: page.locator(".anatomy-reference-panel"),
  };
  const initial = Object.fromEntries(await Promise.all(Object.entries(panels).map(async ([id, panel]) => [id, await box(panel)])));
  const sectionCanvas = page.getByTestId("anatomy-section").locator("canvas");
  const originalSection = await sectionCanvas.elementHandle();
  const webgl = page.getByTestId("anatomy-webgl");
  const originalWebgl = await webgl.elementHandle();
  await dragSeparator(page, "调整目录宽度", 45, 0);
  await expect.poll(async () => (await box(panels.course)).width - initial.course.width).toBeGreaterThan(20);
  await dragSeparator(page, "调整 CMR 面板宽度", -55, 0);
  await expect.poll(async () => (await box(panels.inspector)).width - initial.inspector.width).toBeGreaterThan(20);
  await dragSeparator(page, "调整三维面板高度", 0, 60);
  await expect.poll(async () => (await box(panels.scene)).height - initial.scene.height).toBeGreaterThan(20);
  const sectionWidth = (await box(panels.section)).width;
  await dragSeparator(page, "调整断面与定位图比例", 45, 0);
  await expect.poll(async () => (await box(panels.section)).width - sectionWidth).toBeGreaterThan(20);
  await dragSeparator(page, "调整 CMR 面板高度", 0, 60);
  await expect.poll(async () => (await box(panels.reference)).height - initial.reference.height).toBeGreaterThan(20);
  for (const canvas of [sectionCanvas, webgl]) {
    await expect.poll(() => canvas.evaluate((element) => {
      const canvas = element as HTMLCanvasElement, rect = canvas.getBoundingClientRect();
      return Math.max(Math.abs(canvas.width - Math.round(rect.width * devicePixelRatio)), Math.abs(canvas.height - Math.round(rect.height * devicePixelRatio)));
    })).toBeLessThanOrEqual(1);
  }
  expect(await webgl.evaluate((element, previous) => element === previous, originalWebgl)).toBe(true);
  await page.getByTestId("panel-drag-section").dragTo(page.getByTestId("panel-drag-locator"));
  await expect.poll(async () => (await box(panels.section)).x - (await box(panels.locator)).x).toBeGreaterThan(20);
  expect(await sectionCanvas.evaluate((element, previous) => element === previous, originalSection)).toBe(true);
  await page.getByRole("button", { name: "重置工作台布局", exact: true }).click();
  for (const [id, panel] of Object.entries(panels)) {
    await expect.poll(async () => Math.abs((await box(panel)).width - initial[id].width)).toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs((await box(panel)).height - initial[id].height)).toBeLessThanOrEqual(1);
  }
  expect((await box(panels.section)).x).toBeLessThan((await box(panels.locator)).x);
  await noHorizontalOverflow(page);
});

test("local CMR comparison has its own cursor and preserves the original viewer", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const imported = page.waitForResponse((response) => response.url().endsWith("/api/studies") && response.request().method() === "POST");
  await page.getByLabel("选择 DICOM 文件或 ZIP").setInputFiles(createSyntheticStudyUploads());
  const catalog = await (await imported).json();
  try {
    await page.getByTestId("mode-inspect").click();
    await page.getByTestId("time-slider").fill("2");
    await page.getByLabel("窗宽", { exact: true }).fill("360");
    await page.getByTestId("frame-note").fill("Independent teaching comparison");
    const primaryPlane = await page.getByTestId("layer-slider").inputValue();
    await openAnatomy(page);
    await page.getByRole("group", { name: "参考影像来源" }).getByRole("button", { name: "本机病例", exact: true }).click();
    const local = page.getByTestId("local-comparison");
    await expect(local).toBeVisible();
    const fourChamber = catalog.collections.find((entry: { view: string }) => entry.view === "4CH");
    await expect(local.getByLabel("本机对照序列", { exact: true })).toHaveValue(fourChamber.id);
    await expect(local.getByTestId("image-viewport")).toHaveAttribute("aria-label", /行 × .* 列/);
    await local.getByLabel("本机时间帧", { exact: true }).fill("1");
    await local.locator(".local-comparison-window > summary").click();
    await local.getByLabel("本机窗宽", { exact: true }).fill("520");
    await local.getByLabel("本机窗宽", { exact: true }).press("Tab");
    await expect(local.getByLabel("本机窗宽", { exact: true })).toHaveValue("520");
    await expect(local).toContainText("未进行同人空间配准或心动相位同步");

    const localNode = await local.elementHandle();
    const localCanvas = await local.getByTestId("image-viewport").elementHandle();
    await page.getByTestId("language-switch").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(local.getByLabel("Local comparison series", { exact: true })).toHaveValue(fourChamber.id);
    await expect(local.getByLabel("Local time frame", { exact: true })).toHaveValue("1");
    await expect(local.getByLabel("Local window width", { exact: true })).toHaveValue("520");
    expect(await local.evaluate((element, previous) => element === previous, localNode)).toBe(true);
    expect(await local.getByTestId("image-viewport").evaluate((element, previous) => element === previous, localCanvas)).toBe(true);
    await page.getByTestId("language-switch").click();
    await expect(local.getByLabel("本机时间帧", { exact: true })).toHaveValue("1");
    await page.getByRole("button", { name: "放大 CMR 对照", exact: true }).click();
    const cmrDialog = page.getByRole("dialog", { name: "放大 CMR 对照", exact: true });
    await expect(cmrDialog.getByTestId("local-comparison")).toBeVisible();
    await expect(page.getByTestId("local-comparison")).toHaveCount(1);
    expect(await local.evaluate((element, previous) => element === previous, localNode)).toBe(true);
    await expect(local.getByLabel("本机对照序列", { exact: true })).toHaveValue(fourChamber.id);
    await expect(local.getByLabel("本机时间帧", { exact: true })).toHaveValue("1");
    await expect(local.getByLabel("本机窗宽", { exact: true })).toHaveValue("520");
    await local.getByRole("button", { name: "播放本机 Cine", exact: true }).click();
    await expect.poll(() => local.getByLabel("本机时间帧", { exact: true }).inputValue()).not.toBe("1");
    await page.getByRole("button", { name: "关闭 CMR 放大", exact: true }).click();
    await expect(cmrDialog).toHaveCount(0);
    await expect(local.getByRole("button", { name: "暂停本机 Cine", exact: true })).toBeVisible();
    expect(await local.evaluate((element, previous) => element === previous, localNode)).toBe(true);
    await local.getByRole("button", { name: "暂停本机 Cine", exact: true }).click();
    await expect(local.getByLabel("本机窗宽", { exact: true })).toHaveValue("520");

    await page.getByTestId("anatomy-view-rvot").click();
    await expect(local).toContainText("未找到标为 RVOT");
    await expect(local.getByLabel("本机对照序列", { exact: true })).toHaveValue("");
    const sax = catalog.collections.find((entry: { view: string }) => entry.view === "SAX");
    await local.getByLabel("本机对照序列", { exact: true }).selectOption(sax.id);
    await local.getByLabel("本机空间层位", { exact: true }).fill("1");
    await expect(local.getByLabel("本机空间层位", { exact: true })).toHaveValue("1");
    await local.getByRole("button", { name: "播放本机 Cine", exact: true }).click();
    await expect.poll(() => local.getByLabel("本机时间帧", { exact: true }).inputValue()).not.toBe("0");
    await page.getByTestId("mode-anatomy").click();
    await expect(page.getByTestId("mode-inspect")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("time-slider")).toHaveValue("2");
    await expect(page.getByTestId("layer-slider")).toHaveValue(primaryPlane);
    await expect(page.getByLabel("窗宽", { exact: true })).toHaveValue("360");
    await expect(page.getByTestId("frame-note")).toHaveValue("Independent teaching comparison");
    await expect(page.getByTestId("play-button")).toHaveAttribute("aria-label", "播放");
  } finally {
    await request.delete(`/api/studies/${encodeURIComponent(catalog.id)}`);
  }
});

test("failed model loads can retry and unavailable WebGL retains useful 2D views", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof original>) {
      if (String(args[0]).startsWith("webgl") || String(args[0]) === "experimental-webgl") return null;
      return original.apply(this, args);
    } as typeof original;
  });
  let fail = true;
  await page.route("**/anatomy/bodyparts3d.json", (route) => fail ? route.fulfill({ status: 503, body: "Unavailable" }) : route.continue());
  await page.goto("/");
  await openAnatomy(page);
  await expect(page.getByRole("heading", { name: "图谱加载未完成", exact: true })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.getByTestId("anatomy-stage")).toHaveAttribute("data-state", "unavailable");
  await expect(page.getByText("三维显示暂不可用", { exact: true })).toBeVisible();
  await expect(page.getByTestId("anatomy-section")).toBeVisible();
  await expect(page.getByTestId("anatomy-locator")).toBeVisible();
  await expect.poll(() => page.getByTestId("anatomy-section").locator("canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(50);
});
