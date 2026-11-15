"use client";

import { useI18n } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { loadAnatomyCines } from "@/core/anatomy/data";
import type { AnatomyCineCatalog, AnatomyViewId } from "@/core/anatomy/types";
import "./reference-cine.css";

const related: Partial<Record<AnatomyViewId, { id: AnatomyViewId; label: string }>> = {
  p2ch: { id: "2ch", label: "二腔心" },
  p4ch: { id: "4ch", label: "四腔心" },
  lvot: { id: "3ch", label: "三腔心" },
  "rv-inout": { id: "rvot", label: "RVOT" }
};

export default function ReferenceCine({ viewId, onSelectView }: {
  viewId: AnatomyViewId;
  onSelectView?: (viewId: AnatomyViewId) => void;
}) {
  const { t } = useI18n();
  const [imageAspect, setImageAspect] = useState(1);
  const [catalog, setCatalog] = useState<AnatomyCineCatalog | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(25);
  const [imageError, setImageError] = useState(false);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageRetry, setImageRetry] = useState(0);
  const frameRef = useRef(0);
  const cine = catalog?.[viewId];
  const frameCount = cine?.frames.length ?? 0;
  const shownFrame = Math.min(frame, Math.max(0, frameCount - 1));
  const isCine = frameCount > 1;
  const trigger = cine?.triggerTimesMs[shownFrame];

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void loadAnatomyCines(controller.signal).then((result) => {
      if (!controller.signal.aborted) setCatalog(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError("参考影像暂时无法加载。");
    });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    setFrame(0);
    frameRef.current = 0;
    setPlaying(false);
    setImageError(false);
    setImageLoading(true);
  }, [viewId]);

  useEffect(() => {
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
  }, []);

  useEffect(() => {
    if (!cine || cine.frames.length < 2) return;
    const images = [1, 2, 3, -1].map((offset) => {
      const image = new Image();
      image.src = cine.frames[(shownFrame + offset + cine.frames.length) % cine.frames.length];
      return image;
    });
    return () => { for (const image of images) image.onload = image.onerror = null; };
  }, [cine, shownFrame]);

  useEffect(() => {
    if (!playing || !isCine || imageError) return;
    let request = 0;
    let last = performance.now();
    const interval = 1000 / fps;
    const advance = (now: number) => {
      if (now - last >= interval) {
        const steps = Math.max(1, Math.floor((now - last) / interval));
        frameRef.current = (frameRef.current + steps) % frameCount;
        setFrame(frameRef.current);
        last = now - ((now - last) % interval);
      }
      request = requestAnimationFrame(advance);
    };
    request = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(request);
  }, [playing, fps, isCine, frameCount, imageError]);

  const goToFrame = (index: number) => {
    setPlaying(false);
    frameRef.current = ((index % frameCount) + frameCount) % frameCount;
    setFrame(frameRef.current);
    setImageError(false);
  };
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !isCine || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === " ") { event.preventDefault(); event.stopPropagation(); if (!imageError && !imageLoading) setPlaying((value) => !value); }
    if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); goToFrame(shownFrame + 1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); goToFrame(shownFrame - 1); }
  };

  return <div className="anatomy-cine" data-testid="anatomy-reference-cine">
    {!catalog ? <div className="anatomy-cine-empty" role={error ? "alert" : "status"}>
      <span>{error ? t(error) : t("加载公开参考影像…")}</span>
      {error && <button type="button" className="anatomy-cine-retry" onClick={() => setRetry((value) => value + 1)}>{t("重新加载")}</button>}
    </div> : !cine ? <div className="anatomy-cine-empty">
      <span className="anatomy-cine-empty-mark" aria-hidden="true">—</span>
      <strong>{t("此视图没有直接的 MR 对照")}</strong>
      <p>{t("可观察解剖断面与定位线，或切换其他参考视图。")}</p>
      {related[viewId] && onSelectView && <button type="button" className="anatomy-cine-retry" onClick={() => onSelectView(related[viewId]!.id)}>
        {t("转到{view}参考", { view: t(related[viewId]!.label) })}<span aria-hidden="true">↗</span>
      </button>}
    </div> : <>
      <div className="anatomy-cine-image" style={{ "--cmr-aspect": imageAspect } as CSSProperties} tabIndex={0} role="group" aria-label={t("{name}，{instructions}", { name: t(cine.name), instructions: t(isCine ? "空格播放或暂停，左右键切帧" : "静态参考像") })} onKeyDown={handleKey}>
        {/* Public reference images retain their native dimensions and grayscale. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={`${viewId}-${imageRetry}`} src={cine.frames[shownFrame]} alt={t("AMRG {name}，第 {frame} 帧", { name: t(cine.name), frame: shownFrame + 1 })} draggable={false}
          onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth > 0 && image.naturalHeight > 0) setImageAspect(image.naturalWidth / image.naturalHeight); setImageLoading(false); setImageError(false); }}
          onError={() => { setImageLoading(false); setImageError(true); setPlaying(false); }} />
        <span className="anatomy-cine-image-tag">{isCine ? "CINE" : t("T1 · 静态定位")}</span>
        {typeof trigger === "number" && Number.isFinite(trigger) && <span className="anatomy-cine-trigger">{trigger.toFixed(0)} ms</span>}
        {imageLoading && <div className="anatomy-cine-image-status" role="status">{t("读取影像…")}</div>}
        {imageError && <div className="anatomy-cine-image-status" role="alert"><span>{t("此帧读取失败")}</span><button type="button" onClick={() => { setImageError(false); setImageLoading(true); setImageRetry((value) => value + 1); }}>{t("重试")}</button></div>}
      </div>
      {isCine && <div className="anatomy-cine-controls">
        <button type="button" className="anatomy-cine-play" aria-label={playing ? t("暂停参考 Cine") : t("播放参考 Cine")} aria-pressed={playing} disabled={imageError || imageLoading} onClick={() => setPlaying((value) => !value)}>{playing ? "Ⅱ" : "▶"}</button>
        <label className="anatomy-cine-track"><span className="sr-only">{t("参考 Cine 帧")}</span><input type="range" min={0} max={frameCount - 1} value={shownFrame} onChange={(event) => goToFrame(Number(event.target.value))} /></label>
        <output className="anatomy-cine-count" aria-live="off">{String(shownFrame + 1).padStart(2, "0")}<span> / {frameCount}</span></output>
        <label className="anatomy-cine-fps"><span className="sr-only">{t("参考 Cine 播放速度")}</span><select value={fps} onChange={(event) => setFps(Number(event.target.value))}><option value={12}>12 fps</option><option value={25}>25 fps</option><option value={32}>32 fps</option></select></label>
      </div>}
      <div className="anatomy-cine-meta"><span>{t(cine.name)}</span><span>Series {cine.series}</span></div>
    </>}
    <p className="anatomy-cine-provenance">{t("AMRG 志愿者 · 与图谱非同一受试者")}</p>
  </div>;
}
