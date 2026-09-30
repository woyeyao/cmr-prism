import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CmrCollection, FrameDescriptor, StudyCatalog } from "@/core/types";
import { BrowserStudySource } from "./studySource";
import { useFrames } from "./useFrames";

type FetchRequest = {
  url: string;
  signal?: AbortSignal;
  settled: boolean;
  resolve: (response: Response) => void;
  reject: (error: DOMException) => void;
};

function descriptor(id: string): FrameDescriptor {
  return {
    id,
    instanceId: "instance-" + id,
    frameNumber: 1,
    studyUid: "study-uid",
    seriesId: "series-uid",
    seriesDescription: "SAX Cine",
    imageType: ["ORIGINAL", "PRIMARY"],
    rows: 2,
    columns: 2,
    photometric: "MONOCHROME2",
    parameters: {},
    rescaleSlope: 1,
    rescaleIntercept: 0,
  };
}

function cineCollection(id: string, loops: string[][], kind: CmrCollection["kind"] = "cine"): CmrCollection {
  return {
    id,
    studyUid: "study-uid",
    label: id,
    view: "SAX",
    kind,
    axisKind: "cardiac",
    axisLabel: "phase",
    sourceSeriesIds: [id],
    planes: loops.map((frameIds, index) => ({
      id: id + "-plane-" + index,
      positionMm: index,
      frameIds,
      phases: frameIds.map((_, phase) => phase),
    })),
    phaseMatching: "measured",
    defaultWindow: { center: 0, width: 1 },
    warnings: [],
  };
}

function catalog(ids: string[], collections: CmrCollection[] = []): StudyCatalog {
  return {
    id: "local-study",
    collections,
    frames: Object.fromEntries(ids.map((id) => [id, descriptor(id)])),
    report: { acceptedInstances: ids.length, acceptedFrames: ids.length, skippedObjects: 0, failedFiles: 0, warnings: [] },
  };
}

function okResponse(values: number[]): Response {
  const pixels = new Float32Array(values);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => pixels.buffer,
  } as Response;
}

function failedResponse(status = 500): Response {
  return {
    ok: false,
    status,
    json: async () => ({ message: "optional frame failed" }),
  } as Response;
}

