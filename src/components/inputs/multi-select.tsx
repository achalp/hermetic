"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useBoundProp } from "@json-render/react";

interface MultiSelectProps {
  label: string;
  value: string[];
  options: { value: string; label: string }[];
  placeholder?: string | null;
  /** Maximum number of options to show in the dropdown panel before scrolling. */
  maxVisibleOptions?: number | null;
}

interface MultiSelectComponentProps {
  props: MultiSelectProps;
  bindings?: Record<string, string>;
}

export function MultiSelectComponent({ props, bindings }: MultiSelectComponentProps) {
  const [value, setValue] = useBoundProp<string[]>(props.value, bindings?.value);
  const selected: string[] = Array.isArray(value) ? value : [];

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const labelByValue = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of props.options) m.set(o.value, o.label);
    return m;
  }, [props.options]);

  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return props.options;
    return props.options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    );
  }, [props.options, search]);

  function toggle(val: string) {
    const next = selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val];
    setValue(next);
  }

  function removeChip(val: string) {
    setValue(selected.filter((v) => v !== val));
  }

  function clearAll() {
    setValue([]);
  }

  return (
    <div className="flex flex-col gap-1" ref={containerRef}>
      <label className="text-sm font-medium text-t-secondary">{props.label}</label>
      <div
        className="theme-input flex flex-wrap items-center gap-1 border border-border-default bg-surface-input px-2 py-1.5 text-sm text-t-primary cursor-text"
        style={{
          borderRadius: "var(--radius-input)",
          minHeight: 36,
        }}
        onClick={() => setOpen(true)}
      >
        {selected.length === 0 && (
          <span className="text-t-tertiary px-1">
            {props.placeholder ?? "Select one or more..."}
          </span>
        )}
        {selected.map((val) => (
          <span
            key={val}
            className="inline-flex items-center gap-1"
            style={{
              padding: "2px 6px 2px 8px",
              borderRadius: 99,
              background: "var(--color-accent-subtle)",
              color: "var(--color-accent-text)",
              fontSize: 12,
            }}
          >
            {labelByValue.get(val) ?? val}
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeChip(val);
              }}
              aria-label={`Remove ${labelByValue.get(val) ?? val}`}
              style={{
                background: "none",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: 14,
                lineHeight: 1,
                padding: 0,
                marginLeft: 2,
              }}
            >
              ×
            </button>
          </span>
        ))}
        {selected.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              clearAll();
            }}
            className="text-t-tertiary hover:text-t-primary"
            style={{
              fontSize: 12,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "0 4px",
              marginLeft: "auto",
            }}
          >
            Clear
          </button>
        )}
      </div>

      {open && (
        <div
          className="border border-border-default bg-surface-input"
          style={{
            position: "relative",
            borderRadius: "var(--radius-input)",
            marginTop: 4,
            zIndex: 10,
          }}
        >
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="w-full px-3 py-2 text-sm text-t-primary outline-none"
            style={{
              background: "transparent",
              borderBottom: "1px solid var(--color-border-default)",
            }}
          />
          <div
            style={{
              maxHeight: (props.maxVisibleOptions ?? 8) * 32,
              overflowY: "auto",
            }}
          >
            {filteredOptions.length === 0 && (
              <div className="px-3 py-2 text-sm text-t-tertiary">No matches</div>
            )}
            {filteredOptions.map((opt) => {
              const isSelected = selected.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  onClick={() => toggle(opt.value)}
                  className="flex w-full items-center gap-2 text-left text-sm hover:bg-surface-1"
                  style={{
                    padding: "6px 12px",
                    background: isSelected ? "var(--color-accent-subtle)" : "transparent",
                    color: isSelected ? "var(--color-accent-text)" : "var(--color-t-primary)",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ width: 14, display: "inline-block" }}>
                    {isSelected ? "✓" : ""}
                  </span>
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
