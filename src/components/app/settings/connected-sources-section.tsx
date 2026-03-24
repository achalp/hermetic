"use client";

interface ConnectedSourcesSectionProps {
  isConnected: boolean;
  warehouseType: string | null;
  connectionLabel: string | null;
  savedConnections: { id: string; type: string; name: string; host: string }[];
  onConnect: (config: Record<string, unknown>) => void;
  onDisconnect: () => void;
  onDeleteSaved: (id: string) => void;
}

export function ConnectedSourcesSection({
  isConnected,
  connectionLabel,
  savedConnections,
  onDisconnect,
  onDeleteSaved,
}: ConnectedSourcesSectionProps) {
  return (
    <div>
      {/* Connection status */}
      {isConnected ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "var(--color-surface-dark-2)",
            borderRadius: 8,
            padding: 12,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#10b981",
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, fontSize: 13, color: "var(--color-surface-dark-text)" }}>
            {connectionLabel}
          </span>
          <button
            onClick={onDisconnect}
            style={{
              background: "none",
              border: "none",
              fontSize: 13,
              color: "#f87171",
              cursor: "pointer",
              padding: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
            onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <p style={{ fontSize: 13, color: "var(--color-surface-dark-text3)", margin: "0 0 10px" }}>
          No warehouse connected
        </p>
      )}

      {/* Add connection button */}
      <button
        style={{
          fontSize: 13,
          padding: "7px 14px",
          border: "1px solid var(--color-accent)",
          color: "var(--color-accent)",
          background: "none",
          borderRadius: "var(--radius-button)",
          cursor: "pointer",
          marginTop: 10,
          transition: "background 0.15s, color 0.15s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--color-accent)";
          e.currentTarget.style.color = "#fff";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
          e.currentTarget.style.color = "var(--color-accent)";
        }}
        title="Use the home screen to add a new connection."
      >
        Add connection
      </button>

      {/* Saved connections */}
      {savedConnections.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {savedConnections.map((conn) => (
            <div
              key={conn.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "6px 0",
                fontSize: 13,
                color: "var(--color-surface-dark-text2)",
              }}
            >
              <span>
                {conn.name}{" "}
                <span style={{ fontSize: 11, color: "var(--color-surface-dark-text4)" }}>
                  {conn.type}
                </span>
              </span>
              <button
                onClick={() => onDeleteSaved(conn.id)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#f87171",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "0 4px",
                }}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
