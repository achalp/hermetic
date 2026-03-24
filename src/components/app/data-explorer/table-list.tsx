"use client";

interface TableListProps {
  tables: { name: string; rows: string }[];
  active: string;
  onSelect: (name: string) => void;
}

export function TableList({ tables, active, onSelect }: TableListProps) {
  return (
    <div>
      {tables.map((table) => {
        const isActive = table.name === active;
        return (
          <button
            key={table.name}
            onClick={() => onSelect(table.name)}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
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
            <span>{table.name}</span>
            <span style={{ fontSize: 11, color: "var(--color-surface-dark-text4)" }}>
              {table.rows}
            </span>
          </button>
        );
      })}
    </div>
  );
}
