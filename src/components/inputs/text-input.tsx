"use client";

import { useBoundProp } from "@json-render/react";

interface TextInputProps {
  label: string;
  value: string;
  type?: "text" | "email" | "password" | "url" | null;
  placeholder?: string | null;
}

interface TextInputComponentProps {
  props: TextInputProps;
  bindings?: Record<string, string>;
}

export function TextInputComponent({ props, bindings }: TextInputComponentProps) {
  const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-t-secondary">{props.label}</label>
      <input
        type={props.type ?? "text"}
        value={value ?? ""}
        placeholder={props.placeholder ?? undefined}
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
