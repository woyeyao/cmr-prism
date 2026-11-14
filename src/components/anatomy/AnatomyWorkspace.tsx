"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import { ANATOMY_MODELS, ANATOMY_VIEWS, getAnatomyPreset, loadAnatomyModel } from "@/core/anatomy/data";
import { planeFrame } from "@/core/anatomy/geometry";
import type { AnatomyModel, AnatomyModelId, AnatomyPlane, AnatomyViewId, Vec3 } from "@/core/anatomy/types";
import AnatomyStage from "@/presentation/anatomy/AnatomyStage";
import AnatomySection from "@/presentation/anatomy/AnatomySection";
import AnatomyLocator from "@/presentation/anatomy/AnatomyLocator";
import ReferenceCine from "./ReferenceCine";
import ExpandableReference, { keepPanelFocus } from "./ExpandableReference";
import AnatomySources from "./AnatomySources";
import { useAnatomyLayout } from "./useAnatomyLayout";
import "@/app/anatomy.css";

export interface AnatomyWorkspaceProps {
  theme: "light" | "dark";
  renderLocalStudy?: (viewId: string) => ReactNode;
  onImport?: () => void;
  headerActions?: ReactNode;
}

const initialOptions = {
  positive: true, negative: true, showPlane: true,
  showVessels: true, showCavities: false, fill3D: true, fill2D: true,
  showLabels: true, hiddenIds: [] as string[]
};
const groupLabels = { wall: "心壁", papillary: "乳头肌", valve: "瓣膜", vessel: "大血管", cavity: "血池" };
const shortView = (id: AnatomyViewId) => ANATOMY_VIEWS.find((view) => view.id === id)?.shortLabel ?? id;
const numberLabel = (value: number, suffix: string) => `${value > 0 ? "+" : ""}${value}${suffix}`;

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="anatomy-toggle"><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="anatomy-toggle-track" aria-hidden="true" /></label>;
}

function PlaneSlider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  return <label className="anatomy-slider"><span>{label}<output>{numberLabel(value, unit)}</output></span><input type="range" min={min} max={max} step={1} value={value} onChange={(event) => onChange(Number(event.target.value))} aria-label={label} /></label>;
}

