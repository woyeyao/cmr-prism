import { describe, expect, it } from "vitest";
import { FIT_IMAGE, imageRectangle, normalizeImageTransform, zoomImageAt } from "./imageTransform";

describe("2D image navigation", () => {
  it("keeps the same image point under an off-centre zoom pointer", () => {
    const original = { zoom: 1.5, panX: 0.12, panY: -0.08 };
    const before = imageRectangle(80, 120, 2, 1, 800, 600, original);
    const afterView = zoomImageAt(original, 1.8, 570, 230, 800, 600);
    const after = imageRectangle(80, 120, 2, 1, 800, 600, afterView);
    expect((570 - before.left) / before.width).toBeCloseTo((570 - after.left) / after.width, 10);
    expect((230 - before.top) / before.height).toBeCloseTo((230 - after.top) / after.height, 10);
    expect(original).toEqual({ zoom: 1.5, panX: 0.12, panY: -0.08 });
  });
  it("preserves physical aspect and applies the same rectangle to image and overlay", () => {
    expect(imageRectangle(100, 200, 2, 1, 800, 600, FIT_IMAGE)).toEqual({ left: 100, top: 0, width: 600, height: 600 });
    expect(imageRectangle(100, 200, 2, 1, 800, 600, { zoom: 2, panX: 0.25, panY: -0.1 })).toEqual({ left: 0, top: -360, width: 1200, height: 1200 });
  });
  it("limits zoom and displacement, handles missing size and rejects nonfinite values", () => {
    expect(normalizeImageTransform({ zoom: Infinity, panX: NaN, panY: -8 })).toEqual({ zoom: 1, panX: 0, panY: -4 });
    expect(zoomImageAt(FIT_IMAGE, 100, 400, 300, 800, 600).zoom).toBe(8);
    expect(zoomImageAt(FIT_IMAGE, 0.0001, 400, 300, 800, 600).zoom).toBe(0.25);
    expect(zoomImageAt(FIT_IMAGE, 2, 0, 0, 0, 0)).toBe(FIT_IMAGE);
  });
});
