import dcmjs from "dcmjs";
import yauzl from "yauzl";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import { buildCollections } from "../core/spaceTime";
import type { FrameDescriptor, PlaneGeometry, StudyCatalog, WindowLevel } from "../core/types";

const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const IMPORT_WORKERS = 4;
const MR_IMAGE_SOP_CLASSES = new Set([
  "1.2.840.10008.5.1.4.1.1.4",
  "1.2.840.10008.5.1.4.1.1.4.1",
  "1.2.840.10008.5.1.4.1.1.4.3"
]);
const UNCOMPRESSED_TRANSFER_SYNTAXES = new Set([
  "1.2.840.10008.1.2",
  "1.2.840.10008.1.2.1",
  "1.2.840.10008.1.2.2"
]);

export class StudySourceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "StudySourceError";
    this.status = status;
    this.code = code;
  }
}

type DicomDataset = Record<string, unknown>;
type ParsedFrame = {
  descriptor: FrameDescriptor;
  frameOffset: number;
  slope: number;
  intercept: number;
  decoder: "native" | "itk";
};
type ParsedInstance = {
  instanceId: string;
  path: string;
  frames: ParsedFrame[];
};
type CacheEntry = { studyId: string; pixels: Float32Array; bytes: number };
type StudySession = {
  id: string;
  root: string;
  catalog: StudyCatalog;
  frames: Map<string, ParsedFrame>;
  instances: Map<string, ParsedInstance>;
  lastAccess: number;
  disposed: boolean;
  inFlight: Map<string, Promise<Float32Array>>;
};
type StudySourceRegistry = {
  sessions: Map<string, StudySession>;
  decodedCache: Map<string, CacheEntry>;
  decodedCacheBytes: number;
  sweeper?: NodeJS.Timeout;
};
type InputFile = { name: string; size: number; stream: () => ReadableStream<Uint8Array> };
type SourceFile = { path: string };

const registryKey = "__cmrPrismStudySourceRegistryV1";
const globals = globalThis as unknown as Record<string, unknown>;
const registry = (globals[registryKey] as StudySourceRegistry | undefined) ?? {
  sessions: new Map<string, StudySession>(),
  decodedCache: new Map<string, CacheEntry>(),
  decodedCacheBytes: 0
};
globals[registryKey] = registry;
const { sessions, decodedCache } = registry;

// Abrupt process termination can leave private temp directories behind; cleanup is intentionally
// limited to tracked sessions because cross-process deletion could race another local viewer.

if (!registry.sweeper) registry.sweeper = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (!session.disposed && now - session.lastAccess >= SESSION_TTL_MS) {
      void disposeStudy(session.id);
    }
  }
}, SWEEP_INTERVAL_MS);
registry.sweeper.unref?.();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function first(value: unknown): unknown {
  if (Array.isArray(value)) return value[0];
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const values = value as unknown as ArrayLike<unknown>;
    return values.length ? values[0] : undefined;
  }
  return value;
}

function text(value: unknown): string | undefined {
  const item = first(value);
  if (typeof item !== "string" && typeof item !== "number") return undefined;
  const result = String(item).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return result || undefined;
}

function number(value: unknown): number | undefined {
  const item = first(value);
  const parsed = typeof item === "number" ? item : typeof item === "string" ? Number(item.trim()) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numbers(value: unknown): number[] | undefined {
  const source = Array.isArray(value)
    ? value
    : ArrayBuffer.isView(value) && !(value instanceof DataView)
      ? Array.from(value as unknown as ArrayLike<number>)
      : typeof value === "string" ? value.split("\\") : undefined;
  if (!source) return undefined;
  const result = source.map((item) => typeof item === "number" ? item : Number(String(item).trim()));
  return result.every(Number.isFinite) ? result : undefined;
}

function sequence(value: unknown): DicomDataset[] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.Item)
      ? value.Item
      : isRecord(value) && Array.isArray(value.Value)
        ? value.Value
        : [];
  return entries.filter(isRecord).flatMap((entry) => {
    if (Array.isArray(entry.Item)) return entry.Item.filter(isRecord) as DicomDataset[];
    return [entry as DicomDataset];
  });
}

function nestedFirst<T = DicomDataset>(dataset: DicomDataset, field: string): T | undefined {
  return sequence(dataset[field])[0] as T | undefined;
}

function parseTimeMs(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const match = /^(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(raw.replaceAll(":", ""));
  if (!match) return undefined;
  const [, hh, mm, ss, fraction = ""] = match;
  const valueMs = ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number(`0.${fraction}`) * 1000;
  return Number.isFinite(valueMs) ? valueMs : undefined;
}

function normalizeArrayBuffer(input: Uint8Array): ArrayBuffer {
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
}

async function mapOrderedBounded<T, R>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.trunc(concurrency)), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

function naturalize(value: unknown): DicomDataset {
  const dcm = dcmjs as unknown as { data: { DicomMessage: { readFile: (bytes: ArrayBuffer) => { dict: unknown; meta?: unknown } }; DicomMetaDictionary: { naturalizeDataset: (dataset: unknown) => DicomDataset } } };
  const parsed = dcm.data.DicomMessage.readFile(normalizeArrayBuffer(value as Uint8Array));
  return {
    ...dcm.data.DicomMetaDictionary.naturalizeDataset(parsed.dict),
    __part10meta: dcm.data.DicomMetaDictionary.naturalizeDataset(parsed.meta ?? {})
  };
}

