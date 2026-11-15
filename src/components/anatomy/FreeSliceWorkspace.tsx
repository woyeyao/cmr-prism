"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ANATOMY_MODELS, loadAnatomyModel } from "@/core/anatomy/data";
import { freePlaneFrame, freePlaneFromNormal, freePlanePose, wrapDegrees, type FreePlanePose } from "@/core/anatomy/freePlane";
import type { AnatomyModel, AnatomyModelId, PlaneFrame, Vec3 } from "@/core/anatomy/types";
import { useI18n } from "@/i18n";
import AnatomyStage from "@/presentation/anatomy/AnatomyStage";
import { DEFAULT_ANATOMY_OPTIONS, modelBounds } from "@/presentation/anatomy/rendering";
import AnatomySources from "./AnatomySources";
import "@/app/anatomy.css";
import "./free-slice.css";

export interface FreeSliceWorkspaceProps {
  theme: "light" | "dark";
  headerActions?: ReactNode;
}

type EditMode = "translate" | "rotate" | null;
type CutMode = "negative" | "positive" | "whole" | "section";
const axes = ["X", "Y", "Z"] as const;
const formatValue = (value: number) => String(Number(value.toFixed(6)));

function NumberField({ value, label, onChange }: { value: number; label: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(formatValue(value));
  useEffect(() => setDraft(formatValue(value)), [value]);
  return <input type="number" step="any" aria-label={label} value={draft} onChange={event => {
    setDraft(event.target.value);
    const next = event.target.valueAsNumber;
    if (Number.isFinite(next)) onChange(next);
  }} onBlur={() => setDraft(formatValue(value))} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

function exportFreePlane(model: AnatomyModel, pose: FreePlanePose, plane: PlaneFrame) {
  const payload = {
    schemaVersion: 1, mode: "free", modelId: model.id, modelVersion: model.version, space: model.space,
    pose, rotationOrder: "extrinsic XYZ, degrees, about the plane origin", effectivePlane: plane,
    note: "User-defined atlas plane. No patient registration or clinical preset validation. effectivePlane already includes pose.",
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `cmr-prism-${model.id}-free-plane.json`; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** An unconstrained 3D work area, independent of the course preset adjustments. */
export default function FreeSliceWorkspace({ theme, headerActions }: FreeSliceWorkspaceProps) {
  const { t } = useI18n();
  const [modelId, setModelId] = useState<AnatomyModelId>("bodyparts3d");
  const [model, setModel] = useState<AnatomyModel | null>(null);
  const [pose, setPose] = useState<FreePlanePose | null>(null);
  const [startId, setStartId] = useState("4ch");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [editMode, setEditMode] = useState<EditMode>("translate");
  const [cutMode, setCutMode] = useState<CutMode>("negative");
  const [rangeFactor, setRangeFactor] = useState(1);
  const [showPlane, setShowPlane] = useState(true);
  const [fill3D, setFill3D] = useState(true);
  const [showVessels, setShowVessels] = useState(true);
  const [showCavities, setShowCavities] = useState(false);
  const [normalDraft, setNormalDraft] = useState<Vec3>([0, 0, 1]);
  const [normalError, setNormalError] = useState(false);
  const plane = useMemo(() => pose ? freePlaneFrame(pose) : null, [pose]);
  const start = model?.presets.find(preset => preset.id === startId) ?? model?.presets.find(preset => preset.id === "4ch");
  const bounds = useMemo(() => model ? modelBounds(model) : { center: [0, 0, 0] as Vec3, span: 100 }, [model]);
  const rangeCenter = start?.origin ?? bounds.center;
  const options = useMemo(() => ({
    ...DEFAULT_ANATOMY_OPTIONS, showPlane, fill3D, showVessels, showCavities,
    positive: cutMode === "positive" || cutMode === "whole",
    negative: cutMode === "negative" || cutMode === "whole",
  }), [cutMode, showPlane, fill3D, showVessels, showCavities]);

  useEffect(() => {
    const controller = new AbortController();
    setModel(null); setPose(null); setError(""); setUnavailable(false);
    void loadAnatomyModel(modelId, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      const initial = next.presets.find(preset => preset.id === "4ch") ?? next.presets[0];
      setStartId(initial.id); setPose(freePlanePose(initial)); setRangeFactor(1); setModel(next);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "解剖模型加载失败，请重试");
    });
    return () => controller.abort();
  }, [modelId, retry]);

  useEffect(() => {
    if (plane) { setNormalDraft(plane.normal); setNormalError(false); }
  }, [plane]);

  const changeAxis = (key: "origin" | "rotation", index: number, value: number) => setPose(current => current
    ? { ...current, [key]: current[key].map((number, axis) => axis === index ? value : number) as Vec3 } : current);
  const resetPlane = () => { if (start) setPose(freePlanePose(start)); setRangeFactor(1); setNormalError(false); };
  const editModes: [EditMode, string][] = [["translate", "移动切面"], ["rotate", "旋转切面"], [null, "观察模型"]];
  const cutModes: [CutMode, string][] = [["negative", "保留负侧"], ["positive", "保留正侧"], ["whole", "整心"], ["section", "仅断面"]];

  return <section className="anatomy-workspace free-slice-workspace" data-theme={theme} data-testid="free-slice-workspace" aria-label={t("自由切面工作区")}
    onKeyDown={event => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === "Escape") { event.preventDefault(); setEditMode(null); return; }
      if ((event.target as HTMLElement).closest("input,select,textarea,[contenteditable]")) return;
      if (event.key.toLowerCase() === "g") { event.preventDefault(); setEditMode("translate"); }
      if (event.key.toLowerCase() === "r") { event.preventDefault(); setEditMode("rotate"); }
    }}>
    <header className="anatomy-header">
      <div className="anatomy-header-title"><span className="anatomy-brand">CMR <b>PRISM</b></span><h1>{t("自由切面")}</h1></div>
      <div className="anatomy-model-switch" role="group" aria-label={t("解剖图谱")}>{ANATOMY_MODELS.map(entry => <button key={entry.id} type="button" aria-pressed={modelId === entry.id} onClick={() => {
        if (entry.id !== modelId) { setModel(null); setPose(null); setModelId(entry.id); }
      }}>{t(entry.label)}</button>)}</div>
      <div className="anatomy-header-actions">{headerActions}</div>
    </header>

    <div className="free-slice-layout">
      <div className="free-slice-main">
        <div className="free-slice-toolbar" role="group" aria-label={t("切面操作方式")}>{editModes.map(([mode, label]) => <button type="button" key={label} disabled={!plane || unavailable} aria-pressed={editMode === mode} aria-keyshortcuts={mode === "translate" ? "G" : mode === "rotate" ? "R" : "Escape"} onClick={() => setEditMode(mode)}>{t(label)}<kbd aria-hidden="true">{mode === "translate" ? "G" : mode === "rotate" ? "R" : "Esc"}</kbd></button>)}<span className="free-slice-custom-tag">{t("用户自定义切面")}</span></div>
        <div className="free-slice-stage" data-testid="free-slice-stage">
          {model && model.id === modelId && plane ? <>
            <AnatomyStage model={model} plane={plane} options={options} theme={theme} initialView="plane" planeControl={editMode} onPlaneChange={frame => setPose(freePlanePose(frame))} onUnavailable={() => setUnavailable(true)}
              interactionHint={t(editMode === "translate" ? "拖动彩色轴移动切面；空白处旋转模型" : editMode === "rotate" ? "拖动圆环旋转切面；位置保持不变" : "拖动旋转模型 · 滚轮缩放 · 右键平移")}
              unavailableMessage={t("请刷新页面或换用支持 WebGL2 的桌面浏览器。")} />
          </> : <div className="free-slice-empty" role={error ? "alert" : "status"}><h2>{t(error ? "图谱暂时无法读取" : "正在准备解剖图谱")}</h2>{error && <><p>{t(error)}</p><button type="button" onClick={() => setRetry(value => value + 1)}>{t("重新加载")}</button></>}</div>}
        </div>
      </div>

      <aside className="free-slice-controls" aria-label={t("自由切面控制")}>
        <fieldset disabled={!pose || unavailable}><legend>{t("自由切割")}</legend>
          <div className="free-slice-segments" role="group" aria-label={t("切割保留侧")}>{cutModes.map(([mode, label]) => <button type="button" key={mode} aria-pressed={cutMode === mode} onClick={() => setCutMode(mode)}>{t(label)}</button>)}</div>
          <p className="free-slice-note">{t("正侧沿法线方向；改变方向不会移动切面中心。")}</p>
          <div className="free-slice-toggles">{([["切面平板", showPlane, setShowPlane], ["3D 切口填色", fill3D, setFill3D], ["大血管", showVessels, setShowVessels], ["血池铸型", showCavities, setShowCavities]] as const).map(([label, checked, setter]) => <label key={label}><input type="checkbox" checked={checked} onChange={event => setter(event.target.checked)} />{t(label)}</label>)}</div>
        </fieldset>

        <fieldset disabled={!pose}><legend>{t("切面位置")}</legend><p className="free-slice-note">{t("模型绝对坐标 · +X 左 / +Y 后 / +Z 头 · mm")}</p>
          {axes.map((axis, index) => {
            const value = pose?.origin[index] ?? 0;
            const radius = Math.max(bounds.span * rangeFactor, Math.abs(value - rangeCenter[index]) * 1.1);
            return <div className={`free-slice-axis free-slice-axis-${axis.toLowerCase()}`} key={axis}><label><span>{axis}</span><NumberField label={t("自由切面 {axis} 坐标", { axis })} value={value} onChange={next => changeAxis("origin", index, next)} /><span>mm</span></label><input type="range" aria-label={t("移动自由切面 {axis} 轴", { axis })} min={rangeCenter[index] - radius} max={rangeCenter[index] + radius} step={0.1} value={value} onChange={event => changeAxis("origin", index, Number(event.target.value))} /></div>;
          })}
          <div className="free-slice-range-actions"><button type="button" onClick={() => setRangeFactor(value => value * 2)}>{t("扩大滑块范围")}</button><button type="button" onClick={() => setRangeFactor(1)}>{t("恢复滑块范围")}</button></div>
          <p className="free-slice-note">{t("数值输入不受滑块范围限制，范围会随位置扩展。")}</p>
        </fieldset>

        <fieldset disabled={!pose}><legend>{t("切面方向")}</legend><p className="free-slice-note">{t("依次绕模型 X / Y / Z 轴旋转，角度可超过一周。")}</p>
          {axes.map((axis, index) => <div className={`free-slice-axis free-slice-axis-${axis.toLowerCase()}`} key={axis}><label><span>{axis}</span><NumberField label={t("自由切面绕 {axis} 轴角度", { axis })} value={pose?.rotation[index] ?? 0} onChange={next => changeAxis("rotation", index, next)} /><span>°</span></label><input type="range" aria-label={t("旋转自由切面 {axis} 轴", { axis })} min={-180} max={180} step={1} value={wrapDegrees(pose?.rotation[index] ?? 0)} onChange={event => changeAxis("rotation", index, Number(event.target.value))} /></div>)}
          <details className="free-slice-normal"><summary>{t("直接设置法线")}</summary><div>{axes.map((axis, index) => <label key={axis}>{axis}<NumberField label={t("自由切面法线 {axis}", { axis })} value={normalDraft[index]} onChange={value => setNormalDraft(current => current.map((number, component) => component === index ? value : number) as Vec3)} /></label>)}</div><button type="button" onClick={() => {
            if (!pose || !plane) return;
            try { setPose(freePlaneFromNormal(pose.origin, normalDraft, plane.up)); setNormalError(false); } catch { setNormalError(true); }
          }}>{t("应用法线")}</button>{normalError && <p role="alert">{t("法线不能为零向量。")}</p>}</details>
        </fieldset>

        <fieldset disabled={!model || !pose}><legend>{t("起点与保存")}</legend><label className="free-slice-start">{t("以课程面为起点")}<select aria-label={t("自由切面起始参考面")} value={startId} onChange={event => {
          const preset = model?.presets.find(entry => entry.id === event.target.value);
          if (preset) { setStartId(preset.id); setPose(freePlanePose(preset)); setRangeFactor(1); }
        }}>{model?.presets.map(preset => <option key={preset.id} value={preset.id}>{t(preset.label)}</option>)}</select></label>
          <div className="free-slice-actions"><button type="button" onClick={resetPlane}>{t("复位切面")}</button><button type="button" onClick={() => { if (model && pose && plane) exportFreePlane(model, pose, plane); }}>{t("导出自由切面")}</button></div>
          <p className="free-slice-note">{t("自由调整不改写课程预设，也不改变模型形状。")}</p>
        </fieldset>
        <AnatomySources />
      </aside>
    </div>
  </section>;
}
