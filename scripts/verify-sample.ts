import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import dcmjs from "dcmjs";
import { readImageNode } from "@itk-wasm/image-io";
import type { FrameDescriptor } from "../src/core/types";
import { disposeStudy, importStudyPaths, readScalarFrame } from "../src/server/studySource";

type Dataset = Record<string, unknown>;
const dcm = dcmjs as unknown as {
  data: {
    DicomMessage: { readFile(bytes: ArrayBuffer): { dict: unknown; meta?: unknown } };
    DicomMetaDictionary: { naturalizeDataset(dataset: unknown): Dataset };
  };
};
const uncompressedSyntaxes = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"]);

function scalar(value: unknown): string | number | undefined {
  const item = Array.isArray(value) ? value[0] : value;
  if (typeof item === "number" || typeof item === "string") return item;
  return undefined;
}

function matchesItkGeometry(image: Awaited<ReturnType<typeof readImageNode>>, frame: FrameDescriptor): boolean {
  const geometry = frame.geometry;
  if (!geometry || image.imageType.dimension !== 3 || image.size.length !== 3
    || image.size[0] !== frame.columns || image.size[1] !== frame.rows || image.size[2] !== 1
    || image.origin.length !== 3 || image.spacing.length !== 3 || image.direction.length !== 9) return false;
  const row = geometry.rowCosines;
  const column = geometry.columnCosines;
  const normal = [
    row[1] * column[2] - row[2] * column[1],
    row[2] * column[0] - row[0] * column[2],
    row[0] * column[1] - row[1] * column[0]
  ];
  const close = (actual: unknown, expected: number, tolerance: number): boolean => {
    const numeric = typeof actual === "number" || typeof actual === "bigint" ? Number(actual) : NaN;
    return Number.isFinite(numeric) && Math.abs(numeric - expected) <= tolerance;
  };
  return geometry.origin.every((coordinate, index) => close(image.origin[index], coordinate, 0.05))
    && close(image.spacing[0], geometry.pixelSpacing[1], 1e-4)
    && close(image.spacing[1], geometry.pixelSpacing[0], 1e-4)
    && (geometry.thickness <= 0 || close(image.spacing[2], geometry.thickness, 0.05))
    && [
      [image.direction[0], row[0]], [image.direction[3], row[1]], [image.direction[6], row[2]],
      [image.direction[1], column[0]], [image.direction[4], column[1]], [image.direction[7], column[2]],
      [image.direction[2], normal[0]], [image.direction[5], normal[1]], [image.direction[8], normal[2]]
    ].every(([actual, expected]) => close(actual, Number(expected), 1e-4));
}

async function findRescaledClassicSample(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      const input = await readFile(path);
      const bytes = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
      const parsed = dcm.data.DicomMessage.readFile(bytes);
      const dataset = dcm.data.DicomMetaDictionary.naturalizeDataset(parsed.dict);
      const meta = dcm.data.DicomMetaDictionary.naturalizeDataset(parsed.meta ?? {});
      const slope = Number(scalar(dataset.RescaleSlope) ?? 1);
      const intercept = Number(scalar(dataset.RescaleIntercept) ?? 0);
      if (scalar(dataset.Modality)?.toString().toUpperCase() !== "MR"
        || scalar(dataset.PhotometricInterpretation)?.toString().toUpperCase() !== "MONOCHROME2"
        || Number(scalar(dataset.NumberOfFrames) ?? 1) !== 1
        || !uncompressedSyntaxes.has(String(scalar(meta.TransferSyntaxUID) ?? "1.2.840.10008.1.2.1"))
        || (slope === 1 && intercept === 0)) continue;
      return path;
    } catch {
      // Non-DICOM and unsupported sample objects are already counted by the importer.
    }
  }
  return undefined;
}