function geometryFrom(dataset: DicomDataset, frameGroups: DicomDataset | undefined, sharedGroups: DicomDataset | undefined): PlaneGeometry | undefined {
  const findGroupValue = (name: string, groupSequence: string): unknown => {
    const fromFrame = nestedFirst<DicomDataset>(frameGroups ?? {}, groupSequence);
    const fromShared = nestedFirst<DicomDataset>(sharedGroups ?? {}, groupSequence);
    return fromFrame?.[name] ?? fromShared?.[name] ?? dataset[name];
  };
  const orientation = numbers(findGroupValue("ImageOrientationPatient", "PlaneOrientationSequence"));
  const origin = numbers(findGroupValue("ImagePositionPatient", "PlanePositionSequence"));
  const pixelSpacing = numbers(findGroupValue("PixelSpacing", "PixelMeasuresSequence"));
  const thickness = number(findGroupValue("SliceThickness", "PixelMeasuresSequence"));
  const frameOfReferenceUid = text(dataset.FrameOfReferenceUID);
  const rows = number(dataset.Rows);
  const columns = number(dataset.Columns);
  if (!orientation || orientation.length !== 6 || !origin || origin.length !== 3 || !pixelSpacing || pixelSpacing.length !== 2 || !rows || !columns || !frameOfReferenceUid) return undefined;
  if (pixelSpacing.some((value) => value <= 0) || [...orientation, ...origin].some((value) => !Number.isFinite(value))) return undefined;
  return {
    origin: [origin[0], origin[1], origin[2]],
    rowCosines: [orientation[0], orientation[1], orientation[2]],
    columnCosines: [orientation[3], orientation[4], orientation[5]],
    pixelSpacing: [pixelSpacing[0], pixelSpacing[1]],
    rows,
    columns,
    thickness: thickness && thickness > 0 ? thickness : 0,
    frameOfReferenceUid
  };
}

function isMrImage(dataset: DicomDataset): boolean {
  const sopClass = text(dataset.SOPClassUID) ?? "";
  const modality = text(dataset.Modality)?.toUpperCase();
  const rows = number(dataset.Rows);
  const columns = number(dataset.Columns);
  const samples = number(dataset.SamplesPerPixel) ?? 1;
  return modality === "MR" && rows !== undefined && rows > 0 && columns !== undefined && columns > 0 && samples === 1 && MR_IMAGE_SOP_CLASSES.has(sopClass);
}

function dimensionPointer(value: unknown): string | undefined {
  const item = first(value);
  if (typeof item === "number" && Number.isFinite(item)) return Math.trunc(item).toString(16).padStart(8, "0").toUpperCase();
  if (typeof item === "string") {
    const clean = item.replace(/[^0-9a-f]/gi, "").toUpperCase();
    return clean.length >= 8 ? clean.slice(-8) : clean.length === 4 ? `0000${clean}` : undefined;
  }
  if (Array.isArray(item) && item.length >= 2) {
    return `${Number(item[0]).toString(16).padStart(4, "0")}${Number(item[1]).toString(16).padStart(4, "0")}`.toUpperCase();
  }
  if (ArrayBuffer.isView(item) && !(item instanceof DataView)) {
    const bytes = new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
    if (bytes.length >= 4) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return `${view.getUint16(0, true).toString(16).padStart(4, "0")}${view.getUint16(2, true).toString(16).padStart(4, "0")}`.toUpperCase();
    }
  }
  return undefined;
}

const DIMENSION_NAMES: Record<string, string> = {
  "00209128": "temporalPositionIndex",
  "00209057": "inStackPositionNumber",
  "00200032": "imagePositionIndex",
  "00189087": "diffusionBValue",
  "00189089": "diffusionGradientOrientation",
  "00189082": "effectiveEchoTime",
  "00189080": "effectiveRepetitionTime"
};

function frameDimensionValues(frameGroup: DicomDataset | undefined, dimensionItems: DicomDataset[]): Record<string, number> | undefined {
  const content = nestedFirst<DicomDataset>(frameGroup ?? {}, "FrameContentSequence");
  if (!content) return undefined;
  const values = numbers(content.DimensionIndexValues);
  if (!values) return undefined;
  const result: Record<string, number> = {};
  for (let index = 0; index < Math.min(values.length, dimensionItems.length); index += 1) {
    const pointer = dimensionPointer(dimensionItems[index].DimensionIndexPointer);
    const key = pointer ? DIMENSION_NAMES[pointer] ?? `tag_${pointer}` : `dimension_${index + 1}`;
    result[key] = values[index];
  }
  return Object.keys(result).length ? result : undefined;
}

function windowLevel(dataset: DicomDataset, frameGroups?: DicomDataset, sharedGroups?: DicomDataset): WindowLevel | undefined {
  const frameVoi = nestedFirst<DicomDataset>(frameGroups ?? {}, "FrameVOILUTSequence");
  const sharedVoi = nestedFirst<DicomDataset>(sharedGroups ?? {}, "FrameVOILUTSequence");
  const center = number(frameVoi?.WindowCenter) ?? number(sharedVoi?.WindowCenter) ?? number(dataset.WindowCenter);
  const width = number(frameVoi?.WindowWidth) ?? number(sharedVoi?.WindowWidth) ?? number(dataset.WindowWidth);
  return center !== undefined && width !== undefined && width > 0 ? { center, width } : undefined;
}

