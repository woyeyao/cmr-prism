import type { ImageTransform } from "./types";

export const FIT_IMAGE: ImageTransform = { zoom: 1, panX: 0, panY: 0 };

export function normalizeImageTransform(value: ImageTransform): ImageTransform {
  const clamp = (v: number, min: number, max: number, fallback: number) =>
    Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  return { zoom: clamp(value.zoom, 0.25, 8, 1), panX: clamp(value.panX, -4, 4, 0), panY: clamp(value.panY, -4, 4, 0) };
}

/** Keep the point under the pointer fixed; pan is stored in viewport fractions. */
export function zoomImageAt(view: ImageTransform, factor: number, x: number, y: number, width: number, height: number): ImageTransform {
  if (width <= 0 || height <= 0 || !Number.isFinite(factor) || factor <= 0) return view;
  const zoom = normalizeImageTransform({ ...view, zoom: view.zoom * factor }).zoom;
  const ratio = zoom / view.zoom;
  return normalizeImageTransform({
    zoom,
    panX: (x / width - 0.5) * (1 - ratio) + view.panX * ratio,
    panY: (y / height - 0.5) * (1 - ratio) + view.panY * ratio,
  });
}

export function imageRectangle(rows: number, columns: number, rowMm: number, columnMm: number, width: number, height: number, view: ImageTransform) {
  if (rows <= 0 || columns <= 0 || width <= 0 || height <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  const fit = Math.min(width / (columns * columnMm), height / (rows * rowMm));
  const imageWidth = columns * columnMm * fit * view.zoom;
  const imageHeight = rows * rowMm * fit * view.zoom;
  return { left: (width - imageWidth) / 2 + view.panX * width, top: (height - imageHeight) / 2 + view.panY * height, width: imageWidth, height: imageHeight };
}
