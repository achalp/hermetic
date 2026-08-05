"use client";

interface SuggestionPillsProps {
  suggestions: string[];
  onSelect: (question: string) => void;
  /** Optional heading above the pills (e.g. "Try next") */
  title?: string;
  /** Layout: "centered" (default, narrow column) or "inline" (full-width, left-aligned) */
  layout?: "centered" | "inline";
}

export function SuggestionPills({
  suggestions,
  onSelect,
  title,
  layout = "centered",
}: SuggestionPillsProps) {
  if (suggestions.length === 0) return null;

  const containerClass =
    layout === "inline"
      ? "mt-3 flex flex-wrap gap-1.5 w-full"
      : "mt-3 flex flex-wrap justify-center gap-1.5 w-full max-w-[700px]";

  return (
    <div className={layout === "inline" ? "w-full" : "flex w-full flex-col items-center"}>
      {title && (
        <p
          className="text-xs font-medium text-t-tertiary"
          style={{
            marginTop: 12,
            marginBottom: 4,
            textAlign: layout === "inline" ? "left" : "center",
            width: "100%",
            maxWidth: layout === "inline" ? undefined : 700,
          }}
        >
          {title}
        </p>
      )}
      <div className={containerClass}>
        {suggestions.map((q, i) => (
          <button
            key={q}
            onClick={() => onSelect(q)}
            className="source-card-hover transition-all"
            style={{
              padding: "5px 12px",
              borderRadius: 99,
              border: "none",
              background: "var(--color-accent-subtle)",
              color: "var(--color-accent-text)",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 12,
              whiteSpace: "nowrap",
              opacity: 0,
              animation: `fadeUp 0.3s ease forwards ${i * 0.08}s`,
            }}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
