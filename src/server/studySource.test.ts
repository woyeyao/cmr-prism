import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readImageNode } from "@itk-wasm/image-io";
import yauzl from "yauzl";
import { disposeStudy, getStudy, importStudy, readScalarFrame, StudySourceError, STUDY_SOURCE_LIMITS } from "./studySource";
import { POST } from "../app/api/studies/route";

vi.mock("@itk-wasm/image-io", () => ({ readImageNode: vi.fn() }));

const studies: string[] = [];
const MR_SOP = "1.2.840.10008.5.1.4.1.1.4";
const PR_SOP = "1.2.840.10008.5.1.4.1.1.11.1";
const STUDY_UID = "1.2.826.0.1.3680043.10.900.10";
const SERIES_UID = "1.2.826.0.1.3680043.10.900.20";
const FOR_UID = "1.2.826.0.1.3680043.10.900.30";

function padded(value: string, pad = 0x20): Buffer {
  const bytes = Buffer.from(value, "ascii");
  return bytes.length % 2 ? Buffer.concat([bytes, Buffer.from([pad])]) : bytes;
}

function ushort(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function ulong(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function element(group: number, tag: number, vr: string, value: Buffer): Buffer {
  const long = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UR", "UT", "UN"]);
  const header = Buffer.alloc(long.has(vr) ? 12 : 8);
  header.writeUInt16LE(group, 0);
  header.writeUInt16LE(tag, 2);
  header.write(vr, 4, 2, "ascii");
  if (long.has(vr)) header.writeUInt32LE(value.length, 8);
  else header.writeUInt16LE(value.length, 6);
  return Buffer.concat([header, value]);
}

function item(value: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0xfffe, 0);
  header.writeUInt16LE(0xe000, 2);
  header.writeUInt32LE(0xffff_ffff, 4);
  const delimiter = Buffer.alloc(8);
  delimiter.writeUInt16LE(0xfffe, 0);
  delimiter.writeUInt16LE(0xe00d, 2);
  return Buffer.concat([header, value, delimiter]);
}

function sequence(group: number, tag: number, items: Buffer[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16LE(group, 0);
  header.writeUInt16LE(tag, 2);
  header.write("SQ", 4, 2, "ascii");
  header.writeUInt32LE(0xffff_ffff, 8);
  const delimiter = Buffer.alloc(8);
  delimiter.writeUInt16LE(0xfffe, 0);
  delimiter.writeUInt16LE(0xe0dd, 2);
  return Buffer.concat([header, ...items, delimiter]);
}

function at(group: number, tag: number): Buffer {
  return Buffer.concat([ushort(group), ushort(tag)]);
}

function part10(dataset: Buffer, sopClass: string, sopInstance: string, transferSyntax = "1.2.840.10008.1.2.1"): Buffer {
  const metaBody = Buffer.concat([
    element(0x0002, 0x0001, "OB", Buffer.from([0, 1])),
    element(0x0002, 0x0002, "UI", padded(sopClass, 0)),
    element(0x0002, 0x0003, "UI", padded(sopInstance, 0)),
    element(0x0002, 0x0010, "UI", padded(transferSyntax, 0)),
    element(0x0002, 0x0012, "UI", padded("1.2.826.0.1.3680043.10.900.999", 0)),
    element(0x0002, 0x0013, "SH", padded("CMR_TEST"))
  ]);
  const preamble = Buffer.alloc(132);
  preamble.write("DICM", 128, 4, "ascii");
  return Buffer.concat([preamble, element(0x0002, 0x0000, "UL", ulong(metaBody.length)), metaBody, dataset]);
}

function baseElements(sopClass: string, sopInstance: string): Buffer[] {
  return [
    element(0x0008, 0x0016, "UI", padded(sopClass, 0)),
    element(0x0008, 0x0018, "UI", padded(sopInstance, 0)),
    element(0x0008, 0x0060, "CS", padded(sopClass === PR_SOP ? "PR" : "MR")),
    element(0x0008, 0x103e, "LO", padded("Synthetic CMR")),
    element(0x0018, 0x0050, "DS", padded("2.5")),
    element(0x0020, 0x000d, "UI", padded(STUDY_UID, 0)),
    element(0x0020, 0x000e, "UI", padded(SERIES_UID, 0)),
    element(0x0020, 0x0052, "UI", padded(FOR_UID, 0)),
    element(0x0020, 0x0013, "IS", padded("1")),
    element(0x0028, 0x0002, "US", ushort(1)),
    element(0x0028, 0x0004, "CS", padded("MONOCHROME1")),
    element(0x0028, 0x0010, "US", ushort(2)),
    element(0x0028, 0x0011, "US", ushort(2)),
    element(0x0028, 0x0030, "DS", padded("0.8\\0.9")),
    element(0x0028, 0x0100, "US", ushort(16)),
    element(0x0028, 0x0101, "US", ushort(16)),
    element(0x0028, 0x0102, "US", ushort(15)),
    element(0x0028, 0x0103, "US", ushort(1)),
    element(0x0028, 0x1050, "DS", padded("30")),
    element(0x0028, 0x1051, "DS", padded("80")),
    element(0x0020, 0x0037, "DS", padded("1\\0\\0\\0\\1\\0"))
  ];
}

function int16Pixels(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeInt16LE(value, index * 2));
  return bytes;
}

function pixelLayoutDicom(bitsAllocated: number, bitsStored: number, highBit: number, signed: boolean, pixels: Buffer): Buffer {
  const sopInstance = `1.2.826.0.1.3680043.10.900.${200 + bitsAllocated + bitsStored + Number(signed)}`;
  const replacedTags = new Set(["00280010", "00280011", "00280100", "00280101", "00280102", "00280103"]);
  const base = baseElements(MR_SOP, sopInstance).filter((entry) => !replacedTags.has(entry.readUInt16LE(0).toString(16).padStart(4, "0") + entry.readUInt16LE(2).toString(16).padStart(4, "0")));
  const allocatedValue = ushort(bitsAllocated);
  return part10(Buffer.concat([
    ...base,
    element(0x0028, 0x0010, "US", ushort(1)),
    element(0x0028, 0x0011, "US", ushort(pixels.length / (bitsAllocated / 8))),
    element(0x0028, 0x0100, "US", allocatedValue),
    element(0x0028, 0x0101, "US", ushort(bitsStored)),
    element(0x0028, 0x0102, "US", ushort(highBit)),
    element(0x0028, 0x0103, "US", ushort(Number(signed))),
    element(0x7fe0, 0x0010, "OW", pixels)
  ]), MR_SOP, sopInstance);
}

function uint32Pixels(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32LE(value >>> 0, index * 4));
  return bytes;
}

