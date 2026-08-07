"use client";

import { PURPOSE_LIST, resolvePurpose } from "@/lib/purpose-prompts";

interface AnalysisDefaultsSectionProps {
  defaultStyle: string;
  onDefaultStyleChange: (style: string) => void;
  schemaMode: string;
  onSchemaModeChange: (mode: string) => void;
  composerSight: string;
  onComposerSightChange: (mode: string) => void;
}

const SCHEMA_MODES = ["Metadata", "Sample"];
const SIGHT_MODES = ["Blind", "Sighted"];

export function AnalysisDefaultsSection({
  defaultStyle,
  onDefaultStyleChange,
  schemaMode,
  onSchemaModeChange,
  composerSight,
  onComposerSightChange,
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
        {PURPOSE_LIST.map((s) => {
          const value = s.id;
          const active = resolvePurpose(defaultStyle) === value;
          return (
            <button
              key={value}
              title={s.description}
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
              {s.label}
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

      {/* Composer sight (composer-sight spec §1): Blind = values never enter
          the composition prompt (default). Sighted = the composer sees the
          DERIVED Analysis Product values (never raw rows) to inform
          selection/phrasing; binding discipline unchanged. */}
      <div style={{ ...labelStyle, marginTop: 14 }}>COMPOSER SIGHT</div>
      <div
        style={{
          display: "flex",
          background: "var(--color-surface-dark-2)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {SIGHT_MODES.map((m) => {
          const value = m.toLowerCase();
          const active = composerSight === value;
          return (
            <button
              key={value}
              onClick={() => onComposerSightChange(value)}
              title={
                value === "blind"
                  ? "Composer never sees computed values (maximal separation)"
                  : "Composer sees derived aggregates (never raw rows) for better selection and phrasing"
              }
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
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}
