import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANATOMY_VIEWS, prepareAnatomyModel } from "@/core/anatomy/data";
import { messages, translate } from "./messages";

describe("offline bilingual display", () => {
  it("covers every supplied structure, view and candidate-plane explanation", () => {
    const texts = ANATOMY_VIEWS.flatMap(view => [view.label, view.shortLabel, view.group, view.lesson, view.expected]);
    for (const id of ["bodyparts3d", "hra"] as const) {
      const model = prepareAnatomyModel(JSON.parse(readFileSync(new URL(`../../public/anatomy/${id}.json`, import.meta.url), "utf8")), id);
      texts.push(...model.meshes.map(mesh => mesh.label));
      texts.push(...model.presets.flatMap(plane => [plane.label, plane.description, plane.basis, plane.review, plane.sideA, plane.sideB]));
    }
    for (const text of texts) {
      expect(translate(text, "zh")).toBe(text);
      expect(translate(text, "en"), text).not.toMatch(/[\u3400-\u9fff]/);
    }
  });

  it("retains every interpolation field and leaves imported names intact", () => {
    const fields = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const [source, translated] of Object.entries(messages)) expect(fields(translated), source).toEqual(fields(source));
    expect(translate("AMRG {name}，第 {frame} 帧", "en", { name: "4CH", frame: 12 })).toBe("AMRG 4CH, frame 12");
    expect(translate("用户自定义扫描名称_01", "en")).toBe("用户自定义扫描名称_01");
    expect(translate("{axis} 轴平移", "zh", { axis: "X" })).toBe("X 轴平移");
  });
});
