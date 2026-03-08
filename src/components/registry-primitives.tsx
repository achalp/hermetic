"use client";

/**
 * Extracted registry primitive components.
 * These were previously inline in registry.tsx, adding ~200 lines.
 */

import { useBoundProp } from "@json-render/react";
import { useStatCardTheme, useInsightTheme, useAnnotationTheme } from "@/lib/theme-config";

// ── Constants ──────────────────────────────────────────────────

const SEVERITY_STYLES: Record<string, string> = {
  info: "border-info-border bg-info-bg text-info-text",
  warning: "border-warning-border bg-warning-bg text-warning-text",
  success: "border-success-border bg-success-bg text-success-text",
  error: "border-error-border bg-error-bg text-error-text",
};

const ICON_MAP: Record<string, string> = {
  alert: "\u26A0\uFE0F",
  info: "\u2139\uFE0F",
  trend: "\uD83D\uDCC8",
  check: "\u2705",
  flag: "\uD83D\uDEA9",
};

const TREND_STYLES: Record<string, string> = {
  up: "text-trend-up",
  down: "text-trend-down",
  flat: "text-t-tertiary",
};

const TREND_ARROWS: Record<string, string> = { up: "\u2191", down: "\u2193", flat: "\u2192" };

// ── Formatting helpers ─────────────────────────────────────────

export function formatStatNumber(num: number, prefix = ""): string {
  const abs = Math.abs(num);
  if (abs >= 1_000_000_000) return prefix + (num / 1_000_000_000).toFixed(1) + "B";
  if (abs >= 1_000_000) return prefix + (num / 1_000_000).toFixed(1) + "M";
  if (Number.isInteger(num)) return prefix + num.toLocaleString();
  return prefix + num.toFixed(2);
}

export function formatStatValue(v: unknown): string {
  if (typeof v === "number") return formatStatNumber(v);
  if (typeof v === "string") {
    const prefix = v.match(/^[$€£¥]/)?.[0] ?? "";
    const stripped = v.replace(/[$€£¥,%\s]/g, "");
    const num = Number(stripped);
    if (!isNaN(num) && stripped.length > 0) {
      const suffix = v.endsWith("%") ? "%" : "";
      return formatStatNumber(num, prefix) + suffix;
    }
  }
  return String(v ?? "");
}

// ── Prop types ────────────────────────────────────────────────

export interface StatCardProps {
  label: string;
  value: unknown;
  change?: string | null;
  trend?: "up" | "down" | "flat" | null;
  description?: string | null;
}

export interface TextBlockProps {
  content: string;
  variant?: "body" | "insight" | "warning" | "heading" | null;
}

export interface AnnotationProps {
  title: string;
  content: string;
  severity?: "info" | "warning" | "success" | "error" | null;
  icon?: "alert" | "info" | "trend" | "check" | "flag" | null;
}

export interface TrendIndicatorProps {
  label: string;
  current?: number | null;
  previous?: number | null;
  format?: "currency" | "percent" | "number" | null;
  precision?: number | null;
}

export interface SelectControlProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string | null;
}

export interface NumberInputProps {
  label: string;
  value: number;
  min?: number | null;
  max?: number | null;
  step?: number | null;
}

export interface ToggleSwitchProps {
  label: string;
  checked: boolean;
}

// ── StatCard ───────────────────────────────────────────────────

export function StatCardComponent({ props }: { props: StatCardProps }) {
  const statCard = useStatCardTheme();
  const displayValue = formatStatValue(props.value);
  const fontSize = statCard.valueClass;
  return (
    <div
      className={`stat-card theme-card min-w-0 overflow-hidden bg-surface-2 ${statCard.align === "left" ? "text-left" : "text-center"}`}
      style={{
        padding: "var(--padding-card)",
        borderRadius: "var(--radius-card)",
        border: "var(--surface-card-border)",
        boxShadow: "var(--shadow-card)",
        transitionDuration: "var(--transition-speed)",
      }}
    >
      <p
        className="truncate text-xs text-t-secondary"
        style={{
          fontWeight: statCard.labelWeight,
          textTransform: statCard.labelTransform,
          letterSpacing: statCard.labelTracking,
        }}
      >
        {props.label}
      </p>
      <p
        className={`mt-1 tabular-nums text-t-primary ${fontSize}`}
        style={{ fontWeight: "var(--stat-value-weight)" as unknown as number }}
        title={displayValue}
      >
        {displayValue}
      </p>
      {(props.change || props.trend) && (
        <p className={`mt-1 text-sm font-medium ${TREND_STYLES[props.trend ?? "flat"]}`}>
          {props.trend && TREND_ARROWS[props.trend]} {props.change}
        </p>
      )}
      {props.description && <p className="mt-1 text-xs text-t-tertiary">{props.description}</p>}
    </div>
  );
}

// ── TextBlock ──────────────────────────────────────────────────

