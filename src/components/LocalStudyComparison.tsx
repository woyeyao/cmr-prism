"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { BrowserStudySource } from "@/client/studySource";
import { useFrames } from "@/client/useFrames";
import { FIT_IMAGE } from "@/core/imageTransform";
import { comparisonViewLabel, initialComparisonPlane, recommendComparisonCollection } from "@/core/localComparison";
import type { ImageTransform, StudyCatalog, WindowLevel } from "@/core/types";
import ImageViewport from "@/presentation/ImageViewport";
import FrameRateControl from "./FrameRateControl";
import "./local-study-comparison.css";

export type LocalStudyComparisonProps = { source: BrowserStudySource; catalog: StudyCatalog; viewId: string };

/** Mounting a new teaching view resets only this independent comparison pane. */
export default function LocalStudyComparison(props: LocalStudyComparisonProps) {
  return <LocalStudyViewer key={`${props.catalog.id}/${props.viewId}`} {...props} />;
}

function LocalStudyViewer({ source, catalog, viewId }: LocalStudyComparisonProps) {
  const recommendation = recommendComparisonCollection(catalog, viewId);
  const [collectionId, setCollectionId] = useState(recommendation?.id ?? "");
  const collection = catalog.collections.find((entry) => entry.id === collectionId);
  const [planeIndex, setPlaneIndex] = useState(initialComparisonPlane(recommendation));
  const [frameIndex, setFrameIndex] = useState(0);
  const [windowLevel, setWindowLevel] = useState<WindowLevel>(recommendation?.defaultWindow ?? { center: 128, width: 256 });
  const [transform, setTransform] = useState<ImageTransform>(FIT_IMAGE);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(25);
  const [retrying, setRetrying] = useState(false);
  const retryController = useRef<AbortController | null>(null);
  const plane = collection?.planes[planeIndex];
  const count = plane?.frameIds.length ?? 0;
  const frameId = plane?.frameIds[frameIndex] ?? null;
  const entries = useFrames(source, frameId ? [frameId] : []);
  const entry = frameId ? entries[frameId] : undefined;
  const missing = !!collection && !frameId;
  const error = entry?.error ?? (missing ? "此层位的当前帧缺失，请换帧或层位" : undefined);

  useEffect(() => {
    source.setPriorityFrames(frameId ? [frameId] : []);
  }, [source, frameId]);
  useEffect(() => {
    if (!collection || collection.kind !== "cine") return;
    const controller = new AbortController();
    void source.warmCine([collection.id], controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [source, collection]);
  useEffect(() => {
    if (!plane || !entry?.frame || !count) { source.prefetch([]); return; }
    source.prefetch([1, 2, 3, -1].flatMap((delta) => {
      const id = plane.frameIds[(frameIndex + delta + count) % count];
      return id ? [id] : [];
    }));
  }, [source, plane, count, frameIndex, entry?.frame]);
  useEffect(() => () => source.prefetch([]), [source]);
  useEffect(() => {
    if (!playing || count < 2 || !entry?.frame || error) return;
    const timer = window.setTimeout(() => setFrameIndex((index) => (index + 1) % count), 1000 / fps);
    return () => window.clearTimeout(timer);
  }, [playing, count, entry?.frame, error, fps, frameIndex]);
  useEffect(() => { if (error) setPlaying(false); }, [error]);
  useEffect(() => {
    const pause = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);
  useEffect(() => {
    setRetrying(false);
    return () => retryController.current?.abort();
  }, [source, frameId]);

  function retryFrame() {
    if (!frameId) return;
    retryController.current?.abort();
    const controller = new AbortController();
    retryController.current = controller;
    setRetrying(true);
    void source.load(frameId, controller.signal).catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setRetrying(false);
    });
  }

  function selectCollection(id: string) {
    const next = catalog.collections.find((item) => item.id === id);
    setPlaying(false); setCollectionId(id); setPlaneIndex(initialComparisonPlane(next)); setFrameIndex(0);
    setWindowLevel(next?.defaultWindow ?? { center: 128, width: 256 }); setTransform(FIT_IMAGE);
  }
  function selectPlane(index: number) {
    const next = Math.max(0, Math.min((collection?.planes.length ?? 1) - 1, index));
    setPlaying(false); setPlaneIndex(next);
    setFrameIndex((current) => Math.min(current, Math.max(0, (collection?.planes[next]?.frameIds.length ?? 1) - 1)));
  }
  function navigate(axis: "time" | "space", delta: number) {
    setPlaying(false);
    if (axis === "space") selectPlane(planeIndex + delta);
    else if (count) setFrameIndex((current) => (current + delta + count) % count);
  }
  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("input, select, textarea, button, [contenteditable]")) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const moves: Record<string, ["time" | "space", number]> = {
      ArrowLeft: ["time", -1], ArrowRight: ["time", 1], ArrowUp: ["space", -1], ArrowDown: ["space", 1],
    };
    if (moves[event.key]) { event.preventDefault(); event.stopPropagation(); navigate(...moves[event.key]); }
    else if (event.key === " " && count > 1) { event.preventDefault(); event.stopPropagation(); setPlaying((current) => !current); }
  }

  const recommendedLabel = comparisonViewLabel(viewId);
  const geometricallyInferred = collection?.warnings.some((warning) => warning.startsWith("Geometric view inference:"));
  return <section className="local-comparison" aria-label="本机病例对照" onKeyDown={handleKeys} data-testid="local-comparison">
    <label className="local-comparison-select">本机序列
      <select aria-label="本机对照序列" value={collectionId} onChange={(event) => selectCollection(event.target.value)}>
        <option value="">选择对照序列</option>
        {catalog.collections.map((item) => <option key={item.id} value={item.id}>{item.view === "UNKNOWN" ? "视角待确认" : item.view} · {item.kind.toUpperCase()} · {item.label} · {item.planes.length} 层</option>)}
      </select>
    </label>
    {!recommendation && <p className="local-comparison-note">{recommendedLabel ? `未找到标为 ${recommendedLabel} 的${recommendedLabel === "AXIAL" ? "定位" : "Cine"}序列。` : "本教学面没有可直接匹配的病例视角标签。"}可手动选择影像比较。</p>}
    {collection && <>
      <div className="local-comparison-image">
        <ImageViewport frame={entry?.frame ?? null} window={windowLevel} transform={transform} onTransformChange={setTransform}
          onNavigate={navigate} loading={retrying || entry?.loading} error={retrying ? undefined : error}
          label={`本机 ${collection.view === "UNKNOWN" ? "待确认视角" : collection.view}，第 ${planeIndex + 1} 层`} />
        <span className="local-comparison-readout">S{planeIndex + 1}/{collection.planes.length} · F{frameIndex + 1}/{count || 1}</span>
        <button className="local-comparison-fit" onClick={() => setTransform(FIT_IMAGE)} aria-label="适应本机影像">适应</button>
      </div>
      {entry?.error && <button className="local-comparison-retry" disabled={retrying} onClick={retryFrame}>重试读取</button>}
      <div className="local-comparison-transport">
        <button aria-label={`${playing ? "暂停" : "播放"}本机${collection.axisKind === "cardiac" ? " Cine" : "序列"}`} aria-pressed={playing} disabled={count < 2 || !!error} onClick={() => setPlaying((current) => !current)}>{playing ? "Ⅱ" : "▶"}</button>
        <label>{collection.axisKind === "cardiac" ? "心动帧" : collection.axisLabel}<input aria-label="本机时间帧" type="range" min={0} max={Math.max(0, count - 1)} value={frameIndex} disabled={count < 2} onChange={(event) => { setPlaying(false); setFrameIndex(Number(event.target.value)); }} /></label>
        <FrameRateControl value={fps} onChange={setFps} />
      </div>
      {collection.planes.length > 1 && <label className="local-comparison-layer">病例层位 <output>{planeIndex + 1} / {collection.planes.length}</output><input aria-label="本机空间层位" type="range" min={0} max={collection.planes.length - 1} value={planeIndex} onChange={(event) => selectPlane(Number(event.target.value))} /></label>}
      <details className="local-comparison-window"><summary>窗宽 / 窗位 · {Math.round(transform.zoom * 100)}%</summary><div>
        <WindowNumber label="WW" ariaLabel="本机窗宽" value={windowLevel.width} min={1} onChange={(width) => setWindowLevel((current) => ({ ...current, width }))} />
        <WindowNumber label="WL" ariaLabel="本机窗位" value={windowLevel.center} onChange={(center) => setWindowLevel((current) => ({ ...current, center }))} />
        <button onClick={() => setWindowLevel(collection.defaultWindow)}>重置窗</button>
      </div><p>拖动平移 · Ctrl + 滚轮缩放 · 滚轮切帧 · Shift + 滚轮切层</p></details>
      {collection.view === "SAX" && <p className="local-comparison-note">初始显示目录中层；基底、乳头肌与心尖层需根据病例影像手动确认。</p>}
      {geometricallyInferred && <p className="local-comparison-note">此病例视角由几何推断，尚需核对解剖。</p>}
    </>}
    <p className="local-comparison-boundary">本机病例与静态图谱并排比较；未进行同人空间配准或心动相位同步。影像仅在本机处理。</p>
  </section>;
}

function WindowNumber({ label, ariaLabel, value, min, onChange }: { label: string; ariaLabel: string; value: number; min?: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(Math.round(value)));
  useEffect(() => setDraft(String(Math.round(value))), [value]);
  const commit = () => {
    const next = Number(draft);
    if (draft.trim() && Number.isFinite(next)) onChange(min === undefined ? next : Math.max(min, next));
    else setDraft(String(Math.round(value)));
  };
  return <label>{label}<input aria-label={ariaLabel} type="number" value={draft} min={min} step={10} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}
