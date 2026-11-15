import { expect, test } from "@playwright/test";
import { createSyntheticStudyUploads } from "./syntheticDicom";

const ignoredGraphicsErrors = /WebGL|WebGPU|GPU process|graphics context|ANGLE|SwiftShader/i;

test("wave cover animates separate boxes and theme survives reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".wave-box")).toHaveCount(10);
  const positions = () => page.locator(".wave-box").evaluateAll((boxes) => boxes.map((box) => getComputedStyle(box).transform));
  const before = await positions();
  expect(new Set(before).size).toBeGreaterThan(5);
  await expect.poll(async () => JSON.stringify(await positions())).not.toBe(JSON.stringify(before));
  await page.getByRole("button", { name: "切换暗色模式", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.locator(".welcome").evaluate((e) => e.getAnimations({ subtree: true }).length)).toBe(0);
  await page.getByRole("button", { name: "切换浅色模式", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("imports synthetic CMR and completes atlas, inspection, linked split, and cube review", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  const uncaughtErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !ignoredGraphicsErrors.test(message.text())) consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => uncaughtErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /心动/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "演示模式", exact: true })).toHaveCount(0);
  const uploads = createSyntheticStudyUploads();
  const importedResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/studies") && response.request().method() === "POST",
  );
  await page.getByLabel("选择 DICOM 文件或 ZIP").setInputFiles(uploads);
  const importedResponse = await importedResponsePromise;
  expect(importedResponse.status()).toBe(201);
  const catalog = await importedResponse.json();
  const studyId = catalog.id as string;
  expect(catalog.report).toMatchObject({ acceptedInstances: 15, acceptedFrames: 15, skippedObjects: 1, failedFiles: 1 });

  const sax = catalog.collections.find((collection: any) => collection.view === "SAX" && collection.kind === "cine");
  const longAxis = catalog.collections.filter((collection: any) => ["2CH", "3CH", "4CH"].includes(collection.view));
  expect(sax.planes).toHaveLength(2);
  expect(sax.planes.every((plane: any) => plane.frameIds.length === 3)).toBe(true);
  expect(sax.planes[0].geometry.columnCosines).not.toEqual([0, 1, 0]);
  expect(longAxis.map((collection: any) => collection.view).sort()).toEqual(["2CH", "3CH", "4CH"]);
  expect(new Set(catalog.collections.map((collection: any) => collection.planes[0]?.geometry?.frameOfReferenceUid))).toEqual(
    new Set([catalog.collections[0].planes[0].geometry.frameOfReferenceUid]),
  );

  await expect(page.getByRole("heading", { name: /影像目录/ })).toBeVisible();
  await expect(page.getByTestId("mode-atlas")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".series-card")).toHaveCount(4);
  await expect(page.locator(".atlas-layer-strip button")).toHaveCount(2);
  await page.getByLabel("阵列层间距").fill("0.9");
  await expect(page.getByLabel("阵列层间距")).toHaveValue("0.9");
  await expect(page.getByLabel("播放帧率")).toHaveValue("25");
  await page.getByLabel("播放帧率").fill("35");
  await page.getByLabel("播放帧率").press("Tab");
  await expect(page.getByLabel("播放帧率")).toHaveValue("35");
  await page.getByLabel("播放帧率").fill("25");
  await expect(page.locator(".stage-atlas [data-testid='glass-stage'], .stage-atlas .fallback-grid").first()).toBeVisible();
  const originalCenterWidth = await page.locator(".viewing-area").evaluate((element) => element.getBoundingClientRect().width);
  await page.getByRole("button", { name: "隐藏影像目录", exact: true }).click();
  await page.getByRole("button", { name: "隐藏参数面板", exact: true }).click();
  await expect(page.getByRole("button", { name: "展开影像目录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "展开参数面板", exact: true })).toBeVisible();
  await expect.poll(() => page.locator(".viewing-area").evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(originalCenterWidth + 250);
  await page.getByRole("button", { name: "展开影像目录", exact: true }).click();
  await page.getByRole("button", { name: "展开参数面板", exact: true }).click();

  const toastClose = page.getByLabel("关闭消息");
  if (await toastClose.count()) await toastClose.click();
  await page.getByText(/导入报告 · .* 帧/).click();
  const report = page.getByRole("dialog", { name: "导入报告" });
  await expect(report).toBeVisible();
  const reportRows = await report.locator(".report-stats > div").allTextContents();
  expect(reportRows).toEqual(["影像实例15", "可浏览帧15", "跳过非影像1", "无法读取1"]);
  await report.getByRole("button", { name: "继续浏览" }).click();
  await page.getByTestId("language-switch").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "Import report · 15 frames ↗", exact: true })).toBeVisible();
  await expect(page.locator(".series-dimensions").first()).toContainText("2 slices");
  await page.getByTestId("language-switch").click();
  await expect(page.getByRole("button", { name: "导入报告 · 15 帧 ↗", exact: true })).toBeVisible();

  // A double click on a physical layer opens the large 2D frame view.
  await page.locator(".atlas-layer-strip button").first().dblclick();
  await expect(page.getByTestId("mode-inspect")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("image-viewport")).toBeVisible();
  await expect(page.getByTestId("image-viewport")).toHaveAttribute("aria-label", /行 × .* 列/);
  await expect(page.getByLabel("窗宽")).toBeVisible();
  await expect(page.getByLabel("窗位")).toBeVisible();

  const initialTime = await page.getByTestId("time-slider").inputValue();
  const initialLayer = await page.getByTestId("layer-slider").inputValue();
  const note = page.getByTestId("frame-note");
  await note.fill("EF");
  await note.focus();
  await note.press("End");
  await note.press("Space");
  await note.press("ArrowLeft");
  await note.press("x");
  await expect(note).toHaveValue("EFx ");
  expect(await page.getByTestId("time-slider").inputValue()).toBe(initialTime);
  expect(await page.getByTestId("layer-slider").inputValue()).toBe(initialLayer);

  await page.getByLabel("窗宽").fill("360");
  await page.getByLabel("窗位").fill("210");
  await expect(page.getByLabel("窗宽")).toHaveValue("360");
  await expect(page.getByLabel("窗位")).toHaveValue("210");

  const image = page.getByTestId("image-viewport");
  const transformSurface = page.locator(".image-viewport");
  const imageBox = (await image.boundingBox())!;
  await page.mouse.move(imageBox.x + imageBox.width * 0.6, imageBox.y + imageBox.height * 0.4);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -220);
  await page.keyboard.up("Control");
  await expect.poll(async () => Number(await transformSurface.getAttribute("data-zoom"))).toBeGreaterThan(1.4);
  expect(await page.getByTestId("time-slider").inputValue()).toBe(initialTime);
  expect(await page.getByTestId("layer-slider").inputValue()).toBe(initialLayer);
  const zoom = await transformSurface.getAttribute("data-zoom");
  const oldPan = Number(await transformSurface.getAttribute("data-pan-x"));
  await page.mouse.down();
  await page.mouse.move(imageBox.x + imageBox.width * 0.6 + 90, imageBox.y + imageBox.height * 0.4 + 45, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await transformSurface.getAttribute("data-pan-x"))).toBeGreaterThan(oldPan + 0.05);
  await expect(page.getByLabel("窗宽")).toHaveValue("360");
  const grayscale = await image.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await page.getByRole("button", { name: "切换暗色模式", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await image.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).toBe(grayscale);
  await page.getByRole("button", { name: "切换浅色模式", exact: true }).click();

  await page.getByTestId("mode-split").click();
  await expect(note).toHaveValue("EFx ");
  await page.getByTestId("mode-inspect").click();
  await expect(note).toHaveValue("EFx ");
  await expect(transformSurface).toHaveAttribute("data-zoom", zoom!);
  await page.getByRole("button", { name: "重置视口 1 缩放和平移", exact: true }).click();
  await expect(transformSurface).toHaveAttribute("data-zoom", "1.000");
  await expect(transformSurface).toHaveAttribute("data-pan-x", "0.000");

  await page.getByTestId("image-viewport").click();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("time-slider")).toHaveValue("1");
  await page.getByTestId("image-viewport").dispatchEvent("wheel", { deltaY: 80 });
  await expect(page.getByTestId("time-slider")).toHaveValue("2");
  await page.getByTestId("image-viewport").dispatchEvent("wheel", { deltaY: 80, shiftKey: true });
  await expect(page.getByTestId("layer-slider")).toHaveValue("1");

  await page.getByTestId("mode-split").click();
  expect(
    (await page.locator(".split-grid .pane-readout").allTextContents()).map((text) => text.split("/")[0].trim()),
  ).toEqual(["SAX", "2CH", "3CH", "4CH"]);
  for (const count of [2, 3, 4] as const) {
    await page.getByTestId(`layout-${count}`).click();
    await expect(page.locator(".split-grid .viewer-pane")).toHaveCount(count);
  }

  const pane0 = page.getByTestId("pane-0");
  const pane1 = page.getByTestId("pane-1");
  const pane0Readout = pane0.locator(".pane-readout");
  const pane1Readout = pane1.locator(".pane-readout");
  await expect.poll(() => page.locator(".split-grid .image-overlay line").count()).toBeGreaterThan(0);

  // SAX has three phases and 2CH has four. A linked step is phase-matched;
  // after unlinking, later SAX changes leave the 2CH pane at its own frame.
  await pane0.getByTestId("image-viewport").click();
  await page.getByTestId("time-slider").focus();
  await page.keyboard.press("Home");
  await pane0.getByTestId("image-viewport").click();
  await page.keyboard.press("ArrowRight");
  await expect(pane0Readout).toContainText("F2");
  await expect(pane1Readout).toContainText("F2");
  await pane1.getByRole("button", { name: "联动" }).click();
  await expect(pane1.getByRole("button", { name: "独立" })).toHaveAttribute("aria-pressed", "false");
  await pane0.getByTestId("image-viewport").click();
  await page.keyboard.press("ArrowRight");
  await expect(pane0Readout).toContainText("F3");
  await expect(pane1Readout).toContainText("F2");

  // Expand the independent long-axis pane, preserving its own cursor and window.
  await pane1.getByTestId("image-viewport").click();
  await page.getByLabel("窗宽").fill("420");
  const expandedFrame = await page.getByTestId("time-slider").inputValue();
  const secondSurface = pane1.locator(".image-viewport");
  await pane1.getByTestId("image-viewport").dispatchEvent("wheel", { deltaY: -200, ctrlKey: true });
  await expect.poll(async () => Number(await secondSurface.getAttribute("data-zoom"))).toBeGreaterThan(1);
  const splitZoom = await secondSurface.getAttribute("data-zoom");
  const splitImageBox = (await pane1.getByTestId("image-viewport").boundingBox())!;
  await page.mouse.move(splitImageBox.x + splitImageBox.width / 2, splitImageBox.y + splitImageBox.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(splitImageBox.x + splitImageBox.width / 2 + 35, splitImageBox.y + splitImageBox.height / 2 + 20, { steps: 5 });
  await page.mouse.up({ button: "right" });
  const splitPan = await secondSurface.getAttribute("data-pan-x");
  await page.waitForTimeout(550);
  await pane1.getByTestId("image-viewport").dblclick();
  await expect(page.getByTestId("mode-inspect")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("image-viewport")).toHaveCount(1);
  await expect(page.getByTestId("time-slider")).toHaveValue(expandedFrame);
  await expect(page.getByLabel("窗宽")).toHaveValue("420");
  await expect(page.locator(".image-viewport")).toHaveAttribute("data-zoom", splitZoom!);
  await expect(page.locator(".image-viewport")).toHaveAttribute("data-pan-x", splitPan!);
  await expect(page.locator(".pane-readout")).toContainText("2CH");
  await page.getByRole("button", { name: "返回分屏", exact: true }).click();
  await expect(page.locator(".split-grid .viewer-pane")).toHaveCount(4);
  await expect(pane1Readout).toContainText("F2");
  await expect(secondSurface).toHaveAttribute("data-zoom", splitZoom!);
  await expect(pane1.getByRole("button", { name: "独立" })).toHaveAttribute("aria-pressed", "false");

  // Select two SAX layers and three long-axis planes from this study/FOR.
  await pane0.getByRole("button", { name: "加入视口 1 切片到立方体" }).click();
  await page.getByTestId("layer-slider").press("Home");
  await pane0.getByRole("button", { name: "加入视口 1 切片到立方体" }).click();
  await pane1.getByRole("button", { name: "加入视口 2 切片到立方体" }).click();
  await page.getByTestId("pane-2").getByRole("button", { name: "加入视口 3 切片到立方体" }).click();
  await page.getByTestId("pane-3").getByRole("button", { name: "加入视口 4 切片到立方体" }).click();
  await expect(page.locator(".selection-tray")).toContainText("5/5");
  await page.getByTestId("mode-cube").click();
  await expect(page.getByTestId("mode-cube")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".stage-cube [data-testid='glass-stage'], .stage-cube .fallback-grid").first()).toBeVisible();
  await expect(page.locator(".stage-cube .fallback-tile, .stage-cube [data-testid='glass-stage']").first()).toBeVisible();

  const deletionPromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/studies/${encodeURIComponent(studyId)}`) && response.request().method() === "DELETE",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const deletion = await deletionPromise;
  expect(deletion.status()).toBe(204);
  await expect.poll(async () => (await request.get(`/api/studies/${encodeURIComponent(studyId)}`)).status()).toBe(404);
  expect(uncaughtErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await page.close();
});
