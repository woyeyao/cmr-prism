"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { ImageTransform, ReferenceLine, ScalarFrame, WindowLevel } from "../core/types";
import { FIT_IMAGE, imageRectangle, normalizeImageTransform, zoomImageAt } from "../core/imageTransform";
import { grayscaleRgba } from "./grayscale";

export type ImageViewportProps = {
  frame: ScalarFrame | null;
  window: WindowLevel;
  lines?: Array<ReferenceLine & { color?: string }>;
  active?: boolean;
  loading?: boolean;
  error?: string;
  onActivate?: () => void;
  transform?: ImageTransform;
  onTransformChange?: (transform: ImageTransform) => void;
  onNavigate?: (axis: "time" | "space", delta: number) => void;
  className?: string;
  label?: string;
};

type SurfaceSize = { width: number; height: number; pixelRatio: number };
type ImageLayout = { left: number; top: number; width: number; height: number };
type ImageDrag = {
  pointerId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  transform: ImageTransform;
};

const EMPTY_SURFACE: SurfaceSize = { width: 0, height: 0, pixelRatio: 1 };

/** A quiet 2D grayscale viewer whose data stay in the original pixel grid. */
export default function ImageViewport({
  frame,
  window: windowLevel,
  lines = [],
  active = false,
  loading = false,
  error,
  onActivate,
  transform = FIT_IMAGE,
  onTransformChange,
  onNavigate,
  className,
  label = "影像视口",
}: ImageViewportProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<ImageDrag | null>(null);
  const suppressClickUntilRef = useRef(0);
  const onNavigateRef = useRef(onNavigate);
  const interactionRef = useRef({ transform, onTransformChange, onActivate });
  interactionRef.current = { transform, onTransformChange, onActivate };
  const [surface, setSurface] = useState<SurfaceSize>(EMPTY_SURFACE);

  const descriptor = frame?.descriptor;
  const rows = descriptor?.rows ?? 0;
  const columns = descriptor?.columns ?? 0;
  const pixelCountMatches = !!frame && rows > 0 && columns > 0 && frame.pixels.length === rows * columns;
  const rgba = useMemo(() => {
    if (!frame || !descriptor || !pixelCountMatches) return null;
    return grayscaleRgba(frame.pixels, windowLevel, descriptor.photometric);
  }, [descriptor?.photometric, frame, pixelCountMatches, windowLevel.center, windowLevel.width]);

  const rowSpacing = descriptor?.geometry?.pixelSpacing[0];
  const columnSpacing = descriptor?.geometry?.pixelSpacing[1];
  const rowMm = Number.isFinite(rowSpacing) && rowSpacing! > 0 ? rowSpacing! : 1;
  const columnMm = Number.isFinite(columnSpacing) && columnSpacing! > 0 ? columnSpacing! : 1;
  const imageLayout = useMemo<ImageLayout>(() => {
    return imageRectangle(rows, columns, rowMm, columnMm, surface.width, surface.height, transform);
  }, [columnMm, columns, rowMm, rows, surface.height, surface.width, transform]);

  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;

    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const next = {
        width: Math.max(0, bounds.width),
        height: Math.max(0, bounds.height),
        pixelRatio: Math.max(1, window.devicePixelRatio || 1),
      };
      setSurface((current) =>
        current.width === next.width &&
        current.height === next.height &&
        current.pixelRatio === next.pixelRatio
          ? current
          : next,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pixelRatio = surface.pixelRatio;
    const backingWidth = Math.max(1, Math.round(surface.width * pixelRatio));
    const backingHeight = Math.max(1, Math.round(surface.height * pixelRatio));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = "#050608";
    context.fillRect(0, 0, surface.width, surface.height);

    if (!rgba || !descriptor || surface.width <= 0 || surface.height <= 0) return;

    let sourceCanvas = sourceCanvasRef.current;
    if (!sourceCanvas) {
      sourceCanvas = document.createElement("canvas");
      sourceCanvasRef.current = sourceCanvas;
    }
    if (sourceCanvas.width !== columns) sourceCanvas.width = columns;
    if (sourceCanvas.height !== rows) sourceCanvas.height = rows;
    const sourceContext = sourceCanvas.getContext("2d", { alpha: false });
    if (!sourceContext) return;

    const image = new ImageData(columns, rows);
    image.data.set(rgba);
    sourceContext.putImageData(image, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(sourceCanvas, imageLayout.left, imageLayout.top, imageLayout.width, imageLayout.height);
  }, [columns, descriptor, imageLayout, rgba, rows, surface]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const amount = event.deltaY || event.deltaX;
      const interaction = interactionRef.current;
      interaction.onActivate?.();
      if (event.ctrlKey || event.metaKey) {
        const bounds = canvas.getBoundingClientRect();
        const delta = amount * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
        interaction.onTransformChange?.(zoomImageAt(interaction.transform, Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height));
        return;
      }
      if (onNavigateRef.current && amount !== 0) {
        onNavigateRef.current(event.shiftKey ? "space" : "time", Math.sign(amount));
      }
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      event.currentTarget.focus({ preventScroll: true });
      onActivate?.();
      if (!onTransformChange || ![0, 1, 2].includes(event.button)) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      dragRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        width: Math.max(bounds.width, 1),
        height: Math.max(bounds.height, 1),
        transform,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [onActivate, onTransformChange, transform],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - drag.x;
      const deltaY = event.clientY - drag.y;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 3) {
        suppressClickUntilRef.current = Date.now() + 500;
      }
      onTransformChange?.(normalizeImageTransform({ ...drag.transform, panX: drag.transform.panX + deltaX / drag.width, panY: drag.transform.panY + deltaY / drag.height }));
    },
    [onTransformChange],
  );

  const endPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleClick = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    event.currentTarget.focus({ preventScroll: true });
    if (Date.now() <= suppressClickUntilRef.current) return;
    onActivate?.();
  }, [onActivate]);

  const status = error ?? (loading ? "正在加载影像…" : frame && !pixelCountMatches ? "影像尺寸与像素数据不匹配" : !frame ? "等待影像" : null);
  const svgViewBox = descriptor && rows > 0 && columns > 0 ? `-0.5 -0.5 ${columns} ${rows}` : "-0.5 -0.5 1 1";

  return (
    <div
      ref={rootRef}
      className={["image-viewport", className].filter(Boolean).join(" ")}
      data-active={active ? "true" : "false"}
      data-zoom={transform.zoom.toFixed(3)}
      data-pan-x={transform.panX.toFixed(3)}
      data-pan-y={transform.panY.toFixed(3)}
      role="group"
      aria-label={label}
    >
      <canvas
        ref={canvasRef}
        className="image-canvas"
        data-testid="image-viewport"
        aria-label={descriptor ? `${label}，${rows} 行 × ${columns} 列` : label}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClick={handleClick}
        onContextMenu={(event) => event.preventDefault()}
      />
      <svg
        className="image-overlay"
        aria-hidden="true"
        viewBox={svgViewBox}
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          left: imageLayout.left,
          top: imageLayout.top,
          right: "auto",
          bottom: "auto",
          width: imageLayout.width,
          height: imageLayout.height,
          pointerEvents: "none",
        }}
      >
        {lines.map((line, index) => (
          <line
            key={`${line.sourcePlaneId ?? "reference"}-${index}`}
            x1={line.from[0]}
            y1={line.from[1]}
            x2={line.to[0]}
            y2={line.to[1]}
            stroke={line.color ?? "#4bd5d2"}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {status && (
        <div
          className="viewport-status"
          role={error ? "alert" : "status"}
        >
          {status}
        </div>
      )}
    </div>
  );
}
