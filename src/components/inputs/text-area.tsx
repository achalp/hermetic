"use client";

import { useBoundProp } from "@json-render/react";

interface TextAreaProps {
  label: string;
  value: string;
  placeholder?: string | null;
  rows?: number | null;
}

interface TextAreaComponentProps {
  props: TextAreaProps;
  bindings?: Record<string, string>;
}

export function TextAreaComponent({ props, bindings }: TextAreaComponentProps) {
  const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-t-secondary">{props.label}</label>
      <textarea
        value={value ?? ""}
        placeholder={props.placeholder ?? undefined}
        rows={props.rows ?? 3}
        onChange={(e) => setValue(e.target.value)}
        className="theme-input border border-border-default bg-surface-input px-3 py-2 text-sm text-t-primary outline-none transition-colors focus:border-accent"
        style={{
          borderRadius: "var(--radius-input)",
          transitionDuration: "var(--transition-speed)",
        }}
        onFocus={(e) => (e.currentTarget.style.boxShadow = "var(--ring-focus)")}
        onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
      />
    </div>
  );
}
