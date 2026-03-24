"use client";

interface SavedConnectionsProps {
  connections: { id: string; type: string; name: string; host: string }[];
  onConnect: (id: string) => void;
}

const dotColors: Record<string, string> = {
  postgresql: "#3b82f6",
  bigquery: "#f59e0b",
  clickhouse: "#10b981",
  trino: "#8b5cf6",
  hive: "#d97706",
};

export function SavedConnections({ connections, onConnect }: SavedConnectionsProps) {
  if (connections.length === 0) return null;

  return (
    <div className="w-full" style={{ maxWidth: 700 }}>
      <span
        className="uppercase"
        style={{ fontSize: 12, letterSpacing: "0.06em", color: "var(--color-t-tertiary)" }}
      >
        Saved connections
      </span>

      <div className="flex flex-wrap gap-2" style={{ marginTop: 8 }}>
        {connections.map((conn) => (
          <button
            key={conn.id}
            onClick={() => onConnect(conn.id)}
            className="flex items-center gap-2 transition-all duration-200 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)]"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-badge)",
              padding: "8px 16px",
            }}
          >
            <span
              className="shrink-0 rounded-full"
              style={{ width: 8, height: 8, background: dotColors[conn.type] ?? "#6b7280" }}
            />
            <span style={{ fontWeight: 500, fontSize: 13 }}>{conn.name}</span>
            <span style={{ fontSize: 12, color: "var(--color-t-secondary)" }}>{conn.host}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
