"use client";

interface AnalysisDefaultsSectionProps {
  defaultStyle: string;
  onDefaultStyleChange: (style: string) => void;
  schemaMode: string;
  onSchemaModeChange: (mode: string) => void;
}

const STYLES = ["Dashboard", "Narrative", "Summary", "Deep dive", "Slides", "Report"];
const SCHEMA_MODES = ["Metadata", "Sample"];

export function AnalysisDefaultsSection({
  defaultStyle,
  onDefaultStyleChange,
  schemaMode,
  onSchemaModeChange,
}: AnalysisDefaultsSectionProps) {
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "var(--color-surface-dark-text4)",
    marginBottom: 6,
  };

  return (
    <div>
      {/* Default style pills */}
      <div style={labelStyle}>DEFAULT STYLE</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {STYLES.map((s) => {
          const value = s.toLowerCase();
          const active = defaultStyle === value;
          return (
            <button
              key={value}
              onClick={() => onDefaultStyleChange(value)}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 99,
                border: `1px solid ${active ? "var(--color-accent)" : "var(--color-surface-dark-3)"}`,
                background: active ? "var(--color-accent)" : "none",
                color: active ? "#fff" : "var(--color-surface-dark-text3)",
                cursor: "pointer",
                transition: "border-color 0.15s, color 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  e.currentTarget.style.borderColor = "var(--color-accent)";
                  e.currentTarget.style.color = "var(--color-accent)";
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  e.currentTarget.style.borderColor = "var(--color-surface-dark-3)";
                  e.currentTarget.style.color = "var(--color-surface-dark-text3)";
                }
              }}
            >
              {s}
            </button>
          );
        })}
      </div>

      {/* Schema mode toggle */}
      <div style={{ ...labelStyle, marginTop: 14 }}>SCHEMA MODE</div>
      <div
        style={{
          display: "flex",
          background: "var(--color-surface-dark-2)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {SCHEMA_MODES.map((m) => {
          const value = m.toLowerCase();
          const active = schemaMode === value;
          return (
            <button
              key={value}
              onClick={() => onSchemaModeChange(value)}
              style={{
                flex: 1,
                padding: "6px 0",
                fontSize: 12,
                textAlign: "center",
                background: active ? "var(--color-accent)" : "transparent",
                color: active ? "#fff" : "var(--color-surface-dark-text3)",
                border: "none",
                cursor: "pointer",
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.color = "var(--color-surface-dark-text2)";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.color = "var(--color-surface-dark-text3)";
              }}
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}
