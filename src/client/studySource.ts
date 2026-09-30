import type { CmrCollection, ScalarFrame, StudyCatalog } from "@/core/types";

type BackgroundKind = "warm-selected" | "warm-other" | "prefetch";
type CacheEntry = { frame: ScalarFrame; bytes: number };
type Pending = {
  id: string;
  controller: AbortController;
  promise: Promise<ScalarFrame>;
  resolve: (frame: ScalarFrame) => void;
  reject: (error: unknown) => void;
  users: number;
  state: "queued" | "running" | "settled" | "cancelled";
  backgroundKind?: BackgroundKind;
  backgroundOwner?: object;
  sequence: number;
  countedBackground: boolean;
  countedNetwork: boolean;
};
type WarmOwner = {
  key: string;
  controller: AbortController;
  warmedFrames: number;
  promise?: Promise<void>;
};
type PrefetchOwner = { key: string };
const abortError = () => new DOMException("Request cancelled", "AbortError");
const frameBytes = (rows: number, columns: number) => rows * columns * Float32Array.BYTES_PER_ELEMENT;

/** One bounded pixel cache per imported session, shared by every presentation. */
export class BrowserStudySource {
  readonly catalog: StudyCatalog;
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Pending>();
  private bytes = 0;
  private closed = false;
  private running = 0;
  private runningBackground = 0;
  private sequence = 0;
  private pumpScheduled = false;
  private priorityOrder = new Map<string, number>();
  private lookaheadOrder = new Map<string, number>();
  private protectedFrames = new Set<string>();
  private warmOwner?: WarmOwner;
  private prefetchOwner?: PrefetchOwner;
  private warming = false;
  private warmedFrames = 0;

  constructor(catalog: StudyCatalog, private limit = 128 * 1024 * 1024) {
    this.catalog = catalog;
  }

  peek(id: string): ScalarFrame | undefined {
    const entry = this.cache.get(id);
    if (entry) {
      this.cache.delete(id);
      this.cache.set(id, entry);
    }
    return entry?.frame;
  }

  /** Frame ids are ordered from the visible active frame to other visible frames. */
  setPriorityFrames(ids: string[]): void {
    this.priorityOrder = new Map([...new Set(ids)].map((id, index) => [id, index]));
    this.lookaheadOrder.clear();
    this.protectedFrames = new Set(this.priorityOrder.keys());
    this.schedulePump();
  }

