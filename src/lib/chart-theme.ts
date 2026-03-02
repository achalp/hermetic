"use client";

import { useSyncExternalStore } from "react";
import type { PartialTheme } from "@nivo/theming";
import { useTheme, type ThemeId } from "./theme-context";
import { useThemeConfig } from "./theme-config";

/**
 * Named color palette for charts.
 * LLM can use names like "indigo" in color_map values, or raw hex codes.
 */
export const CHART_COLORS: Record<string, string> = {
  indigo: "#6366f1",
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  violet: "#8b5cf6",
  cyan: "#06b6d4",
  orange: "#f97316",
  pink: "#ec4899",
  sky: "#0ea5e9",
  lime: "#84cc16",
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
  teal: "#14b8a6",
  fuchsia: "#d946ef",
};

/** Per-theme chart color palettes */
const THEME_CHART_COLORS: Record<ThemeId, string[]> = {
  vanilla: [
    "#6366f1", // indigo
    "#10b981", // emerald
    "#f59e0b", // amber
    "#f43f5e", // rose
    "#8b5cf6", // violet
    "#06b6d4", // cyan
    "#f97316", // orange
    "#ec4899", // pink
  ],
  stamen: [
    "#204CE5", // Stamen blue
    "#D4956A", // warm terracotta
    "#6AAFB8", // muted teal
    "#8B72B0", // dusty purple
    "#5D8C4E", // sage green
    "#D45F3C", // burnt sienna
    "#F2C75C", // ochre yellow
    "#3A7CA5", // steel blue
  ],
  iib: [
    "#00ACC1", // teal
    "#F06292", // pink
    "#FFB74D", // amber
    "#7E57C2", // purple
    "#66BB6A", // green
    "#EF5350", // red
    "#42A5F5", // blue
    "#FF7043", // deep orange
  ],
  pentagram: [
    "#CC0000", // Pentagram red
    "#2B2B2B", // near-black
    "#6B7280", // gray
    "#B91C1C", // dark red
    "#9CA3AF", // light gray
    "#404040", // charcoal
    "#D1D5DB", // silver
    "#1F2937", // slate
  ],
};

/** Default ordered color sequence for charts (vanilla fallback for non-hook contexts) */
export const DEFAULT_CHART_COLORS = THEME_CHART_COLORS.vanilla;

/** Per-theme chart surface colors for axis text, tooltips, grids, scene backgrounds */
const THEME_CHART_SURFACE: Record<
  ThemeId,
  {
    light: { text: string; tooltipBg: string; gridBase: string; sceneBg: string };
    dark: { text: string; tooltipBg: string; gridBase: string; sceneBg: string };
  }
> = {
  vanilla: {
    light: { text: "#374151", tooltipBg: "#ffffff", gridBase: "0,0,0", sceneBg: "#ffffff" },
    dark: { text: "#e5e5e5", tooltipBg: "#1f2937", gridBase: "255,255,255", sceneBg: "#111827" },
  },
  stamen: {
    light: { text: "#112337", tooltipBg: "#FEFEFA", gridBase: "17,35,55", sceneBg: "#FEFEFA" },
    dark: { text: "#F0F0ED", tooltipBg: "#1E2E42", gridBase: "240,240,237", sceneBg: "#142030" },
  },
  iib: {
    light: { text: "#1A1A2E", tooltipBg: "#FFFFFF", gridBase: "26,26,46", sceneBg: "#FFFFFF" },
    dark: { text: "#F0F0F5", tooltipBg: "#252540", gridBase: "240,240,245", sceneBg: "#1A1A2E" },
  },
  pentagram: {
    light: { text: "#000000", tooltipBg: "#FFFFFF", gridBase: "0,0,0", sceneBg: "#FFFFFF" },
    dark: { text: "#FFFFFF", tooltipBg: "#161616", gridBase: "255,255,255", sceneBg: "#0A0A0A" },
  },
};

/** Per-theme trend / signal colors used for candlestick, regression, highlights */
const THEME_TREND_COLORS: Record<
  ThemeId,
  { light: { up: string; down: string }; dark: { up: string; down: string } }