function shifted12BitPixels(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(((value & 0xfff) << 3) | 5, index * 2));
  return bytes;
}

function classicDicom(values = [-5, 0, 5, 10], sopClass = MR_SOP, sopInstance = "1.2.826.0.1.3680043.10.900.101", z = 0, transferSyntax?: string): Buffer {
  const data = [
    ...baseElements(sopClass, sopInstance),
    element(0x0020, 0x0032, "DS", padded(`0\\0\\${z}`)),
    element(0x0020, 0x0100, "IS", padded("1")),
    element(0x0018, 0x1060, "DS", padded("40")),
    element(0x0028, 0x1052, "DS", padded("-10")),
    element(0x0028, 0x1053, "DS", padded("2")),
    element(0x7fe0, 0x0010, "OW", int16Pixels(values))
  ];
  return part10(Buffer.concat(data), sopClass, sopInstance, transferSyntax);
}

function mockItkImage(overrides: Partial<{
  imageType: { dimension: number; components: number };
  size: number[];
  origin: number[];
  spacing: number[];
  direction: Float64Array;
  data: Float64Array;
}> = {}) {
  return {
    imageType: { dimension: 3, components: 1 },
    size: [2, 2, 1],
    origin: [0, 0, 0],
    spacing: [0.9, 0.8, 2.5],
    direction: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    data: new Float64Array([-20, -10, 0, 10]),
    ...overrides
  };
}

