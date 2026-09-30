import type { WindowLevel } from "../core/types";

/**
 * Apply the DICOM LINEAR VOI function to samples that have already had their
 * modality rescale applied. Invalid samples are rendered black.
 */
export function grayscaleRgba(
  pixels: Float32Array,
  window: WindowLevel,
  photometric: "MONOCHROME1" | "MONOCHROME2",
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  const center = Number.isFinite(window.center) ? window.center : 0;
  const width = Number.isFinite(window.width) ? Math.max(1, window.width) : 1;
  const threshold = center - 0.5;
  const span = width - 1;
  const low = threshold - span / 2;
  const high = threshold + span / 2;

  for (let index = 0; index < pixels.length; index += 1) {
    const sample = pixels[index];
    let gray = 0;

    if (Number.isFinite(sample)) {
      if (width === 1) {
        // DICOM defines width 1 as a threshold, avoiding a divide by zero.
        gray = sample <= threshold ? 0 : 255;
      } else if (sample <= low) {
        gray = 0;
      } else if (sample > high) {
        gray = 255;
      } else {
        gray = ((sample - threshold) / span + 0.5) * 255;
      }

      if (photometric === "MONOCHROME1") gray = 255 - gray;
    }

    const offset = index * 4;
    rgba[offset] = gray;
    rgba[offset + 1] = gray;
    rgba[offset + 2] = gray;
    rgba[offset + 3] = 255;
  }

  return rgba;
}

/**
 * Estimate a stable linear window from the central 98% of finite samples.
 * A deterministic bounded reservoir keeps memory use predictable for large
 * images while still resisting isolated bright or dark outliers.
 */
export function estimateWindow(pixels: Float32Array): WindowLevel {
  const maxSamples = 65_536;
  const samples: number[] = [];
  let finiteCount = 0;
  let randomState = 0x9e3779b9;

  for (let index = 0; index < pixels.length; index += 1) {
    const value = pixels[index];
    if (!Number.isFinite(value)) continue;

    finiteCount += 1;
    if (samples.length < maxSamples) {
      samples.push(value);
      continue;
    }

    // Deterministic xorshift reservoir sampling gives repeatable windows.
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    const slot = (randomState >>> 0) % finiteCount;
    if (slot < maxSamples) samples[slot] = value;
  }

  if (samples.length === 0) return { center: 0, width: 1 };

  samples.sort((left, right) => left - right);
  const quantile = (fraction: number): number => {
    const position = fraction * (samples.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const amount = position - lowerIndex;
    return samples[lowerIndex] * (1 - amount) + samples[upperIndex] * amount;
  };

  const firstQuartile = quantile(0.25);
  const thirdQuartile = quantile(0.75);
  const interquartileRange = thirdQuartile - firstQuartile;
  const robustLow = firstQuartile - 1.5 * interquartileRange;
  const robustHigh = thirdQuartile + 1.5 * interquartileRange;
  const trimmed = samples.map((sample) => Math.max(robustLow, Math.min(robustHigh, sample)));
  trimmed.sort((left, right) => left - right);

  const lowPosition = 0.01 * (trimmed.length - 1);
  const highPosition = 0.99 * (trimmed.length - 1);
  const lowIndex = Math.floor(lowPosition);
  const highIndex = Math.floor(highPosition);
  const low = trimmed[lowIndex] * (1 - (lowPosition - lowIndex)) + trimmed[Math.ceil(lowPosition)] * (lowPosition - lowIndex);
  const high = trimmed[highIndex] * (1 - (highPosition - highIndex)) + trimmed[Math.ceil(highPosition)] * (highPosition - highIndex);
  const range = Math.max(0, high - low);
  // Account for the LINEAR function's center-0.5 and width-1 semantics so
  // these robust endpoints map to the black and white limits.
  const width = range === 0 ? 2 : Math.max(1, range + 1);
  return { center: (low + high) / 2 + 0.5, width };
}
