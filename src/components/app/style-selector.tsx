"use client";

interface StyleSelectorProps {
  selected: string;
  onSelect: (id: string) => void;
}

const STYLES = [
  { label: "Dashboard", id: "infographic" },
  { label: "Narrative", id: "narrative" },
  { label: "Summary", id: "executive-summary" },
  { label: "Deep dive", id: "deep-analysis" },
  { label: "Slides", id: "presentation" },
  { label: "Report", id: "report" },
];

export function StyleSelector({ selected, onSelect }: StyleSelectorProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Output style"
      className="flex flex-row flex-wrap items-center justify-center"
      style={{ gap: 4, fontSize: 13 }}
    >
      {STYLES.map((style, i) => (
        <span key={style.id} className="flex items-center">
          {i > 0 && <span style={{ color: "var(--color-border-default)" }}> · </span>}
          <button
            role="radio"
            aria-checked={selected === style.id}
            onClick={() => onSelect(style.id)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 13,
              padding: 0,
              ...(selected === style.id
                ? {
                    color: "var(--color-accent)",
                    textDecoration: "underline",
                    textUnderlineOffset: 3,
                  }
                : {
                    color: "var(--color-t-secondary)",
                  }),
            }}
            onMouseEnter={(e) => {
              if (selected !== style.id) {
                e.currentTarget.style.color = "var(--color-t-primary)";
              }
            }}
            onMouseLeave={(e) => {
              if (selected !== style.id) {
                e.currentTarget.style.color = "var(--color-t-secondary)";
              }
            }}
          >
            {style.label}
          </button>
        </span>
      ))}
    </div>
  );
}