> = {
  vanilla: {
    light: { up: "#16a34a", down: "#dc2626" },
    dark: { up: "#4ade80", down: "#f87171" },
  },
  stamen: {
    light: { up: "#5D8C4E", down: "#C05A3C" },
    dark: { up: "#7FB872", down: "#E07A5F" },
  },
  iib: {
    light: { up: "#43A047", down: "#E53935" },
    dark: { up: "#66BB6A", down: "#EF5350" },
  },
  pentagram: {
    light: { up: "#2B2B2B", down: "#CC0000" },
    dark: { up: "#FFFFFF", down: "#EF4444" },
  },
};

/** Resolve a named color or pass hex through */
export function resolveColor(nameOrHex: string): string {
  return CHART_COLORS[nameOrHex.toLowerCase()] ?? nameOrHex;
}

/** Resolve an array of named colors / hex codes */
export function resolveColors(arr: string[]): string[] {
  return arr.map(resolveColor);
}

/**
 * Resolve a color_map (keyed by series name) into a hex array aligned to keys,
 * falling back to DEFAULT_CHART_COLORS for unmapped keys.
 */
export function resolveColorMap(
  keys: string[],
  colorMap?: Record<string, string> | null
): string[] {
  if (!colorMap) return DEFAULT_CHART_COLORS.slice(0, keys.length);
  return keys.map(
    (k, i) =>
      resolveColor(colorMap[k] ?? "") || DEFAULT_CHART_COLORS[i % DEFAULT_CHART_COLORS.length]
  );
}

/**
 * Transform flat records into nivo line/area series format.
 * Input:  [{ month: "Jan", sales: 10, profit: 5 }, ...]
 * Output: [{ id: "sales", data: [{ x: "Jan", y: 10 }] }, { id: "profit", data: [...] }]
 */
export function toNivoLineSeries(
  data: Record<string, unknown>[],
  xKey: string,
  yKeys: string[]
): { id: string; data: { x: string | number; y: number | null }[] }[] {
  return yKeys.map((key) => ({
    id: key,
    data: data.map((row) => ({
      x: row[xKey] as string | number,
      y: row[key] != null ? Number(row[key]) : null,
    })),
  }));
}

/**
 * Abbreviate large numbers for axis ticks: 1500 → "1.5k", 2000000 → "2M".
 */
export function formatAxisNumber(v: number | string): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (isNaN(n)) return String(v);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * For point-scale x-axes (line/area charts), pick evenly-spaced tick values
 * so labels don't overlap. Returns undefined if all ticks fit.
 */
export function pickTickValues(
  data: Record<string, unknown>[],
  xKey: string,
  maxTicks = 12
): (string | number)[] | undefined {
  if (data.length <= maxTicks) return undefined;
  const step = Math.ceil(data.length / maxTicks);
  const ticks: (string | number)[] = [];
  for (let i = 0; i < data.length; i += step) {
    ticks.push(data[i][xKey] as string | number);
  }
  const last = data[data.length - 1][xKey] as string | number;
  if (ticks[ticks.length - 1] !== last) ticks.push(last);
  return ticks;
}

/** Shared hook for detecting dark mode */
function useDarkMode(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false
  );
}

/** Get chart colors for the active theme */
export function useChartColors(): string[] {
  const { theme } = useTheme();
  return THEME_CHART_COLORS[theme] ?? THEME_CHART_COLORS.vanilla;
}

/**
 * Theme-aware color map resolver (hook version).
 * Use this instead of resolveColorMap() in React components
 * so charts pick up the active theme's palette as default colors.
 */
export function useColorMap(keys: string[], colorMap?: Record<string, string> | null): string[] {
  const themeColors = useChartColors();
  if (!colorMap) return themeColors.slice(0, Math.max(keys.length, 1));
  return keys.map((k, i) => resolveColor(colorMap[k] ?? "") || themeColors[i % themeColors.length]);
}

