"use client";

import { useBoundProp } from "@json-render/react";

interface RangeSliderProps {
  label: string;
  /** Two-element array: [low, high]. Bind to `/filters/<col>` to drive a `filterRange` op. */
  value: [number, number];
  min: number;
  max: number;
  step?: number | null;
  format?: "currency" | "percent" | "number" | null;
}

interface RangeSliderComponentProps {
  props: RangeSliderProps;
  bindings?: Record<string, string>;
}

function formatValue(v: number, format: RangeSliderProps["format"]): string {
  switch (format) {
    case "currency":
      return `$${v.toLocaleString()}`;
    case "percent":
      return `${v}%`;
    default:
      return v.toLocaleString();
  }
}

/**
 * Two-thumb range slider built from a pair of native `<input type="range">`
 * elements. The upper-thumb input is layered on top with `pointer-events:
 * auto` only over the right portion of the track. State is kept in sync by
 * clamping each thumb against the other on change.
 */
export function RangeSliderComponent({ props, bindings }: RangeSliderComponentProps) {
  const [value, setValue] = useBoundProp<[number, number]>(props.value, bindings?.value);
  const current: [number, number] = Array.isArray(value)
    ? value
    : (props.value ?? [props.min, props.max]);
  const [low, high] = current;
  const step = props.step ?? 1;

  const range = props.max - props.min || 1;
  const lowPct = ((low - props.min) / range) * 100;
  const highPct = ((high - props.min) / range) * 100;

  function setLow(v: number) {
    const clamped = Math.max(props.min, Math.min(v, high));
    setValue([clamped, high]);
  }
  function setHigh(v: number) {
    const clamped = Math.min(props.max, Math.max(v, low));
    setValue([low, clamped]);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-t-secondary">{props.label}</label>
        <span className="text-sm tabular-nums text-t-primary">
          {formatValue(low, props.format)} – {formatValue(high, props.format)}
        </span>
      </div>
      <div style={{ position: "relative", height: 24 }}>
        {/* Track background */}
        <div
          style={{
            position: "absolute",
            top: 11,
            left: 0,
            right: 0,
            height: 2,
            background: "var(--color-border-default)",
            borderRadius: 2,
          }}
        />
        {/* Active range */}
        <div
          style={{
            position: "absolute",
            top: 11,
            left: `${lowPct}%`,
            width: `${highPct - lowPct}%`,
            height: 2,
            background: "var(--color-accent)",
            borderRadius: 2,
          }}
        />
        {/* Two range inputs stacked. CSS makes the thumbs interactive but
            the track itself transparent so each input only handles its own
            thumb. */}
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={step}
          value={low}
          onChange={(e) => setLow(Number(e.target.value))}
          className="range-slider-thumb accent-accent"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            margin: 0,
            background: "none",
            pointerEvents: "none",
            appearance: "none",
            WebkitAppearance: "none",
          }}
        />
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={step}
          value={high}
          onChange={(e) => setHigh(Number(e.target.value))}
          className="range-slider-thumb accent-accent"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            margin: 0,
            background: "none",
            pointerEvents: "none",
            appearance: "none",
            WebkitAppearance: "none",
          }}
        />
        <style>{`
          .range-slider-thumb::-webkit-slider-thumb {
            pointer-events: auto;
            -webkit-appearance: none;
            appearance: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--color-accent);
            border: 2px solid var(--color-surface-input);
            cursor: grab;
          }
          .range-slider-thumb::-moz-range-thumb {
            pointer-events: auto;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: var(--color-accent);
            border: 2px solid var(--color-surface-input);
            cursor: grab;
          }
          .range-slider-thumb::-webkit-slider-runnable-track {
            background: transparent;
          }
          .range-slider-thumb::-moz-range-track {
            background: transparent;
          }
        `}</style>
      </div>
      <div className="flex justify-between text-xs text-t-tertiary">
        <span>{formatValue(props.min, props.format)}</span>
        <span>{formatValue(props.max, props.format)}</span>
      </div>
    </div>
  );
}
