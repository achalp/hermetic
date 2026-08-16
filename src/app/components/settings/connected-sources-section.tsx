"use client";

import { useState, useCallback } from "react";
import { errMessage } from "@/lib/logger";
import {
  bindDbtManifest,
  unbindDbtManifest,
  ApiError,
  type SavedConnectionInfo,
} from "@/app/lib/api";

interface ConnectedSourcesSectionProps {
  isConnected: boolean;
  warehouseType: string | null;
  warehouseId?: string | null;
  connectionLabel: string | null;
  savedConnections: SavedConnectionInfo[];
  onConnect: (config: Record<string, unknown>) => void;
  onDisconnect: () => void;
  onDeleteSaved: (id: string) => void;
  onRenameSaved: (id: string, name: string) => void;
}

export function ConnectedSourcesSection({
  isConnected,
  warehouseId,
  connectionLabel,
  savedConnections,
  onDisconnect,
  onDeleteSaved,
  onRenameSaved,
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
              background: "var(--color-accent)",
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
              color:
                "#f87171" /* fixed red on always-dark drawer; error-text token is dark-on-dark in light mode */,
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
          <p
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-surface-dark-text3)",
              margin: "0 0 6px",
            }}
          >
            Saved connections
          </p>
          {savedConnections.map((conn) => (
            <SavedConnectionRow
              key={conn.id}
              conn={conn}
              onDelete={() => onDeleteSaved(conn.id)}
              onRename={(name) => onRenameSaved(conn.id, name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Saved connection row: view/copy details + rename ───────────────

const SENSITIVE_KEYS = new Set(["password", "credentialsJson", "privateKey", "token", "secret"]);

function humanizeKey(k: string): string {
  const map: Record<string, string> = {
    credentialsJson: "Service Account JSON",
    projectId: "Project ID",
    serverHostname: "Server Hostname",
    httpPath: "HTTP Path",
    accessToken: "Access Token",
  };
  if (map[k]) return map[k];
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

const copyBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-accent)",
  cursor: "pointer",
  fontSize: 11,
  padding: 0,
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard unavailable — no-op
        }
      }}
      style={copyBtnStyle}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function DetailRow({ keyName, value }: { keyName: string; value: unknown }) {
  const [revealed, setRevealed] = useState(false);
  const sensitive = SENSITIVE_KEYS.has(keyName);
  const str = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value ?? "");
  if (str === "") return null;

  // BigQuery service-account JSON (and any long secret): full-width block.
  if (keyName === "credentialsJson") {
    return (
      <div style={{ padding: "6px 0", borderTop: "1px solid var(--color-surface-dark-3)" }}>
        <div
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
        >
          <span style={{ fontSize: 12, color: "var(--color-surface-dark-text3)" }}>
            {humanizeKey(keyName)}
          </span>
          <span style={{ display: "flex", gap: 10 }}>
            <button onClick={() => setRevealed((v) => !v)} style={copyBtnStyle}>
              {revealed ? "Hide" : "Reveal"}
            </button>
            <CopyButton text={str} />
          </span>
        </div>
        {revealed && (
          <pre
            style={{
              margin: "6px 0 0",
              padding: 8,
              maxHeight: 160,
              overflow: "auto",
              borderRadius: 6,
              background: "var(--color-surface-dark-1)",
              border: "1px solid var(--color-surface-dark-3)",
              fontSize: 11,
              fontFamily: "monospace",
              color: "var(--color-surface-dark-text2)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {str}
          </pre>
        )}
      </div>
    );
  }

  const shown = sensitive && !revealed ? "•".repeat(Math.min(str.length, 12)) : str;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "5px 0",
        borderTop: "1px solid var(--color-surface-dark-3)",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--color-surface-dark-text3)", flexShrink: 0 }}>
        {humanizeKey(keyName)}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
        }}
      >
        <span
          style={{
            color: "var(--color-surface-dark-text)",
            fontFamily: "monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {shown}
        </span>
        {sensitive && (
          <button onClick={() => setRevealed((v) => !v)} style={copyBtnStyle}>
            {revealed ? "Hide" : "Show"}
          </button>
        )}
        {typeof value !== "boolean" && <CopyButton text={str} />}
      </span>
    </div>
  );
}

function SavedConnectionRow({
  conn,
  onDelete,
  onRename,
}: {
  conn: SavedConnectionInfo;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [nameDraft, setNameDraft] = useState(conn.name ?? "");
  const display = conn.name || conn.label;
  const dirty = (nameDraft.trim() || undefined) !== conn.name;
  const fields = Object.entries(conn.config).filter(([k]) => k !== "type");

  return (
    <div style={{ borderTop: "1px solid var(--color-surface-dark-3)", padding: "8px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontSize: 13,
          color: "var(--color-surface-dark-text2)",
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {display}{" "}
          <span style={{ fontSize: 12, color: "var(--color-surface-dark-text4)" }}>
            {conn.config.type}
          </span>
        </span>
        <span style={{ display: "flex", gap: 12, flexShrink: 0 }}>
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{ ...copyBtnStyle, color: "var(--color-surface-dark-text3)" }}
          >
            {expanded ? "Hide" : "Details"}
          </button>
          <button
            onClick={onDelete}
            style={{ ...copyBtnStyle, color: "#f87171" /* fixed red on always-dark drawer */ }}
            title="Delete saved connection"
          >
            Forget
          </button>
        </span>
      </div>

      {expanded && (
        <div
          style={{
            marginTop: 8,
            padding: 10,
            borderRadius: 8,
            background: "var(--color-surface-dark-2)",
            border: "1px solid var(--color-surface-dark-3)",
          }}
        >
          {/* Friendly name */}
          <label
            style={{ display: "block", fontSize: 12, color: "var(--color-surface-dark-text3)" }}
          >
            Friendly name
          </label>
          <div style={{ display: "flex", gap: 8, margin: "4px 0 8px" }}>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder={conn.label}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "5px 9px",
                borderRadius: 6,
                border: "1px solid var(--color-surface-dark-3)",
                background: "var(--color-surface-dark-1)",
                color: "var(--color-surface-dark-text)",
                fontSize: 12,
                outline: "none",
              }}
            />
            <button
              onClick={() => onRename(nameDraft)}
              disabled={!dirty}
              style={{
                fontSize: 12,
                padding: "5px 12px",
                border: "1px solid var(--color-accent)",
                color: "var(--color-accent)",
                background: "none",
                borderRadius: "var(--radius-button)",
                cursor: dirty ? "pointer" : "not-allowed",
                opacity: dirty ? 1 : 0.5,
              }}
            >
              Save
            </button>
          </div>

          {/* Read-only connection details with copy */}
          {fields.map(([key, value]) => (
            <DetailRow key={key} keyName={key} value={value} />
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
      const msg = err instanceof ApiError ? err.message : errMessage(err);
      setStatus({ kind: "error", error: msg });
    }
  }, [path, warehouseId]);

  const handleUnbind = useCallback(async () => {
    try {
      await unbindDbtManifest(warehouseId);
      setStatus({ kind: "idle" });
      setPath("");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : errMessage(err);
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
              color:
                "#10b981" /* fixed green pill on always-dark drawer (paired with alpha bg above) */,
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
              color: "#f87171" /* fixed red on always-dark drawer */,
              background: "none",
              cursor: "pointer",
            }}
          >
            Unlink
          </button>
        </>
      )}
      {status.kind === "error" && (
        <p
          style={{
            fontSize: 12,
            color: "#f87171" /* fixed red on always-dark drawer */,
            margin: "8px 0 0",
          }}
        >
          {status.error}
        </p>
      )}
    </div>
  );
}