/** Get theme-appropriate trend (up/down) colors for candlesticks, regression lines, etc. */
export function useTrendColors(): { up: string; down: string; upAlpha: string; downAlpha: string } {
  const { theme } = useTheme();
  const dark = useDarkMode();
  const colors = (THEME_TREND_COLORS[theme] ?? THEME_TREND_COLORS.vanilla)[dark ? "dark" : "light"];
  // Pre-compute 35% opacity variants for volume bars etc.
  const hexToAlpha = (hex: string) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},0.35)`;
  };
  return { ...colors, upAlpha: hexToAlpha(colors.up), downAlpha: hexToAlpha(colors.down) };
}

/** Plotly layout hook — adapts to theme config + dark mode */
export function usePlotlyLayout(): Record<string, unknown> {
  const dark = useDarkMode();
  const { theme } = useTheme();
  const config = useThemeConfig();
  const { chart } = config;
  const colors = THEME_CHART_COLORS[theme] ?? THEME_CHART_COLORS.vanilla;
  const surface = (THEME_CHART_SURFACE[theme] ?? THEME_CHART_SURFACE.vanilla)[
    dark ? "dark" : "light"
  ];

  const textColor = surface.text;
  const gridColor = `rgba(${surface.gridBase},${chart.gridOpacity})`;

  return {
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    colorway: colors,
    font: { color: textColor, size: chart.fontSize },
    xaxis: {
      gridcolor: gridColor,
      zerolinecolor: gridColor,
      showgrid: chart.enableGridX,
      automargin: true,
      ...(chart.gridDash ? { griddash: "dash" } : {}),
    },
    yaxis: {
      gridcolor: gridColor,
      zerolinecolor: gridColor,
      showgrid: chart.enableGridY,
      automargin: true,
      ...(chart.gridDash ? { griddash: "dash" } : {}),
    },
    margin: {
      t: chart.margin.top + 20,
      r: chart.margin.right,
      b: chart.margin.bottom,
      l: chart.margin.left,
    },
  };
}

/** Plotly 3D scene layout hook — adapts to theme config + dark mode */
export function usePlotly3DScene(): Record<string, unknown> {
  const dark = useDarkMode();
  const { theme } = useTheme();
  const config = useThemeConfig();
  const { chart } = config;
  const colors = THEME_CHART_COLORS[theme] ?? THEME_CHART_COLORS.vanilla;
  const surface = (THEME_CHART_SURFACE[theme] ?? THEME_CHART_SURFACE.vanilla)[
    dark ? "dark" : "light"
  ];

  const textColor = surface.text;
  const gridColor = `rgba(${surface.gridBase},${chart.gridOpacity})`;
  const bgColor = surface.sceneBg;

  return {
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    colorway: colors,
    font: { color: textColor, size: chart.fontSize },
    margin: { t: 30, r: 20, b: 30, l: 20 },
    scene: {
      bgcolor: bgColor,
      xaxis: { gridcolor: gridColor, color: textColor, showgrid: chart.enableGridY },
      yaxis: { gridcolor: gridColor, color: textColor, showgrid: chart.enableGridY },
      zaxis: { gridcolor: gridColor, color: textColor, showgrid: chart.enableGridY },
    },
  };
}

/** Nivo Theme hook — adapts to theme config + dark mode */
export function useNivoTheme(): PartialTheme {
  const dark = useDarkMode();
  const { theme } = useTheme();
  const config = useThemeConfig();
  const { chart } = config;
  const surface = (THEME_CHART_SURFACE[theme] ?? THEME_CHART_SURFACE.vanilla)[
    dark ? "dark" : "light"
  ];

  const textColor = surface.text;
  const baseGridColor = `rgba(${surface.gridBase},${chart.gridOpacity})`;

  // Make tooltip border dark-mode aware for themes that use it
  const tooltipBorder =
    chart.tooltipBorder !== "none"
      ? dark
        ? chart.tooltipBorder.replace("rgba(0,0,0,", "rgba(255,255,255,")
        : chart.tooltipBorder
      : undefined;

  return {
    text: { fill: textColor, fontSize: chart.fontSize },
    axis: {
      ticks: { text: { fill: textColor, fontSize: chart.fontSize - 1 } },
      legend: { text: { fill: textColor, fontSize: chart.fontSize } },
    },
    grid: {
      line: {
        stroke: baseGridColor,
        ...(chart.gridDash ? { strokeDasharray: chart.gridDash } : {}),
      },
    },
    tooltip: {
      container: {
        background: surface.tooltipBg,
        color: surface.text,
        fontSize: chart.fontSize,
        borderRadius: chart.tooltipRadius,
        boxShadow: chart.tooltipShadow,
        ...(tooltipBorder ? { border: tooltipBorder } : {}),
      },
    },
    legends: { text: { fill: textColor, fontSize: chart.fontSize - 1 } },
  };
}
