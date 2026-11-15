"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HTMLAttributes, RefObject } from "react";
import { useI18n } from "@/i18n";

export interface AnatomyLayout {
  railWidth: number;
  inspectorWidth: number;
  stageHeight: number;
  sectionRatio: number;
  /** Extra image viewport height beyond its intrinsic aspect ratio, in pixels. */
  referenceHeight: number;
}

export type AnatomyLayoutKey = keyof AnatomyLayout;

const DEFAULT_LAYOUT: AnatomyLayout = {
  railWidth: 190,
  inspectorWidth: 330,
  stageHeight: 360,
  sectionRatio: 0.5,
  referenceHeight: 0
};

const LABELS: Record<AnatomyLayoutKey, string> = {
  railWidth: "调整目录宽度",
  inspectorWidth: "调整 CMR 面板宽度",
  stageHeight: "调整三维面板高度",
  sectionRatio: "调整断面与定位图比例",
  referenceHeight: "调整 CMR 面板高度"
};

type Dimensions = { width: number; height: number; studyWidth: number };
type SeparatorProps = HTMLAttributes<HTMLElement> & { "data-testid": string };
type Drag = {
  key: AnatomyLayoutKey;
  pointerId: number;
  element: HTMLElement;
  x: number;
  y: number;
  value: number;
  userSelect: string;
  cursor: string;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const horizontal = (key: AnatomyLayoutKey) => key === "railWidth" || key === "inspectorWidth" || key === "sectionRatio";
const fittedStageHeight = (size: Dimensions) => size.height > 0 ? clamp(size.height - 440, 320, 650) : DEFAULT_LAYOUT.stageHeight;

function bounds(key: AnatomyLayoutKey, layout: AnatomyLayout, size: Dimensions): [number, number] {
  const availableWidth = size.width > 0 ? size.width - 360 - 20 : Number.POSITIVE_INFINITY;
  const maxHeight = size.height > 0 ? Math.min(900, Math.max(260, size.height - 56)) : 900;
  switch (key) {
    case "railWidth": return [140, Math.max(140, Math.min(300, availableWidth - layout.inspectorWidth))];
    case "inspectorWidth": return [280, Math.max(280, Math.min(600, availableWidth - layout.railWidth))];
    case "stageHeight": return [260, maxHeight];
    case "referenceHeight": return [-160, 600];
    case "sectionRatio": return [0.25, 0.75];
  }
}

function normalize(layout: AnatomyLayout, size: Dimensions): AnatomyLayout {
  const next = { ...layout };
  for (const key of Object.keys(next) as AnatomyLayoutKey[]) {
    next[key] = clamp(next[key], ...bounds(key, next, size));
  }
  return (Object.keys(next) as AnatomyLayoutKey[]).every((key) => next[key] === layout[key]) ? layout : next;
}

/** Local desktop layout state. Separators support pointer capture and keyboard resizing. */
export function useAnatomyLayout({ workspaceRef, studyRef }: {
  workspaceRef: RefObject<HTMLElement | null>;
  studyRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<AnatomyLayout>(DEFAULT_LAYOUT);
  const [isResizing, setIsResizing] = useState(false);
  const dimensions = useRef<Dimensions>({ width: 0, height: 0, studyWidth: 0 });
  const drag = useRef<Drag | null>(null);
  const stageTouched = useRef(false);

  const finishDrag = useCallback(() => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    document.body.style.userSelect = current.userSelect;
    document.body.style.cursor = current.cursor;
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    setIsResizing(false);
  }, []);

  useEffect(() => {
    const measure = () => {
      const workspace = workspaceRef.current;
      const study = studyRef.current;
      dimensions.current = {
        width: workspace?.clientWidth ?? 0,
        height: workspace?.clientHeight ?? 0,
        studyWidth: study?.querySelector(".anatomy-section-grid")?.clientWidth ?? study?.clientWidth ?? 0
      };
      setLayout((current) => {
        const height = fittedStageHeight(dimensions.current);
        const next = !stageTouched.current && current.stageHeight !== height ? { ...current, stageHeight: height } : current;
        return normalize(next, dimensions.current);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (workspaceRef.current) observer.observe(workspaceRef.current);
    if (studyRef.current) observer.observe(studyRef.current);
    window.addEventListener("blur", finishDrag);
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", finishDrag);
      finishDrag();
    };
  }, [workspaceRef, studyRef, finishDrag]);

  const setValue = useCallback((key: AnatomyLayoutKey, value: number, manuallyAdjusted = true) => {
    if (key === "stageHeight") stageTouched.current = manuallyAdjusted;
    setLayout((current) => {
      const next = clamp(value, ...bounds(key, current, dimensions.current));
      return current[key] === next ? current : { ...current, [key]: next };
    });
  }, []);

  const resetLayout = useCallback(() => {
    finishDrag();
    stageTouched.current = false;
    setLayout(normalize({ ...DEFAULT_LAYOUT, stageHeight: fittedStageHeight(dimensions.current) }, dimensions.current));
  }, [finishDrag]);

  const separatorProps = (key: AnatomyLayoutKey): SeparatorProps => {
    const [min, max] = bounds(key, layout, dimensions.current);
    const ratio = key === "sectionRatio";
    const displayValue = (value: number) => Math.round(ratio ? value * 100 : value);
    return {
      role: "separator",
      tabIndex: 0,
      "aria-label": t(LABELS[key]),
      "aria-orientation": horizontal(key) ? "vertical" : "horizontal",
      "aria-valuemin": displayValue(min),
      "aria-valuemax": displayValue(max),
      "aria-valuenow": displayValue(layout[key]),
      "aria-valuetext": key === "referenceHeight"
        ? t("等比高度 {offset} 像素", { offset: `${layout[key] >= 0 ? "+" : ""}${displayValue(layout[key])}` })
        : `${displayValue(layout[key])}${ratio ? "%" : ` ${t("像素")}`}`,
      "data-testid": `resize-${key}`,
      title: `${t(LABELS[key])} · ${t("拖动或方向键调整，双击还原")}`,
      style: { touchAction: "none" },
      onPointerDown: (event) => {
        if (!event.isPrimary || event.button !== 0) return;
        finishDrag();
        event.preventDefault();
        const element = event.currentTarget;
        element.focus({ preventScroll: true });
        element.setPointerCapture(event.pointerId);
        drag.current = {
          key, pointerId: event.pointerId, element,
          x: event.clientX, y: event.clientY, value: layout[key],
          userSelect: document.body.style.userSelect, cursor: document.body.style.cursor
        };
        document.body.style.userSelect = "none";
        document.body.style.cursor = horizontal(key) ? "col-resize" : "row-resize";
        setIsResizing(true);
      },
      onPointerMove: (event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        const delta = key === "sectionRatio" ? dx / Math.max(1, dimensions.current.studyWidth)
          : key === "inspectorWidth" ? -dx : horizontal(key) ? dx : dy;
        setValue(key, current.value + delta);
      },
      onPointerUp: (event) => { if (drag.current?.pointerId === event.pointerId) finishDrag(); },
      onPointerCancel: (event) => { if (drag.current?.pointerId === event.pointerId) finishDrag(); },
      onLostPointerCapture: (event) => { if (drag.current?.pointerId === event.pointerId) finishDrag(); },
      onDoubleClick: () => setValue(key, key === "stageHeight" ? fittedStageHeight(dimensions.current) : DEFAULT_LAYOUT[key], false),
      onKeyDown: (event) => {
        let next: number;
        if (event.key === "Home") next = min;
        else if (event.key === "End") next = max;
        else {
          const previous = horizontal(key) ? "ArrowLeft" : "ArrowUp";
          const following = horizontal(key) ? "ArrowRight" : "ArrowDown";
          if (event.key !== previous && event.key !== following) return;
          const step = ratio ? (event.shiftKey ? 0.05 : 0.02) : (event.shiftKey ? 30 : 10);
          const direction = (event.key === following ? 1 : -1) * (key === "inspectorWidth" ? -1 : 1);
          next = layout[key] + direction * step;
        }
        event.preventDefault();
        setValue(key, next);
      }
    };
  };

  return { layout, resetLayout, separatorProps, isResizing };
}
