/**
 * Shared chrome for the standalone viewers (the MCP embedded viewer and the
 * single-file HTML export): the web app's theme + mode choices, compacted.
 * Lives beside the entries so both stay visually identical to the app
 * (same ThemeProvider, same storage keys — theme choice persists per origin).
 */
import React from "react";
import { THEMES, useTheme, type ColorMode } from "@/components/theme/theme-context";

const MODES: { id: ColorMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export function ThemeControls() {
  const { theme, setTheme, mode, setMode } = useTheme();
  const selectClass =
    "rounded-badge border border-border-default bg-surface-1 px-1.5 py-0.5 text-xs " +
    "text-t-secondary focus:outline-none focus:ring-1 focus:ring-accent";
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <select
        aria-label="Theme"
        className={selectClass}
        value={theme}
        onChange={(e) => setTheme(e.target.value as (typeof THEMES)[number]["id"])}
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Color mode"
        className={selectClass}
        value={mode}
        onChange={(e) => setMode(e.target.value as ColorMode)}
      >
        {MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </span>
  );
}