export function TextBlockComponent({ props }: { props: TextBlockProps }) {
  const insight = useInsightTheme();
  const variant = props.variant ?? "body";
  const isInsight = variant === "insight";
  const insightBase = isInsight
    ? insight.borderSide === "left"
      ? "text-accent-text border-l-4 border-accent pl-4"
      : insight.borderSide === "top"
        ? "text-accent-text"
        : "text-accent-text"
    : "";
  const bgTint = isInsight && insight.bgTint ? " bg-accent-subtle" : "";
  const styles: Record<string, string> = {
    body: "text-t-secondary",
    insight: `insight-block ${insightBase}${bgTint}`,
    warning: "text-warning-text border-l-4 border-warning-border pl-4",
    heading: "text-xl text-t-primary",
  };
  return (
    <div
      className={styles[variant]}
      style={variant === "heading" ? { fontWeight: "var(--font-heading-weight)" } : undefined}
    >
      <p className="whitespace-pre-wrap">{props.content}</p>
    </div>
  );
}

// ── Annotation ─────────────────────────────────────────────────

export function AnnotationComponent({ props }: { props: AnnotationProps }) {
  const annotation = useAnnotationTheme();
  const severity = props.severity ?? "info";
  const baseStyles = SEVERITY_STYLES[severity];
  const bgClass = annotation.bgFill ? baseStyles : baseStyles.replace(/bg-\S+/g, "");
  return (
    <div
      className={`annotation-block border ${bgClass}`}
      style={{
        borderRadius: "var(--radius-card)",
        borderWidth: annotation.borderWidth,
        padding: "var(--padding-card)",
      }}
    >
      <div className="flex items-start gap-2">
        <span className="text-lg">{ICON_MAP[props.icon ?? "info"]}</span>
        <div>
          <p className="font-semibold">{props.title}</p>
          <p className="mt-1 text-sm opacity-90">{props.content}</p>
        </div>
      </div>
    </div>
  );
}

// ── TrendIndicator ─────────────────────────────────────────────

export function TrendIndicatorComponent({ props }: { props: TrendIndicatorProps }) {
  const current = props.current ?? 0;
  const previous = props.previous ?? 0;
  const change = current - previous;
  const pctChange = previous !== 0 ? (change / previous) * 100 : 0;
  const trend = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const precision = props.precision ?? 1;

  const formatValue = (v: number) => {
    switch (props.format) {
      case "currency":
        return `$${v.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
      case "percent":
        return `${v.toFixed(precision)}%`;
      default:
        return v.toLocaleString(undefined, {
          minimumFractionDigits: precision,
          maximumFractionDigits: precision,
        });
    }
  };

  return (
    <div
      className="theme-card flex items-center gap-3 border border-border-default bg-surface-2"
      style={{
        padding: "var(--padding-card)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div>
        <p className="text-sm text-t-secondary">{props.label}</p>
        <p className="text-lg font-bold text-t-primary">{formatValue(current)}</p>
      </div>
      <div className={`text-sm font-medium ${TREND_STYLES[trend]}`}>
        {TREND_ARROWS[trend]} {pctChange >= 0 ? "+" : ""}
        {pctChange.toFixed(1)}%
      </div>
    </div>
  );
}

// ── SelectControl ──────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
export function SelectControlComponent({
  props,
  bindings,
}: {
  props: SelectControlProps;
  bindings: any;
}) {
  const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-t-secondary">{props.label}</label>
      <select
        value={value ?? ""}
        onChange={(e) => setValue(e.target.value)}
        className="theme-input border border-border-default bg-surface-input px-3 py-2 text-sm text-t-primary outline-none transition-colors focus:border-accent focus-visible:shadow-[var(--ring-focus)]"
        style={{
          borderRadius: "var(--radius-input)",
          transitionDuration: "var(--transition-speed)",
        }}
      >
        {props.placeholder && <option value="">{props.placeholder}</option>}
        {props.options.map((opt: { value: string; label: string }) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── NumberInput ─────────────────────────────────────────────────

export function NumberInputComponent({
  props,
  bindings,
}: {
  props: NumberInputProps;
  bindings: any;
}) {
  const [value, setValue] = useBoundProp<number>(props.value, bindings?.value);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-t-secondary">{props.label}</label>
      <input
        type="number"
        value={value ?? 0}
        min={props.min ?? undefined}
        max={props.max ?? undefined}
        step={props.step ?? undefined}
        onChange={(e) => setValue(parseFloat(e.target.value))}
        className="theme-input border border-border-default bg-surface-input px-3 py-2 text-sm text-t-primary outline-none transition-colors focus:border-accent focus-visible:shadow-[var(--ring-focus)]"
        style={{
          borderRadius: "var(--radius-input)",
          transitionDuration: "var(--transition-speed)",
        }}
      />
    </div>
  );
}

// ── ToggleSwitch ───────────────────────────────────────────────

export function ToggleSwitchComponent({
  props,
  bindings,
}: {
  props: ToggleSwitchProps;
  bindings: any;
}) {
  const [checked, setChecked] = useBoundProp<boolean>(props.checked, bindings?.checked);
  const isChecked = checked ?? false;
  return (
    <div className="flex items-center gap-3">
      <label className="text-sm font-medium text-t-secondary">{props.label}</label>
      <button
        type="button"
        role="switch"
        aria-checked={isChecked}
        onClick={() => setChecked(!isChecked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:shadow-[var(--ring-focus)] ${
          isChecked ? "bg-accent" : "bg-surface-2"
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            isChecked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */
// Note: `bindings` params remain `any` because json-render binding types are dynamic
