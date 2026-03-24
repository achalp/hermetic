"use client";

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";

export type ThemeId = "vanilla" | "stamen" | "iib" | "pentagram";
export type ColorMode = "light" | "dark" | "system";

export const THEMES: { id: ThemeId; label: string; description: string }[] = [
  { id: "vanilla", label: "Vanilla", description: "Clean defaults" },
  { id: "stamen", label: "Stamen", description: "Cartographic precision" },
  { id: "iib", label: "Info is Beautiful", description: "Vivid & encyclopedic" },
  { id: "pentagram", label: "Pentagram", description: "Reductive authority" },
];

const THEME_KEY = "gud-theme";
const MODE_KEY = "gud-mode";

function getStoredTheme(): ThemeId {
  if (typeof window === "undefined") return "vanilla";
  const stored = localStorage.getItem(THEME_KEY) as ThemeId | null;
  if (stored && THEMES.some((t) => t.id === stored)) return stored;
  return "vanilla";
}

function getStoredMode(): ColorMode {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(MODE_KEY) as ColorMode | null;
  if (stored && ["light", "dark", "system"].includes(stored)) return stored;
  return "system";
}

function applyMode(mode: ColorMode) {
  const html = document.documentElement;
  if (mode === "dark") {
    html.setAttribute("data-mode", "dark");
    html.style.colorScheme = "dark";
  } else if (mode === "light") {
    html.removeAttribute("data-mode");
    html.style.colorScheme = "light";
  } else {
    // system
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark) {
      html.setAttribute("data-mode", "dark");
      html.style.colorScheme = "dark";
    } else {
      html.removeAttribute("data-mode");
      html.style.colorScheme = "light";
    }
  }
}

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  mode: ColorMode;
  setMode: (m: ColorMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "vanilla",
  setTheme: () => {},
  mode: "system",
  setMode: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(getStoredTheme);
  const [mode, setModeState] = useState<ColorMode>(getStoredMode);

  // Apply data-theme attribute
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Apply color mode
  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  // Listen for system preference changes when in "system" mode
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (mode === "system") applyMode("system");
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode]);

  const setTheme = useCallback((t: ThemeId) => {
    setThemeState(t);
    localStorage.setItem(THEME_KEY, t);
  }, []);

  const setMode = useCallback((m: ColorMode) => {
    setModeState(m);
    localStorage.setItem(MODE_KEY, m);
    applyMode(m);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, mode, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
