"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useI18n } from "@/i18n";

export function keepPanelFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  const panel = event.currentTarget;
  const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
    "a[href],button,input:not([type=hidden]),select,textarea,[tabindex]"
  )).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled")
    && !element.closest("[hidden],[inert]") && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden");
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (!first || !last) { event.preventDefault(); panel.focus(); return; }
  const current = document.activeElement;
  if (!focusable.includes(current as HTMLElement) || event.shiftKey && current === first || !event.shiftKey && current === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
  }
}

/** Expands the same pane in place: the cine component and all its state stay mounted. */
export default function ExpandableReference({ sourceSwitch, children }: {
  sourceSwitch: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const slotRef = useRef<HTMLDivElement>(null);
  const collapsedHeight = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!expanded || !panel) return;
    const disabled: { node: HTMLElement; inert: boolean }[] = [];
    const inspector = panel.closest<HTMLElement>(".anatomy-inspector");
    const previousOverflow = inspector?.style.overflowY ?? "";
    if (inspector) inspector.style.overflowY = "hidden";
    // Leave the mounted player in its original DOM position while making the rest
    // of this workspace unavailable to pointer and keyboard navigation.
    let branch: HTMLElement = panel;
    while (branch.parentElement && !branch.classList.contains("anatomy-workspace")) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.classList.contains("anatomy-reference-backdrop")) continue;
        disabled.push({ node: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
      branch = branch.parentElement;
    }
    toggleRef.current?.focus({ preventScroll: true });
    return () => {
      for (const { node, inert } of disabled) node.inert = inert;
      if (inspector) inspector.style.overflowY = previousOverflow;
      toggleRef.current?.focus({ preventScroll: true });
    };
  }, [expanded]);

  return <div className="anatomy-reference-slot" ref={slotRef} style={expanded ? { height: collapsedHeight.current } : undefined}>
    {expanded && <div className="anatomy-reference-backdrop" aria-hidden="true" onClick={() => setExpanded(false)} />}
    <section ref={panelRef} className={`anatomy-panel anatomy-reference-panel${expanded ? " is-expanded" : ""}`}
      role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined}
      aria-label={t(expanded ? "放大 CMR 对照" : "真实 CMR 对照")} tabIndex={expanded ? -1 : undefined}
      onKeyDown={(event) => {
        if (!expanded) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
        keepPanelFocus(event);
      }}>
      <header><div><span className="anatomy-eyebrow">THE MR CONNECTION</span><h3>{t("真实 CMR 对照")}</h3></div>
        <button type="button" className="anatomy-expand-section" ref={toggleRef}
          aria-label={t(expanded ? "关闭 CMR 放大" : "放大 CMR 对照")} aria-expanded={expanded}
          onClick={() => {
            if (!expanded) collapsedHeight.current = slotRef.current?.getBoundingClientRect().height ?? 0;
            setExpanded((value) => !value);
          }}>{t(expanded ? "收起" : "放大")} <span aria-hidden="true">{expanded ? "×" : "⤢"}</span></button>
      </header>
      <div className="anatomy-reference-toolbar">{sourceSwitch}</div>
      <div className="anatomy-reference-content">{children}</div>
      <p className="anatomy-reference-note">{t("静态图谱与 MR 并排比较解剖关系；两者未做空间配准。")}</p>
    </section>
  </div>;
}
