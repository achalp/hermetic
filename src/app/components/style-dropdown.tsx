"use client";

import { useEffect, useRef, useState } from "react";
import { PURPOSE_LIST, resolvePurpose } from "@/lib/purpose-prompts";

interface StyleDropdownProps {
  selected: string;
  onSelect: (id: string) => void;
}

/**
 * Compact output-style picker for the results toolbar: the trigger shows the
 * current mode; clicking opens a dropdown of the styles with descriptions.
 * (The spacious pre-results state uses the inline StyleSelector instead.)
 */
export function StyleDropdown({ selected, onSelect }: StyleDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = resolvePurpose(selected);
  const current = PURPOSE_LIST.find((p) => p.id === active) ?? PURPOSE_LIST[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-medium text-t-secondary hover:text-accent transition-colors"
        title="Output style"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current.label} ▾
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full mt-1 border border-border-default bg-surface-1 py-1"
          style={{
            borderRadius: "var(--radius-button)",
            boxShadow: "var(--shadow-elevated)",
            zIndex: "var(--z-export-dropdown)",
            minWidth: 220,
          }}
        >
          {PURPOSE_LIST.map((p) => {
            const isActive = p.id === active;
            return (
              <button
                key={p.id}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  setOpen(false);
                  if (p.id !== active) onSelect(p.id);
                }}
                className={`block w-full px-3 py-2 text-left transition-colors hover:bg-accent-subtle ${
                  isActive ? "text-accent" : "text-t-primary"
                }`}
              >
                <span className="block text-sm font-medium">{p.label}</span>
                <span className="block text-xs text-t-tertiary">{p.description}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
