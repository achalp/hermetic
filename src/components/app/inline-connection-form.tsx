"use client";

import { useState } from "react";

interface InlineConnectionFormProps {
  visible: boolean;
  onConnect: (config: { type: string; host: string; database: string; password: string }) => void;
}

const dbTypes = [
  { value: "PostgreSQL", label: "\u{1F418} PostgreSQL" },
  { value: "BigQuery", label: "\u{1F4CA} BigQuery" },
  { value: "ClickHouse", label: "\u26A1 ClickHouse" },
  { value: "Trino", label: "\u{1F537} Trino" },
];

const btnBase =
  "flex-1 cursor-pointer text-center transition-all duration-200 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)]";

const inputStyle: React.CSSProperties = {
  background: "var(--color-surface-input)",
  border: "1px solid var(--color-border-default)",
  borderRadius: "var(--radius-button)",
  padding: "10px 14px",
  fontSize: 14,
  outline: "none",
  width: "100%",
};

export function InlineConnectionForm({ visible, onConnect }: InlineConnectionFormProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [database, setDatabase] = useState("");
  const [password, setPassword] = useState("");

  if (!visible) return null;

  return (
    <div
      className="w-full"
      style={{
        maxWidth: 700,
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-default)",
        borderRadius: "var(--radius-card)",
        padding: "20px 24px",
      }}
    >
      <div className="flex gap-2">
        {dbTypes.map((db) => (
          <button
            key={db.value}
            onClick={() => setSelectedType(db.value)}
            className={btnBase}
            style={{
              padding: 10,
              fontSize: 13,
              border: `1px solid ${selectedType === db.value ? "var(--color-accent)" : "var(--color-border-default)"}`,
              borderRadius: "var(--radius-button)",
              background:
                selectedType === db.value ? "var(--color-accent-subtle)" : "var(--color-surface-1)",
              color: selectedType === db.value ? "var(--color-accent)" : "inherit",
            }}
          >
            {db.label}
          </button>
        ))}
      </div>

      {selectedType && (
        <div className="flex flex-col gap-2" style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder="Host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            style={inputStyle}
            className="focus:border-[var(--color-accent)]"
          />
          <input
            type="text"
            placeholder="Database"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            style={inputStyle}
            className="focus:border-[var(--color-accent)]"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
            className="focus:border-[var(--color-accent)]"
          />
          <button
            onClick={() => onConnect({ type: selectedType, host, database, password })}
            style={{
              background: "var(--color-accent)",
              color: "white",
              borderRadius: "var(--radius-button)",
              padding: "10px 24px",
              fontSize: 14,
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
            }}
          >
            Connect
          </button>
        </div>
      )}
    </div>
  );
}
