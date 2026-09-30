"use client";

import { useEffect, useState } from "react";
import type { ScalarFrame } from "@/core/types";
import type { BrowserStudySource } from "./studySource";

export type FrameEntry = { frame: ScalarFrame | null; loading: boolean; error?: string };

export function useFrames(source: BrowserStudySource | null, frameIds: string[]): Record<string, FrameEntry> {
  const key = JSON.stringify([...new Set(frameIds)].sort());
  const ids = JSON.parse(key) as string[];
  const [result, setResult] = useState<{
    source: BrowserStudySource | null;
    key: string;
    entries: Record<string, FrameEntry>;
  }>({ source: null, key: "", entries: {} });

  useEffect(() => {
    const controller = new AbortController();
    const entries: Record<string, FrameEntry> = {};
    const batched: Record<string, FrameEntry> = {};
    let animationFrame: number | undefined;
    let microtaskQueued = false;

    for (const id of ids) {
      const frame = source?.peek(id) ?? null;
      entries[id] = { frame, loading: !frame };
    }

    const cleanup = () => {
      controller.abort();
      if (animationFrame !== undefined && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(animationFrame);
      }
      for (const id of Object.keys(batched)) delete batched[id];
    };

    // Render already returned these cache hits synchronously; avoid a redundant
    // state update on every playback tick when all requested frames are ready.
    if (!source || ids.every((id) => !!entries[id].frame)) return cleanup;
    setResult({ source, key, entries });

    const flush = () => {
      animationFrame = undefined;
      microtaskQueued = false;
      if (controller.signal.aborted) return;
      const updates = { ...batched };
      for (const id of Object.keys(batched)) delete batched[id];
      if (!Object.keys(updates).length) return;
      setResult((previous) =>
        previous.source === source && previous.key === key
          ? { ...previous, entries: { ...previous.entries, ...updates } }
          : previous,
      );
    };

    const scheduleFlush = () => {
      if (animationFrame !== undefined || microtaskQueued) return;
      if (typeof requestAnimationFrame === "function") {
        animationFrame = requestAnimationFrame(flush);
      } else {
        microtaskQueued = true;
        queueMicrotask(flush);
      }
    };

    for (const id of ids) {
      if (entries[id].frame) continue;
      void source.load(id, controller.signal).then(
        (frame) => {
          if (controller.signal.aborted) return;
          batched[id] = { frame, loading: false };
          scheduleFlush();
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          batched[id] = {
            frame: null,
            loading: false,
            error: error instanceof Error ? error.message : "读取影像失败",
          };
          scheduleFlush();
        },
      );
    }

    return cleanup;
  }, [source, key]);

  // Read the cache during render so an already-loaded frame is never painted as
  // loading for one effect cycle after navigation or a presentation change.
  const entries: Record<string, FrameEntry> = {};
  for (const id of ids) {
    const cached = source?.peek(id);
    if (cached) {
      entries[id] = { frame: cached, loading: false };
    } else if (result.source === source && result.key === key && result.entries[id]) {
      entries[id] = result.entries[id];
    } else {
      entries[id] = { frame: null, loading: !!source };
    }
  }
  return entries;
}