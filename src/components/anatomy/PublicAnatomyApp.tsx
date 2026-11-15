"use client";

import { useColorTheme } from "@/client/useColorTheme";
import { LanguageSwitch, useI18n } from "@/i18n";
import AnatomyClassroom from "./AnatomyClassroom";

/** This entry has no dependency on the local DICOM viewer or its server API. */
export default function PublicAnatomyApp() {
  const { theme, toggleTheme } = useColorTheme();
  const { t } = useI18n();
  return <main className="prism-shell is-empty has-anatomy" data-testid="public-anatomy-app">
    <AnatomyClassroom theme={theme} publicOnly headerActions={<div className="header-actions">
      <LanguageSwitch />
      <button type="button" className="theme-toggle" aria-label={t(theme === "light" ? "切换暗色模式" : "切换浅色模式")} aria-pressed={theme === "dark"} onClick={toggleTheme}>{t(theme === "light" ? "☾ 暗色" : "☀ 浅色")}</button>
      <a className="classroom-source" href="https://github.com/woyeyao/cmr-prism" target="_blank" rel="noreferrer">{t("源码")} ↗</a>
    </div>} />
  </main>;
}
