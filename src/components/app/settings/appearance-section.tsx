"use client";

import { useSyncExternalStore } from "react";
import { useTheme, THEMES, type ColorMode } from "@/lib/theme-context";

const emptySubscribe = () => () => {};
function useIsMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

const SWATCH_CONFIG: Record<string, { color: string; radius: string }> = {
  vanilla: { color: "#059669", radius: "12px" },
  stamen: { color: "#204ce5", radius: "4px" },
  iib: { color: "#e53935", radius: "16px" },
  pentagram: { color: "#000000", radius: "0" },
};

const MODES: { value: ColorMode; label: string }[] = [
  { value: "light", label: "\u2600 Light" },
  { value: "system", label: "\u25D0 System" },
  { value: "dark", label: "\u263E Dark" },
];

export function AppearanceSection() {
  const { theme, setTheme, mode, setMode } = useTheme();
  // Defer render to avoid SSR/client hydration mismatch when stored theme differs from default
  const mounted = useIsMounted();
  if (!mounted) return null;

  return (
    <div>
      {/* Mode toggle */}
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--color-surface-dark-text4)",
          marginBottom: 6,
        }}
      >
        MODE
      </div>
      <div
        style={{
          display: "flex",
          background: "var(--color-surface-dark-2)",
          borderRadius: 6,
          overflow: "hidden",
          marginBottom: 16,
        }}
      >
        {MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value)}
            style={{
              flex: 1,
              padding: "6px 0",
              fontSize: 12,
              textAlign: "center",
              background: mode === m.value ? "var(--color-accent)" : "transparent",
              color: mode === m.value ? "#fff" : "var(--color-surface-dark-text3)",
              border: "none",
              cursor: "pointer",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => {
              if (mode !== m.value) e.currentTarget.style.color = "var(--color-surface-dark-text2)";
            }}
            onMouseLeave={(e) => {
              if (mode !== m.value) e.currentTarget.style.color = "var(--color-surface-dark-text3)";
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Theme swatches */}
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--color-surface-dark-text4)",
          marginBottom: 6,
        }}
      >
        THEME
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {THEMES.map((t) => {
          const cfg = SWATCH_CONFIG[t.id];
          const active = theme === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                cursor: "pointer",
                background: "none",
                border: "none",
                padding: 0,
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  background: cfg.color,
                  borderRadius: cfg.radius,
                  border: `2px solid ${active ? cfg.color : "transparent"}`,
                  transition: "border-color 0.15s",
                }}
              />
              <span
                style={{
                  fontSize: 10,
                  color: active
                    ? "var(--color-surface-dark-text)"
                    : "var(--color-surface-dark-text3)",
                }}
              >
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
