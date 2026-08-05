"use client";

import { useBoundProp } from "@/spec/react";
import { formatSliderValue } from "@/lib/format";

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

export function SliderComponent({ props, bindings }: SliderComponentProps) {
  const [value, setValue] = useBoundProp<number>(props.value, bindings?.value);
  const current = value ?? props.value ?? props.min;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-t-secondary">{props.label}</label>
        <span className="text-sm tabular-nums text-t-primary">
          {formatSliderValue(current, props.format)}
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
        <span>{formatSliderValue(props.min, props.format)}</span>
        <span>{formatSliderValue(props.max, props.format)}</span>
      </div>
    </div>
  );
}