function makeFrameDescriptor(dataset: DicomDataset, frameGroups: DicomDataset | undefined, sharedGroups: DicomDataset | undefined, frameIndex: number, instanceId: string, seriesId: string, seriesDescription: string, protocolName?: string, sequenceName?: string, decoder: "native" | "itk" = "native"): ParsedFrame {
  const rows = number(dataset.Rows) ?? 0;
  const columns = number(dataset.Columns) ?? 0;
  const content = nestedFirst<DicomDataset>(frameGroups ?? {}, "FrameContentSequence");
  const timing = nestedFirst<DicomDataset>(frameGroups ?? {}, "MRTimingAndRelatedParametersSequence")
    ?? nestedFirst<DicomDataset>(sharedGroups ?? {}, "MRTimingAndRelatedParametersSequence");
  const modifier = nestedFirst<DicomDataset>(frameGroups ?? {}, "MRImagingModifierSequence")
    ?? nestedFirst<DicomDataset>(sharedGroups ?? {}, "MRImagingModifierSequence");
  const cardiac = nestedFirst<DicomDataset>(frameGroups ?? {}, "CardiacSynchronizationSequence")
    ?? nestedFirst<DicomDataset>(sharedGroups ?? {}, "CardiacSynchronizationSequence");
  const transform = nestedFirst<DicomDataset>(frameGroups ?? {}, "PixelValueTransformationSequence")
    ?? nestedFirst<DicomDataset>(sharedGroups ?? {}, "PixelValueTransformationSequence");
  const slope = number(transform?.RescaleSlope) ?? number(dataset.RescaleSlope) ?? 1;
  const intercept = number(transform?.RescaleIntercept) ?? number(dataset.RescaleIntercept) ?? 0;
  const imageFrameType = nestedFirst<DicomDataset>(frameGroups ?? {}, "MRImageFrameTypeSequence");
  const imageTypeRaw = dataset.ImageType ?? imageFrameType?.FrameType;
  const imageType = (Array.isArray(imageTypeRaw) ? imageTypeRaw : typeof imageTypeRaw === "string" ? imageTypeRaw.split("\\") : [])
    .map((part) => String(part).trim()).filter(Boolean).slice(0, 16);
  const temporalPosition = number(content?.TemporalPositionIndex) ?? number(dataset.TemporalPositionIdentifier);
  const triggerMs = number(cardiac?.TriggerTime) ?? number(cardiac?.NominalCardiacTriggerDelayTime)
    ?? number(frameGroups?.TriggerTime) ?? number(frameGroups?.NominalCardiacTriggerDelayTime) ?? number(dataset.TriggerTime) ?? number(dataset.NominalCardiacTriggerDelayTime);
  const nominalPhase = number(cardiac?.NominalPercentageOfCardiacPhase) ?? number(frameGroups?.NominalPercentageOfCardiacPhase) ?? number(dataset.NominalPercentageOfCardiacPhase);
  const rrMs = number(cardiac?.NominalInterval) ?? number(cardiac?.RRIntervalTimeNominal) ?? number(cardiac?.LowRRValue) ?? number(dataset.NominalInterval) ?? number(dataset.LowRRValue);
  const frameAcquisition = text(frameGroups?.FrameAcquisitionDateTime) ?? text(content?.FrameAcquisitionDateTime) ?? text(dataset.AcquisitionTime);
  const acquisitionMs = frameAcquisition && frameAcquisition.length >= 14
    ? parseTimeMs(frameAcquisition.slice(8))
    : parseTimeMs(frameAcquisition);
  const measurement = nestedFirst<DicomDataset>(frameGroups ?? {}, "MREchoSequence")
    ?? nestedFirst<DicomDataset>(sharedGroups ?? {}, "MREchoSequence");
  const parameters = {
    trMs: number(timing?.RepetitionTime) ?? number(dataset.RepetitionTime),
    teMs: number(measurement?.EffectiveEchoTime) ?? number(dataset.EchoTime),
    tiMs: number(modifier?.InversionTimes) ?? number(dataset.InversionTime),
    flipAngle: number(timing?.FlipAngle) ?? number(dataset.FlipAngle),
    heartRate: number(dataset.HeartRate)
  };
  const descriptor: FrameDescriptor = {
    id: randomUUID(),
    instanceId,
    frameNumber: frameIndex + 1,
    studyUid: text(dataset.StudyInstanceUID) ?? "unknown-study",
    seriesId,
    seriesDescription,
    ...(protocolName ? { protocolName } : {}),
    ...(sequenceName ? { sequenceName } : {}),
    imageType,
    rows,
    columns,
    geometry: geometryFrom(dataset, frameGroups, sharedGroups),
    photometric: text(dataset.PhotometricInterpretation)?.toUpperCase() === "MONOCHROME1" ? "MONOCHROME1" : "MONOCHROME2",
    ...(number(dataset.InstanceNumber) !== undefined ? { instanceNumber: number(dataset.InstanceNumber) } : {}),
    ...(temporalPosition !== undefined ? { temporalPosition } : {}),
    ...(triggerMs !== undefined ? { triggerMs } : {}),
    ...(nominalPhase !== undefined ? { nominalPhase } : {}),
    ...(rrMs !== undefined ? { rrMs } : {}),
    ...(acquisitionMs !== undefined ? { acquisitionMs } : {}),
    parameters,
    rescaleSlope: slope,
    rescaleIntercept: intercept,
    ...(windowLevel(dataset, frameGroups, sharedGroups) ? { window: windowLevel(dataset, frameGroups, sharedGroups) } : {})
  };
  const dimensionItems = sequence(dataset.DimensionIndexSequence);
  const dimensionValues = frameDimensionValues(frameGroups, dimensionItems);
  if (dimensionValues) descriptor.dimensionValues = dimensionValues;
  return { descriptor, frameOffset: frameIndex, slope, intercept, decoder };
}

