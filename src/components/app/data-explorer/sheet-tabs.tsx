"use client";

interface SheetTabsProps {
  sheets: { name: string; rows: number }[];
  active: string;
  onSelect: (name: string) => void;
  relationships?: { from: string; to: string }[];
}

export function SheetTabs({ sheets, active, onSelect, relationships }: SheetTabsProps) {
  return (
    <div>
      {sheets.map((sheet) => {
        const isActive = sheet.name === active;
        return (
          <button
            key={sheet.name}
            onClick={() => onSelect(sheet.name)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 16px",
              fontSize: 13,
              cursor: "pointer",
              border: "none",
              borderLeft: `3px solid ${isActive ? "var(--color-accent)" : "transparent"}`,
              background: isActive ? "var(--color-surface-dark-2)" : "transparent",
              color: isActive
                ? "var(--color-surface-dark-text)"
                : "var(--color-surface-dark-text3)",
              textAlign: "left",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--color-surface-dark-text2)";
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--color-surface-dark-text3)";
            }}
          >
            {sheet.name}
            <span style={{ fontSize: 11, color: "var(--color-surface-dark-text4)", marginLeft: 8 }}>
              {sheet.rows.toLocaleString()}
            </span>
          </button>
        );
      })}
      {relationships && relationships.length > 0 && (
        <>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              color: "var(--color-surface-dark-text4)",
              padding: "12px 16px 4px",
              letterSpacing: "0.04em",
            }}
          >
            Relationships
          </div>
          {relationships.map((rel, i) => (
            <div
              key={i}
              style={{
                fontSize: 12,
                padding: "4px 16px",
                color: "var(--color-surface-dark-text3)",
              }}
            >
              {rel.from} <span style={{ color: "var(--color-accent)" }}>&rarr;</span> {rel.to}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
