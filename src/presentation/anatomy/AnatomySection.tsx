"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AnatomyModel, AnatomySection as Section, Vec2, Vec3 } from "@/core/anatomy/types";
import { planeIntersection } from "@/core/anatomy/geometry";
import { useI18n } from "@/i18n";
import { DEFAULT_ANATOMY_OPTIONS, directionLabel, drawSections, enabledSection, getPlaneFrame, getSections, labelPriority, sectionDrawings, sectionExtent, sectionViewport, shortLabel, type AnatomyRenderOptions, type RenderPlane } from "./rendering";
import "./anatomy-rendering.css";

export interface AnatomySectionProps {
  model: AnatomyModel;
  plane: RenderPlane;
  options?: AnatomyRenderOptions;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  referencePlane?: RenderPlane | null;
  theme?: "light" | "dark";
  className?: string;
}

function inside(point: Vec2, path: Vec2[]): boolean {
  let yes = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[i], b = path[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
  }
  return yes;
}

function nearPath(point: Vec2, paths: Vec2[][], tolerance: number): boolean {
  for (const path of paths) for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
    if (Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy) < tolerance) return true;
  }
  return false;
}

export default function AnatomySection({ model, plane, options = DEFAULT_ANATOMY_OPTIONS, selectedId, onSelect, referencePlane, className }: AnatomySectionProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fitRef = useRef({ factor: 1, width: 1, height: 1, dpr: 1, centerX: 0, centerY: 0 });
  const [hovered, setHovered] = useState<Section | null>(null);
  const sections = useMemo(() => getSections(model, plane), [model, plane]);
  const drawings = useMemo(() => sectionDrawings(sections), [sections]);
  const hasTissue = sections.some(section => section.loops.length || section.paths.length);
  const hasOpenWalls = sections.some(section => section.group === "wall" && section.paths.length > 0 && enabledSection(section, options));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const render = () => {
      raf = 0;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#0d1b24"; ctx.fillRect(0, 0, w, h);
      const frame = getPlaneFrame(plane), extent = sectionExtent(sections, model);
      const fit = sectionViewport(sections, model, plane);
      const factor = Math.max(0.001, Math.min((w - (options.showLabels ? 112 : 36) * dpr) / fit.width, (h - 48 * dpr) / fit.height));
      const centerX = w / 2 - fit.center[0] * factor, centerY = h / 2 + fit.center[1] * factor;
      fitRef.current = { factor, width: w, height: h, dpr, centerX, centerY };
      ctx.save(); ctx.beginPath(); ctx.rect(5 * dpr, 25 * dpr, w - 10 * dpr, h - 51 * dpr); ctx.clip();
      ctx.setTransform(factor, 0, 0, -factor, centerX, centerY);
      drawSections(ctx, drawings, options, factor / dpr, options.fill2D, hovered?.id ?? selectedId);
      if (referencePlane) {
        const line = planeIntersection(frame, getPlaneFrame(referencePlane), extent);
        if (line) {
          ctx.strokeStyle = "#e9d69d"; ctx.lineWidth = 1.4 * dpr / factor;
          ctx.setLineDash([5 * dpr / factor, 4 * dpr / factor]);
          ctx.beginPath(); ctx.moveTo(...line[0]); ctx.lineTo(...line[1]); ctx.stroke(); ctx.setLineDash([]);
        }
      }
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (options.showLabels) {
        const tagCandidates = sections.filter(section => enabledSection(section, options)
          && (section.loops.length > 0 || section.paths.length > 0)
          && (section.group !== "wall" || model.id === "hra"));
        const used = new Set<string>();
        const labels = tagCandidates.sort((a, b) => labelPriority(a, plane) - labelPriority(b, plane)).flatMap(section => {
          const name = shortLabel({ ...section, label: t(section.label) });
          if (used.has(name)) return [];
          used.add(name);
          const paths = section.loops.length ? section.loops : section.paths;
          const points = paths.reduce((a, b) => a.length > b.length ? a : b);
          const mid = points.reduce((acc, p) => [acc[0] + p[0] / points.length, acc[1] + p[1] / points.length] as Vec2, [0, 0]);
          return [{ section, name, x: centerX + mid[0] * factor, y: centerY - mid[1] * factor }];
        }).slice(0, 8);
        ctx.font = `600 ${10 * dpr}px system-ui, sans-serif`; ctx.textBaseline = "middle";
        for (const side of [-1, 1]) {
          const entries = labels.filter(label => (label.x < w / 2 ? -1 : 1) === side).sort((a, b) => a.y - b.y);
          let prev = 28 * dpr;
          entries.forEach((label, index) => {
            const y = Math.max(prev, Math.min(label.y, h - (entries.length - index) * 18 * dpr - 26 * dpr));
            prev = y + 18 * dpr;
            const x = side === -1 ? 12 * dpr : w - 12 * dpr;
            ctx.textAlign = side === -1 ? "left" : "right";
            const edge = x - side * (ctx.measureText(label.name).width + 5 * dpr);
            ctx.strokeStyle = label.section.color; ctx.globalAlpha = 0.6; ctx.lineWidth = 0.8 * dpr;
            ctx.beginPath(); ctx.moveTo(label.x, label.y); ctx.lineTo(edge, y); ctx.stroke(); ctx.globalAlpha = 1;
            ctx.strokeStyle = "#0d1b24"; ctx.lineWidth = 4 * dpr; ctx.strokeText(label.name, x, y);
            ctx.fillStyle = "#c4d5d8"; ctx.fillText(label.name, x, y);
          });
        }
      }
      ctx.font = `600 ${10 * dpr}px system-ui, sans-serif`; ctx.fillStyle = "#9cb9be";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(directionLabel(frame.up, model.space.axes), w / 2, 13 * dpr);
      ctx.fillText(directionLabel(frame.up.map(v => -v) as Vec3, model.space.axes), w / 2, h - 13 * dpr);
      ctx.textAlign = "left"; ctx.fillText(`${directionLabel(frame.right.map(v => -v) as Vec3, model.space.axes)}${model.space.axes === "LPS" ? " ←" : ""}`, 10 * dpr, 13 * dpr);
      ctx.textAlign = "right"; ctx.fillText(`${model.space.axes === "LPS" ? "→ " : ""}${directionLabel(frame.right, model.space.axes)}`, w - 10 * dpr, 13 * dpr);
      const mm = extent > 100 ? 40 : 20;
      const bar = mm * factor, x = w - 14 * dpr - bar, y = h - 17 * dpr;
      ctx.strokeStyle = "#6d919a"; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(x, y - 3 * dpr); ctx.lineTo(x, y); ctx.lineTo(x + bar, y); ctx.lineTo(x + bar, y - 3 * dpr); ctx.stroke();
      ctx.font = `${9 * dpr}px system-ui, sans-serif`; ctx.textAlign = "center";
      ctx.fillText(`${mm} mm`, x + bar / 2, y - 10 * dpr);
    };
    const request = () => { if (!raf) raf = requestAnimationFrame(render); };
    const observer = new ResizeObserver(request); observer.observe(canvas); request();
    return () => { observer.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [drawings, model, options, plane, referencePlane, sections, selectedId, hovered, t]);

  function findAt(clientX: number, clientY: number): Section | null {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const { dpr, factor, centerX, centerY } = fitRef.current;
    const point: Vec2 = [((clientX - rect.left) * dpr - centerX) / factor, -((clientY - rect.top) * dpr - centerY) / factor];
    for (const { section } of [...drawings].reverse()) {
      if (!enabledSection(section, options)) continue;
      let contains = false;
      for (const loop of section.loops) if (inside(point, loop)) contains = !contains;
      if (contains || nearPath(point, [...section.loops, ...section.paths], 4 * dpr / factor)) return section;
    }
    return null;
  }

  return <div className={`anatomy-section ${className ?? ""}`} data-testid="anatomy-section" role="img" aria-label={t("当前切面的二维解剖断面，组织填色保留心腔")}>
    <canvas ref={canvasRef} onPointerMove={event => setHovered(findAt(event.clientX, event.clientY))}
      onPointerLeave={() => setHovered(null)} onClick={event => onSelect?.(findAt(event.clientX, event.clientY)?.id ?? null)} />
    {hovered && <div className="anatomy-section__hover">{t(hovered.label)}</div>}
    {!hasTissue && <div className="anatomy-section__label">{t("当前平面未与可见结构相交")}</div>}
    {model.space.axes === "specimen" && !hovered && <div className="anatomy-section__label">{t("标本坐标")} · {t(hasOpenWalls ? "开放边界仅显示轮廓" : "未映射患者方位")}</div>}
  </div>;
}