function enhancedDicom(): Buffer {
  const sopInstance = "1.2.826.0.1.3680043.10.900.150";
  const dimensions = sequence(0x0020, 0x9222, [
    item(Buffer.concat([
      element(0x0020, 0x9165, "AT", at(0x0020, 0x9057)),
      element(0x0020, 0x9167, "AT", at(0x0020, 0x9111))
    ])),
    item(Buffer.concat([
      element(0x0020, 0x9165, "AT", at(0x0020, 0x9128)),
      element(0x0020, 0x9167, "AT", at(0x0020, 0x9111))
    ]))
  ]);
  const shared = sequence(0x5200, 0x9229, [item(Buffer.concat([
    sequence(0x0028, 0x9110, [item(element(0x0028, 0x0030, "DS", padded("0.8\\0.9")))]),
    sequence(0x0020, 0x9116, [item(element(0x0020, 0x0037, "DS", padded("1\\0\\0\\0\\1\\0")))])
  ]))]);
  const positions = [
    { z: 0, spatial: 1, temporal: 1, slope: 1, intercept: -1 },
    { z: 5, spatial: 2, temporal: 1, slope: 2, intercept: -2 },
    { z: 0, spatial: 1, temporal: 2, slope: 3, intercept: -3 },
    { z: 5, spatial: 2, temporal: 2, slope: 4, intercept: -4 }
  ];
  const perFrames = sequence(0x5200, 0x9230, positions.map(({ z, spatial, temporal, slope, intercept }) => item(Buffer.concat([
    sequence(0x0020, 0x9111, [item(Buffer.concat([
      element(0x0020, 0x9057, "UL", ulong(spatial)),
      element(0x0020, 0x9128, "UL", ulong(temporal)),
      element(0x0020, 0x9157, "UL", Buffer.concat([ulong(spatial), ulong(temporal)]))
    ]))]),
    sequence(0x0020, 0x9113, [item(element(0x0020, 0x0032, "DS", padded(`0\\0\\${z}`))) ]),
    sequence(0x0028, 0x9145, [item(Buffer.concat([
      element(0x0028, 0x1052, "DS", padded(String(intercept))),
      element(0x0028, 0x1053, "DS", padded(String(slope)))
    ]))])
  ]))));
  const pixels = int16Pixels([10, 11, 20, 21, 30, 31, 40, 41]);
  const dataset = Buffer.concat([
    ...baseElements(MR_SOP, sopInstance).filter((entry) => !(entry.readUInt16LE(0) === 0x0028 && entry.readUInt16LE(2) === 0x0030)),
    element(0x0028, 0x0010, "US", ushort(1)),
    element(0x0028, 0x0011, "US", ushort(2)),
    element(0x0028, 0x0103, "US", ushort(0)),
    element(0x0028, 0x1052, "DS", padded("0")),
    element(0x0028, 0x1053, "DS", padded("1")),
    element(0x0028, 0x0008, "IS", padded("4")),
    dimensions,
    shared,
    perFrames,
    element(0x7fe0, 0x0010, "OW", pixels)
  ]);
  return part10(dataset, MR_SOP, sopInstance);
}

function upload(bytes: Buffer, name = "sample.dcm"): File {
  return new File([new Uint8Array(bytes)], name, { type: "application/dicom" });
}

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function zipStore(name: string, content: Buffer): Buffer {
  const fileName = Buffer.from(name, "utf8");
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const localRecord = Buffer.concat([local, fileName, content]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const centralRecord = Buffer.concat([central, fileName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralRecord.length, 12);
  end.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, end]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(readImageNode).mockReset();
  await Promise.all(studies.splice(0).map((id) => disposeStudy(id).catch(() => undefined)));
});

