"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PlaneGeometry, ScalarFrame, WindowLevel } from "../core/types";
import { createGlassRuntime, type GlassRuntime } from "./glassRuntime";

export type GlassItem = {
  id: string;
  frame: ScalarFrame | null;
  window: WindowLevel;
  geometry?: PlaneGeometry;
  label: string;
  selected?: boolean;
  approximate?: boolean;
};

export type GlassStageProps = {
  items: GlassItem[];
  mode: "atlas" | "cube";
  activeId?: string;
  atlasSpacing?: number;
  theme?: "light" | "dark";
  onSelect: (id: string) => void;
  onInspect?: (id: string) => void;
  onNavigate?: (axis: "time" | "space", delta: number) => void;
  onUnavailable?: (reason: string) => void;
  className?: string;
};

type StageCallbacks = Pick<GlassStageProps, "onSelect" | "onInspect" | "onNavigate" | "onUnavailable">;

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [role='textbox']");
}

/** Reusable Three.js host for the glass atlas and true-position CMR plane cube. */
export default function GlassStage({
  items,
  mode,
  activeId,
  atlasSpacing = 0.46,
  theme = "light",
  onSelect,
  onInspect,
  onNavigate,
  onUnavailable,
  className
}: GlassStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<GlassRuntime | null>(null);
  const latestRef = useRef({ items, mode, activeId, atlasSpacing, theme, onSelect, onInspect, onNavigate, onUnavailable });
  const [status, setStatus] = useState<"starting" | "ready" | "unavailable">("starting");
  const [backend, setBackend] = useState<"WebGPU" | "WebGL2" | null>(null);

  latestRef.current = { items, mode, activeId, atlasSpacing, theme, onSelect, onInspect, onNavigate, onUnavailable };

  useEffect(() => {
    const host = stageRef.current;
    if (!host) return;
    let cancelled = false;
    const callbacks = {
      onSelect: (id: string) => latestRef.current.onSelect(id),
      onInspect: (id: string) => latestRef.current.onInspect?.(id),
      onUnavailable: (reason: string) => {
        setStatus("unavailable");
        latestRef.current.onUnavailable?.(reason);
      }
    };

    void createGlassRuntime(host, callbacks).then((runtime) => {
      if (cancelled) {
        runtime.dispose();
        return;
      }
      runtimeRef.current = runtime;
      runtime.update(latestRef.current.items, latestRef.current.mode, latestRef.current.activeId, latestRef.current.atlasSpacing, latestRef.current.theme);
      setBackend(runtime.backend);
      setStatus("ready");
    }).catch((error: unknown) => {
      if (cancelled) return;
      const reason = error instanceof Error ? error.message : "玻璃场景初始化失败。";
      setStatus("unavailable");
      latestRef.current.onUnavailable?.(reason);
    });

    return () => {
      cancelled = true;
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    runtimeRef.current?.update(items, mode, activeId, atlasSpacing, theme);
  }, [items, mode, activeId, atlasSpacing, theme]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest(".glass-controls")) return;
      const amount = event.deltaY || event.deltaX;
      const navigate = latestRef.current.onNavigate;
      if (!navigate || amount === 0) return;
      event.preventDefault();
      if (!event.defaultPrevented) return;
      navigate(event.shiftKey ? "space" : "time", Math.sign(amount));
    };
    stage.addEventListener("wheel", handleWheel, { passive: false });
    return () => stage.removeEventListener("wheel", handleWheel);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.target !== event.currentTarget ||
      isTextEntry(event.target) ||
      event.altKey || event.ctrlKey || event.metaKey ||
      !onNavigate
    ) return;
    const navigation: Record<string, ["time" | "space", number]> = {
      ArrowLeft: ["time", -1],
      ArrowRight: ["time", 1],
      ArrowUp: ["space", -1],
      ArrowDown: ["space", 1]
    };
    const action = navigation[event.key];
    if (!action) return;
    event.preventDefault();
    onNavigate(action[0], action[1]);
  };

  const zoom = (factor: number) => runtimeRef.current?.zoomBy(factor);

  return (
    <div
      ref={stageRef}
      className={["glass-stage", className].filter(Boolean).join(" ")}
      data-testid="glass-stage"
      data-backend={backend ?? undefined}
      role="region"
      aria-label={mode === "atlas" ? "CMR 短轴玻璃阵列" : "CMR 空间切片立方体"}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {status !== "ready" && (
        <div className="glass-status" role="status" aria-live="polite">
          {status === "starting" ? "正在准备玻璃影像场景…" : "三维场景暂不可用，二维影像仍可继续浏览。"}
        </div>
      )}
      {status === "ready" && (
        <div className="glass-status glass-status--ready" aria-live="polite">
          {backend} · {mode === "atlas"
            ? `${items.length} 个层位`
            : `${items.filter((item) => (item.geometry ?? item.frame?.descriptor.geometry)?.frameOfReferenceUid.trim()).length} 个可定位平面 · L 左 / P 后 / S 上`}
        </div>
      )}
      <div className={`glass-controls glass-controls--${mode}`} role="group" aria-label="场景视角控制">
        <span className="glass-controls__hint" aria-hidden="true">
          {mode === "atlas" ? "拖动旋转 · Shift / 右键平移" : "拖动旋转 · 重置恢复默认视角"}
        </span>
        <button className="glass-controls__button glass-controls__button--zoom-out" type="button" aria-label="缩小场景" title="缩小" onClick={() => zoom(1.18)}>−</button>
        <button className="glass-controls__button glass-controls__button--reset" type="button" aria-label="重置场景视角" title="重置视角" onClick={() => runtimeRef.current?.resetCamera()}>重置</button>
        <button className="glass-controls__button glass-controls__button--zoom-in" type="button" aria-label="放大场景" title="放大" onClick={() => zoom(0.84)}>＋</button>
      </div>
    </div>
  );
}
