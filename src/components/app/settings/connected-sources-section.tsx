"use client";

import { useState, useCallback } from "react";
import { bindDbtManifest, unbindDbtManifest, ApiError } from "@/lib/api";

interface ConnectedSourcesSectionProps {
  isConnected: boolean;
  warehouseType: string | null;
  warehouseId?: string | null;
  connectionLabel: string | null;
  savedConnections: { id: string; type: string; name: string; host: string }[];
  onConnect: (config: Record<string, unknown>) => void;
  onDisconnect: () => void;
  onDeleteSaved: (id: string) => void;
}

export function ConnectedSourcesSection({
  isConnected,
  warehouseId,
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

      {/* dbt manifest binding — only shown when connected */}
      {isConnected && warehouseId && <DbtBindingPanel warehouseId={warehouseId} />}

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
                <span style={{ fontSize: 12, color: "var(--color-surface-dark-text4)" }}>
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

// ── dbt manifest binding panel ─────────────────────────────────

interface DbtBindingPanelProps {
  warehouseId: string;
}

function DbtBindingPanel({ warehouseId }: DbtBindingPanelProps) {
  const [path, setPath] = useState("");
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "linked"; enriched: number; total: number; manifestPath: string }
    | { kind: "error"; error: string }
  >({ kind: "idle" });

  const handleBind = useCallback(async () => {
    if (!path.trim()) return;
    setStatus({ kind: "loading" });
    try {
      const result = await bindDbtManifest(warehouseId, path.trim());
      setStatus({
        kind: "linked",
        enriched: result.enrichedTableCount,
        total: result.totalTableCount,
        manifestPath: result.manifestPath,
      });
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", error: msg });
    }
  }, [path, warehouseId]);

  const handleUnbind = useCallback(async () => {
    try {
      await unbindDbtManifest(warehouseId);
      setStatus({ kind: "idle" });
      setPath("");
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", error: msg });
    }
  }, [warehouseId]);

  const isLinked = status.kind === "linked";

  return (
    <div
      style={{
        marginTop: 14,
        padding: 12,
        borderRadius: 8,
        background: "var(--color-surface-dark-2)",
        border: "1px solid var(--color-surface-dark-3)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-surface-dark-text)" }}>
          dbt project
        </span>
        {isLinked && (
          <span
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 99,
              background: "rgba(16, 185, 129, 0.15)",
              color: "#10b981",
            }}
          >
            linked: {status.enriched} / {status.total} tables
          </span>
        )}
      </div>
      <p
        style={{
          fontSize: 12,
          color: "var(--color-surface-dark-text3)",
          margin: "0 0 8px",
          lineHeight: 1.5,
        }}
      >
        Path to a dbt <code style={{ fontSize: 11 }}>manifest.json</code>. When linked, table and
        column descriptions enrich the LLM prompt.
      </p>
      {!isLinked ? (
        <>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/dbt/target/manifest.json"
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--color-surface-dark-3)",
              background: "var(--color-surface-dark-1)",
              color: "var(--color-surface-dark-text)",
              fontSize: 12,
              fontFamily: "monospace",
              outline: "none",
            }}
            disabled={status.kind === "loading"}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              onClick={handleBind}
              disabled={!path.trim() || status.kind === "loading"}
              style={{
                fontSize: 12,
                padding: "5px 12px",
                border: "1px solid var(--color-accent)",
                color: "var(--color-accent)",
                background: "none",
                borderRadius: "var(--radius-button)",
                cursor: status.kind === "loading" || !path.trim() ? "not-allowed" : "pointer",
                opacity: !path.trim() ? 0.5 : 1,
              }}
            >
              {status.kind === "loading" ? "Loading..." : "Link manifest"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p
            style={{
              fontSize: 11,
              color: "var(--color-surface-dark-text4)",
              margin: "0 0 8px",
              fontFamily: "monospace",
              wordBreak: "break-all",
            }}
          >
            {status.manifestPath}
          </p>
          <button
            onClick={handleUnbind}
            style={{
              fontSize: 12,
              padding: "5px 0",
              border: "none",
              color: "#f87171",
              background: "none",
              cursor: "pointer",
            }}
          >
            Unlink
          </button>
        </>
      )}
      {status.kind === "error" && (
        <p style={{ fontSize: 12, color: "#f87171", margin: "8px 0 0" }}>{status.error}</p>
      )}
    </div>
  );
}
