"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { translate, type Locale, type MessageParams } from "./messages";
import "./language.css";

export { translate } from "./messages";
export type { Locale, MessageParams } from "./messages";
export type Translator = (message: string, params?: MessageParams) => string;

const STORAGE_KEY = "cmr-prism-locale";
interface I18nContextValue { locale: Locale; setLocale: (locale: Locale) => void; t: Translator }
const I18nContext = createContext<I18nContextValue>({ locale: "zh", setLocale: () => undefined, t: (message, params) => translate(message, "zh", params) });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>("zh");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "en" || saved === "zh") updateLocale(saved);
    } catch { /* A blocked storage API must not prevent using the app. */ }
  }, []);
  useEffect(() => { document.documentElement.lang = locale === "zh" ? "zh-CN" : "en"; }, [locale]);
  const setLocale = useCallback((next: Locale) => {
    updateLocale(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep the in-memory choice. */ }
  }, []);
  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t: (message, params) => translate(message, locale, params) }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() { return useContext(I18nContext); }

export function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  return <button type="button" className="language-switch" data-testid="language-switch"
    lang={locale === "zh" ? "en" : "zh-CN"} title={t(locale === "zh" ? "切换为英文" : "切换为中文")}
    onClick={() => setLocale(locale === "zh" ? "en" : "zh")}>{locale === "zh" ? "English" : "中文"}</button>;
}
