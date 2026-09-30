import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { disposeStudy, importStudyPaths } from "../src/server/studySource";

// Local metadata inventory: omit patient identity, raw UIDs and file names.
const directory = resolve(process.cwd(), "..", "cmr-eg");
const files = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name));
const catalog = await importStudyPaths(files);
try {
  const groups = new Map<string, typeof catalog.collections>();
  for (const collection of catalog.collections) {
    const key = `${collection.label}\t${collection.kind}`;
    const group = groups.get(key) ?? [];
    group.push(collection); groups.set(key, group);
  }
  const rows = [...groups.values()].map((collections) => {
    const frameIds = [...new Set(collections.flatMap((c) => c.planes.flatMap((p) => p.frameIds.filter((id): id is string => id !== null))))];
    const frames = frameIds.map((id) => catalog.frames[id]);
    const values = (key: "trMs" | "teMs" | "tiMs" | "flipAngle") => [...new Set(frames.map((f) => f.parameters[key]).filter((v): v is number => v !== undefined))].sort((a, b) => a - b);
    return {
      description: collections[0].label,
      kind: collections[0].kind,
      views: [...new Set(collections.map((c) => c.view))],
      sourceSeries: new Set(frames.map((f) => f.seriesId)).size,
      collections: collections.length,
      images: frames.length,
      shapes: collections.map((c) => ({ planes: c.planes.length, framesPerPlane: [...new Set(c.planes.map((p) => p.frameIds.filter(Boolean).length))], axis: c.axisKind })),
      protocol: [...new Set(frames.map((f) => f.protocolName).filter(Boolean))],
      sequenceName: [...new Set(frames.map((f) => f.sequenceName).filter(Boolean))],
      imageTypes: [...new Set(frames.map((f) => f.imageType.join("\\")))],
      imageTypeCounts: Object.fromEntries([...new Set(frames.map((f) => f.imageType.join("\\")))].map((type) => [type, frames.filter((f) => f.imageType.join("\\") === type).length])),
      trMs: values("trMs"), teMs: values("teMs"), tiMs: values("tiMs"), flipAngle: values("flipAngle"),
    };
  }).sort((a, b) => a.description.localeCompare(b.description));
  console.log(JSON.stringify({ directoryFiles: files.length, report: catalog.report, sourceImageSeries: new Set(Object.values(catalog.frames).map((f) => f.seriesId)).size, collections: catalog.collections.length, rows }, null, 2));
} finally {
  await disposeStudy(catalog.id);
}
