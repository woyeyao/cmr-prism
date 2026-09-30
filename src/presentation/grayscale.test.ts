import { describe, expect, it } from "vitest";
import { estimateWindow, grayscaleRgba } from "./grayscale";

function grayChannels(rgba: Uint8ClampedArray): number[] {
  return Array.from({ length: rgba.length / 4 }, (_, index) => rgba[index * 4]);
}

describe("grayscaleRgba", () => {
  it("uses the DICOM LINEAR width-1 edge semantics", () => {
    const pixels = new Float32Array([-2, -1.5, -0.5, 0.5, 2]);
    const result = grayscaleRgba(pixels, { center: 0, width: 3 }, "MONOCHROME2");

    expect(grayChannels(result)).toEqual([0, 0, 128, 255, 255]);
  });

  it("treats a width of one as a threshold without dividing by zero", () => {
    const result = grayscaleRgba(
      new Float32Array([9, 9.5, 10]),
      { center: 10, width: 1 },
      "MONOCHROME2",
    );

    expect(grayChannels(result)).toEqual([0, 0, 255]);
  });

  it("inverts finite values for MONOCHROME1 and keeps invalid samples safe", () => {
    const result = grayscaleRgba(
      new Float32Array([-2, 0.5, Number.NaN, Number.POSITIVE_INFINITY]),
      { center: 0, width: 3 },
      "MONOCHROME1",
    );

    expect(grayChannels(result)).toEqual([255, 0, 0, 0]);
    expect(Array.from(result).filter((_, index) => index % 4 === 3)).toEqual([255, 255, 255, 255]);
  });

  it("keeps source samples unchanged because modality rescale is already applied", () => {
    const pixels = new Float32Array([-20, 0, 20]);
    const before = pixels.slice();
    grayscaleRgba(pixels, { center: 0, width: 41 }, "MONOCHROME2");

    expect(pixels).toEqual(before);
  });

  it("uses finite window fallbacks and clamps width to at least one", () => {
    const result = grayscaleRgba(
      new Float32Array([-1, 1]),
      { center: Number.NaN, width: 0 },
      "MONOCHROME2",
    );

    expect(grayChannels(result)).toEqual([0, 255]);
  });
});

describe("estimateWindow", () => {
  it("ignores non-finite samples and limits the influence of isolated outliers", () => {
    const samples = new Float32Array([-1_000_000, 0, 10, 20, 30, 40, 50, 1_000_000, Number.NaN]);
    const window = estimateWindow(samples);

    expect(Number.isFinite(window.center)).toBe(true);
    expect(Number.isFinite(window.width)).toBe(true);
    expect(window.width).toBeGreaterThanOrEqual(1);
    expect(window.width).toBeLessThan(150);
  });

  it("returns a stable fallback when no finite samples exist", () => {
    expect(estimateWindow(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]))).toEqual({
      center: 0,
      width: 1,
    });
  });

  it("returns a usable window for a constant-valued frame", () => {
    const window = estimateWindow(new Float32Array([7, 7, 7, 7]));
    expect(window.center).toBe(7.5);
    expect(window.width).toBe(2);
  });
});