function isByteLike(value: unknown): value is ArrayBuffer | ArrayBufferView | number[] {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Array.isArray(value);
}

function pixelBytesFrom(value: unknown): Uint8Array | undefined {
  let item = value;
  if (Array.isArray(item) && item.length === 1 && isByteLike(item[0])) item = item[0];
  if (item instanceof ArrayBuffer) return new Uint8Array(item);
  if (ArrayBuffer.isView(item) && !(item instanceof DataView)) return new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
  if (Array.isArray(item) && item.every((byte) => typeof byte === "number" && byte >= 0 && byte <= 255)) return Uint8Array.from(item);
  return undefined;
}

function validatePixelData(dataset: DicomDataset, parsed: ParsedFrame[], bytes: Uint8Array | undefined): void {
  const bitsAllocated = number(dataset.BitsAllocated);
  const rows = number(dataset.Rows);
  const columns = number(dataset.Columns);
  const frames = parsed.length;
  if (!bitsAllocated || ![8, 16, 32].includes(bitsAllocated) || !rows || !columns || !frames) throw new Error("unsupported grayscale pixel layout");
  const expectedBytes = rows * columns * frames * (bitsAllocated / 8);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !bytes || bytes.byteLength < expectedBytes) throw new Error("missing or incomplete pixel data");
}

async function parseInstance(filePath: string): Promise<ParsedInstance | null> {
  const input = new Uint8Array(await readFile(filePath));
  const dataset = naturalize(input);
  if (!isMrImage(dataset)) return null;
  const rows = number(dataset.Rows) ?? 0;
  const columns = number(dataset.Columns) ?? 0;
  const frameCount = Math.trunc(number(dataset.NumberOfFrames) ?? 1);
  if (frameCount < 1 || frameCount > 100_000 || rows * columns > 100_000_000) throw new Error("invalid image dimensions");
  const meta = isRecord(dataset.__part10meta) ? dataset.__part10meta : {};
  const transferSyntax = text(meta.TransferSyntaxUID) ?? "1.2.840.10008.1.2.1";
  const decoder: "native" | "itk" = UNCOMPRESSED_TRANSFER_SYNTAXES.has(transferSyntax) ? "native" : "itk";
  if (decoder === "itk" && frameCount !== 1) throw new Error("compressed Enhanced MR frame layout is not verified");
  const bytes = pixelBytesFrom(dataset.PixelData);
  if (!dataset.PixelData) throw new Error("missing pixel data");
  const sharedGroups = sequence(dataset.SharedFunctionalGroupsSequence)[0];
  const perFrameGroups = sequence(dataset.PerFrameFunctionalGroupsSequence);
  if (perFrameGroups.length !== 0 && perFrameGroups.length !== frameCount) throw new Error("invalid enhanced frame metadata");
  const instanceId = randomUUID();
  const seriesId = text(dataset.SeriesInstanceUID) ?? "unknown-series";
  const description = text(dataset.SeriesDescription) ?? "Untitled series";
  const protocolName = text(dataset.ProtocolName);
  const sequenceName = text(dataset.SequenceName);
  const parsed = Array.from({ length: frameCount }, (_, frameIndex) => makeFrameDescriptor(
    dataset,
    perFrameGroups[frameIndex],
    sharedGroups,
    frameIndex,
    instanceId,
    seriesId,
    description,
    protocolName,
    sequenceName,
    decoder
  ));
  if (decoder === "native") {
    validatePixelData(dataset, parsed, bytes);
  } else {
    const decoded = await decodeItkFrame(filePath, parsed[0].descriptor);
    if (decoded.length !== rows * columns) throw new Error("ITK-Wasm decoded an unexpected pixel count");
  }
  return { instanceId, path: filePath, frames: parsed };
}

function closeEnough(actual: unknown, expected: number, tolerance: number): boolean {
  const numeric = typeof actual === "number" || typeof actual === "bigint" ? Number(actual) : NaN;
  return Number.isFinite(numeric) && Math.abs(numeric - expected) <= tolerance;
}

function validateItkGeometry(
  image: { imageType: { dimension: number; components: number }; size: number[]; origin: number[]; spacing: number[]; direction: ArrayLike<number | bigint>; data: ArrayLike<number | bigint> | null },
  descriptor: FrameDescriptor
): void {
  const geometry = descriptor.geometry;
  const [rows, columns] = [descriptor.rows, descriptor.columns];
  if (!geometry || image.imageType.dimension !== 3 || image.size.length !== 3
    || image.size[0] !== columns || image.size[1] !== rows || image.size[2] !== 1
    || image.origin.length !== 3 || image.spacing.length !== 3 || image.direction.length !== 9) {
    throw new StudySourceError(422, "PIXEL_GEOMETRY_MISMATCH", "此压缩影像无法与 DICOM 空间几何可靠对应，已拒绝显示。");
  }
  const direction = (index: number): number => Number(image.direction[index]);
  const row = geometry.rowCosines;
  const column = geometry.columnCosines;
  const normal = [
    row[1] * column[2] - row[2] * column[1],
    row[2] * column[0] - row[0] * column[2],
    row[0] * column[1] - row[1] * column[0]
  ];
  const geometryMatches = geometry.origin.every((coordinate, index) => closeEnough(image.origin[index], coordinate, 0.05))
    && closeEnough(image.spacing[0], geometry.pixelSpacing[1], 1e-4)
    && closeEnough(image.spacing[1], geometry.pixelSpacing[0], 1e-4)
    && (geometry.thickness <= 0 || closeEnough(image.spacing[2], geometry.thickness, 0.05))
    && [
      [direction(0), row[0]], [direction(3), row[1]], [direction(6), row[2]],
      [direction(1), column[0]], [direction(4), column[1]], [direction(7), column[2]],
      [direction(2), normal[0]], [direction(5), normal[1]], [direction(8), normal[2]]
    ].every(([actual, expected]) => closeEnough(actual, expected, 1e-4));
  if (!geometryMatches) {
    throw new StudySourceError(422, "PIXEL_GEOMETRY_MISMATCH", "此压缩影像的像素方向与 DICOM 空间几何不一致，已拒绝显示。");
  }
}

