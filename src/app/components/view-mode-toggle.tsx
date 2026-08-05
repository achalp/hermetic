"use client";

export function ViewModeToggle({
  value,
  onChange,
}: {
  value: "dashboard" | "notebook";
  onChange: (v: "dashboard" | "notebook") => void;
}) {
  return (
    <div
      className="inline-flex overflow-hidden border border-border-default"
      style={{ borderRadius: "var(--radius-badge)" }}
      role="tablist"
      aria-label="Result view"
    >
      {(["dashboard", "notebook"] as const).map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={`px-3 py-1 text-xs font-medium transition-colors ${
            value === v ? "bg-accent-subtle text-accent" : "text-t-secondary hover:text-t-primary"
          }`}
          style={{ transitionDuration: "var(--transition-speed)" }}
        >
          {v === "dashboard" ? "Dashboard" : "Notebook"}
        </button>
      ))}
    </div>
  );
}