describe("cancelled imports", () => {
  const registry = () => (globalThis as unknown as {
    __cmrPrismStudySourceRegistryV1: { sessions: Map<string, unknown>; decodedCache: Map<string, { studyId: string }> }
  }).__cmrPrismStudySourceRegistryV1;
  const snapshot = async () => ({
    sessions: new Set(registry().sessions.keys()),
    directories: new Set((await readdir(tmpdir())).filter(name => name.startsWith("cmr-prism-")))
  });
  const expectClean = async (before: Awaited<ReturnType<typeof snapshot>>) => {
    expect(new Set(registry().sessions.keys())).toEqual(before.sessions);
    expect(new Set((await readdir(tmpdir())).filter(name => name.startsWith("cmr-prism-")))).toEqual(before.directories);
    expect([...registry().decodedCache.values()].every(entry => before.sessions.has(entry.studyId))).toBe(true);
  };

  it("rejects an already-cancelled import and an HTTP abort after multipart parsing", async () => {
    const before = await snapshot(), controller = new AbortController();
    controller.abort();
    const stream = vi.fn(() => { throw new Error("must not consume a cancelled upload"); });
    await expect(importStudy([{ name: "cancelled.dcm", size: 1, stream } as unknown as File], controller.signal))
      .rejects.toMatchObject({ code: "IMPORT_CANCELLED", status: 499 });
    expect(stream).not.toHaveBeenCalled();
    const requestController = new AbortController(), form = new FormData();
    form.append("files", upload(classicDicom()));
    const response = await POST({
      headers: new Headers(), signal: requestController.signal,
      formData: async () => { requestController.abort(); return form; }
    } as unknown as Request);
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ code: "IMPORT_CANCELLED" });
    await expectClean(before);
  });

  it("cancels a partially copied upload stream and removes the private directory", async () => {
    const before = await snapshot(), controller = new AbortController();
    const cancelled = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const file = {
      name: "partial.dcm", size: 4096,
      stream: () => new ReadableStream<Uint8Array>({
        start(streamController) { streamController.enqueue(new Uint8Array(32)); started(); },
        cancel: cancelled
      })
    } as unknown as File;
    const pending = importStudy([file], controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    await ready;
    controller.abort();
    await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
    await expectClean(before);
  });

  it("closes both the ZIP entry stream and archive handle before removing cancelled extraction", async () => {
    const before = await snapshot(), controller = new AbortController();
    let entryClosed = false, archiveClosed = false;
    const openReadStream = yauzl.ZipFile.prototype.openReadStream;
    vi.spyOn(yauzl.ZipFile.prototype, "openReadStream").mockImplementation(function (this: yauzl.ZipFile, entry, callback) {
      this.once("close", () => { archiveClosed = true; });
      openReadStream.call(this, entry, (error, stream) => {
        if (stream) {
          stream.once("close", () => { entryClosed = true; });
          stream.once("data", () => controller.abort());
        }
        callback(error, stream);
      });
    });
    const content = Buffer.concat([classicDicom(), Buffer.alloc(256 * 1024)]);
    await expect(importStudy([upload(zipStore("image.dcm", content), "cancelled.zip")], controller.signal))
      .rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    expect(controller.signal.aborted).toBe(true);
    expect(entryClosed).toBe(true);
    expect(archiveClosed).toBe(true);
    await expectClean(before);
  });

  it("waits for active decode workers before cleaning a cancelled parse", async () => {
    const before = await snapshot(), controller = new AbortController();
    let finishDecode!: () => void, decodeStarted!: () => void;
    const ready = new Promise<void>(resolve => { decodeStarted = resolve; });
    const decode = new Promise<void>(resolve => { finishDecode = resolve; });
    vi.mocked(readImageNode).mockImplementation(async () => {
      decodeStarted(); await decode; return mockItkImage() as never;
    });
    const compressed = upload(classicDicom(undefined, MR_SOP, "1.2.826.0.1.3680043.10.900.181", 0, "1.2.840.10008.1.2.4.50"));
    const pending = importStudy([compressed, upload(classicDicom())], controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    await ready;
    controller.abort(); finishDecode();
    await rejected;
    await expectClean(before);
  });

  it("removes a session and decoded pixels when cancellation arrives during catalog finalization", async () => {
    const before = await snapshot(), controller = new AbortController();
    const instance = "1.2.826.0.1.3680043.10.900.182";
    const noWindow = baseElements(MR_SOP, instance).filter(entry => entry.readUInt16LE(0) !== 0x0028 || ![0x1050, 0x1051].includes(entry.readUInt16LE(2)));
    const bytes = part10(Buffer.concat([
      ...noWindow, element(0x0020, 0x0032, "DS", padded("0\\0\\0")),
      element(0x7fe0, 0x0010, "OW", int16Pixels([-5, 0, 5, 10]))
    ]), MR_SOP, instance, "1.2.840.10008.1.2.4.50");
    let calls = 0, registeredId: string | undefined;
    vi.mocked(readImageNode).mockImplementation(async () => {
      if (++calls === 2) {
        registeredId = [...registry().sessions.keys()].find(id => !before.sessions.has(id));
        controller.abort();
      }
      return mockItkImage() as never;
    });
    await expect(importStudy([upload(bytes)], controller.signal)).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
    expect(registeredId).toBeDefined();
    expect(() => getStudy(registeredId!)).toThrowError(StudySourceError);
    await expectClean(before);
  });
});