async function decodeItkFrame(filePath: string, descriptor: FrameDescriptor, frameOffset = 0): Promise<Float32Array> {
  const { readImageNode } = await import("@itk-wasm/image-io");
  const itkImage = await readImageNode(filePath);
  const image = itkImage as unknown as {
    imageType: { dimension: number; components: number };
    size: number[];
    origin: number[];
    spacing: number[];
    direction: ArrayLike<number | bigint>;
    data: ArrayLike<number | bigint> | null;
  };
  if (!image.data || image.imageType.components !== 1) throw new StudySourceError(422, "PIXEL_DECODE_FAILED", "此影像的像素数据无法解码。");
  validateItkGeometry(image, descriptor);
  const frameSize = descriptor.rows * descriptor.columns;
  const start = frameOffset * frameSize;
  if (frameOffset !== 0 || image.data.length !== frameSize || image.data.length < start + frameSize) {
    throw new StudySourceError(422, "PIXEL_LAYOUT_UNSUPPORTED", "此影像的像素帧数量与元数据不一致。");
  }
  const result = new Float32Array(frameSize);
  for (let index = 0; index < frameSize; index += 1) result[index] = Number(image.data[start + index]);
  return result;
}

function readNativePixels(dataset: DicomDataset, frame: ParsedFrame): Float32Array {
  const values = pixelBytesFrom(dataset.PixelData);
  if (!values) throw new StudySourceError(422, "PIXEL_DECODE_FAILED", "此影像的像素数据无法解码。");
  const bitsAllocated = number(dataset.BitsAllocated) ?? 0;
  const bitsStored = number(dataset.BitsStored) ?? bitsAllocated;
  const highBit = number(dataset.HighBit) ?? bitsStored - 1;
  const signed = number(dataset.PixelRepresentation) === 1;
  const rows = number(dataset.Rows) ?? 0;
  const columns = number(dataset.Columns) ?? 0;
  const count = rows * columns;
  const bytesPerSample = bitsAllocated / 8;
  const littleEndian = text((dataset.__part10meta as DicomDataset | undefined)?.TransferSyntaxUID) !== "1.2.840.10008.1.2.2";
  const offset = frame.frameOffset * count * bytesPerSample;
  if (![8, 16, 32].includes(bitsAllocated) || bitsStored < 1 || bitsStored > bitsAllocated || highBit >= bitsAllocated || highBit + 1 < bitsStored || offset + count * bytesPerSample > values.byteLength) {
    throw new StudySourceError(422, "PIXEL_LAYOUT_UNSUPPORTED", "此影像的像素格式暂不支持。");
  }
  const shift = highBit - bitsStored + 1;
  const signBit = 2 ** (bitsStored - 1);
  const data = new DataView(values.buffer, values.byteOffset, values.byteLength);
  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const byteOffset = offset + index * bytesPerSample;
    let raw = bitsAllocated === 8 ? data.getUint8(byteOffset)
      : bitsAllocated === 16 ? data.getUint16(byteOffset, littleEndian)
      : data.getUint32(byteOffset, littleEndian);
    raw = Math.floor(raw / (2 ** shift)) % (2 ** bitsStored);
    const storedValue = signed && raw >= signBit ? raw - (2 ** bitsStored) : raw;
    output[index] = storedValue * frame.slope + frame.intercept;
  }
  return output;
}

async function decodeFrame(session: StudySession, parsedFrame: ParsedFrame): Promise<Float32Array> {
  try {
    const filePath = session.instances.get(parsedFrame.descriptor.instanceId)?.path;
    if (!filePath) throw new Error("missing source instance");
    if (parsedFrame.decoder === "itk") return await decodeItkFrame(filePath, parsedFrame.descriptor, parsedFrame.frameOffset);
    const input = new Uint8Array(await readFile(filePath));
    const dataset = naturalize(input);
    return readNativePixels(dataset, parsedFrame);
  } catch (error) {
    if (error instanceof StudySourceError) throw error;
    throw new StudySourceError(422, "PIXEL_DECODE_FAILED", "此影像的像素数据无法解码。");
  }
}

function touch(session: StudySession): void {
  if (session.disposed || !sessions.has(session.id)) throw new StudySourceError(404, "STUDY_NOT_FOUND", "影像会话不存在或已过期。");
  session.lastAccess = Date.now();
}

function cacheGet(frameId: string): Float32Array | undefined {
  const entry = decodedCache.get(frameId);
  if (!entry) return undefined;
  decodedCache.delete(frameId);
  decodedCache.set(frameId, entry);
  return entry.pixels;
}

