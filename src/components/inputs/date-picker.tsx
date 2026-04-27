"use client";

import { useBoundProp } from "@json-render/react";

interface DatePickerProps {
  label: string;
  value: string;
  /** Date variant: "date" for YYYY-MM-DD, "datetime-local" for full timestamp. Default "date". */
  type?: "date" | "datetime-local" | null;
  min?: string | null;
  max?: string | null;
}

interface DatePickerComponentProps {
  props: DatePickerProps;
  bindings?: Record<string, string>;
}

export function DatePickerComponent({ props, bindings }: DatePickerComponentProps) {
  const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-t-secondary">{props.label}</label>
      <input
        type={props.type ?? "date"}
        value={value ?? ""}
        min={props.min ?? undefined}
        max={props.max ?? undefined}
        onChange={(e) => setValue(e.target.value)}
        className="theme-input border border-border-default bg-surface-input px-3 py-2 text-sm text-t-primary outline-none transition-colors focus:border-accent focus-visible:shadow-[var(--ring-focus)]"
        style={{
          borderRadius: "var(--radius-input)",
          transitionDuration: "var(--transition-speed)",
        }}
      />
    </div>
  );
}
