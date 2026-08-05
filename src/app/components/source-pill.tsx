"use client";

interface SourcePillProps {
  label: string;
}

export function SourcePill({ label }: SourcePillProps) {
  return (
    <span
      className="bg-accent-subtle text-accent-text text-xs font-medium px-3 py-1 whitespace-nowrap"
      style={{ borderRadius: "var(--radius-badge)" }}
    >
      {label}
    </span>
  );
}
