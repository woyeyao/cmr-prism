"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { AnatomyMesh, AnatomyModel } from "@/core/anatomy/types";
import { createAnatomyRuntime, type AnatomyRuntime } from "./anatomyRuntime";
import { DEFAULT_ANATOMY_OPTIONS, type AnatomyRenderOptions, type RenderPlane } from "./rendering";
import "./anatomy-rendering.css";

export type { AnatomyRenderOptions } from "./rendering";
export interface AnatomyStageHandle {
  alignView: () => void;
  resetView: () => void;
  flipView: () => void;
  zoomBy: (factor: number) => void;
}

export interface AnatomyStageProps {
  model: AnatomyModel;
  plane: RenderPlane;
  options?: AnatomyRenderOptions;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onUnavailable?: () => void;
  theme?: "light" | "dark";
  hideControls?: boolean;
  className?: string;
}

const AnatomyStage = forwardRef<AnatomyStageHandle, AnatomyStageProps>(function AnatomyStage({
  model, plane, options = DEFAULT_ANATOMY_OPTIONS, selectedId, onSelect, onUnavailable,
  theme = "light", hideControls = false, className
}, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<AnatomyRuntime | null>(null);
  const latestRef = useRef({ plane, options, selectedId, onSelect, onUnavailable, theme });
  latestRef.current = { plane, options, selectedId, onSelect, onUnavailable, theme };
  const [unavailable, setUnavailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [hovered, setHovered] = useState<AnatomyMesh | null>(null);

  useImperativeHandle(ref, () => ({
    alignView: () => runtimeRef.current?.alignView(), resetView: () => runtimeRef.current?.resetView(),
    flipView: () => runtimeRef.current?.flipView(), zoomBy: factor => runtimeRef.current?.zoomBy(factor)
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setUnavailable(false); setReady(false); setHovered(null);
    try {
      const runtime = createAnatomyRuntime(host, model, {
        onHover: setHovered,
        onSelect: id => latestRef.current.onSelect?.(id),
        onUnavailable: () => {
          runtimeRef.current?.dispose(); runtimeRef.current = null;
          setUnavailable(true); latestRef.current.onUnavailable?.();
        }
      });
      runtimeRef.current = runtime;
      const latest = latestRef.current;
      runtime.setTheme(latest.theme);
      runtime.update(latest.plane, latest.options, latest.selectedId);
      setReady(true);
    } catch {
      runtimeRef.current?.dispose(); runtimeRef.current = null;
      setUnavailable(true); latestRef.current.onUnavailable?.();
    }
    return () => { runtimeRef.current?.dispose(); runtimeRef.current = null; };
  }, [model]);

  useEffect(() => {
    try { runtimeRef.current?.update(plane, options, selectedId); }
    catch {
      runtimeRef.current?.dispose(); runtimeRef.current = null;
      setUnavailable(true); latestRef.current.onUnavailable?.();
    }
  }, [plane, options, selectedId]);

  useEffect(() => { runtimeRef.current?.setTheme(theme); }, [theme]);

  return <div className={`anatomy-stage ${className ?? ""}`} ref={hostRef}
    data-testid="anatomy-stage" data-theme={theme} data-state={unavailable ? "unavailable" : ready ? "ready" : "starting"} role="region" aria-label="三维心脏解剖与切面" tabIndex={0}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); runtimeRef.current?.zoomBy(1.16); }
      if (event.key === "-") { event.preventDefault(); runtimeRef.current?.zoomBy(1 / 1.16); }
      if (event.key === "Home") { event.preventDefault(); runtimeRef.current?.resetView(); }
    }}>
    {unavailable && <div className="anatomy-stage__unavailable" role="status">
      <strong>三维显示暂不可用</strong><span>仍可在右侧查看解剖断面和定位线。</span>
    </div>}
    {!unavailable && <div className="anatomy-stage__hint">拖动旋转 · 滚轮缩放 · 右键平移</div>}
    {hovered && !unavailable && <div className="anatomy-stage__hover" aria-live="polite">
      <i style={{ background: hovered.color }} />{hovered.label}
    </div>}
    {!hideControls && <div className="anatomy-stage__controls" role="group" aria-label="解剖场景视角控制">
      <button type="button" onClick={() => runtimeRef.current?.alignView()} disabled={unavailable}>正对切面</button>
      <button type="button" onClick={() => runtimeRef.current?.flipView()} disabled={unavailable} title="从切面另一侧观察">翻面</button>
      <span />
      <button type="button" onClick={() => runtimeRef.current?.zoomBy(1 / 1.18)} disabled={unavailable} aria-label="缩小心脏模型">−</button>
      <button type="button" onClick={() => runtimeRef.current?.resetView()} disabled={unavailable}>复位</button>
      <button type="button" onClick={() => runtimeRef.current?.zoomBy(1.18)} disabled={unavailable} aria-label="放大心脏模型">＋</button>
    </div>}
  </div>;
});

export default AnatomyStage;