function TranslationSlider({ axis, value, onChange }: { axis: string; value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <div className="anatomy-slider anatomy-translation-slider"><label><span>{axis} 轴平移</span><span className="anatomy-precise-value"><input type="number" aria-label={`${axis} 轴平移数值`} value={draft} min={-100} max={100} step="any" onBlur={() => setDraft(String(value))} onChange={(event) => {
    setDraft(event.currentTarget.value);
    const next = event.currentTarget.valueAsNumber;
    if (Number.isFinite(next)) onChange(Math.min(100, Math.max(-100, next)));
  }} /> mm</span></label><input type="range" aria-label={`${axis} 轴平移`} value={value} min={-100} max={100} step={1} onChange={(event) => onChange(Number(event.target.value))} /></div>;
}

function downloadPlane(model: AnatomyModel, originalPreset: AnatomyPlane, effectivePlane: AnatomyPlane, adjustments: { offset: number; tiltX: number; tiltY: number; translationXYZ: Vec3 }) {
  const payload = { modelId: model.id, modelVersion: model.version, space: model.space, originalPreset, effectivePlane, adjustments, status: "candidate", note: "effectivePlane 已应用 adjustments，勿重复施加。图谱教学候选面；未与 DICOM 配准，待独立解剖复核。" };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `cmr-prism-${model.id}-${effectivePlane.id}.json`; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AnatomyWorkspace({ theme, renderLocalStudy, onImport, headerActions }: AnatomyWorkspaceProps) {
  const [modelId, setModelId] = useState<AnatomyModelId>("bodyparts3d");
  const [viewId, setViewId] = useState<AnatomyViewId>("4ch");
  const [model, setModel] = useState<AnatomyModel | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [options, setOptions] = useState(initialOptions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [referenceSource, setReferenceSource] = useState<"amrg" | "local">("amrg");
  const [offset, setOffset] = useState(0);
  const [tiltX, setTiltX] = useState(0);
  const [tiltY, setTiltY] = useState(0);
  const [translationXYZ, setTranslationXYZ] = useState<Vec3>([0, 0, 0]);
  const [panelsSwapped, setPanelsSwapped] = useState(false);
  const [draggingPanel, setDraggingPanel] = useState<"section" | "locator" | null>(null);
  const [structureQuery, setStructureQuery] = useState("");
  const [referenceId, setReferenceId] = useState<AnatomyViewId | null>(null);
  const [sectionOpen, setSectionOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogCloseRef = useRef<HTMLButtonElement>(null);
  const sectionTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const studyRef = useRef<HTMLElement>(null);
  const { layout, resetLayout, separatorProps, isResizing } = useAnatomyLayout({ workspaceRef, studyRef });
  const groups = useMemo(() => [...new Set(ANATOMY_VIEWS.map((view) => view.group))], []);
  const selectedView = ANATOMY_VIEWS.find((view) => view.id === viewId)!;
  const viewIndex = ANATOMY_VIEWS.findIndex((view) => view.id === viewId);
  const preset = model ? getAnatomyPreset(model, viewId) : undefined;
  const plane = useMemo(() => preset ? { ...preset, ...planeFrame(preset, offset, tiltX, tiltY, translationXYZ) } : undefined, [preset, offset, tiltX, tiltY, translationXYZ]);
  const referenceChoices = useMemo(() => model?.presets.filter((item) => item.id !== viewId) ?? [], [model, viewId]);
  const referencePlane = preset ? referenceChoices.find((item) => item.id === (referenceId ?? preset.referenceViewId)) ?? referenceChoices[0] : undefined;
  const selectedMesh = model?.meshes.find((mesh) => mesh.id === selectedId);
  const adjusted = offset !== 0 || tiltX !== 0 || tiltY !== 0 || translationXYZ.some((value) => value !== 0);
  const isLoading = !model && !error;

  useEffect(() => {
    const controller = new AbortController();
    setModel(null); setError(""); setSelectedId(null); setStructureQuery("");
    setOptions((previous) => ({ ...previous, hiddenIds: [] }));
    void loadAnatomyModel(modelId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setModel(next);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "图谱资源暂时无法读取");
    });
    return () => controller.abort();
  }, [modelId, retry]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !sectionOpen) return;
    dialog.showModal();
    dialogCloseRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      sectionTriggerRef.current?.focus({ preventScroll: true });
    };
  }, [sectionOpen]);

  const selectView = useCallback((id: AnatomyViewId) => { setOffset(0); setTiltX(0); setTiltY(0); setTranslationXYZ([0, 0, 0]); setReferenceId(null); setSelectedId(null); setViewId(id); }, []);
  const changeOption = <K extends keyof typeof options>(key: K, value: typeof options[K]) => setOptions((previous) => ({ ...previous, [key]: value }));
  const resetPlane = () => { setOffset(0); setTiltX(0); setTiltY(0); setTranslationXYZ([0, 0, 0]); };
  const hasPlane = !!model && model.id === modelId && !!plane;
  const renderOptions = options;
  const modelName = ANATOMY_MODELS.find((entry) => entry.id === modelId)?.label ?? modelId;
  const referenceSelect = (label: string) => <label className="anatomy-reference-select"><span className="sr-only">{label}</span><select value={referencePlane?.id ?? ""} disabled={!hasPlane || referenceChoices.length === 0} onChange={(event) => setReferenceId(event.target.value as AnatomyViewId)}>{!referencePlane && <option value="">图谱参考面</option>}{referenceChoices.map((item) => <option key={item.id} value={item.id}>{shortView(item.id)}</option>)}</select></label>;
  const dropPanel = (target: "section" | "locator", event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (draggingPanel && draggingPanel !== target) setPanelsSwapped((value) => !value);
    setDraggingPanel(null);
  };
  const dragHandle = (id: "section" | "locator") => <button type="button" className="anatomy-panel-grip" draggable data-testid={`panel-drag-${id}`} aria-label={id === "section" ? "移动二维断面面板" : "移动定位图面板"} title="拖动交换左右位置，或点击交换" onClick={() => setPanelsSwapped((value) => !value)} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); setDraggingPanel(id); }} onDragEnd={() => setDraggingPanel(null)}><span aria-hidden="true">⠿</span></button>;

  return <section className={`anatomy-workspace${isResizing ? " is-resizing" : ""}`} aria-label="解剖课堂" data-theme={theme} data-testid="anatomy-workspace" tabIndex={-1} style={{ "--rail-width": `${layout.railWidth}px`, "--inspector-width": `${layout.inspectorWidth}px`, "--stage-height": `${layout.stageHeight}px`, "--section-ratio": layout.sectionRatio, "--reference-height": `${layout.referenceHeight}px` } as CSSProperties} onDragOver={(event) => { if (draggingPanel) { event.preventDefault(); event.stopPropagation(); } }} onDrop={(event) => { if (draggingPanel) { event.preventDefault(); event.stopPropagation(); setDraggingPanel(null); } }} onKeyDown={(event) => {
    if (event.defaultPrevented) return;
    if ((event.target as HTMLElement).closest("dialog,[role=dialog],[role=separator]")) return;
    if ((event.target as HTMLElement).closest("input,textarea,select,button,[contenteditable]")) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "ArrowRight" && viewIndex < ANATOMY_VIEWS.length - 1) { event.preventDefault(); selectView(ANATOMY_VIEWS[viewIndex + 1].id); }
    if (event.key === "ArrowLeft" && viewIndex > 0) { event.preventDefault(); selectView(ANATOMY_VIEWS[viewIndex - 1].id); }
  }}>
    <header className="anatomy-header">
      <div className="anatomy-header-title"><span className="anatomy-brand">CMR <b>PRISM</b></span><h1>解剖课堂</h1></div>
      <div className="anatomy-model-switch" role="group" aria-label="解剖图谱">{ANATOMY_MODELS.map((entry) => <button key={entry.id} type="button" aria-pressed={modelId === entry.id} onClick={() => { if (entry.id !== modelId) { resetPlane(); setReferenceId(null); setModel(null); setError(""); setModelId(entry.id); } }}>{entry.label}</button>)}</div>
      <div className="anatomy-header-actions"><button type="button" className="anatomy-reset-layout" aria-label="重置工作台布局" title="还原面板大小与位置" onClick={() => { resetLayout(); setPanelsSwapped(false); }}>重置布局</button>{headerActions}</div>
    </header>

    <div className="anatomy-workbench" ref={workspaceRef}>
      <aside className="anatomy-course" aria-label="教学视图">
        <div className="anatomy-course-heading"><span className="anatomy-eyebrow">THE PLANE JOURNEY</span><span>{String(viewIndex + 1).padStart(2, "0")}<i> / {ANATOMY_VIEWS.length}</i></span></div>
        <nav>{groups.map((group, index) => <div className="anatomy-course-group" key={group}><h2><span>0{index + 1}</span>{group}</h2>{ANATOMY_VIEWS.filter((view) => view.group === group).map((view) => {
          const available = model?.presets.some((item) => item.id === view.id);
          return <button type="button" key={view.id} data-testid={`anatomy-view-${view.id}`} aria-current={viewId === view.id ? "step" : undefined} onClick={() => selectView(view.id)}><span>{view.label}</span>{model && !available ? <small>待补标</small> : <span className="anatomy-nav-dot" aria-hidden="true" />}</button>;
        })}</div>)}</nav>
        <div className="anatomy-course-footer"><span className="anatomy-specimen-dot" /><p>{modelName}<small>{model ? `${model.presets.length} 个候选面 · ${model.meshes.length} 个结构` : "正在读取图谱…"}</small></p></div>
      </aside>
      <div className="anatomy-resizer anatomy-resizer-vertical" {...separatorProps("railWidth")} />

      <section className="anatomy-study" aria-label="解剖与切面" ref={studyRef}>
        <div className="anatomy-view-heading"><div><span className="anatomy-eyebrow">{selectedView.group} / {selectedView.shortLabel}</span><div className="anatomy-view-title"><h2>{selectedView.label}</h2>{hasPlane && <span className="anatomy-review-tag">{adjusted ? "微调候选面" : "候选面"} · 待复核</span>}</div></div><div className="anatomy-step-controls"><button type="button" aria-label="上一个教学视图" disabled={viewIndex === 0} onClick={() => selectView(ANATOMY_VIEWS[viewIndex - 1].id)}>←</button><button type="button" aria-label="下一个教学视图" disabled={viewIndex === ANATOMY_VIEWS.length - 1} onClick={() => selectView(ANATOMY_VIEWS[viewIndex + 1].id)}>下一步 <span aria-hidden="true">→</span></button></div></div>
        <div className="anatomy-model-panel" data-testid="anatomy-scene">
          {hasPlane ? <>
            <AnatomyStage model={model} plane={plane} options={renderOptions} selectedId={selectedId ?? undefined} onSelect={setSelectedId} theme={theme} />
            <div className="anatomy-scene-bottom"><div className="anatomy-cut-presets" role="group" aria-label="剖切方式"><button type="button" aria-pressed={options.positive && options.negative} onClick={() => setOptions((previous) => ({ ...previous, positive: true, negative: true }))}>整心</button><button type="button" aria-pressed={!options.positive && options.negative} onClick={() => setOptions((previous) => ({ ...previous, positive: false, negative: true }))}>剖开</button><button type="button" aria-pressed={!options.positive && !options.negative} onClick={() => setOptions((previous) => ({ ...previous, positive: false, negative: false }))}>仅断面</button></div>{selectedMesh && <span>{selectedMesh.label}</span>}</div>
          </> : <div className="anatomy-empty" role={error ? "alert" : "status"}>
            <span className={`anatomy-empty-symbol${isLoading ? " is-loading" : ""}`} aria-hidden="true">◇</span>
            <h3>{error ? "图谱加载未完成" : isLoading ? "正在准备解剖图谱" : `${modelName} · 此视图待补标`}</h3>
            <p>{error ? "请检查本机服务后重试，已导入的影像仍可正常浏览。" : isLoading ? "载入模型、结构与切面参数" : "每个标本需要独立确定心尖、瓣环与观察方向。当前保留所选视图，等待该标本的切面完成。"}</p>
            {error && <><details><summary>加载详情</summary><p>{error}</p></details><button type="button" className="anatomy-button" onClick={() => setRetry((value) => value + 1)}>重新加载</button></>}
            {!error && model && !plane && <button type="button" className="anatomy-button" onClick={() => selectView("sax-mid")}>查看乳头肌短轴候选 <span aria-hidden="true">→</span></button>}
          </div>}
        </div>

        <div className="anatomy-resizer anatomy-resizer-horizontal" {...separatorProps("stageHeight")} />
        <div className={`anatomy-section-grid${panelsSwapped ? " is-swapped" : ""}${draggingPanel ? " is-dragging" : ""}`}>
          <section className="anatomy-panel anatomy-section-panel" onDragOver={(event) => { if (draggingPanel) event.preventDefault(); }} onDrop={(event) => dropPanel("section", event)}><header>{dragHandle("section")}<div><span className="anatomy-eyebrow">ON THE PLANE</span><h3>二维解剖断面</h3></div><button type="button" className="anatomy-expand-section" ref={sectionTriggerRef} aria-label="放大解剖断面" disabled={!hasPlane} onClick={() => setSectionOpen(true)}>放大 <span aria-hidden="true">⤢</span></button></header><div className="anatomy-canvas-container">{hasPlane ? <AnatomySection model={model} plane={plane} options={renderOptions} selectedId={selectedId ?? undefined} onSelect={setSelectedId} theme={theme} /> : <p className="anatomy-panel-placeholder">切面就绪后显示断面</p>}</div></section>
          <div className="anatomy-resizer anatomy-resizer-vertical" {...separatorProps("sectionRatio")} />
          <section className="anatomy-panel anatomy-locator-panel" onDragOver={(event) => { if (draggingPanel) event.preventDefault(); }} onDrop={(event) => dropPanel("locator", event)}><header>{dragHandle("locator")}<div><span className="anatomy-eyebrow">LOCATE IN SPACE</span><h3>参考面上的定位线</h3></div>{referenceSelect("定位参考面")}</header><div className="anatomy-canvas-container">{hasPlane && referencePlane ? <AnatomyLocator model={model} plane={plane} referencePlane={referencePlane} options={renderOptions} theme={theme} /> : <p className="anatomy-panel-placeholder">{hasPlane ? "该标本的参考面待补标" : "切面就绪后显示定位线"}</p>}</div></section>
        </div>
        <div className="anatomy-view-note"><span aria-hidden="true">↳</span><p>{selectedView.lesson}</p></div>
      </section>
      <div className="anatomy-resizer anatomy-resizer-vertical" {...separatorProps("inspectorWidth")} />

      <aside className="anatomy-inspector" aria-label="影像对照与切面控制">
        <ExpandableReference sourceSwitch={<div className="anatomy-source-switch" role="group" aria-label="参考影像来源"><button type="button" aria-pressed={referenceSource === "amrg"} onClick={() => setReferenceSource("amrg")}>公开参考</button><button type="button" aria-pressed={referenceSource === "local"} onClick={() => setReferenceSource("local")}>本机病例</button></div>}>
          {referenceSource === "amrg" ? <ReferenceCine viewId={viewId} onSelectView={selectView} /> : renderLocalStudy ? <div className="anatomy-local-study">{renderLocalStudy(viewId)}</div> : <div className="anatomy-empty anatomy-empty-compact"><span className="anatomy-empty-symbol" aria-hidden="true">⊞</span><h3>把自己的病例放在旁边</h3><p>导入本机 DICOM 后，与图谱并排观察同类切面。</p>{onImport && <button type="button" className="anatomy-button" onClick={onImport}>导入本机影像 <span aria-hidden="true">↗</span></button>}</div>}
        </ExpandableReference>
        <div className="anatomy-resizer anatomy-resizer-horizontal" {...separatorProps("referenceHeight")} />

        <section className="anatomy-controls"><h3>剖切与显示</h3><fieldset disabled={!hasPlane}><legend className="sr-only">剖切与显示控制</legend><div className="anatomy-side-controls"><Toggle label="显示 A 侧" checked={options.positive} onChange={(value) => changeOption("positive", value)} /><Toggle label="显示 B 侧" checked={options.negative} onChange={(value) => changeOption("negative", value)} /></div>{preset && <p className="anatomy-side-note">{preset.sideA}<br />{preset.sideB}</p>}<div className="anatomy-options-grid"><Toggle label="切面平板" checked={options.showPlane} onChange={(value) => changeOption("showPlane", value)} /><Toggle label="大血管" checked={options.showVessels} onChange={(value) => changeOption("showVessels", value)} /><Toggle label="3D 切口填色" checked={options.fill3D} onChange={(value) => changeOption("fill3D", value)} /><Toggle label="2D 断面填色" checked={options.fill2D} onChange={(value) => changeOption("fill2D", value)} /><Toggle label="血池铸型" checked={options.showCavities} onChange={(value) => changeOption("showCavities", value)} /><Toggle label="结构标注" checked={options.showLabels} onChange={(value) => changeOption("showLabels", value)} /></div></fieldset></section>

        <details className="anatomy-adjustments"><summary>切面微调 <span>{adjusted ? "已调整" : "XYZ · 层位 · 角度"}</span></summary><fieldset disabled={!hasPlane}><legend className="sr-only">切面位置与角度</legend>
          <div className="anatomy-translation-controls"><h4>XYZ 自由平移</h4><p>{model?.space.axes === "LPS" ? "+X 向左 · +Y 向后 · +Z 向头（mm）" : "沿当前图谱的坐标轴移动切面中心（mm）。"}</p>{["X", "Y", "Z"].map((axis, index) => <TranslationSlider key={axis} axis={axis} value={translationXYZ[index]} onChange={(value) => setTranslationXYZ((previous) => previous.map((item, axisIndex) => axisIndex === index ? value : item) as Vec3)} />)}</div>
          <PlaneSlider label="沿法线平移" value={offset} min={preset?.offsetRange[0] ?? -28} max={preset?.offsetRange[1] ?? 28} unit=" mm" onChange={setOffset} /><PlaneSlider label="绕面内横轴倾斜" value={tiltX} min={-25} max={25} unit="°" onChange={setTiltX} /><PlaneSlider label="绕面内纵轴倾斜" value={tiltY} min={-25} max={25} unit="°" onChange={setTiltY} /><div className="anatomy-adjustment-actions"><button type="button" onClick={resetPlane} disabled={!adjusted}>恢复预设</button><button type="button" onClick={() => { if (model && preset && plane) downloadPlane(model, preset, plane, { offset, tiltX, tiltY, translationXYZ }); }}>导出切面参数 ↗</button></div><p>XYZ 位移与沿法线平移叠加；切换视图或图谱后恢复预设。</p>
        </fieldset></details>
        {preset && <details className="anatomy-review-details"><summary>定位依据与复核要点 <span aria-hidden="true">＋</span></summary><div><p><strong>定位依据</strong>{preset.basis}</p><p><strong>复核要点</strong>{preset.review}</p><span className="anatomy-review-version">{model?.version} · 切面 {preset.version}</span></div></details>}

        {model && <details className="anatomy-structures"><summary>解剖结构 <span>{model.meshes.length} 项</span></summary><label className="anatomy-structure-search"><span className="sr-only">搜索解剖结构</span><input type="search" placeholder="搜索结构名称" value={structureQuery} onChange={(event) => setStructureQuery(event.target.value)} /></label><div className="anatomy-structure-list">{model.meshes.filter((mesh) => `${mesh.label} ${mesh.id}`.toLowerCase().includes(structureQuery.toLowerCase())).map((mesh) => {
          const hidden = options.hiddenIds.includes(mesh.id);
          const groupHidden = mesh.group === "vessel" && !options.showVessels || mesh.group === "cavity" && !options.showCavities;
          return <div key={mesh.id} className={`anatomy-structure${selectedId === mesh.id ? " is-selected" : ""}${hidden || groupHidden ? " is-hidden" : ""}`}><button type="button" className="anatomy-structure-name" onClick={() => setSelectedId(selectedId === mesh.id ? null : mesh.id)} aria-pressed={selectedId === mesh.id}><i style={{ "--structure-color": mesh.color } as CSSProperties} /><span>{mesh.label}<small>{groupLabels[mesh.group]} · {mesh.id}</small></span></button><input type="checkbox" checked={!hidden} aria-label={`显示${mesh.label}`} title={groupHidden ? "需先打开对应结构组显示" : `显示${mesh.label}`} onChange={() => changeOption("hiddenIds", hidden ? options.hiddenIds.filter((id) => id !== mesh.id) : [...options.hiddenIds, mesh.id])} /></div>;
        })}</div><button type="button" className="anatomy-restore-structures" onClick={() => { changeOption("hiddenIds", []); setSelectedId(null); }}>恢复结构显示</button></details>}

        <AnatomySources />
      </aside>
    </div>
    <dialog ref={dialogRef} className="anatomy-section-dialog" aria-label="放大解剖断面与定位线" onKeyDown={keepPanelFocus} onCancel={(event) => { event.preventDefault(); setSectionOpen(false); }} onClose={() => setSectionOpen(false)}>
      <header className="anatomy-dialog-heading"><div><span className="anatomy-eyebrow">{modelName} · {adjusted ? "微调候选面" : "候选面"}</span><h2>{selectedView.label}</h2></div><button type="button" ref={dialogCloseRef} aria-label="关闭放大视图" onClick={() => setSectionOpen(false)}>关闭 <span aria-hidden="true">×</span></button></header>
      {sectionOpen && hasPlane && <div className="anatomy-dialog-content"><section className="anatomy-dialog-section"><header><h3>二维解剖断面</h3><span>与 3D 共用当前切面</span></header><div className="anatomy-dialog-canvas"><AnatomySection model={model} plane={plane} options={renderOptions} selectedId={selectedId ?? undefined} onSelect={setSelectedId} theme={theme} /></div></section><section className="anatomy-dialog-locator"><header><h3>参考面上的定位线</h3>{referenceSelect("放大视图定位参考面")}</header><div className="anatomy-dialog-canvas">{referencePlane ? <AnatomyLocator model={model} plane={plane} referencePlane={referencePlane} options={renderOptions} theme={theme} /> : <p className="anatomy-panel-placeholder">该标本的参考面待补标</p>}</div></section></div>}
      <p className="anatomy-dialog-note">{selectedView.lesson}</p>
    </dialog>
  </section>;
}
