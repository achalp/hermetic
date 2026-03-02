"use client";

import { useTheme, type ThemeId } from "./theme-context";

/* ═══════════════════════════════════════════════════════════
   Theme Configuration — structural / behavioral tokens
   per theme that can't be expressed as simple CSS values.
   ═══════════════════════════════════════════════════════════ */

export interface ChartConfig {
  height: number;
  enableGridX: boolean;
  enableGridY: boolean;
  gridDash: string;
  gridOpacity: number;
  axisTickSize: number;
  barPadding: number;
  barRadius: number;
  pieCornerRadius: number;
  piePadAngle: number;
  pointSize: number;
  lineWidth: number;
  margin: { top: number; right: number; bottom: number; left: number };
  tooltipRadius: number;
  tooltipShadow: string;
  tooltipBorder: string;
  legendSymbolSize: number;
  fontSize: number;
}

export interface StatCardConfig {
  align: "center" | "left";
  valueClass: string;
  labelTransform: "none" | "uppercase";
  labelTracking: string;
  labelWeight: number;
}

export interface InsightConfig {
  borderSide: "left" | "top" | "none";
  bgTint: boolean;
}

export interface AnnotationConfig {
  bgFill: boolean;
  borderWidth: string;
}

export interface TableConfig {
  headerBg: boolean;
  headerTransform: "none" | "uppercase";
  headerBorderWidth: string;
  cellPadding: string;
}

export interface LayoutConfig {
  sectionGap: string;
  cardPadding: string;
}

export interface ThemeConfig {
  chart: ChartConfig;
  statCard: StatCardConfig;
  insight: InsightConfig;
  annotation: AnnotationConfig;
  table: TableConfig;
  layout: LayoutConfig;
}

const VANILLA: ThemeConfig = {
  chart: {
    height: 350,
    enableGridX: false,
    enableGridY: true,
    gridDash: "",
    gridOpacity: 0.1,
    axisTickSize: 5,
    barPadding: 0.3,
    barRadius: 0,
    pieCornerRadius: 3,
    piePadAngle: 0.7,
    pointSize: 6,
    lineWidth: 2,
    margin: { top: 10, right: 20, bottom: 50, left: 60 },
    tooltipRadius: 4,
    tooltipShadow: "0 2px 8px rgba(0,0,0,0.15)",
    tooltipBorder: "none",
    legendSymbolSize: 12,
    fontSize: 12,
  },
  statCard: {
    align: "center",
    valueClass: "text-xl",
    labelTransform: "none",
    labelTracking: "0",
    labelWeight: 500,
  },
  insight: { borderSide: "left", bgTint: false },
  annotation: { bgFill: true, borderWidth: "1px" },
  table: {
    headerBg: true,
    headerTransform: "none",
    headerBorderWidth: "1px",
    cellPadding: "px-3 py-2",
  },
  layout: { sectionGap: "16px", cardPadding: "1rem" },
};

const STAMEN: ThemeConfig = {
  chart: {
    height: 320,
    enableGridX: true,
    enableGridY: true,
    gridDash: "4 4",
    gridOpacity: 0.15,
    axisTickSize: 4,
    barPadding: 0.25,
    barRadius: 0,
    pieCornerRadius: 0,
    piePadAngle: 0.5,
    pointSize: 5,
    lineWidth: 1.5,
    margin: { top: 8, right: 16, bottom: 45, left: 55 },
    tooltipRadius: 2,
    tooltipShadow: "0 1px 3px rgba(0,0,0,0.08)",
    tooltipBorder: "1px solid rgba(0,0,0,0.1)",
    legendSymbolSize: 10,
    fontSize: 11,
  },
  statCard: {
    align: "left",
    valueClass: "text-lg",
    labelTransform: "uppercase",
    labelTracking: "0.05em",
    labelWeight: 600,
  },
  insight: { borderSide: "top", bgTint: false },
  annotation: { bgFill: false, borderWidth: "1px" },
  table: {
    headerBg: false,
    headerTransform: "uppercase",
    headerBorderWidth: "2px",
    cellPadding: "px-3 py-1.5",
  },
  layout: { sectionGap: "12px", cardPadding: "0.75rem" },
};

const IIB: ThemeConfig = {
  chart: {
    height: 380,
    enableGridX: false,
    enableGridY: true,
    gridDash: "",
    gridOpacity: 0.06,
    axisTickSize: 0,
    barPadding: 0.35,
    barRadius: 4,
    pieCornerRadius: 6,
    piePadAngle: 1.0,
    pointSize: 10,
    lineWidth: 3,
    margin: { top: 15, right: 25, bottom: 55, left: 65 },
    tooltipRadius: 12,
    tooltipShadow: "0 4px 16px rgba(0,0,0,0.12)",
    tooltipBorder: "none",
    legendSymbolSize: 14,
    fontSize: 13,
  },
  statCard: {
    align: "center",
    valueClass: "text-2xl",
    labelTransform: "none",
    labelTracking: "0",
    labelWeight: 500,
  },
  insight: { borderSide: "left", bgTint: true },
  annotation: { bgFill: true, borderWidth: "1px" },
  table: {
    headerBg: true,
    headerTransform: "none",
    headerBorderWidth: "1px",
    cellPadding: "px-4 py-3",
  },
  layout: { sectionGap: "20px", cardPadding: "1.5rem" },
};

const PENTAGRAM: ThemeConfig = {
  chart: {
    height: 320,
    enableGridX: false,
    enableGridY: false,
    gridDash: "",
    gridOpacity: 0,
    axisTickSize: 0,
    barPadding: 0.2,
    barRadius: 0,
    pieCornerRadius: 0,
    piePadAngle: 0.3,
    pointSize: 4,
    lineWidth: 1.5,
    margin: { top: 8, right: 16, bottom: 40, left: 50 },
    tooltipRadius: 0,
    tooltipShadow: "none",
    tooltipBorder: "1px solid rgba(0,0,0,0.2)",
    legendSymbolSize: 10,
    fontSize: 11,
  },
  statCard: {
    align: "left",
    valueClass: "text-3xl",
    labelTransform: "uppercase",
    labelTracking: "0.1em",
    labelWeight: 300,
  },
  insight: { borderSide: "none", bgTint: false },
  annotation: { bgFill: false, borderWidth: "2px" },
  table: {
    headerBg: false,
    headerTransform: "uppercase",
    headerBorderWidth: "2px",
    cellPadding: "px-3 py-1.5",
  },
  layout: { sectionGap: "12px", cardPadding: "0.75rem" },
};

export const THEME_CONFIGS: Record<ThemeId, ThemeConfig> = {
  vanilla: VANILLA,
  stamen: STAMEN,
  iib: IIB,
  pentagram: PENTAGRAM,
};

export function useThemeConfig(): ThemeConfig {
  const { theme } = useTheme();
  return THEME_CONFIGS[theme] ?? THEME_CONFIGS.vanilla;
}
