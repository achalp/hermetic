"use client";

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";

export type ThemeId = "vanilla" | "stamen" | "iib" | "pentagram";

export const THEMES: { id: ThemeId; label: string; description: string }[] = [
  { id: "vanilla", label: "Vanilla", description: "Clean defaults" },
  { id: "stamen", label: "Stamen", description: "Cartographic precision" },
  { id: "iib", label: "Info is Beautiful", description: "Vivid & encyclopedic" },
  { id: "pentagram", label: "Pentagram", description: "Reductive authority" },
];

const STORAGE_KEY = "gud-theme";

interface ThemeContextValue {
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "vanilla",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>("vanilla");
  const [mounted, setMounted] = useState(false);

  // Read from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (stored && THEMES.some((t) => t.id === stored)) {
      setThemeState(stored);
    }
    setMounted(true);
  }, []);

  // Apply data-theme attribute on <html>
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme, mounted]);

  const setTheme = useCallback((t: ThemeId) => {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