function cacheSet(frameId: string, studyId: string, pixels: Float32Array): void {
  if (pixels.byteLength > MAX_CACHE_BYTES) return;
  const previous = decodedCache.get(frameId);
  if (previous) registry.decodedCacheBytes -= previous.bytes;
  decodedCache.delete(frameId);
  while (registry.decodedCacheBytes + pixels.byteLength > MAX_CACHE_BYTES) {
    const oldestId = decodedCache.keys().next().value as string | undefined;
    if (!oldestId) break;
    const oldest = decodedCache.get(oldestId);
    if (oldest) registry.decodedCacheBytes -= oldest.bytes;
    decodedCache.delete(oldestId);
  }
  decodedCache.set(frameId, { studyId, pixels, bytes: pixels.byteLength });
  registry.decodedCacheBytes += pixels.byteLength;
}

function removeCachedStudy(studyId: string): void {
  for (const [frameId, entry] of decodedCache) {
    if (entry.studyId === studyId) {
      registry.decodedCacheBytes -= entry.bytes;
      decodedCache.delete(frameId);
    }
  }
}

function deriveWindow(pixels: Float32Array): WindowLevel {
  const stride = Math.max(1, Math.ceil(pixels.length / 50_000));
  const sample: number[] = [];
  for (let index = 0; index < pixels.length; index += stride) {
    const value = pixels[index];
    if (Number.isFinite(value)) sample.push(value);
  }
  if (sample.length === 0) return { center: 0, width: 1 };
  sample.sort((a, b) => a - b);
  const low = sample[Math.floor((sample.length - 1) * 0.02)];
  const high = sample[Math.floor((sample.length - 1) * 0.98)];
  const width = Math.max(1, high - low);
  return { center: (high + low) / 2, width };
}

function isValidWindow(window: WindowLevel | undefined): window is WindowLevel {
  return Boolean(window && Number.isFinite(window.center) && Number.isFinite(window.width) && window.width > 0);
}

async function finalizeCatalog(session: StudySession, instances: ParsedInstance[], warnings: string[]): Promise<StudyCatalog> {
  const frames: Record<string, FrameDescriptor> = {};
  const parsedFrames = new Map<string, ParsedFrame>();
  const instanceMap = new Map<string, ParsedInstance>();
  const opaqueStudyIds = new Map<string, string>();
  const opaqueSeriesIds = new Map<string, string>();
  const opaqueFrameOfReferenceIds = new Map<string, string>();
  const opaqueId = (map: Map<string, string>, sourceId: string): string => {
    let result = map.get(sourceId);
    if (!result) {
      result = randomUUID();
      map.set(sourceId, result);
    }
    return result;
  };
  for (const instance of instances) {
    instanceMap.set(instance.instanceId, instance);
    for (const frame of instance.frames) {
      frame.descriptor.studyUid = opaqueId(opaqueStudyIds, frame.descriptor.studyUid);
      frame.descriptor.seriesId = opaqueId(opaqueSeriesIds, frame.descriptor.seriesId);
      const geometry = frame.descriptor.geometry;
      if (geometry) {
        frame.descriptor.geometry = {
          ...geometry,
          frameOfReferenceUid: opaqueId(opaqueFrameOfReferenceIds, geometry.frameOfReferenceUid)
        };
      }
      frames[frame.descriptor.id] = frame.descriptor;
      parsedFrames.set(frame.descriptor.id, frame);
    }
  }
  const collections = buildCollections(Object.values(frames));
  const catalog: StudyCatalog = {
    id: session.id,
    collections,
    frames,
    report: {
      acceptedInstances: instances.length,
      acceptedFrames: Object.keys(frames).length,
      skippedObjects: 0,
      failedFiles: 0,
      warnings
    }
  };
  session.frames = parsedFrames;
  session.instances = instanceMap;
  session.catalog = catalog;
  sessions.set(session.id, session);

  for (const collection of collections) {
    const availableFrames = collection.planes.flatMap((plane) => plane.frameIds).filter((id): id is string => id !== null);
    const tagged = availableFrames.map((id) => frames[id]?.window).find(isValidWindow);
    if (tagged) {
      collection.defaultWindow = { ...tagged };
      continue;
    }
    const firstId = availableFrames[0];
    if (!firstId) {
      collection.defaultWindow = { center: 0, width: 1 };
      continue;
    }
    try {
      const pixels = await readScalarFrame(session.id, firstId);
      collection.defaultWindow = deriveWindow(pixels);
    } catch {
      collection.defaultWindow = { center: 0, width: 1 };
      warnings.push("部分序列无法推导默认窗宽窗位，请在查看时手动调整。");
    }
  }
  return catalog;
}

async function withNewSession<T>(work: (session: StudySession) => Promise<T>): Promise<T> {
  const root = await mkdtemp(/* turbopackIgnore: true */ join(tmpdir(), "cmr-prism-"));
  const id = randomUUID();
  const placeholder: StudyCatalog = {
    id,
    collections: [],
    frames: {},
    report: { acceptedInstances: 0, acceptedFrames: 0, skippedObjects: 0, failedFiles: 0, warnings: [] }
  };
  const session: StudySession = {
    id,
    root,
    catalog: placeholder,
    frames: new Map(),
    instances: new Map(),
    lastAccess: Date.now(),
    disposed: false,
    inFlight: new Map()
  };
  try {
    return await work(session);
  } catch (error) {
    session.disposed = true;
    removeCachedStudy(session.id);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function zipOpen(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error || !zipFile) reject(error ?? new Error("ZIP open failed"));
      else resolve(zipFile);
    });
  });
}

function zipReadEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { zip.removeListener("entry", onEntry); zip.removeListener("end", onEnd); zip.removeListener("error", onError); };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

function zipStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) reject(error ?? new Error("ZIP entry stream unavailable"));
    else resolve(stream);
  }));
}

function isSafeZipEntry(entry: yauzl.Entry): boolean {
  const name = entry.fileName.replaceAll("\\", "/");
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & 0o170000;
  return !name.startsWith("/") && !/^[A-Za-z]:/.test(name) && !name.split("/").some((part) => part === ".." || part === ".")
    && !name.includes("\0") && type !== 0o120000;
}

async function unpackZip(filePath: string, destination: string, budget: { bytes: number; entries: number }): Promise<SourceFile[]> {
  let zip: yauzl.ZipFile;
  try {
    zip = await zipOpen(filePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message.toLowerCase() : "";
    const code = reason.includes("path") || reason.includes("filename") || reason.includes("absolute") ? "UNSAFE_ARCHIVE" : "INVALID_ARCHIVE";
    throw new StudySourceError(400, code, "ZIP 无法读取或包含不安全路径，已拒绝该压缩包。");
  }
  const files: SourceFile[] = [];
  let settled = false;
  try {
    for (;;) {
      const entry = await zipReadEntry(zip);
      if (!entry) break;
      budget.entries += 1;
      if (budget.entries > 20_000) throw new StudySourceError(413, "TOO_MANY_FILES", "单次导入文件数量超过限制。");
      const isDirectory = entry.fileName.endsWith("/");
      if (!isSafeZipEntry(entry)) throw new StudySourceError(400, "UNSAFE_ARCHIVE", "ZIP 包含不安全路径，已拒绝该压缩包。");
      if (isDirectory) continue;
      if (entry.uncompressedSize < 0 || budget.bytes + entry.uncompressedSize > MAX_IMPORT_BYTES) {
        throw new StudySourceError(413, "IMPORT_TOO_LARGE", "解压后文件总量超过 1 GiB 限制。");
      }
      const output = /* turbopackIgnore: true */ join(destination, `archive-${randomUUID()}${extname(entry.fileName).slice(0, 12)}`);
      let actual = 0;
      const input = await zipStream(zip, entry);
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          actual += chunk.byteLength;
          if (actual > MAX_IMPORT_BYTES || budget.bytes + actual > MAX_IMPORT_BYTES) {
            callback(new StudySourceError(413, "IMPORT_TOO_LARGE", "解压后文件总量超过 1 GiB 限制。"));
            return;
          }
          callback(null, chunk);
        }
      });
      await pipeline(input, limiter, createWriteStream(output, { flags: "wx" }));
      budget.bytes += actual;
      files.push({ path: output });
    }
    settled = true;
  } catch (error) {
    if (error instanceof StudySourceError) throw error;
    const reason = error instanceof Error ? error.message.toLowerCase() : "";
    const code = reason.includes("path") || reason.includes("filename") || reason.includes("absolute") ? "UNSAFE_ARCHIVE" : "INVALID_ARCHIVE";
    throw new StudySourceError(400, code, "ZIP 无法读取或包含不安全路径，已拒绝该压缩包。");
  } finally {
    zip.close();
    if (!settled) await Promise.all(files.map(({ path }) => rm(path, { force: true })));
  }
  return files;
}

async function copyWebFile(file: InputFile, output: string, seenBytes: { value: number }): Promise<void> {
  if (!Number.isFinite(file.size) || file.size < 0 || seenBytes.value + file.size > MAX_IMPORT_BYTES) {
    throw new StudySourceError(413, "IMPORT_TOO_LARGE", "导入文件总量超过 1 GiB 限制。");
  }
  let actual = 0;
  const webStream = file.stream() as unknown as import("node:stream/web").ReadableStream<Uint8Array>;
  const input = (await import("node:stream")).Readable.fromWeb(webStream);
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      actual += chunk.byteLength;
      if (actual + seenBytes.value > MAX_IMPORT_BYTES) {
        callback(new StudySourceError(413, "IMPORT_TOO_LARGE", "导入文件总量超过 1 GiB 限制。"));
        return;
      }
      callback(null, chunk);
    }
  });
  await pipeline(input, limiter, createWriteStream(output, { flags: "wx" }));
  seenBytes.value += actual;
}

async function looksLikeZip(filePath: string): Promise<boolean> {
  const handle = await import("node:fs/promises").then(({ open }) => open(filePath, "r"));
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === 4 && header[0] === 0x50 && header[1] === 0x4b && [0x03, 0x05, 0x07].includes(header[2]) && [0x04, 0x06, 0x08].includes(header[3]);
  } finally {
    await handle.close();
  }
}