function controlledFetch() {
  const requests: FetchRequest[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const request: FetchRequest = {
        url: String(input),
        signal: init?.signal ?? undefined,
        settled: false,
        resolve: (response) => {
          request.settled = true;
          resolve(response);
        },
        reject: (error) => {
          request.settled = true;
          reject(error);
        },
      };
      requests.push(request);
      init?.signal?.addEventListener(
        "abort",
        () => request.reject(new DOMException("Request cancelled", "AbortError")),
        { once: true },
      );
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function completeRequest(requests: FetchRequest[], index: number, values: number[]) {
  await flushMicrotasks();
  const request = requests[index];
  if (!request) throw new Error("Expected a frame request at index " + index);
  request.resolve(okResponse(values));
  await flushMicrotasks();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BrowserStudySource frame requests", () => {
  it("rejects pixel buffers whose byte length does not match the catalog", async () => {
    const { requests } = controlledFetch();
    const source = new BrowserStudySource(catalog(["frame-1"]));
    const loading = source.load("frame-1");
    await flushMicrotasks();
    requests[0].resolve(okResponse([1, 2, 3]));

    await expect(loading).rejects.toThrow("影像像素长度与目录不一致");
    expect(source.stats()).toEqual({
      cachedFrames: 0, bytes: 0, requests: 0, warming: false, warmedFrames: 0,
    });
  });

  it("deduplicates concurrent loads and shares the decoded frame", async () => {
    const { requests, fetchMock } = controlledFetch();
    const source = new BrowserStudySource(catalog(["frame-1"]));
    const first = source.load("frame-1");
    const second = source.load("frame-1");
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await completeRequest(requests, 0, [1, 2, 3, 4]);
    const [frameA, frameB] = await Promise.all([first, second]);

    expect(frameA).toBe(frameB);
    expect(Array.from(frameA.pixels)).toEqual([1, 2, 3, 4]);
    expect(source.stats()).toEqual({
      cachedFrames: 1, bytes: 16, requests: 0, warming: false, warmedFrames: 0,
    });
  });

  it("cancels only the requesting subscriber while another subscriber is waiting", async () => {
    const { requests, fetchMock } = controlledFetch();
    const source = new BrowserStudySource(catalog(["frame-1"]));
    const abandoned = new AbortController();
    const stillInterested = new AbortController();
    const first = source.load("frame-1", abandoned.signal);
    const second = source.load("frame-1", stillInterested.signal);
    const firstRejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();

    abandoned.abort();
    await firstRejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests[0].signal?.aborted).toBe(false);

    await completeRequest(requests, 0, [4, 3, 2, 1]);
    expect(Array.from((await second).pixels)).toEqual([4, 3, 2, 1]);
    expect(source.stats().cachedFrames).toBe(1);
  });

  it("evicts the least recently used frame to stay within the byte limit", async () => {
    const { requests } = controlledFetch();
    const source = new BrowserStudySource(catalog(["a", "b", "c"]), 32);

    const a = source.load("a");
    await completeRequest(requests, 0, [1, 1, 1, 1]);
    await a;
    const b = source.load("b");
    await completeRequest(requests, 1, [2, 2, 2, 2]);
    await b;
    expect(source.stats().bytes).toBe(32);

    expect(source.peek("a")).toBeDefined();
    const c = source.load("c");
    await completeRequest(requests, 2, [3, 3, 3, 3]);
    await c;

    expect(source.peek("a")).toBeDefined();
    expect(source.peek("b")).toBeUndefined();
    expect(source.peek("c")).toBeDefined();
    expect(source.stats().bytes).toBe(32);
  });

  it("lets foreground loads overtake queued warm work and caps warm concurrency at two", async () => {
    const ids = ["warm-1", "warm-2", "warm-3", "active-1", "active-2", "active-3", "active-4", "active-5"];
    const { requests } = controlledFetch();
    const source = new BrowserStudySource(catalog(ids, [
      cineCollection("selected", [["warm-1", "warm-2", "warm-3"]]),
    ]));

    const warm = source.warmCine(["selected"]);
    await flushMicrotasks();
    expect(requests.map((request) => request.url)).toHaveLength(2);
    expect(requests.every((request) => request.url.includes("warm-"))).toBe(true);

    const foreground = ids.slice(3).map((id) => source.load(id));
    await flushMicrotasks();
    expect(requests).toHaveLength(6);

    await completeRequest(requests, 2, [1, 1, 1, 1]);
    await flushMicrotasks();
    expect(requests).toHaveLength(7);
    expect(requests[6].url).toContain("active-5");
    expect(requests.some((request) => request.url.includes("warm-3"))).toBe(false);

    for (let index = 0; index < requests.length; index += 1) {
      if (!requests[index].settled) await completeRequest(requests, index, [2, 2, 2, 2]);
    }
    await Promise.all([warm, ...foreground]);
    expect(requests.filter((request) => request.url.includes("warm-"))).toHaveLength(3);
    expect(source.stats().warming).toBe(false);
  });

  it("admits the active plane loop before earlier catalog planes", async () => {
    const ids = ["cold-1", "cold-2", "cold-3", "active-1", "active-2", "active-3"];
    const { requests } = controlledFetch();
    const source = new BrowserStudySource(catalog(ids, [
      cineCollection("selected", [["cold-1", "cold-2", "cold-3"], ["active-1", "active-2", "active-3"]]),
    ]), 64);
    source.setPriorityFrames(["active-1"]);

    const warm = source.warmCine(["selected"]);
    await flushMicrotasks();
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.url.includes("active-"))).toBe(true);
    await completeRequest(requests, 0, [1, 1, 1, 1]);
    await completeRequest(requests, 1, [1, 1, 1, 1]);
    await flushMicrotasks();
    expect(requests).toHaveLength(3);
    expect(requests[2].url).toContain("active-3");
    await completeRequest(requests, 2, [1, 1, 1, 1]);
    await warm;

    expect(source.peek("active-1")).toBeDefined();
    expect(source.peek("active-2")).toBeDefined();
    expect(source.peek("active-3")).toBeDefined();
    expect(source.peek("cold-1")).toBeUndefined();
  });

  it("moves a queued warm frame forward for lookahead without taking warm ownership", async () => {
    const ids = ["current-1", "current-2", "current-3", "ordinary-1", "ordinary-2", "lookahead", "lookahead-2"];
    const { requests } = controlledFetch();
    const source = new BrowserStudySource(catalog(ids, [
      cineCollection("selected", [["current-1", "current-2", "current-3"], ["ordinary-1", "ordinary-2"], ["lookahead", "lookahead-2"]]),
    ]));
    source.setPriorityFrames(["current-1"]);

    const warm = source.warmCine(["selected"]);
    await flushMicrotasks();
    expect(requests).toHaveLength(2);
    source.prefetch(["lookahead"]);
    expect(requests).toHaveLength(2);

    await completeRequest(requests, 0, [1, 1, 1, 1]);
    await flushMicrotasks();
    expect(requests).toHaveLength(3);
    expect(requests[2].url).toContain("lookahead");
    source.prefetch([]);
    expect(requests[2].signal?.aborted).toBe(false);

    for (let index = 0; index < requests.length; index += 1) {
      if (!requests[index].settled) await completeRequest(requests, index, [2, 2, 2, 2]);
    }
    await warm;
    expect(requests.filter((request) => request.url.endsWith("/lookahead")).length).toBe(1);
  });
  it("charges cached loops against the warm budget after a collection switch", async () => {
    const ids = ["a-1", "a-2", "b-1", "b-2", "c-1"];
    const { requests, fetchMock } = controlledFetch();
    const source = new BrowserStudySource(catalog(ids, [
      cineCollection("a", [["a-1", "a-2"]]),
      cineCollection("b", [["b-1", "b-2"]]),
      cineCollection("c", [["c-1"]]),
    ]), 64);

    const firstWarm = source.warmCine(["a"]);
    await flushMicrotasks();
    expect(requests).toHaveLength(2);
    await completeRequest(requests, 0, [1, 1, 1, 1]);
    await completeRequest(requests, 1, [1, 1, 1, 1]);
    await flushMicrotasks();
    expect(requests).toHaveLength(3);
    await completeRequest(requests, 2, [1, 1, 1, 1]);
    await firstWarm;

    const switchedWarm = source.warmCine(["c"]);
    await switchedWarm;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(source.peek("a-1")).toBeDefined();
    expect(source.peek("a-2")).toBeDefined();
    expect(source.peek("c-1")).toBeDefined();
    expect(source.peek("b-1")).toBeUndefined();
    expect(source.stats().bytes).toBe(48);
  });
  it("keeps priority frames while Cine warming stays within 75 percent of cache", async () => {
    const ids = ["active-1", "active-2", "selected-1", "selected-2", "other-1", "other-2"];
    const { requests } = controlledFetch();
    const source = new BrowserStudySource(catalog(ids, [
      cineCollection("selected", [["selected-1", "selected-2"]]),
      cineCollection("other", [["other-1"], ["other-2"]]),
    ]), 64);

    source.setPriorityFrames(["active-1", "active-2"]);
    const active = [source.load("active-1"), source.load("active-2")];
    await flushMicrotasks();
    await completeRequest(requests, 0, [1, 1, 1, 1]);
    await completeRequest(requests, 1, [1, 1, 1, 1]);
    await Promise.all(active);

    const warm = source.warmCine(["selected"]);
    await flushMicrotasks();
    expect(requests).toHaveLength(4);
    await completeRequest(requests, 2, [2, 2, 2, 2]);
    await completeRequest(requests, 3, [2, 2, 2, 2]);
    await flushMicrotasks();
    expect(requests).toHaveLength(5);
    expect(requests[4].url).toContain("other-1");
    requests[4].resolve(failedResponse());
    await warm;

    expect(source.peek("active-1")).toBeDefined();
    expect(source.peek("active-2")).toBeDefined();
    expect(source.peek("other-2")).toBeUndefined();
    expect(source.stats()).toEqual({
      cachedFrames: 4, bytes: 64, requests: 0, warming: false, warmedFrames: 2,
    });
  });

  it("aborts queued and active warm work when the warm signal is cancelled", async () => {
    const { requests } = controlledFetch();
    const source = new BrowserStudySource(catalog(["active", "warm-1", "warm-2", "warm-3"], [
      cineCollection("selected", [["warm-1", "warm-2", "warm-3"]]),
    ]));
    const controller = new AbortController();
    const warm = source.warmCine(["selected"], controller.signal);
    const warmRejection = expect(warm).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    const foreground = source.load("active");
    await flushMicrotasks();
    expect(requests).toHaveLength(3);

    controller.abort();
    await warmRejection;
    await flushMicrotasks();
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].signal?.aborted).toBe(true);
    expect(requests.some((request) => request.url.includes("warm-3"))).toBe(false);
    expect(requests[2].signal?.aborted).toBe(false);

    await completeRequest(requests, 2, [9, 8, 7, 6]);
    expect(Array.from((await foreground).pixels)).toEqual([9, 8, 7, 6]);
  });

  it("cancels the previous background selection when Cine collections change", async () => {
    const ids = ["first-1", "first-2", "first-3", "second-1", "second-2", "second-3"];
    const { requests } = controlledFetch();
    const source = new BrowserStudySource(catalog(ids, [
      cineCollection("first", [["first-1", "first-2", "first-3"]]),
      cineCollection("second", [["second-1", "second-2", "second-3"]]),
    ]));
    const firstWarm = source.warmCine(["first"]);
    const firstRejection = expect(firstWarm).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    expect(requests).toHaveLength(2);

    const secondWarm = source.warmCine(["second"]);
    await firstRejection;
    await flushMicrotasks();
    expect(requests.slice(0, 2).every((request) => request.signal?.aborted)).toBe(true);
    expect(requests.some((request) => request.url.includes("first-3"))).toBe(false);
    expect(requests.some((request) => request.url.includes("second-"))).toBe(true);

    for (let index = 0; index < requests.length; index += 1) {
      if (!requests[index].settled) await completeRequest(requests, index, [2, 2, 2, 2]);
    }
    await secondWarm;
  });
  it("returns a cached frame from the first useFrames render", async () => {
    const { requests } = controlledFetch();
    const source = new BrowserStudySource(catalog(["cached"]));
    const loading = source.load("cached");
    await flushMicrotasks();
    await completeRequest(requests, 0, [17, 2, 3, 4]);
    await loading;

    function Probe() {
      const entries = useFrames(source, ["cached"]);
      return createElement("span", null, entries.cached?.frame?.pixels[0] ?? "loading");
    }

    expect(renderToString(createElement(Probe))).toContain(">17</span>");
  });

  it("disposes queued and active warm work along with foreground requests", async () => {
    const { requests } = controlledFetch();
    const ids = ["pending", "warm-1", "warm-2", "warm-3"];
    const source = new BrowserStudySource(catalog(ids, [cineCollection("cine", [["warm-1", "warm-2", "warm-3"]])]));
    const pending = source.load("pending");
    const pendingRejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const warm = source.warmCine(["cine"]);
    const warmRejection = expect(warm).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    expect(requests).toHaveLength(3);

    source.dispose();
    await Promise.all([pendingRejection, warmRejection]);
    await flushMicrotasks();

    expect(requests.every((request) => request.signal?.aborted)).toBe(true);
    expect(requests.some((request) => request.url.includes("warm-3"))).toBe(false);
    expect(source.stats()).toEqual({
      cachedFrames: 0, bytes: 0, requests: 0, warming: false, warmedFrames: 0,
    });
  });
  it("aborts pending requests, clears cache accounting, and rejects later loads on dispose", async () => {
    const { requests, fetchMock } = controlledFetch();
    const source = new BrowserStudySource(catalog(["cached", "pending"]));
    const cachedLoad = source.load("cached");
    await completeRequest(requests, 0, [1, 1, 1, 1]);
    await cachedLoad;

    const pendingLoad = source.load("pending");
    const pendingRejection = expect(pendingLoad).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    expect(source.stats()).toEqual({
      cachedFrames: 1, bytes: 16, requests: 1, warming: false, warmedFrames: 0,
    });

    source.dispose();
    await pendingRejection;

    expect(requests[1].signal?.aborted).toBe(true);
    expect(source.stats()).toEqual({
      cachedFrames: 0, bytes: 0, requests: 0, warming: false, warmedFrames: 0,
    });
    await expect(source.load("pending")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
