"use client";

import { useEffect, useMemo, useRef } from "react";
import type { AnatomyModel } from "@/core/anatomy/types";
import { planeIntersection } from "@/core/anatomy/geometry";
import { useI18n } from "@/i18n";
import { DEFAULT_ANATOMY_OPTIONS, drawSections, getPlaneFrame, getSections, sectionDrawings, sectionExtent, sectionViewport, type AnatomyRenderOptions, type RenderPlane } from "./rendering";
import "./anatomy-rendering.css";

export interface AnatomyLocatorProps {
  model: AnatomyModel;
  plane: RenderPlane;
  referencePlane?: RenderPlane | null;
  options?: AnatomyRenderOptions;
  theme?: "light" | "dark";
  className?: string;
}

export default function AnatomyLocator({ model, plane, referencePlane, options = DEFAULT_ANATOMY_OPTIONS, className }: AnatomyLocatorProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reference = referencePlane ?? model.presets.find(preset => "referenceViewId" in plane && preset.id === plane.referenceViewId)
    ?? model.presets.find(preset => preset.id === "4ch") ?? model.presets[0];
  const sections = useMemo(() => reference ? getSections(model, reference) : [], [model, reference]);
  const drawings = useMemo(() => sectionDrawings(sections), [sections]);
  const label = t(reference && "label" in reference ? reference.label : "参考面");
  const extent = sectionExtent(sections, model);
  const line = reference ? planeIntersection(getPlaneFrame(reference), getPlaneFrame(plane), extent) : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const render = () => {
      raf = 0;
      const rect = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#0d1b24"; ctx.fillRect(0, 0, w, h);
      const fit = sectionViewport(sections, model, reference ?? plane);
      const factor = Math.max(0.001, Math.min((w - 28 * dpr) / fit.width, (h - 50 * dpr) / fit.height));
      const centerX = w / 2 - fit.center[0] * factor, centerY = h / 2 + 5 * dpr + fit.center[1] * factor;
      ctx.save(); ctx.beginPath(); ctx.rect(5 * dpr, 27 * dpr, w - 10 * dpr, h - 49 * dpr); ctx.clip();
      ctx.setTransform(factor, 0, 0, -factor, centerX, centerY);
      drawSections(ctx, drawings, { ...options, showCavities: false }, factor / dpr, true);
      // A dimmed reference plane lets the actual computed intersection remain legible.
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#0d1b2466"; ctx.fillRect(0, 0, w, h);
      if (line) {
        ctx.setTransform(factor, 0, 0, -factor, centerX, centerY);
        ctx.strokeStyle = "#91d6c3"; ctx.lineWidth = 2 * dpr / factor;
        ctx.beginPath(); ctx.moveTo(...line[0]); ctx.lineTo(...line[1]); ctx.stroke();
        ctx.fillStyle = "#d0f0e6";
        for (const point of line) { ctx.beginPath(); ctx.arc(point[0], point[1], 3 * dpr / factor, 0, Math.PI * 2); ctx.fill(); }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      ctx.restore(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#8eafb5"; ctx.font = `${10 * dpr}px system-ui, sans-serif`; ctx.textAlign = "center";
      ctx.fillText(t(line ? "实线为当前平面与参考面的交线" : "两平面平行、重合或交线超出画面"), w / 2, h - 10 * dpr, Math.max(1, w - 20 * dpr));
    };
    const request = () => { if (!raf) raf = requestAnimationFrame(render); };
    const observer = new ResizeObserver(request); observer.observe(canvas); request();
    return () => { observer.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [drawings, extent, line, model, options, plane, reference, sections, t]);

  return <div className={`anatomy-locator ${className ?? ""}`} data-testid="anatomy-locator" role="img" aria-label={t("{label}上的当前切面定位线", { label })}>
    <canvas ref={canvasRef} />
    <div className="anatomy-locator__label">{label} · {t("图谱参考面")}</div>
  </div>;
}
