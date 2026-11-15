"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { CmrCollection, ReferenceLine, ResolvedFrame, ViewLabel, ViewportState } from "@/core/types";
import { frameIndexAtPhase, mergeCollections, phaseAt, referenceLine, resolveFrame, splitCollection } from "@/core/spaceTime";
import { getActiveViewport, getSelectedCursors, initialViewerState, viewerReducer } from "@/core/viewerSession";
import { BrowserStudySource, releaseStudy, uploadStudy } from "@/client/studySource";
import { useFrames } from "@/client/useFrames";
import { useColorTheme } from "@/client/useColorTheme";
import { FIT_IMAGE } from "@/core/imageTransform";
import FrameRateControl from "./FrameRateControl";
import ImageViewport from "@/presentation/ImageViewport";
import type { GlassItem } from "@/presentation/GlassStage";
import LocalStudyComparison from "./LocalStudyComparison";
import { LanguageSwitch, useI18n } from "@/i18n";
function ViewerLoading({ scene = false }: {
  scene?: boolean;
}) {
  const { t } = useI18n();
  return <div className="glass-stage-loading" role="status">{scene ? t("准备三维场景…") : t("准备解剖课堂…")}</div>;
}
const AnatomyClassroom = dynamic(() => import("./anatomy/AnatomyClassroom"), {
  ssr: false,
  loading: () => <ViewerLoading />
});
const GlassStage = dynamic(() => import("@/presentation/GlassStage"), {
  ssr: false,
  loading: () => <ViewerLoading scene/>
});
const views: ViewLabel[] = ["SAX", "2CH", "3CH", "4CH", "LVOT", "RVOT", "AXIAL", "UNKNOWN"];
const lineColors = ["#b86650", "#51857f", "#9b8b52", "#8373a0"];
const fmt = (value?: number, suffix = "", digits = 1) => value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}${suffix}`;
const maxFrames = (collection?: CmrCollection) => Math.max(1, ...(collection?.planes.map((p) => p.frameIds.length) ?? []));
const hasGeometricViewInference = (collection?: CmrCollection | null) => collection?.warnings.some((warning) => warning.startsWith("Geometric view inference:")) ?? false;
function uniformIndices(length: number, count: number): number[] {
  count = Math.min(length, Math.max(1, count));
  return Array.from({ length: count }, (_, index) => count === 1 ? Math.floor((length - 1) / 2) : Math.round(index * (length - 1) / (count - 1)));
}
export default function CmrPrism() {
  const { t } = useI18n();
  const kinds: Record<string, string> = { cine: "CINE", lge: "LGE", perfusion: t("灌注"), mapping: "MAPPING", localizer: t("定位"), other: t("其他") };
  const collectionView = (collection?: CmrCollection | null) => !collection ? "CMR" : collection.view === "UNKNOWN" ? t("视角待确认") : collection.view;
  const collectionType = (collection?: CmrCollection | null) => kinds[collection?.kind ?? "other"];
  const collectionLabel = (collection?: CmrCollection | null) => collection?.view === "UNKNOWN"
    ? t("{p0} · 视角待确认", { p0: collectionType(collection) }) : collectionView(collection);
  const collectionHeading = (collection?: CmrCollection | null) => collection?.view === "UNKNOWN"
    ? t("{p0} / 视角待确认", { p0: collectionType(collection) }) : `${collectionView(collection)} / ${collectionType(collection)}`;
  const collectionOption = (collection: CmrCollection) => collection.view === "UNKNOWN"
    ? t("{p0} · 视角待确认 · {p1}", { p0: collectionType(collection), p1: collection.label }) : `${collection.view} · ${collectionType(collection)} · ${collection.label}`;
  const { theme, toggleTheme } = useColorTheme();
  const [state, dispatch] = useReducer(viewerReducer, undefined, initialViewerState);
  const [source, setSource] = useState<BrowserStudySource | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<string | { key: string; params: Record<string, string | number> }>("");
  const [kindFilter, setKindFilter] = useState("all");
  const [seriesCollapsed, setSeriesCollapsed] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [gpuUnavailable, setGpuUnavailable] = useState(false);
  const [anatomyOpen, setAnatomyOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const welcomeObject = useRef<HTMLDivElement>(null);
  const parallaxFrame = useRef<number | null>(null);
  const parallaxTarget = useRef<{
    x: number;
    y: number;
  } | null>(null);
  const importController = useRef<AbortController | null>(null);
  const catalog = state.catalog;
  const active = getActiveViewport(state);
  const activeResolved = catalog && active ? resolveFrame(catalog, active.cursor) : null;
  const collection = activeResolved?.collection;
  const descriptor = activeResolved?.descriptor;
  const activePhase = collection && active ? phaseAt(collection, active.cursor.planeIndex, active.cursor.frameIndex) : 0;
  const canSplitCurrent = useMemo(() => !!(organizeOpen && catalog && collection && splitCollection(catalog, collection.id) !== catalog), [organizeOpen, catalog, collection]);
  const atlasResolved = useMemo(() => {
    if (!catalog || !collection || !active)
      return [];
    const indices = uniformIndices(collection.planes.length, state.atlasCount);
    if (!indices.includes(active.cursor.planeIndex)) {
      const nearestIndex = indices.reduce((best, index, slot) => Math.abs(index - active.cursor.planeIndex) > Math.abs(indices[best] - active.cursor.planeIndex) ? slot : best, 0);
      indices[nearestIndex] = active.cursor.planeIndex;
      indices.sort((a, b) => a - b);
    }
    return indices.map((index) => resolveFrame(catalog, {
      collectionId: collection.id, planeIndex: index,
      frameIndex: collection.axisKind === "cardiac" ? frameIndexAtPhase(collection, index, Number.isFinite(activePhase) ? activePhase : 0) : Math.min(active.cursor.frameIndex, collection.planes[index].frameIds.length - 1)
    })).filter((r): r is ResolvedFrame => r !== null);
  }, [catalog, collection, active, activePhase, state.atlasCount]);
  const splitResolved = useMemo(() => catalog ? state.viewports.slice(0, state.splitCount).map((v) => resolveFrame(catalog, v.cursor)) : [], [catalog, state.viewports, state.splitCount]);
  const splitActiveIndex = state.viewports.slice(0, state.splitCount).findIndex((viewport) => viewport.id === state.activeViewportId);
  const cubeCursors = getSelectedCursors(state);
  const cubeResolved = catalog ? cubeCursors.map((v) => resolveFrame(catalog, v.cursor)) : [];
  const activeCubeResolved = cubeResolved.find((resolved) => !!resolved && resolved.collection.id === active?.cursor.collectionId && resolved.cursor.planeIndex === active?.cursor.planeIndex);
  const detailResolved = state.mode === "split"
    ? splitResolved[splitActiveIndex] ?? activeResolved
    : state.mode === "cube"
      ? activeCubeResolved ?? cubeResolved[0] ?? activeResolved
      : activeResolved;
  const detailCollection = detailResolved?.collection;
  const detailDescriptor = detailResolved?.descriptor;
  const detailWarnings = detailCollection?.warnings.filter((warning) => !warning.startsWith("Geometric view inference:")) ?? [];
  const detailMatchesActive = !!active && !!detailResolved && detailResolved.collection.id === active.cursor.collectionId
    && detailResolved.cursor.planeIndex === active.cursor.planeIndex
    && detailResolved.cursor.frameIndex === active.cursor.frameIndex;
  const visibleResolved = state.mode === "atlas" ? atlasResolved : state.mode === "split" ? splitResolved : state.mode === "cube" ? cubeResolved : [activeResolved];
  const currentIds = visibleResolved.flatMap((r) => r?.descriptor ? [r.descriptor.id] : []);
  if (descriptor && !currentIds.includes(descriptor.id))
    currentIds.push(descriptor.id);
  const warmCollectionKey = (() => {
    const visibleCollectionIds = state.mode === "split"
      ? state.viewports.slice(0, state.splitCount).map((viewport) => viewport.cursor.collectionId)
      : state.mode === "cube"
        ? state.selectedPlanes.map((plane) => plane.collectionId)
        : active ? [active.cursor.collectionId] : [];
    return [...new Set([active?.cursor.collectionId, ...visibleCollectionIds].filter((id): id is string => !!id))].join("|");
  })();
  const frames = useFrames(anatomyOpen ? null : source, anatomyOpen ? [] : currentIds);
  const busy = currentIds.some((id) => !frames[id] || frames[id].loading);
  const frameFailed = currentIds.some((id) => frames[id]?.error);
  useEffect(() => {
    if (!source)
      return;
    const heartbeat = window.setInterval(() => {
      void fetch(`/api/studies/${encodeURIComponent(source.catalog.id)}`, { cache: "no-store" }).then((r) => {
        if (!r.ok) {
          dispatch({ type: "playing", playing: false });
          setMessage("影像会话已过期，请重新导入");
        }
      }).catch(() => setMessage("本机影像服务暂时无法连接"));
    }, 5 * 60 * 1000);
    const unload = () => { void releaseStudy(source.catalog.id); };
    window.addEventListener("pagehide", unload);
    return () => { window.clearInterval(heartbeat); window.removeEventListener("pagehide", unload); source.dispose(); void releaseStudy(source.catalog.id); };
  }, [source]);
  useEffect(() => () => {
    importController.current?.abort();
    if (parallaxFrame.current !== null)
      window.cancelAnimationFrame(parallaxFrame.current);
  }, []);
  useEffect(() => {
    if (anatomyOpen || !state.playing || busy || frameFailed)
      return;
    const timer = window.setTimeout(() => dispatch({ type: "tick" }), 1000 / state.playbackFps);
    return () => window.clearTimeout(timer);
  }, [anatomyOpen, state.playing, state.playbackFps, state.viewports, state.phase, busy, frameFailed]);
  useEffect(() => { if (frameFailed && state.playing)
    dispatch({ type: "playing", playing: false }); }, [frameFailed, state.playing]);
  useEffect(() => {
    if (!source || anatomyOpen)
      return;
    source.setPriorityFrames([...(descriptor ? [descriptor.id] : []), ...currentIds.filter((id) => id !== descriptor?.id)]);
    // Foreground priority follows the displayed frame set, including atlas and split panes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, anatomyOpen, descriptor?.id, currentIds.join("|")]);
  useEffect(() => {
    if (!source || anatomyOpen)
      return;
    if (busy) {
      source.prefetch([]);
      return;
    }
    const ids: string[] = [];
    for (const resolved of visibleResolved)
      if (resolved) {
        const slots = resolved.plane.frameIds;
        for (const delta of [1, 2, 3, -1]) {
          const id = slots[(resolved.cursor.frameIndex + delta + slots.length) % slots.length];
          if (id)
            ids.push(id);
        }
      }
    source.prefetch(ids);
    return () => source.prefetch([]);
    // Source requests are deduplicated; only update lookahead when the displayed frame set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, anatomyOpen, busy, currentIds.join("|")]);
  useEffect(() => {
    if (!source || !warmCollectionKey || anatomyOpen)
      return;
    const controller = new AbortController();
    void source.warmCine(warmCollectionKey.split("|"), controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [source, anatomyOpen, warmCollectionKey]);
  useEffect(() => {
    const compactLayout = window.matchMedia("(max-width: 900px)");
    const collapseForWidth = () => {
      if (compactLayout.matches) {
        setSeriesCollapsed(true);
        setDetailsCollapsed(true);
      }
    };
    collapseForWidth();
    compactLayout.addEventListener("change", collapseForWidth);
    return () => compactLayout.removeEventListener("change", collapseForWidth);
  }, []);
  const navigate = useCallback((axis: "time" | "space", delta: number) => dispatch({ type: "step", axis, delta }), []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, button, [contenteditable], [role=dialog]"))
        return;
      if (event.defaultPrevented || anatomyOpen || !catalog || reportOpen || organizeOpen || event.altKey || event.ctrlKey || event.metaKey)
        return;
      const keys: Record<string, [
        "time" | "space",
        number
      ]> = { ArrowLeft: ["time", -1], ArrowRight: ["time", 1], ArrowUp: ["space", -1], ArrowDown: ["space", 1] };
      if (keys[event.key]) {
        event.preventDefault();
        navigate(...keys[event.key]);
      }
      else if (event.key === " ") {
        event.preventDefault();
        dispatch({ type: "playing", playing: !state.playing });
      }
      else if (event.key === "Escape")
        dispatch({ type: "mode", mode: "atlas" });
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [anatomyOpen, catalog, navigate, state.playing, reportOpen, organizeOpen]);
  function openAnatomy() {
    dispatch({ type: "playing", playing: false });
    setReportOpen(false);
    setOrganizeOpen(false);
    setAnatomyOpen(true);
  }
  async function importFiles(files: File[]) {
    if (!files.length)
      return;
    if (files.reduce((sum, file) => sum + file.size, 0) > 1024 ** 3) {
      setMessage("单次导入上限为 1 GB");
      return;
    }
    importController.current?.abort();
    const controller = new AbortController();
    importController.current = controller;
    setLoading(true);
    setProgress(0);
    setMessage("");
    try {
      const imported = await uploadStudy(files, setProgress, controller.signal);
      setSource(new BrowserStudySource(imported));
      dispatch({ type: "load", catalog: imported });
      setKindFilter("all");
      setMergeIds([]);
      setGpuUnavailable(false);
      if (imported.report.failedFiles)
        setMessage({ key: "已导入可读影像；{p0} 个文件未能读取，请查看导入报告", params: { p0: imported.report.failedFiles } });
    }
    catch (error) {
      if (!controller.signal.aborted)
        setMessage(error instanceof Error ? error.message : "导入失败");
    }
    finally {
      if (importController.current === controller)
        setLoading(false);
    }
  }
  function filesChanged(event: ChangeEvent<HTMLInputElement>) { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }
  const stageUnavailable = useCallback(() => setGpuUnavailable(true), []);
  const moveWelcomeParallax = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    const bounds = event.currentTarget.getBoundingClientRect();
    parallaxTarget.current = {
      x: Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2)),
      y: Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2))
    };
    if (parallaxFrame.current !== null)
      return;
    parallaxFrame.current = window.requestAnimationFrame(() => {
      const target = parallaxTarget.current;
      const element = welcomeObject.current;
      if (target && element) {
        element.style.setProperty("--pointer-x", `${target.x * 2}deg`);
        element.style.setProperty("--pointer-y", `${target.y * 1.7}deg`);
      }
      parallaxFrame.current = null;
    });
  }, []);
  const resetWelcomeParallax = useCallback(() => {
    if (parallaxFrame.current !== null)
      window.cancelAnimationFrame(parallaxFrame.current);
    parallaxFrame.current = null;
    parallaxTarget.current = null;
    welcomeObject.current?.style.setProperty("--pointer-x", "0deg");
    welcomeObject.current?.style.setProperty("--pointer-y", "0deg");
  }, []);
  function addPlane(viewportId: string) {
    const viewport = state.viewports.find((v) => v.id === viewportId);
    const resolved = catalog && viewport ? resolveFrame(catalog, viewport.cursor) : null;
    if (!resolved?.plane.geometry?.frameOfReferenceUid) {
      setMessage("该切片缺少可靠空间坐标，无法加入立方体");
      return;
    }
    const already = state.selectedPlanes.some((p) => p.collectionId === resolved.collection.id && p.planeIndex === resolved.cursor.planeIndex);
    if (!already && state.selectedPlanes.length >= 5) {
      setMessage("立方体最多容纳 5 个切片，请先移除一个");
      return;
    }
    const first = state.selectedPlanes[0];
    if (first && !already) {
      const other = catalog!.collections.find((c) => c.id === first.collectionId);
      if (other?.studyUid !== resolved.collection.studyUid || other?.planes[first.planeIndex]?.geometry?.frameOfReferenceUid !== resolved.plane.geometry.frameOfReferenceUid) {
        setMessage("立方体中的切片必须来自同一检查和同一空间坐标系");
        return;
      }
    }
    dispatch({ type: "selectPlane", viewportId });
  }
  const selectedHere = active && state.selectedPlanes.some((p) => p.collectionId === active.cursor.collectionId && p.planeIndex === active.cursor.planeIndex);
  function glassItems(resolved: Array<ResolvedFrame | null>, viewports?: ViewportState[]): GlassItem[] {
    return resolved.flatMap((r, index) => r ? [{
        id: state.mode === "cube" ? state.selectedPlanes[index]?.id ?? r.plane.id : r.plane.id,
        frame: r.descriptor ? frames[r.descriptor.id]?.frame ?? null : null,
        window: viewports?.[index]?.window ?? active!.window,
        geometry: r.descriptor?.geometry ?? r.plane.geometry,
        label: `${collectionLabel(r.collection)} · S${String(r.cursor.planeIndex + 1).padStart(2, "0")} / ${r.collection.planes.length} · F${r.cursor.frameIndex + 1}`,
        selected: r.cursor.planeIndex === active?.cursor.planeIndex && r.collection.id === active?.cursor.collectionId,
        approximate: r.approximate
      }] : []);
  }
  const items = state.mode === "cube" ? glassItems(cubeResolved, cubeCursors) : glassItems(atlasResolved);
  function imagePane(viewport: ViewportState, resolved: ResolvedFrame | null, index: number, split = false) {
    const entry = resolved?.descriptor ? frames[resolved.descriptor.id] : undefined;
    const targetGeometry = resolved?.descriptor?.geometry ?? resolved?.plane.geometry;
    const lines: Array<ReferenceLine & {
      color?: string;
    }> = [];
    if (split && targetGeometry)
      splitResolved.forEach((other, i) => {
        if (i === index || !other)
          return;
        const geometry = other.descriptor?.geometry ?? other.plane.geometry;
        if (geometry) {
          const line = referenceLine(geometry, targetGeometry);
          if (line)
            lines.push({ ...line, color: lineColors[i] });
        }
      });
    return <section key={viewport.id} className={`viewer-pane ${state.activeViewportId === viewport.id ? "is-active" : ""}`} style={{ "--pane-color": lineColors[index] } as CSSProperties} data-testid={`pane-${index}`} onPointerDown={() => dispatch({ type: "active", viewportId: viewport.id })} onDoubleClick={(event) => {
        if (!split)
          return;
        const target = event.target as HTMLElement;
        if (!target.closest(".image-viewport") || target.closest(".pane-toolbar, button, input, select, textarea, a, [role=button]"))
          return;
        dispatch({ type: "inspectViewport", viewportId: viewport.id });
      }}>
   <div className="pane-toolbar">
    <span className="pane-number">{String(index + 1).padStart(2, "0")}</span>
    <select aria-label={t("视口 {p0} 序列", { p0: index + 1 })} value={viewport.cursor.collectionId} onChange={(e) => dispatch({ type: "collection", viewportId: viewport.id, collectionId: e.target.value })}>
     {catalog?.collections.map((c) => <option key={c.id} value={c.id}>{collectionOption(c)}</option>)}
    </select>
    <button className={`link-button ${viewport.linked ? "is-linked" : ""}`} aria-pressed={viewport.linked} disabled={resolved?.collection.axisKind !== "cardiac"} onClick={() => dispatch({ type: "link", viewportId: viewport.id, linked: !viewport.linked })} title={t("心动相位联动")}>{viewport.linked ? t("联动") : t("独立")}</button>
    <button aria-label={t("加入视口 {p0} 切片到立方体", { p0: index + 1 })} onClick={() => addPlane(viewport.id)}>＋</button>
    <button aria-label={t("重置视口 {p0} 缩放和平移", { p0: index + 1 })} title={t("适应视口")} onClick={() => dispatch({ type: "imageTransform", viewportId: viewport.id, transform: FIT_IMAGE })}>{t("适应")}</button>
   </div>
   <ImageViewport frame={entry?.frame ?? null} window={viewport.window} lines={lines} transform={viewport.imageTransform} onTransformChange={(transform) => dispatch({ type: "imageTransform", viewportId: viewport.id, transform })} active={state.activeViewportId === viewport.id} loading={entry?.loading} error={entry?.error ?? (!resolved?.descriptor ? t("当前层位 / 帧缺失") : undefined)} label={resolved ? t("{p0} · 第 {p1} 层", { p0: collectionLabel(resolved.collection), p1: resolved.cursor.planeIndex + 1 }) : t("尚未选择影像")} onActivate={() => dispatch({ type: "active", viewportId: viewport.id })} onNavigate={navigate}/>
   <div className="pane-readout"><span>{collectionLabel(resolved?.collection)} / S{(resolved?.cursor.planeIndex ?? 0) + 1} · F{(resolved?.cursor.frameIndex ?? 0) + 1}</span><span className="zoom-readout">{Math.round((viewport.imageTransform?.zoom ?? 1) * 100)}%</span><span>{resolved?.approximate ? t("≈ 相位匹配") : resolved?.collection.axisKind === "cardiac" ? t("心动相位") : t(resolved?.collection.axisLabel ?? "")}</span></div>
  </section>;
  }
  const headerActions = <div className="header-actions"><LanguageSwitch /><button className="quiet-button anatomy-entry" data-testid="mode-anatomy" aria-pressed={anatomyOpen} onClick={() => anatomyOpen ? setAnatomyOpen(false) : openAnatomy()}>{anatomyOpen ? (catalog ? t("返回影像") : t("返回首页")) : t("解剖课堂")}</button><button className="theme-toggle" aria-label={theme === "light" ? t("切换暗色模式") : t("切换浅色模式")} aria-pressed={theme === "dark"} onClick={toggleTheme}>{theme === "light" ? t("☾ 暗色") : t("☀ 浅色")}</button><button className="import-button" disabled={loading} onClick={() => folderInput.current?.click()}>{t("导入文件夹")} <span>↗</span></button></div>;
  return <main className={`prism-shell ${catalog ? "has-study" : "is-empty"}${anatomyOpen ? " has-anatomy" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!loading)
    void importFiles(Array.from(e.dataTransfer.files)); }}>
  <input ref={fileInput} className="sr-only" type="file" multiple accept=".dcm,.dicom,.zip,application/dicom" onChange={filesChanged} aria-label={t("选择 DICOM 文件或 ZIP")}/>
  <input ref={folderInput} className="sr-only" type="file" multiple {...{ webkitdirectory: "", directory: "" }} onChange={filesChanged} aria-label={t("选择 DICOM 文件夹")}/>
  {!anatomyOpen && <header className="prism-header">
   <a className="prism-brand" href="/" aria-label={t("CMR Prism 首页")}><span className="brand-mark">◇</span><span><strong>CMR PRISM<span className="brand-dot">.</span></strong><small>{t("心磁棱镜 / SPACE × TIME")}</small></span></a>
   {catalog && !anatomyOpen && <nav className="mode-tabs" aria-label={t("展示模式")}>
    {([['atlas', t("玻璃阵列")], ['inspect', t("单张")], ['split', t("分屏")], ['cube', t("空间立方体")]] as const).map(([mode, label]) => <button key={mode} data-testid={`mode-${mode}`} aria-pressed={state.mode === mode} disabled={mode === "cube" && state.selectedPlanes.length < 2} onClick={() => mode === "inspect" && state.mode === "split" && active ? dispatch({ type: "inspectViewport", viewportId: active.id }) : dispatch({ type: "mode", mode })}>{label}{mode === "cube" && <sup>{state.selectedPlanes.length}</sup>}</button>)}
   </nav>}
   {headerActions}
  </header>}

  {anatomyOpen ? <AnatomyClassroom theme={theme} headerActions={headerActions} onImport={() => folderInput.current?.click()} renderLocalStudy={source && catalog ? (viewId) => <LocalStudyComparison key={catalog.id} source={source} catalog={catalog} viewId={viewId}/> : undefined}/> : !catalog ? <section className="welcome">
   <div className="welcome-copy"><p className="eyebrow">CARDIAC MAGNETIC RESONANCE / 01</p><h1>{t("心动，")}<br />{t("逐帧可见")}<span>{t("。")}</span></h1><p className="welcome-description">{t("在时间与空间之间，")}<br />{t("看见心脏的每一个切面。")}</p>
    <div className="welcome-import"><button className="primary-button" onClick={() => folderInput.current?.click()} disabled={loading}>{t("导入 DICOM 文件夹")} <span>↗</span></button><button className="text-button" onClick={() => fileInput.current?.click()} disabled={loading}>{t("选择文件或 ZIP")}</button></div><p className="upload-hint">{t("也可以将 DICOM 文件拖入此处 · 本机处理")}</p>
    <div className="welcome-anatomy"><button className="quiet-button" onClick={openAnatomy}>{t("探索心脏解剖")} <span aria-hidden="true">↗</span></button><span>{t("双图谱 · 标准切面 · 真实 Cine，无需导入")}</span></div>
    <div className="welcome-features"><span>01<span>{t("短轴阵列")}</span></span><span>02<span>{t("多视角联动")}</span></span><span>03<span>{t("空间切面")}</span></span></div>
   </div>
   <div ref={welcomeObject} className="welcome-object" aria-hidden="true" onPointerMove={moveWelcomeParallax} onPointerLeave={resetWelcomeParallax}><div className="object-orbit orbit-one"/><div className="object-orbit orbit-two"/><div className="object-orbit orbit-three"/><div className="prism-object wave-stack">{Array.from({ length: 10 }, (_, i) => <div key={i} className="object-slice wave-box" style={{ "--slice": i } as CSSProperties}><span className="object-ring"/><span className="object-index">S–{String(i + 1).padStart(2, "0")}</span></div>)}</div><div className="object-caption"><span>4D</span><small>SPATIAL PLANES<br />CARDIAC PHASES</small></div><p className="object-footnote">SPACE × TIME / CMR PRISM</p></div>
  </section> : <div className={`workspace${seriesCollapsed ? " is-series-collapsed" : ""}${detailsCollapsed ? " is-details-collapsed" : ""}`}>
   <aside className={`series-rail${seriesCollapsed ? " is-collapsed" : ""}`}>
    <button className="sidebar-toggle series-toggle" aria-label={seriesCollapsed ? t("展开影像目录") : t("隐藏影像目录")} aria-expanded={!seriesCollapsed} title={seriesCollapsed ? t("展开影像目录") : t("隐藏影像目录")} onClick={() => setSeriesCollapsed((collapsed) => !collapsed)}><span aria-hidden="true">{seriesCollapsed ? "›" : "‹"}</span></button>
    {!seriesCollapsed && <div className="series-content">
     <div className="rail-heading"><span className="eyebrow">STUDY EXPLORER</span><h2>{t("影像目录")} <span>{catalog.collections.length}</span></h2><button className="text-button report-link" onClick={() => setReportOpen(true)}>{t("导入报告 · {count} 帧 ↗", { count: catalog.report.acceptedFrames })}</button></div>
     <div className="series-filters" aria-label={t("序列分类")}>{["all", "cine", "lge", "mapping", "perfusion", "localizer", "other"].filter((kind) => kind === "all" || catalog.collections.some((c) => c.kind === kind)).map((kind) => <button key={kind} aria-pressed={kindFilter === kind} onClick={() => setKindFilter(kind)}>{kind === "all" ? t("全部") : kinds[kind]}</button>)}</div>
     <div className="series-list">{catalog.collections.filter((c) => kindFilter === "all" || c.kind === kindFilter).map((c, i) => <button key={c.id} className={`series-card ${c.id === collection?.id ? "is-selected" : ""}`} onClick={() => active && dispatch({ type: "collection", viewportId: active.id, collectionId: c.id })} title={hasGeometricViewInference(c) ? t("{p0} · 视角根据同检查 Cine 平面几何推断，仅供参考", { p0: c.label }) : c.label}><span className="series-card-top"><strong>{c.view === "UNKNOWN" ? collectionType(c) : c.view}{hasGeometricViewInference(c) && <sup className="inference-mark" aria-label={t("几何推断")}>≈</sup>}</strong><small>{c.view === "UNKNOWN" ? t("视角待确认") : collectionType(c)}</small></span><span className="series-name">{c.label || t("序列 {p0}", { p0: i + 1 })}</span><span className="series-dimensions">{t("{slices} 层 × {frames} {axis}", { slices: c.planes.length, frames: maxFrames(c), axis: t(c.axisKind === "cardiac" ? "相位" : c.axisKind === "parameter" ? "采样" : "帧") })}</span></button>)}</div>
     <div className="rail-footer"><button className="quiet-button" onClick={() => setOrganizeOpen(true)}>{t("组织序列")} <span>↗</span></button><button className="text-button" onClick={() => fileInput.current?.click()} disabled={loading}>{t("导入文件 / ZIP")}</button></div>
    </div>}
   </aside>
   <section className="viewing-area">
    <div className="stage-heading"><div><span className="eyebrow">{state.mode === "atlas" ? "SHORT-AXIS ATLAS" : state.mode === "cube" ? "PATIENT SPACE" : state.mode === "split" ? "LINKED PERSPECTIVES" : "FRAME INSPECTION"}</span><h2>{state.mode === "cube" ? t("切面在空间中相遇") : state.mode === "split" ? t("多个视角，同一心动") : collectionHeading(collection)}</h2></div>
     {state.mode === "atlas" && <div className="atlas-settings"><label className="count-control">{t("展示")} <input aria-label={t("阵列层数")} type="range" min={1} max={Math.min(20, collection?.planes.length ?? 1)} value={Math.min(state.atlasCount, collection?.planes.length ?? 1)} onChange={(e) => dispatch({ type: "atlasCount", count: Number(e.target.value) })}/><output>{t("{count} 层", { count: Math.min(state.atlasCount, collection?.planes.length ?? 1) })}</output></label><label className="spacing-control">{t("间距")} <input aria-label={t("阵列层间距")} type="range" min="0.16" max="1.4" step="0.02" value={state.atlasSpacing} onChange={(e) => dispatch({ type: "atlasSpacing", spacing: Number(e.target.value) })}/><output>{(state.atlasSpacing / 0.46).toFixed(1)}×</output></label></div>}
     {state.mode === "split" && <div className="layout-switch" aria-label={t("分屏数量")}>{([2, 3, 4] as const).map((count) => <button key={count} data-testid={`layout-${count}`} aria-pressed={state.splitCount === count} onClick={() => dispatch({ type: "layout", count })}>{t("{count} 屏", { count })}</button>)}</div>}
     {state.mode === "inspect" && <button className="text-button inspect-return" aria-label={state.inspectionOrigin === "split" ? t("返回分屏") : t("返回阵列")} onClick={() => state.inspectionOrigin === "split" ? dispatch({ type: "returnToSplit" }) : dispatch({ type: "mode", mode: "atlas" })}>{state.inspectionOrigin === "split" ? t("← 返回分屏") : t("← 返回阵列")}</button>}
    </div>
    <div className={`stage-content stage-${state.mode}`}>
     {(state.mode === "atlas" || state.mode === "cube") && !gpuUnavailable && <GlassStage items={items} mode={state.mode} atlasSpacing={state.atlasSpacing} theme={theme} activeId={state.mode === "cube" ? state.selectedPlanes.find((p) => p.collectionId === active?.cursor.collectionId && p.planeIndex === active?.cursor.planeIndex)?.id : activeResolved?.plane.id} onUnavailable={stageUnavailable} onNavigate={navigate} onSelect={(id) => { if (state.mode === "cube")
      dispatch({ type: "activateSelection", selectionId: id });
    else {
      const r = atlasResolved.find((r) => r.plane.id === id);
      if (r && active)
        dispatch({ type: "plane", viewportId: active.id, index: r.cursor.planeIndex });
    } }} onInspect={(id) => { const r = atlasResolved.find((r) => r.plane.id === id); if (r && active)
      dispatch({ type: "plane", viewportId: active.id, index: r.cursor.planeIndex }); dispatch({ type: "mode", mode: "inspect" }); }}/>}
     {(state.mode === "atlas" || state.mode === "cube") && gpuUnavailable && <div className="fallback-grid"><p className="fallback-notice">{t("三维渲染暂不可用，可继续浏览二维影像。")}</p>{(state.mode === "atlas" ? atlasResolved : cubeResolved).map((r, i) => r && <button key={r.plane.id} className="fallback-tile" onClick={() => { if (active) {
      dispatch({ type: "collection", viewportId: active.id, collectionId: r.collection.id });
      dispatch({ type: "plane", viewportId: active.id, index: r.cursor.planeIndex });
      dispatch({ type: "mode", mode: "inspect" });
    } }}><ImageViewport frame={r.descriptor ? frames[r.descriptor.id]?.frame ?? null : null} window={items[i]?.window ?? active!.window} loading={r.descriptor ? frames[r.descriptor.id]?.loading : false}/><span>{t("{p0} · 第 {p1} 层", { p0: collectionLabel(r.collection), p1: r.cursor.planeIndex + 1 })}</span></button>)}</div>}
     {state.mode === "inspect" && active && imagePane(active, activeResolved, 0)}
     {state.mode === "split" && <div className={`split-grid split-${state.splitCount}`}>{state.viewports.slice(0, state.splitCount).map((v, i) => imagePane(v, splitResolved[i], i, true))}</div>}
     {busy && (state.mode === "atlas" || state.mode === "cube") && <span className="stage-load-indicator">{t("读取当前帧…")}</span>}
     {frameFailed && (state.mode === "atlas" || state.mode === "cube") && <span className="stage-load-indicator" role="alert">{t("部分当前帧无法读取，请切换单张查看错误")}</span>}
    </div>
    {state.mode === "atlas" && <div className="atlas-layer-strip" aria-label={t("短轴层位")}>{collection?.planes.map((plane, index) => <button key={plane.id} aria-pressed={active?.cursor.planeIndex === index} onClick={() => active && dispatch({ type: "plane", viewportId: active.id, index })} onDoubleClick={() => dispatch({ type: "mode", mode: "inspect" })}>{String(index + 1).padStart(2, "0")}</button>)}</div>}
    <div className="selection-tray"><span className="tray-label">{t("空间立方体")} <b>{state.selectedPlanes.length}/5</b></span>{state.selectedPlanes.map((selected) => { const c = catalog.collections.find((c) => c.id === selected.collectionId); const name = c?.view === "UNKNOWN" ? collectionType(c) : collectionView(c); return <div className="selection-chip" key={selected.id}><button onClick={() => dispatch({ type: "activateSelection", selectionId: selected.id })}>{name} · S{selected.planeIndex + 1}</button><button aria-label={t("移除 {p0} 第 {p1} 层", { p0: name, p1: selected.planeIndex + 1 })} onClick={() => dispatch({ type: "removePlane", selectionId: selected.id })}>×</button></div>; })}{!state.selectedPlanes.length && <span className="tray-hint">{t("选择切片，加入 2–5 个空间平面")}</span>}<button className="text-button" disabled={state.selectedPlanes.length < 2} onClick={() => dispatch({ type: "mode", mode: "cube" })}>{t("查看立方体 ↗")}</button></div>
   </section>
   <aside className={`details-panel${detailsCollapsed ? " is-collapsed" : ""}`}>
    <button className="sidebar-toggle details-toggle" aria-label={detailsCollapsed ? t("展开参数面板") : t("隐藏参数面板")} aria-expanded={!detailsCollapsed} title={detailsCollapsed ? t("展开参数面板") : t("隐藏参数面板")} onClick={() => setDetailsCollapsed((collapsed) => !collapsed)}><span aria-hidden="true">{detailsCollapsed ? "‹" : "›"}</span></button>
    {!detailsCollapsed && <div className="details-content">
     <p className="eyebrow">{t("FRAME ARCHIVE / 当前切面")}</p><div className="detail-identity"><span>{detailCollection?.view === "UNKNOWN" ? collectionType(detailCollection) : collectionView(detailCollection)}</span><strong>S{String((detailResolved?.cursor.planeIndex ?? 0) + 1).padStart(2, "0")}</strong></div><p className="detail-sequence">{detailCollection?.view === "UNKNOWN" ? t("视角待确认 · {p0}", { p0: detailCollection.label }) : detailCollection?.label}</p>
     <div className="detail-badges"><span>{t(detailCollection?.axisLabel ?? "")}</span>{detailResolved?.approximate && <span>{t("≈ 相位近似匹配")}</span>}{hasGeometricViewInference(detailCollection) && <span className="inference-badge" title={t("视角根据同检查的 Cine 平面几何推断，仅供参考，不代表解剖学验证；可在组织序列中人工修正。")}>{t("几何推断")}</span>}</div>
     <dl className="metadata-grid"><div><dt>{t("空间层位")}</dt><dd>{(detailResolved?.cursor.planeIndex ?? 0) + 1} / {detailCollection?.planes.length}</dd></div><div><dt>{detailCollection?.axisKind === "cardiac" ? t("心动相位") : t("当前帧 / 采样")}</dt><dd>{(detailResolved?.cursor.frameIndex ?? 0) + 1} / {detailResolved?.plane.frameIds.length ?? 1}</dd></div><div><dt>{t("触发时间")}</dt><dd>{fmt(detailDescriptor?.triggerMs, " ms")}</dd></div><div><dt>{t("层厚")}</dt><dd>{fmt(detailDescriptor?.geometry?.thickness, " mm")}</dd></div><div><dt>{t("像素间距 / 行 × 列")}</dt><dd>{detailDescriptor?.geometry ? `${fmt(detailDescriptor.geometry.pixelSpacing[0], "", 2)} × ${fmt(detailDescriptor.geometry.pixelSpacing[1], " mm", 2)}` : "—"}</dd></div><div><dt>{t("矩阵 / 列 × 行")}</dt><dd>{detailDescriptor ? `${detailDescriptor.columns} × ${detailDescriptor.rows}` : "—"}</dd></div><div><dt>TR / TE</dt><dd>{fmt(detailDescriptor?.parameters.trMs)} / {fmt(detailDescriptor?.parameters.teMs, " ms")}</dd></div><div><dt>{t("TI / 翻转角")}</dt><dd>{fmt(detailDescriptor?.parameters.tiMs, " ms")} / {fmt(detailDescriptor?.parameters.flipAngle, "°")}</dd></div></dl>
     {active && detailMatchesActive && <><div className="window-heading"><h3>{t("窗宽 / 窗位")}</h3><button className="text-button" onClick={() => dispatch({ type: "resetWindow", viewportId: active.id })}>{t("重置")}</button></div><div className="window-inputs"><label>WW<input aria-label={t("窗宽")} type="number" min="1" step="10" value={Math.round(active.window.width)} onChange={(e) => dispatch({ type: "window", viewportId: active.id, window: { ...active.window, width: Math.max(1, Number(e.target.value)) } })}/></label><label>WL<input aria-label={t("窗位")} type="number" step="10" value={Math.round(active.window.center)} onChange={(e) => dispatch({ type: "window", viewportId: active.id, window: { ...active.window, center: Number(e.target.value) } })}/></label></div><p className="detail-hint">{t("输入窗宽/窗位调窗 · 影像左拖平移")}</p><button className={`add-plane-button ${selectedHere ? "is-added" : ""}`} onClick={() => addPlane(active.id)}>{selectedHere ? t("− 从立方体移除") : t("＋ 加入空间立方体")}</button></>}
     <label className="note-label">{t("临时备注")} <span>{t("仅当前帧")}</span><textarea data-testid="frame-note" aria-label={t("当前帧文字备注")} rows={3} placeholder={t("为这一帧留下一点说明…")} disabled={!detailDescriptor} value={detailDescriptor ? state.notes[detailDescriptor.id] ?? "" : ""} onChange={(e) => detailDescriptor && dispatch({ type: "note", frameId: detailDescriptor.id, text: e.target.value })}/></label><p className="detail-hint">{t("切换展示方式后保留 · 关闭后清除")}</p>
     {!!detailWarnings.length && <div className="collection-warnings">{detailWarnings.map((warning, i) => <p key={i}>{warning}</p>)}</div>}
    </div>}
   </aside>
  </div>}

  {!anatomyOpen && <footer className="prism-footer">{catalog && active ? <>
   <button data-testid="play-button" className="play-button" aria-label={state.playing ? t("暂停") : t("播放")} disabled={(activeResolved?.plane.frameIds.length ?? 1) < 2} onClick={() => dispatch({ type: "playing", playing: !state.playing })}>{state.playing ? "Ⅱ" : "▶"}</button>
   <div className="navigation-track"><label>{collection?.axisKind === "cardiac" ? t("心动相位") : t(collection?.axisLabel ?? "帧")}<output>{(active.cursor.frameIndex ?? 0) + 1}<span> / {activeResolved?.plane.frameIds.length ?? 1}</span></output></label><input data-testid="time-slider" aria-label={t("时间或采样帧")} type="range" min={0} max={Math.max(0, (activeResolved?.plane.frameIds.length ?? 1) - 1)} value={Math.max(0, active.cursor.frameIndex)} onChange={(e) => dispatch({ type: "frame", viewportId: active.id, index: Number(e.target.value) })}/></div>
   <div className="navigation-track layer-track"><label>{t("空间层位")}<output>{active.cursor.planeIndex + 1}<span> / {collection?.planes.length}</span></output></label><input data-testid="layer-slider" aria-label={t("空间层位")} type="range" min={0} max={Math.max(0, (collection?.planes.length ?? 1) - 1)} value={active.cursor.planeIndex} onChange={(e) => dispatch({ type: "plane", viewportId: active.id, index: Number(e.target.value) })}/></div>
   <FrameRateControl value={state.playbackFps} onChange={(fps) => dispatch({ type: "fps", fps })}/>
   <span className="keyboard-hint">{t("滚轮 / ← → 时间")}<span>{t("↑ ↓ 层位")}</span></span>
  </> : <><span>{t("CMR PRISM / 心磁棱镜")}</span><span>{t("空间 · 时间 · 多视角")}</span><span>LOCAL FIRST</span></>}</footer>}

  {loading && <div className="import-overlay" role="status"><div className="import-card"><span className="eyebrow">IMPORTING STUDY</span><h2>{progress < 1 ? t("正在导入影像") : t("正在整理时空维度")}</h2><p>{progress < 1 ? t("{p0}% · 文件传输到本机服务", { p0: Math.round(progress * 100) }) : t("识别序列、空间层位和采样帧…")}</p><div className={`import-progress ${progress === 1 ? "is-processing" : ""}`}><span style={{ width: `${Math.max(3, progress * 100)}%` }}/></div><button className="text-button" onClick={() => importController.current?.abort()}>{t("取消导入")}</button></div></div>}
  {message && <div className="toast" role="alert"><span>{typeof message === "string" ? t(message) : t(message.key, message.params)}</span><button aria-label={t("关闭消息")} onClick={() => setMessage("")}>×</button></div>}
  {reportOpen && catalog && <div className="dialog-backdrop" onClick={() => setReportOpen(false)}><section className="prism-dialog" role="dialog" aria-modal="true" aria-labelledby="report-title" onClick={(e) => e.stopPropagation()}><button className="dialog-close" aria-label={t("关闭导入报告")} onClick={() => setReportOpen(false)}>×</button><p className="eyebrow">IMPORT REPORT</p><h2 id="report-title">{t("导入报告")}</h2><dl className="report-stats"><div><dt>{t("影像实例")}</dt><dd>{catalog.report.acceptedInstances}</dd></div><div><dt>{t("可浏览帧")}</dt><dd>{catalog.report.acceptedFrames}</dd></div><div><dt>{t("跳过非影像")}</dt><dd>{catalog.report.skippedObjects}</dd></div><div><dt>{t("无法读取")}</dt><dd>{catalog.report.failedFiles}</dd></div></dl>{catalog.report.warnings.length ? <ul>{catalog.report.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul> : <p>{t("影像已整理完成。")}</p>}<button className="primary-button" onClick={() => setReportOpen(false)}>{t("继续浏览")}</button></section></div>}
  {organizeOpen && catalog && <div className="dialog-backdrop" onClick={() => setOrganizeOpen(false)}><section className="prism-dialog organize-dialog" role="dialog" aria-modal="true" aria-labelledby="organize-title" onClick={(e) => e.stopPropagation()}><button className="dialog-close" aria-label={t("关闭序列组织")} onClick={() => setOrganizeOpen(false)}>×</button><p className="eyebrow">COLLECTION ORGANIZATION</p><h2 id="organize-title">{t("组织序列")} </h2><p>{t("为当前序列修正视角，或合并来自同一空间坐标系的不同层位。")}</p><label className="relabel-control">{t("当前视角")}<select aria-label={t("修正当前序列视角")} value={collection?.view ?? "UNKNOWN"} onChange={(e) => collection && dispatch({ type: "relabel", collectionId: collection.id, view: e.target.value as ViewLabel })}>{views.map((view) => <option key={view} value={view}>{view === "UNKNOWN" ? t("视角待确认") : view}</option>)}</select></label><div className="merge-list">{catalog.collections.map((c) => <label key={c.id}><input type="checkbox" checked={mergeIds.includes(c.id)} onChange={(e) => setMergeIds((ids) => e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id))}/><span><strong>{c.view === "UNKNOWN" ? t("{p0} · 视角待确认", { p0: collectionType(c) }) : `${c.view} · ${collectionType(c)}`}</strong><small>{t("{label} · {count} 层", { label: c.label, count: c.planes.length })}</small></span></label>)}</div><div className="organize-actions"><button className="primary-button" disabled={mergeIds.length < 2} onClick={() => { try {
    mergeCollections(catalog, mergeIds);
    dispatch({ type: "merge", collectionIds: mergeIds });
    setMergeIds([]);
    setMessage("已合并兼容的层位");
  }
  catch (error) {
    setMessage(error instanceof Error ? error.message : "这些序列无法合并");
  } }}>{t("合并选中序列")}</button><button className="quiet-button" disabled={!canSplitCurrent} onClick={() => collection && dispatch({ type: "splitCollection", collectionId: collection.id })}>{t("当前集合按原采集拆分")}</button></div></section></div>}
 </main>;
}
