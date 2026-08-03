"use client";

import { useBoundProp } from "@/spec/react";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number | null;
  /** Format hint for the displayed value: "currency", "percent", "number" (default). */
  format?: "currency" | "percent" | "number" | null;
}

interface SliderComponentProps {
  props: SliderProps;
  bindings?: Record<string, string>;
}

function formatValue(v: number, format: SliderProps["format"]): string {
  switch (format) {
    case "currency":
      return `$${v.toLocaleString()}`;
    case "percent":
      return `${v}%`;
    default:
      return v.toLocaleString();
  }
}

export function SliderComponent({ props, bindings }: SliderComponentProps) {
  const [value, setValue] = useBoundProp<number>(props.value, bindings?.value);
  const current = value ?? props.value ?? props.min;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-t-secondary">{props.label}</label>
        <span className="text-sm tabular-nums text-t-primary">
          {formatValue(current, props.format)}
        </span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={current}
        onChange={(e) => setValue(Number(e.target.value))}
        className="accent-accent"
        style={{ width: "100%" }}
      />
      <div className="flex justify-between text-xs text-t-tertiary">
        <span>{formatValue(props.min, props.format)}</span>
        <span>{formatValue(props.max, props.format)}</span>
      </div>
    </div>
  );
}
