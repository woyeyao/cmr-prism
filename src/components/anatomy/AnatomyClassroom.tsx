"use client";

import { useState } from "react";
import { useI18n } from "@/i18n";
import AnatomyWorkspace, { type AnatomyWorkspaceProps } from "./AnatomyWorkspace";
import FreeSliceWorkspace from "./FreeSliceWorkspace";
import "./classroom.css";

/** Shared classroom entry for the full local app and the public static site. */
export default function AnatomyClassroom(props: AnatomyWorkspaceProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"course" | "free">("course");
  const actions = <>
    <div className="classroom-modes" role="group" aria-label={t("课堂模式")}>
      <button type="button" data-testid="classroom-course" aria-pressed={mode === "course"} onClick={() => setMode("course")}>{t("课程切面")}</button>
      <button type="button" data-testid="classroom-free" aria-pressed={mode === "free"} onClick={() => setMode("free")}>{t("自由切面")}</button>
    </div>
    {props.headerActions}
  </>;
  return mode === "course"
    ? <AnatomyWorkspace {...props} headerActions={actions} />
    : <FreeSliceWorkspace theme={props.theme} headerActions={actions} />;
}
