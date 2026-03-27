"use client";

interface SuggestionPillsProps {
  suggestions: string[];
  onSelect: (question: string) => void;
}

export function SuggestionPills({ suggestions, onSelect }: SuggestionPillsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap justify-center gap-1.5 w-full max-w-[700px]">
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
  );
}