async function importPathsIntoSession(session: StudySession, sourcePaths: string[]): Promise<StudyCatalog> {
  const warnings: string[] = [];
  const parsedInstances: ParsedInstance[] = [];
  const failures: SourceFile[] = [];
  let firstArchiveError: StudySourceError | undefined;
  let skippedObjects = 0;
  const budget = { bytes: 0, entries: sourcePaths.length };
  const candidates: SourceFile[] = [];

  const inspected = await mapOrderedBounded(sourcePaths, IMPORT_WORKERS, async (path) => {
    try {
      return { path, isZip: await looksLikeZip(path), failed: false };
    } catch {
      return { path, isZip: false, failed: true };
    }
  });
  for (const source of inspected) {
    if (source.failed) {
      failures.push({ path: source.path });
      continue;
    }
    if (source.isZip) {
      try {
        candidates.push(...await unpackZip(source.path, session.root, budget));
      } catch (error) {
        if (error instanceof StudySourceError && error.status >= 413) throw error;
        if (!firstArchiveError) {
          firstArchiveError = error instanceof StudySourceError
            ? error
            : new StudySourceError(400, "INVALID_ARCHIVE", "ZIP 无法读取或包含不安全路径，已拒绝该压缩包。");
        }
        failures.push({ path: source.path });
      }
    } else {
      candidates.push({ path: source.path });
    }
  }

  const parseResults = await mapOrderedBounded(candidates, IMPORT_WORKERS, async (candidate) => {
    try {
      return { candidate, instance: await parseInstance(candidate.path), failed: false };
    } catch {
      return { candidate, instance: null, failed: true };
    }
  });
  for (const result of parseResults) {
    if (result.failed) failures.push(result.candidate);
    else if (result.instance) parsedInstances.push(result.instance);
    else skippedObjects += 1;
  }
  if (parsedInstances.length === 0) {
    if (firstArchiveError) throw firstArchiveError;
    throw new StudySourceError(422, "NO_READABLE_IMAGES", "没有找到可读取的灰度 MR 影像。请检查文件格式或编码支持。");
  }
  if (skippedObjects > 0) warnings.push(`${skippedObjects} 个非 MR 影像对象已跳过。`);
  if (failures.length > 0) warnings.push(`${failures.length} 个文件损坏或使用了当前不支持的编码，未影响其他可读影像。`);
  await finalizeCatalog(session, parsedInstances, warnings);
  session.catalog.report.skippedObjects = skippedObjects;
  session.catalog.report.failedFiles = failures.length;
  return session.catalog;
}

/** Import an upload into a private temporary session. File names never become ids or response fields. */
export async function importStudy(files: File[]): Promise<StudyCatalog> {
  if (!Array.isArray(files) || files.length === 0) throw new StudySourceError(400, "EMPTY_UPLOAD", "请至少选择一个 DICOM 文件或 ZIP 压缩包。");
  if (files.length > 20_000) throw new StudySourceError(413, "TOO_MANY_FILES", "单次导入文件数量超过限制。");
  const uploadBytes = files.reduce((sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0), 0);
  if (uploadBytes > MAX_IMPORT_BYTES) throw new StudySourceError(413, "IMPORT_TOO_LARGE", "导入文件总量超过 1 GiB 限制。");

  return withNewSession(async (session) => {
    const sources: string[] = [];
    const counted = { value: 0 };
    for (const file of files) {
      const path = join(session.root, `upload-${randomUUID()}${extname(file.name).slice(0, 12)}`);
      await copyWebFile(file, path, counted);
      sources.push(path);
    }
    return importPathsIntoSession(session, sources);
  });
}

/** Internal local audit hook. It is used by scripts and is not exposed through an API route. */
export async function importStudyPaths(paths: string[]): Promise<StudyCatalog> {
  if (paths.length === 0) throw new StudySourceError(400, "EMPTY_UPLOAD", "没有可检查的本地 DICOM 文件。");
  if (paths.length > 20_000) throw new StudySourceError(413, "TOO_MANY_FILES", "单次导入文件数量超过限制。");
  let bytes = 0;
  const fileStats = await mapOrderedBounded(paths, IMPORT_WORKERS, (path) => stat(path));
  for (const fileStat of fileStats) {
    bytes += fileStat.size;
    if (bytes > MAX_IMPORT_BYTES) throw new StudySourceError(413, "IMPORT_TOO_LARGE", "导入文件总量超过 1 GiB 限制。");
  }
  return withNewSession((session) => importPathsIntoSession(session, paths));
}

export function getStudy(id: string): StudyCatalog {
  const session = sessions.get(id);
  if (!session) throw new StudySourceError(404, "STUDY_NOT_FOUND", "影像会话不存在或已过期。");
  touch(session);
  return session.catalog;
}

export async function readScalarFrame(id: string, frameId: string): Promise<Float32Array> {
  const session = sessions.get(id);
  if (!session) throw new StudySourceError(404, "STUDY_NOT_FOUND", "影像会话不存在或已过期。");
  touch(session);
  const parsedFrame = session.frames.get(frameId);
  if (!parsedFrame) throw new StudySourceError(404, "FRAME_NOT_FOUND", "影像帧不存在。");
  const cached = cacheGet(frameId);
  if (cached) return cached;
  const pending = session.inFlight.get(frameId);
  if (pending) return pending;

  const promise = decodeFrame(session, parsedFrame).then((pixels) => {
    if (!session.disposed && sessions.has(session.id)) cacheSet(frameId, session.id, pixels);
    return pixels;
  }).finally(() => session.inFlight.delete(frameId));
  session.inFlight.set(frameId, promise);
  return promise;
}

export async function disposeStudy(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) throw new StudySourceError(404, "STUDY_NOT_FOUND", "影像会话不存在或已过期。");
  sessions.delete(id);
  session.disposed = true;
  removeCachedStudy(id);
  await Promise.allSettled(session.inFlight.values());
  session.inFlight.clear();
  session.frames.clear();
  session.instances.clear();
  session.catalog = { id, collections: [], frames: {}, report: { acceptedInstances: 0, acceptedFrames: 0, skippedObjects: 0, failedFiles: 0, warnings: [] } };
  await rm(session.root, { recursive: true, force: true });
}

/** Exposed for route and integration tests; values contain no PHI or filesystem paths. */
export const STUDY_SOURCE_LIMITS = { maxImportBytes: MAX_IMPORT_BYTES, maxCacheBytes: MAX_CACHE_BYTES, ttlMs: SESSION_TTL_MS } as const;