  load(id: string, signal?: AbortSignal): Promise<ScalarFrame> {
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    const cached = this.peek(id);
    if (cached) return Promise.resolve(cached);

    let entry = this.pending.get(id);
    if (!entry) {
      entry = this.createPending(id);
    } else if (entry.backgroundKind) {
      // A visible frame takes ownership of a queued warm/lookahead request.
      this.promote(entry);
    }

    const request = entry;
    request.users += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        request.users -= 1;
        if (!request.users && !request.backgroundKind) this.cancelPending(request);
        return true;
      };
      const cancel = () => {
        if (done()) reject(abortError());
      };
      signal?.addEventListener("abort", cancel, { once: true });
      request.promise.then(
        (frame) => { if (done()) resolve(frame); },
        (error) => { if (done()) reject(error); },
      );
      if (signal?.aborted) cancel();
    });
  }

  /**
   * Warm complete loops from selected Cine collections first, then other Cine
   * collections, while keeping all optional background work within 75% of cache.
   */
  warmCine(collectionIds: string[], signal?: AbortSignal): Promise<void> {
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    const selected = [...new Set(collectionIds)];
    const key = selected.join("\u0000");
    if (this.warmOwner?.key === key && !this.warmOwner.controller.signal.aborted && this.warmOwner.promise) {
      return this.warmOwner.promise;
    }

    this.cancelWarm(this.warmOwner);
    this.cancelPrefetch();
    const owner: WarmOwner = { key, controller: new AbortController(), warmedFrames: 0 };
    this.warmOwner = owner;
    this.warmedFrames = 0;
    this.warming = true;
    const abort = () => this.cancelWarm(owner);
    signal?.addEventListener("abort", abort, { once: true });

    owner.promise = this.runWarm(owner, selected).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (this.warmOwner === owner) this.warming = false;
    });
    return owner.promise;
  }

  private async runWarm(owner: WarmOwner, selectedIds: string[]): Promise<void> {
    const selected = selectedIds
      .map((id) => this.catalog.collections.find((collection) => collection.id === id))
      .filter((collection): collection is CmrCollection => collection?.kind === "cine");
    const selectedSet = new Set(selected.map((collection) => collection.id));
    const remaining = this.catalog.collections.filter(
      (collection) => collection.kind === "cine" && !selectedSet.has(collection.id),
    );
    const collections = [
      ...selected.map((collection) => ({ collection, kind: "warm-selected" as const })),
      ...remaining.map((collection) => ({ collection, kind: "warm-other" as const })),
    ];
    const budget = Math.max(0, Math.floor(this.limit * 0.75));
    let reserved = 0;
    const jobs: Pending[] = [];
    const seen = new Set<string>();

    for (const { collection, kind } of collections) {
      const priorityPlanes = collection.planes
        .map((plane, index) => ({
          plane,
          index,
          rank: plane.frameIds.reduce((rank, id) => id
            ? Math.min(rank, this.priorityOrder.get(id) ?? Number.MAX_SAFE_INTEGER)
            : rank, Number.MAX_SAFE_INTEGER),
        }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index);
      for (const { plane } of priorityPlanes) {
        if (owner.controller.signal.aborted || this.closed) throw abortError();
        const loopIds = [...new Set(plane.frameIds.filter((id): id is string => !!id))]
          .filter((id) => !seen.has(id));
        loopIds.forEach((id) => seen.add(id));
        if (!loopIds.length) continue;

        let loopBytes = 0;
        let completeLoop = true;
        for (const id of loopIds) {
          const descriptor = this.catalog.frames[id];
          if (!descriptor) {
            completeLoop = false;
            break;
          }
          // Charge the whole loop even when some frames are already cached or pending.
          loopBytes += frameBytes(descriptor.rows, descriptor.columns);
        }
        // Admit complete plane loops only. This avoids warming a partial cycle.
        if (!completeLoop || reserved + loopBytes > budget) continue;
        reserved += loopBytes;

        for (const id of loopIds) {
          if (this.cache.has(id)) continue;
          const existing = this.pending.get(id);
          if (existing) {
            if (existing.backgroundKind) {
              existing.backgroundOwner = owner;
              if (kind === "warm-selected") existing.backgroundKind = kind;
            }
            jobs.push(existing);
            continue;
          }
          if (!this.catalog.frames[id]) continue;
          const job = this.createPending(id, kind, owner);
          jobs.push(job);
        }
      }
    }

    let rejectOnAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => reject(abortError());
      owner.controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      if (owner.controller.signal.aborted) rejectOnAbort();
    });
    try {
      await Promise.race([Promise.allSettled(jobs.map((job) => job.promise)), aborted]);
    } finally {
      owner.controller.signal.removeEventListener("abort", rejectOnAbort);
    }
    if (owner.controller.signal.aborted || this.closed) throw abortError();
  }

  /** Bounded lookahead; stale work is cancelled whenever the requested set changes. */
  prefetch(ids: string[]): void {
    if (this.closed) return;
    const unique = [...new Set(ids)].slice(0, 32);
    const key = unique.join("\u0000");
    if (this.prefetchOwner?.key === key) {
      this.lookaheadOrder = new Map(unique.map((id, index) => [id, index]));
      return;
    }
    this.cancelPrefetch();
    this.lookaheadOrder = new Map(unique.map((id, index) => [id, index]));
    if (!unique.length) return;

    const owner: PrefetchOwner = { key };
    this.prefetchOwner = owner;
    const budget = Math.max(0, Math.min(this.limit * 0.1, 16 * 1024 * 1024));
    let reserved = 0;
    for (const id of unique) {
      if (this.cache.has(id)) continue;
      const existing = this.pending.get(id);
      if (existing) continue;
      const descriptor = this.catalog.frames[id];
      if (!descriptor) continue;
      const size = frameBytes(descriptor.rows, descriptor.columns);
      if (reserved + size > budget) continue;
      reserved += size;
      this.createPending(id, "prefetch", owner);
    }
  }

  private createPending(id: string, backgroundKind?: BackgroundKind, backgroundOwner?: object): Pending {
    let resolve!: (frame: ScalarFrame) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ScalarFrame>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    if (backgroundKind) void promise.catch(() => {});
    const entry: Pending = {
      id,
      controller: new AbortController(),
      promise,
      resolve,
      reject,
      users: 0,
      state: "queued",
      backgroundKind,
      backgroundOwner,
      sequence: this.sequence++,
      countedBackground: false,
      countedNetwork: false,
    };
    this.pending.set(id, entry);
    this.schedulePump();
    return entry;
  }

  private promote(entry: Pending): void {
    if (!entry.backgroundKind) return;
    entry.backgroundKind = undefined;
    entry.backgroundOwner = undefined;
    if (entry.countedBackground) {
      entry.countedBackground = false;
      this.runningBackground -= 1;
    }
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.closed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private priority(entry: Pending): number {
    if (!entry.backgroundKind) return 0;
    if (this.priorityOrder.has(entry.id)) return 1;
    if (this.lookaheadOrder.has(entry.id)) return 2;
    if (entry.backgroundKind === "warm-selected") return 3;
    if (entry.backgroundKind === "warm-other") return 4;
    return 5;
  }

  private comparePending(a: Pending, b: Pending): number {
    const classOrder = this.priority(a) - this.priority(b);
    if (classOrder) return classOrder;
    const aLookahead = this.lookaheadOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bLookahead = this.lookaheadOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (aLookahead !== bLookahead) return aLookahead - bLookahead;
    const aRank = this.priorityOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bRank = this.priorityOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank || a.sequence - b.sequence;
  }

  private pump(): void {
    while (!this.closed && this.running < 6) {
      const queued = [...this.pending.values()].filter((entry) => entry.state === "queued");
      const foreground = queued.filter((entry) => !entry.backgroundKind).sort((a, b) => this.comparePending(a, b));
      const background = queued.filter((entry) => !!entry.backgroundKind).sort((a, b) => this.comparePending(a, b));
      const entry = foreground[0] ?? (this.runningBackground < 2 ? background[0] : undefined);
      if (!entry) return;

      entry.state = "running";
      entry.countedNetwork = true;
      this.running += 1;
      if (entry.backgroundKind) {
        entry.countedBackground = true;
        this.runningBackground += 1;
      }
      void this.run(entry);
    }
  }

  private async run(entry: Pending): Promise<void> {
    try {
      if (entry.controller.signal.aborted || this.closed) throw abortError();
      const descriptor = this.catalog.frames[entry.id];
      if (!descriptor) throw new Error("目录中不存在这张影像");
      const response = await fetch(
        "/api/studies/" + encodeURIComponent(this.catalog.id) + "/frames/" + encodeURIComponent(entry.id),
        { signal: entry.controller.signal, cache: "no-store" },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.message ?? "读取影像失败 (" + response.status + ")");
      }
      const data = await response.arrayBuffer();
      if (data.byteLength !== frameBytes(descriptor.rows, descriptor.columns)) {
        throw new Error("影像像素长度与目录不一致");
      }
      const frame = { descriptor, pixels: new Float32Array(data) };
      if (entry.state === "cancelled" || entry.controller.signal.aborted || this.closed) throw abortError();
      this.storeFrame(entry.id, frame);
      if (entry.backgroundOwner === this.warmOwner && this.warmOwner) {
        this.warmOwner.warmedFrames += 1;
        this.warmedFrames = this.warmOwner.warmedFrames;
      }
      entry.resolve(frame);
    } catch (error) {
      entry.reject(error);
    } finally {
      if (entry.countedNetwork) {
        entry.countedNetwork = false;
        this.running -= 1;
      }
      if (entry.countedBackground) {
        entry.countedBackground = false;
        this.runningBackground -= 1;
      }
      if (entry.state !== "cancelled") entry.state = "settled";
      if (this.pending.get(entry.id) === entry) this.pending.delete(entry.id);
      this.schedulePump();
    }
  }

  private storeFrame(id: string, frame: ScalarFrame): void {
    const size = frame.pixels.byteLength;
    if (size > this.limit || this.cache.has(id)) return;
    while (this.bytes + size > this.limit) {
      const key = [...this.cache.keys()].find((candidate) => !this.protectedFrames.has(candidate));
      if (!key) return;
      const removed = this.cache.get(key)!;
      this.bytes -= removed.bytes;
      this.cache.delete(key);
    }
    this.cache.set(id, { frame, bytes: size });
    this.bytes += size;
  }

  private cancelPending(entry: Pending): void {
    if (entry.state === "settled" || entry.state === "cancelled") return;
    if (this.pending.get(entry.id) === entry) this.pending.delete(entry.id);
    const wasQueued = entry.state === "queued";
    entry.state = "cancelled";
    entry.controller.abort();
    entry.reject(abortError());
    if (wasQueued) this.schedulePump();
  }

  private cancelWarm(owner?: WarmOwner): void {
    if (!owner) return;
    owner.controller.abort();
    for (const entry of this.pending.values()) {
      if (entry.backgroundOwner === owner && !entry.users) this.cancelPending(entry);
    }
    if (this.warmOwner === owner) this.warming = false;
  }

  private cancelPrefetch(): void {
    const owner = this.prefetchOwner;
    if (!owner) return;
    this.prefetchOwner = undefined;
    for (const entry of this.pending.values()) {
      if (entry.backgroundOwner === owner && !entry.users) this.cancelPending(entry);
    }
  }

  stats() {
    return {
      cachedFrames: this.cache.size,
      bytes: this.bytes,
      requests: this.pending.size,
      warming: this.warming,
      warmedFrames: this.warmedFrames,
    };
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelWarm(this.warmOwner);
    this.cancelPrefetch();
    for (const entry of [...this.pending.values()]) this.cancelPending(entry);
    this.pending.clear();
    this.cache.clear();
    this.bytes = 0;
    this.protectedFrames.clear();
    this.priorityOrder.clear();
    this.lookaheadOrder.clear();
    this.warming = false;
    this.warmedFrames = 0;
  }
}

export function uploadStudy(files: File[], onProgress: (fraction: number) => void, signal: AbortSignal): Promise<StudyCatalog> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const form = new FormData();
    for (const file of files) form.append("files", file);
    request.open("POST", "/api/studies");
    request.responseType = "json";
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    const abort = () => request.abort();
    const clean = () => signal.removeEventListener("abort", abort);
    request.onload = () => {
      clean();
      if (request.status >= 200 && request.status < 300 && request.response?.collections) resolve(request.response);
      else reject(new Error(request.response?.message ?? "导入失败，请检查文件格式和本机服务"));
    };
    request.onerror = () => { clean(); reject(new Error("无法连接本机影像服务")); };
    request.onabort = () => { clean(); reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { clean(); reject(abortError()); return; }
    request.send(form);
  });
}

export async function releaseStudy(id: string) {
  await fetch("/api/studies/" + encodeURIComponent(id), { method: "DELETE", keepalive: true }).catch(() => {});
}
