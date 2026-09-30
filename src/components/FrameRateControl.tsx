"use client";

import { useEffect, useState } from "react";

export default function FrameRateControl({ value, onChange }: { value: number; onChange: (fps: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    const next = draft.trim() && Number.isFinite(parsed) ? Math.max(1, Math.min(60, Math.round(parsed))) : value;
    setDraft(String(next));
    onChange(next);
  };
  return <label className="fps-control" title="输入1–60 fps；实际播放速度取决于加载与绘制速度">
    <input type="number" min={1} max={60} step={1} aria-label="播放帧率" value={draft} onChange={(event) => {
      const text = event.target.value;
      setDraft(text);
      const next = Number(text);
      if (text.trim() && Number.isInteger(next) && next >= 1 && next <= 60) onChange(next);
    }} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <span>fps</span>
  </label>;
}