async function compareNativeAndItk(path: string): Promise<{
  samples: number;
  maxOrderedAbsoluteDelta: number;
  itkDimension: number;
  itkSize: number[];
  geometryMatched: boolean;
  orderedPixelsMatched: boolean;
  verified: boolean;
}> {
  const catalog = await importStudyPaths([path]);
  try {
    const frameId = Object.keys(catalog.frames)[0];
    if (!frameId) throw new Error("Rescale comparison frame is missing.");
    const frame = catalog.frames[frameId];
    const nativePixels = await readScalarFrame(catalog.id, frameId);
    const itkImage = await readImageNode(path);
    const itkPixels = itkImage.data;
    if (!itkPixels || itkImage.imageType.components !== 1 || itkPixels.length !== nativePixels.length) {
      return {
        samples: nativePixels.length,
        maxOrderedAbsoluteDelta: Number.POSITIVE_INFINITY,
        itkDimension: itkImage.imageType.dimension,
        itkSize: itkImage.size,
        geometryMatched: false,
        orderedPixelsMatched: false,
        verified: false
      };
    }
    const itkValues = itkPixels as unknown as ArrayLike<number | bigint>;
    let maxOrderedAbsoluteDelta = 0;
    let orderedPixelsMatched = true;
    for (let index = 0; index < nativePixels.length; index += 1) {
      const delta = Math.abs(Number(nativePixels[index]) - Number(itkValues[index]));
      maxOrderedAbsoluteDelta = Math.max(maxOrderedAbsoluteDelta, delta);
      if (delta > Math.max(1e-3, Math.abs(nativePixels[index]) * 1e-6)) orderedPixelsMatched = false;
    }
    const geometryMatched = matchesItkGeometry(itkImage, frame);
    return {
      samples: nativePixels.length,
      maxOrderedAbsoluteDelta,
      itkDimension: itkImage.imageType.dimension,
      itkSize: itkImage.size,
      geometryMatched,
      orderedPixelsMatched,
      verified: geometryMatched && orderedPixelsMatched
    };
  } finally {
    await disposeStudy(catalog.id);
  }
}

const sampleDirectory = resolve(process.cwd(), "..", "cmr-eg");
const entries = await readdir(sampleDirectory, { withFileTypes: true });
const files = await Promise.all(entries
  .filter((entry) => entry.isFile())
  .map((entry) => join(sampleDirectory, entry.name)));
if (files.length === 0) throw new Error("cmr-eg 没有可检查的文件。");

const totalBytes = (await Promise.all(files.map((path) => stat(path)))).reduce((sum, item) => sum + item.size, 0);
if (totalBytes > 1024 * 1024 * 1024) throw new Error("cmr-eg 超过 1 GiB 验证上限。");
const rescaleProbePath = await findRescaledClassicSample(files);

