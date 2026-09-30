"use client";

import { useEffect, useState } from "react";

/** Store only the appearance preference; study/session data remain temporary. */
export function useColorTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try { if (localStorage.getItem("cmr-prism-theme") === "dark") setTheme("dark"); } catch { /* Storage may be disabled. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (ready) try { localStorage.setItem("cmr-prism-theme", theme); } catch { /* Appearance still works without storage. */ }
  }, [theme, ready]);
  return { theme, toggleTheme: () => setTheme((current) => current === "light" ? "dark" : "light") };
}
