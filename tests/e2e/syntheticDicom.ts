import dcmjs from "dcmjs";

const MR_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.4";
const PR_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.11.1";
const STUDY_UID = "2.25.310000000000000000000000000000000001";
const FRAME_OF_REFERENCE_UID = "2.25.310000000000000000000000000000000002";
const TRANSFER_SYNTAX_UID = "1.2.840.10008.1.2.1";
const ROWS = 8;
const COLUMNS = 8;

export type SyntheticUpload = { name: string; mimeType: string; buffer: Buffer };

type Series = {
  name: string;
  description: string;
  view: "SAX" | "2CH" | "3CH" | "4CH";
  phases: number[];
  planeOffsets: number[];
  row: [number, number, number];
  column: [number, number, number];
};

const saxSeries: Series = {
  name: "synthetic-sax",
  description: "SAX Cine bSSFP synthetic",
  view: "SAX",
  phases: [100, 410, 790],
  planeOffsets: [-1.2, 1.2],
  row: [1, 0, 0],
  column: [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)],
};

const longAxisSeries: Series[] = [
  {
    name: "synthetic-2ch",
    description: "2CH Cine bSSFP synthetic",
    view: "2CH",
    phases: [40, 240, 500, 830],
    planeOffsets: [0],
    row: [1, 0, 0],
    column: [0, 0, 1],
  },
  {
    name: "synthetic-3ch",
    description: "3CH Cine bSSFP synthetic",
    view: "3CH",
    phases: [70, 370, 730],
    planeOffsets: [0],
    row: [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0],
    column: [0, 0, 1],
  },
  {
    name: "synthetic-4ch",
    description: "4CH Cine bSSFP synthetic",
    view: "4CH",
    phases: [130, 480],
    planeOffsets: [0],
    row: [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4), 0],
    column: [0, 0, 1],
  },
];

function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(value: number[]): [number, number, number] {
  const magnitude = Math.hypot(...value);
  return [value[0] / magnitude, value[1] / magnitude, value[2] / magnitude];
}

function subtractScaled(a: number[], b: number[], amount: number): [number, number, number] {
  return [a[0] - b[0] * amount, a[1] - b[1] * amount, a[2] - b[2] * amount];
}

function dicomDecimal(value: number): number {
  return Number(value.toFixed(6));
}

function imagePosition(series: Series, planeOffset: number): [number, number, number] {
  const row = normalize(series.row);
  const column = normalize(series.column);
  const normal = normalize(cross(row, column));
  const center = normal.map((value) => value * planeOffset);
  return subtractScaled(subtractScaled(center, row, (COLUMNS - 1) / 2), column, (ROWS - 1) / 2).map(dicomDecimal) as [number, number, number];
}

function dicomBytes(dataset: Record<string, unknown>): Buffer {
  const data = (dcmjs as any).data;
  const naturalMeta = {
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: dataset.SOPClassUID,
    MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
    TransferSyntaxUID: TRANSFER_SYNTAX_UID,
    ImplementationClassUID: "2.25.310000000000000000000000000000000003",
    ImplementationVersionName: "CMRPRISME2E",
  };
  const dictionary = new data.DicomDict(data.DicomMetaDictionary.denaturalizeDataset(naturalMeta));
  dictionary.dict = data.DicomMetaDictionary.denaturalizeDataset(dataset);
  return Buffer.from(dictionary.write());
}

function makeImage(series: Series, planeIndex: number, phaseIndex: number, instanceNumber: number): SyntheticUpload {
  const sopInstance = `2.25.31000000000000000000000000000000${String(instanceNumber).padStart(4, "0")}`;
  const values = new Uint16Array(ROWS * COLUMNS);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = 120 + planeIndex * 70 + phaseIndex * 160 + ((index * 13 + index % 7 * 19) % 700);
  }
  const dataset: Record<string, unknown> = {
    SpecificCharacterSet: "ISO_IR 100",
    SOPClassUID: MR_SOP_CLASS,
    SOPInstanceUID: sopInstance,
    Modality: "MR",
    StudyInstanceUID: STUDY_UID,
    SeriesInstanceUID: seriesUid(series.name),
    FrameOfReferenceUID: FRAME_OF_REFERENCE_UID,
    SeriesDescription: series.description,
    ProtocolName: "CMR Prism synthetic protocol",
    SequenceName: "bSSFP",
    ImageType: ["ORIGINAL", "PRIMARY", "M", "ND"],
    PatientName: "Synthetic^CMR",
    PatientID: "CMR-PRISM-E2E",
    InstanceNumber: instanceNumber,
    Rows: ROWS,
    Columns: COLUMNS,
    SamplesPerPixel: 1,
    PhotometricInterpretation: "MONOCHROME2",
    PixelSpacing: [1, 1],
    SliceThickness: 8,
    ImageOrientationPatient: [...series.row, ...series.column].map(dicomDecimal),
    ImagePositionPatient: imagePosition(series, series.planeOffsets[planeIndex]),
    BitsAllocated: 16,
    BitsStored: 16,
    HighBit: 15,
    PixelRepresentation: 0,
    _vrMap: { PixelData: "OW" },
    TemporalPositionIdentifier: 1,
    TriggerTime: series.phases[phaseIndex] + planeIndex * 13,
    RepetitionTime: 2.8,
    EchoTime: 1.4,
    FlipAngle: 45,
    RescaleSlope: 1,
    RescaleIntercept: 0,
    WindowCenter: 450,
    WindowWidth: 900,
    PixelData: values.buffer,
  };
  return { name: `${series.name}-${instanceNumber}.dcm`, mimeType: "application/dicom", buffer: dicomBytes(dataset) };
}

function seriesUid(name: string): string {
  const number = name === "synthetic-sax" ? 11 : name === "synthetic-2ch" ? 12 : name === "synthetic-3ch" ? 13 : 14;
  return `2.25.3100000000000000000000000000000000${number}`;
}

function makePresentationState(): SyntheticUpload {
  const instance = "2.25.310000000000000000000000000000000050";
  const bytes = dicomBytes({
    SOPClassUID: PR_SOP_CLASS,
    SOPInstanceUID: instance,
    Modality: "PR",
    StudyInstanceUID: STUDY_UID,
    SeriesInstanceUID: "2.25.310000000000000000000000000000000051",
    SeriesDescription: "Synthetic grayscale presentation state",
  });
  return { name: "synthetic-presentation-state.dcm", mimeType: "application/dicom", buffer: bytes };
}

/** Includes non-axial SAX, three differently sampled LAX views, PR, and one corrupt file. */
export function createSyntheticStudyUploads(): SyntheticUpload[] {
  const uploads: SyntheticUpload[] = [];
  let instanceNumber = 1;
  for (const series of [saxSeries, ...longAxisSeries]) {
    for (let planeIndex = 0; planeIndex < series.planeOffsets.length; planeIndex += 1) {
      for (let phaseIndex = 0; phaseIndex < series.phases.length; phaseIndex += 1) {
        uploads.push(makeImage(series, planeIndex, phaseIndex, instanceNumber));
        instanceNumber += 1;
      }
    }
  }
  uploads.push(makePresentationState());
  uploads.push({ name: "synthetic-corrupt.dcm", mimeType: "application/dicom", buffer: Buffer.from("not a DICOM file") });
  return uploads;
}