const catalog = await importStudyPaths(files);
try {
  const saxCine = catalog.collections
    .filter((collection) => collection.kind === "cine" && collection.planes.length === 11)
    .find((collection) => collection.planes.every((plane) => plane.frameIds.filter((frameId) => frameId !== null).length === 25));
  const firstFrameId = saxCine?.planes.flatMap((plane) => plane.frameIds).find((frameId): frameId is string => frameId !== null)
    ?? Object.keys(catalog.frames)[0];
  if (!firstFrameId) throw new Error("导入目录没有可解码影像帧。");
  const descriptor = catalog.frames[firstFrameId];
  const pixels = await readScalarFrame(catalog.id, firstFrameId);
  const finiteCount = pixels.reduce((count, value) => count + Number(Number.isFinite(value)), 0);
  if (pixels.length !== descriptor.rows * descriptor.columns || finiteCount !== pixels.length) {
    throw new Error("代表性影像帧的像素数或有限值检查失败。");
  }
  const saxPlaneCounts = saxCine?.planes.map((plane) => plane.frameIds.filter((frameId) => frameId !== null).length) ?? [];
  const expectedSaxLayout = saxPlaneCounts.length === 11 && saxPlaneCounts.every((count) => count === 25);
  const benchmarkFrames = saxCine?.planes.map((plane) => plane.frameIds.flatMap((frameId) => frameId ? [catalog.frames[frameId]] : [])) ?? [];
  const constantTemporalLabels = benchmarkFrames.length === 11 && benchmarkFrames.every((plane) => plane.length === 25 && plane.every((frame) => frame.temporalPosition === 1));
  const triggerCounts = benchmarkFrames.map((plane) => new Set(plane.map((frame) => frame.triggerMs).filter((time): time is number => time !== undefined)).size);
  const triggerSetsVaryByPlane = new Set(benchmarkFrames.map((plane) => plane.map((frame) => frame.triggerMs).join(","))).size > 1;
  const perPlaneTriggerTimesComplete = triggerCounts.length === 11 && triggerCounts.every((count) => count === 25);
  const triggerOrderedPlanes = catalog.collections.filter((collection) => collection.kind === "cine")
    .flatMap((collection) => collection.planes.map((plane) => ({ collection, frames: plane.frameIds.flatMap((id) => id ? [catalog.frames[id]] : []) })))
    .filter(({ frames }) => frames.length > 1 && frames.every((frame) => frame.triggerMs !== undefined && frame.nominalPhase === undefined)
      && new Set(frames.map((frame) => frame.temporalPosition)).size <= 1
      && frames.every((frame) => !Object.keys(frame.dimensionValues ?? {}).length));
  const cineTriggerOrderPreserved = triggerOrderedPlanes.length > 0 && triggerOrderedPlanes.every(({ frames }) =>
    frames.every((frame, index) => index === 0 || frame.triggerMs! >= frames[index - 1].triggerMs!));
  const overflowPlanes = triggerOrderedPlanes.filter(({ frames }) => frames.some((frame) =>
    frame.rrMs !== undefined && frame.rrMs > 0 && (frame.triggerMs! < 0 || frame.triggerMs! >= frame.rrMs)));
  const overflowPhaseMatchingApproximate = overflowPlanes.every(({ collection }) => collection.phaseMatching === "approximate");
  const rescaleComparison = rescaleProbePath ? await compareNativeAndItk(rescaleProbePath) : null;
  const viewKindCounts: Record<string, number> = {};
  for (const collection of catalog.collections) {
    const key = `${collection.view}/${collection.kind}/${collection.axisKind}`;
    viewKindCounts[key] = (viewKindCounts[key] ?? 0) + 1;
  }
  const matches = catalog.collections.map((collection) => ({
    view: collection.view,
    kind: collection.kind,
    planes: collection.planes.length,
    phaseCounts: collection.planes.map((plane) => plane.frameIds.filter((id) => id !== null).length)
  })).filter((collection) => collection.view === "SAX" && collection.kind === "cine" && collection.planes > 1);

  console.log(JSON.stringify({
    directoryFiles: files.length,
    sourceMegabytes: Math.round(totalBytes / (1024 * 1024)),
    acceptedInstances: catalog.report.acceptedInstances,
    acceptedFrames: catalog.report.acceptedFrames,
    skippedObjects: catalog.report.skippedObjects,
    failedFiles: catalog.report.failedFiles,
    collections: catalog.collections.length,
    frameMetadataCoverage: {
      geometry: Object.values(catalog.frames).filter((frame) => frame.geometry).length,
      seriesDescription: Object.values(catalog.frames).filter((frame) => frame.seriesDescription !== "Untitled series").length,
      triggerTime: Object.values(catalog.frames).filter((frame) => frame.triggerMs !== undefined).length,
      temporalPosition: Object.values(catalog.frames).filter((frame) => frame.temporalPosition !== undefined).length
    },
    viewKindCounts,
    collectionShapes: catalog.collections.map((collection) => ({
      view: collection.view,
      kind: collection.kind,
      axisKind: collection.axisKind,
      planes: collection.planes.length,
      occupiedFrameCounts: [...new Set(collection.planes.map((plane) => plane.frameIds.filter((id) => id !== null).length))]
    })).sort((a, b) => b.planes - a.planes).slice(0, 20),
    saxCineLayouts: matches.map((collection) => ({ planes: collection.planes, phaseCounts: collection.phaseCounts })),
    benchmarkViewLabel: saxCine?.view ?? null,
    benchmarkTriggerTimesPerPlane: triggerCounts,
    verifiedTemporalLabelsAllOne: constantTemporalLabels,
    verifiedDistinctTriggerTimesPerPlane: perPlaneTriggerTimesComplete,
    verifiedTriggerTimesDifferByPlane: triggerSetsVaryByPlane,
    triggerOrderedCinePlanesChecked: triggerOrderedPlanes.length,
    verifiedCineTriggerOrderPreserved: cineTriggerOrderPreserved,
    triggerOutsideNominalRrPlanes: overflowPlanes.length,
    verifiedOverflowPhaseMatchingApproximate: overflowPhaseMatchingApproximate,
    nativeVsItkRescaleComparison: rescaleComparison ?? { verified: false, reason: "no non-identity MONOCHROME2 classic MR sample found" },
    selectedPixels: pixels.length,
    finitePixels: finiteCount,
    rescaleSlope: descriptor.rescaleSlope,
    rescaleIntercept: descriptor.rescaleIntercept,
    verifiedSax11By25: expectedSaxLayout
  }, null, 2));

  if (!expectedSaxLayout || !constantTemporalLabels || !perPlaneTriggerTimesComplete || !triggerSetsVaryByPlane || !cineTriggerOrderPreserved || !overflowPhaseMatchingApproximate || (rescaleComparison && !rescaleComparison.verified)) {
    throw new Error("样例 cine 基准未通过：预期每层 25 个 TriggerTime、11 层，且 TemporalPositionIdentifier 均为 1。");
  }
} finally {
  await disposeStudy(catalog.id);
}
