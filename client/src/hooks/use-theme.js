import { useEffect, useState } from "react";
import { applyTheme, readStoredTheme, resolveDark, THEME_CHANGE_EVENT } from "../lib/theme.js";

export function useTheme() {
  const [mode, setMode] = useState(readStoredTheme);
  const [dark, setDark] = useState(() => resolveDark(mode));

  useEffect(() => {
    const sync = () => {
      const next = readStoredTheme();
      setMode(next);
      setDark(resolveDark(next));
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMediaChange = () => {
      applyTheme(readStoredTheme());
    };
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    media.addEventListener("change", onMediaChange);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, sync);
      media.removeEventListener("change", onMediaChange);
    };
  }, []);

  return { dark, mode, setTheme: applyTheme };
}
