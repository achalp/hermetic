"use client";

import { PURPOSE_LIST, resolvePurpose } from "@/lib/purpose-prompts";
import { PROFILE_DEPTHS, type ProfileDepth } from "@/lib/constants";

interface AnalysisDefaultsSectionProps {
  defaultStyle: string;
  onDefaultStyleChange: (style: string) => void;
  /** Rows a FILE-source value profile examines (warehouses carry no value stats). */
  profileDepth: ProfileDepth;
  onProfileDepthChange: (depth: ProfileDepth) => void;
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
  profileDepth,
  onProfileDepthChange,
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

      {/* Profile depth: how many rows a FILE source's value profile examines.
          Deliberately NOT shown as a quality dial. On a remote source the sample
          is the leading row groups (a random sample over object storage would
          egress the whole dataset), so on a sorted dataset extra depth widens a
          slice of the same corner rather than making it representative — while
          costing minutes of transfer. Warehouses are unaffected: their schema
          carries no value statistics at all. */}
      <div style={{ ...labelStyle, marginTop: 14 }}>PROFILE DEPTH (FILE SOURCES)</div>
      <div
        style={{
          display: "flex",
          background: "var(--color-surface-dark-2)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {PROFILE_DEPTHS.map((d) => {
          const active = profileDepth === d;
          return (
            <button
              key={d}
              onClick={() => onProfileDepthChange(d)}
              title={
                d === 50_000
                  ? "Fastest. Enough for types, shape and cardinality."
                  : "Deeper statistics, more transfer. Ranges and top values still come from the leading rows of a remote source."
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
                fontVariantNumeric: "tabular-nums",
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.color = "var(--color-surface-dark-text2)";
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.color = "var(--color-surface-dark-text3)";
              }}
            >
              {(d / 1000).toLocaleString()}k rows
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
