"use client";

import { useI18n } from "@/i18n";

export default function AnatomySources() {
  const { t } = useI18n();
  return <details className="anatomy-sources"><summary>{t("模型署名与来源")}<span aria-hidden="true">↗</span></summary>
    <ul>
      <li><strong>BodyParts3D v4.0</strong><span>© The Database Center for Life Science · CC BY 4.0</span><a href="https://dbarchive.biosciencedbc.jp/en/bodyparts3d/" target="_blank" rel="noreferrer">dbarchive.biosciencedbc.jp/en/bodyparts3d/ ↗</a></li>
      <li><strong>{t("HRA 女性心脏 / 血管 v1.3")}</strong><span>{t("Kristen Browne、Heidi Schlehlein · CC BY 4.0")}</span><a href="https://humanatlas.io/3d-reference-library" target="_blank" rel="noreferrer">humanatlas.io/3d-reference-library ↗</a><span><a href="https://doi.org/10.48539/HBM449.SHRV.225" target="_blank" rel="noreferrer">{t("心脏 DOI")}</a> · <a href="https://doi.org/10.48539/HBM322.KKFC.394" target="_blank" rel="noreferrer">{t("血管 DOI")}</a></span></li>
      <li><strong>{t("AMRG CMR 参考影像")}</strong><span>Auckland MRI Research Group, New Zealand · Public domain</span><a href="https://www.cardiacatlas.org/amrg-cardiac-atlas/" target="_blank" rel="noreferrer">cardiacatlas.org/amrg-cardiac-atlas/ ↗</a></li>
      <li><strong>{t("交互参考 · Kalani Cardio Atlas")}</strong><a href="https://kalanimd.com/cardio-atlas/index.html" target="_blank" rel="noreferrer">kalanimd.com/cardio-atlas/ ↗</a></li>
    </ul>
    <p>{t("网格经裁剪、简化与量化处理；图谱切面为教学候选。")}<a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC7038611/" target="_blank" rel="noreferrer">{t("SCMR 标准 CMR 协议 ↗")}</a></p>
  </details>;
}
