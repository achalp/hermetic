"use client";

import { useBoundProp } from "@json-render/react";

interface ColorPickerProps {
  label: string;
  value: string;
}

interface ColorPickerComponentProps {
  props: ColorPickerProps;
  bindings?: Record<string, string>;
}

export function ColorPickerComponent({ props, bindings }: ColorPickerComponentProps) {
  const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);
  const current = value ?? props.value ?? "#000000"; /* default picker value (data, not chrome) */

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-t-secondary">{props.label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={current}
          onChange={(e) => setValue(e.target.value)}
          aria-label={props.label}
          style={{
            width: 48,
            height: 32,
            padding: 0,
            border: "1px solid var(--color-border-default)",
            borderRadius: "var(--radius-input)",
            cursor: "pointer",
            background: "none",
          }}
        />
        <span className="text-sm tabular-nums text-t-primary">{current}</span>
      </div>
    </div>
  );
}