describe("StudySource DICOM import and scalar reads", () => {
  it("decodes signed classic MR pixels, applies rescale once, and retains MONOCHROME1", async () => {
    const catalog = await importStudy([upload(classicDicom())]);
    studies.push(catalog.id);
    expect(catalog.report).toMatchObject({ acceptedInstances: 1, acceptedFrames: 1, skippedObjects: 0, failedFiles: 0 });
    const descriptor = Object.values(catalog.frames)[0];
    expect(descriptor.photometric).toBe("MONOCHROME1");
    expect(descriptor.temporalPosition).toBe(1);
    expect(descriptor.triggerMs).toBe(40);
    expect(descriptor.geometry?.pixelSpacing).toEqual([0.8, 0.9]);
    const catalogJson = JSON.stringify(catalog);
    expect(catalogJson).not.toContain(STUDY_UID);
    expect(catalogJson).not.toContain(SERIES_UID);
    expect(catalogJson).not.toContain(FOR_UID);
    expect(catalogJson).not.toMatch(/PatientName|PatientID|SOPInstanceUID/i);
    const pixels = await readScalarFrame(catalog.id, descriptor.id);
    expect(Array.from(pixels)).toEqual([-20, -10, 0, 10]);
  });

  it("preserves unsigned and signed 32-bit samples without bitwise truncation", async () => {
    const unsigned = await importStudy([upload(pixelLayoutDicom(32, 32, 31, false, uint32Pixels([0x8000_0000, 0xffff_ffff])))]);
    studies.push(unsigned.id);
    const unsignedFrame = Object.keys(unsigned.frames)[0];
    expect(Array.from(await readScalarFrame(unsigned.id, unsignedFrame))).toEqual([2 ** 31, 2 ** 32]);

    const signed = await importStudy([upload(pixelLayoutDicom(32, 32, 31, true, uint32Pixels([0x8000_0000, 0x7fff_ffff])))]);
    studies.push(signed.id);
    const signedFrame = Object.keys(signed.frames)[0];
    expect(Array.from(await readScalarFrame(signed.id, signedFrame))).toEqual([-(2 ** 31), 2 ** 31]);
  });

  it("extracts stored signed samples from a non-byte-aligned HighBit layout", async () => {
    const catalog = await importStudy([upload(pixelLayoutDicom(16, 12, 14, true, shifted12BitPixels([-1, -2048, 2047])))]);
    studies.push(catalog.id);
    const frameId = Object.keys(catalog.frames)[0];
    expect(Array.from(await readScalarFrame(catalog.id, frameId))).toEqual([-1, -2048, 2047]);
  });

  it("accepts compressed single-frame pixels only when ITK geometry matches DICOM geometry", async () => {
    vi.mocked(readImageNode).mockResolvedValue(mockItkImage() as never);
    const catalog = await importStudy([upload(classicDicom(undefined, MR_SOP, "1.2.826.0.1.3680043.10.900.171", 0, "1.2.840.10008.1.2.4.50"))]);
    studies.push(catalog.id);
    expect(catalog.report).toMatchObject({ acceptedInstances: 1, acceptedFrames: 1, failedFiles: 0 });
    const frameId = Object.keys(catalog.frames)[0];
    expect(Array.from(await readScalarFrame(catalog.id, frameId))).toEqual([-20, -10, 0, 10]);
  });

  it("rejects compressed pixels when ITK reorients the plane or returns mismatched dimensions", async () => {
    const compressed = upload(classicDicom(undefined, MR_SOP, "1.2.826.0.1.3680043.10.900.172", 0, "1.2.840.10008.1.2.4.50"), "compressed.dcm");
    vi.mocked(readImageNode).mockResolvedValue(mockItkImage({
      direction: new Float64Array([-1, 0, 0, 0, -1, 0, 0, 0, 1]),
      data: new Float64Array([10, 0, -10, -20])
    }) as never);
    const reoriented = await importStudy([upload(classicDicom()), compressed]);
    studies.push(reoriented.id);
    expect(reoriented.report).toMatchObject({ acceptedInstances: 1, failedFiles: 1 });
    expect(Object.values(reoriented.frames)).toHaveLength(1);

    vi.mocked(readImageNode).mockResolvedValue(mockItkImage({ size: [1, 4, 1] }) as never);
    const mismatchedSize = await importStudy([upload(classicDicom()), upload(classicDicom(undefined, MR_SOP, "1.2.826.0.1.3680043.10.900.173", 0, "1.2.840.10008.1.2.4.50"))]);
    studies.push(mismatchedSize.id);
    expect(mismatchedSize.report).toMatchObject({ acceptedInstances: 1, failedFiles: 1 });
    expect(Object.values(mismatchedSize.frames)).toHaveLength(1);
  });

  it("uses Enhanced MR dimension pointers and per-frame plane, phase, and rescale metadata", async () => {
    const catalog = await importStudy([upload(enhancedDicom())]);
    studies.push(catalog.id);
    expect(catalog.report.acceptedFrames).toBe(4);
    const descriptors = Object.values(catalog.frames);
    expect(descriptors.map((frame) => frame.dimensionValues)).toEqual([
      { inStackPositionNumber: 1, temporalPositionIndex: 1 },
      { inStackPositionNumber: 2, temporalPositionIndex: 1 },
      { inStackPositionNumber: 1, temporalPositionIndex: 2 },
      { inStackPositionNumber: 2, temporalPositionIndex: 2 }
    ]);
    expect(descriptors.map((frame) => frame.geometry?.origin[2])).toEqual([0, 5, 0, 5]);
    const pixels = await Promise.all(descriptors.map((frame) => readScalarFrame(catalog.id, frame.id)));
    expect(pixels.map((frame) => frame[0])).toEqual([9, 38, 87, 156]);
  });

  it("skips presentation states and reports corrupt objects without dropping readable MR", async () => {
    const catalog = await importStudy([
      upload(classicDicom()),
      upload(classicDicom([0, 0, 0, 0], PR_SOP, "1.2.826.0.1.3680043.10.900.102"), "presentation.dcm"),
      upload(Buffer.from("not dicom"), "broken.dcm")
    ]);
    studies.push(catalog.id);
    expect(catalog.report).toMatchObject({ acceptedInstances: 1, skippedObjects: 1, failedFiles: 1 });
    expect(JSON.stringify(catalog)).not.toMatch(/patient|broken\.dcm|presentation\.dcm/i);
  });

  it("rejects ZIP traversal and enforces the upload cap before consuming file streams", async () => {
    await expect(importStudy([upload(zipStore("../outside.dcm", classicDicom()), "unsafe.zip")]))
      .rejects.toMatchObject({ code: "UNSAFE_ARCHIVE", status: 400 });
    const mixed = await importStudy([
      upload(classicDicom()),
      upload(zipStore("../outside.dcm", classicDicom()), "unsafe.zip")
    ]);
    studies.push(mixed.id);
    expect(mixed.report).toMatchObject({ acceptedInstances: 1, failedFiles: 1 });

    const safeArchive = await importStudy([upload(zipStore("nested/image.dcm", classicDicom()), "safe.zip")]);
    studies.push(safeArchive.id);
    expect(safeArchive.report).toMatchObject({ acceptedInstances: 1, failedFiles: 0 });

    expect(STUDY_SOURCE_LIMITS.maxImportBytes).toBe(1024 * 1024 * 1024);
    const tooLarge = { name: "large.dcm", size: STUDY_SOURCE_LIMITS.maxImportBytes + 1, stream: () => { throw new Error("must not read"); } } as unknown as File;
    await expect(importStudy([tooLarge])).rejects.toMatchObject({ code: "IMPORT_TOO_LARGE", status: 413 });
  });

  it("deduplicates parallel frame reads and removes cache/session data on disposal", async () => {
    const existingTempEntries = new Set(await readdir(tmpdir()));
    const catalog = await importStudy([upload(classicDicom())]);
    studies.push(catalog.id);
    const createdTempEntries = (await readdir(tmpdir())).filter((entry) => entry.startsWith("cmr-prism-") && !existingTempEntries.has(entry));
    expect(createdTempEntries.length).toBe(1);
    const frameId = Object.keys(catalog.frames)[0];
    const [first, second] = await Promise.all([
      readScalarFrame(catalog.id, frameId),
      readScalarFrame(catalog.id, frameId)
    ]);
    expect(first).toBe(second);
    expect(getStudy(catalog.id).id).toBe(catalog.id);
    await disposeStudy(catalog.id);
    studies.splice(studies.indexOf(catalog.id), 1);
    expect(() => getStudy(catalog.id)).toThrowError(StudySourceError);
    await expect(readScalarFrame(catalog.id, frameId)).rejects.toMatchObject({ code: "STUDY_NOT_FOUND" });
    expect(await readdir(tmpdir())).not.toContain(createdTempEntries[0]);
  });
});
