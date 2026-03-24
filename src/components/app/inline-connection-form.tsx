"use client";

import { useState } from "react";
import type { WarehouseConnectionConfig } from "@/lib/types";

interface InlineConnectionFormProps {
  visible: boolean;
  onConnect: (config: WarehouseConnectionConfig) => void;
}

const dbTypes = [
  { value: "postgresql", label: "\u{1F418} PostgreSQL" },
  { value: "bigquery", label: "\u{1F4CA} BigQuery" },
  { value: "clickhouse", label: "\u26A1 ClickHouse" },
  { value: "trino", label: "\u{1F537} Trino" },
  { value: "hive", label: "\u{1F41D} Hive" },
] as const;

type DbType = (typeof dbTypes)[number]["value"];

const inputStyle: React.CSSProperties = {
  background: "var(--color-surface-input)",
  border: "1px solid var(--color-border-default)",
  borderRadius: "var(--radius-button)",
  padding: "10px 14px",
  fontSize: 14,
  outline: "none",
  width: "100%",
  color: "var(--color-t-primary)",
};

const checkboxLabelStyle: React.CSSProperties = {
  fontSize: 13,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const connectBtnStyle: React.CSSProperties = {
  background: "var(--color-accent)",
  color: "white",
  borderRadius: "var(--radius-button)",
  padding: "10px 24px",
  fontSize: 14,
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
  alignSelf: "flex-start",
  marginTop: 4,
};

export function InlineConnectionForm({ visible, onConnect }: InlineConnectionFormProps) {
  const [selectedType, setSelectedType] = useState<DbType | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [database, setDatabase] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState(false);
  const [schema, setSchema] = useState("");
  const [projectId, setProjectId] = useState("");
  const [dataset, setDataset] = useState("");
  const [credentialsJson, setCredentialsJson] = useState("");
  const [catalog, setCatalog] = useState("");
  const [auth, setAuth] = useState("NONE");

  if (!visible) return null;

  const resetFields = () => {
    setHost("");
    setPort("");
    setDatabase("");
    setUser("");
    setPassword("");
    setSsl(false);
    setSchema("");
    setProjectId("");
    setDataset("");
    setCredentialsJson("");
    setCatalog("");
    setAuth("NONE");
  };

  const selectType = (t: DbType) => {
    resetFields();
    setSelectedType(t);
  };

  const orUndef = (v: string) => v.trim() || undefined;

  const handleConnect = () => {
    if (!selectedType) return;
    switch (selectedType) {
      case "postgresql":
        return onConnect({
          type: "postgresql",
          host,
          port: Number(port) || 5432,
          database,
          user,
          password,
          ssl,
          schema: orUndef(schema) as string | undefined,
        });
      case "bigquery":
        return onConnect({ type: "bigquery", projectId, dataset, credentialsJson });
      case "clickhouse":
        return onConnect({
          type: "clickhouse",
          host,
          port: Number(port) || 8123,
          database,
          user,
          password,
          ssl,
        });
      case "trino":
        return onConnect({
          type: "trino",
          host,
          port: Number(port) || 8080,
          user,
          catalog,
          schema: schema || "default",
          password: orUndef(password),
          ssl,
        });
      case "hive":
        return onConnect({
          type: "hive",
          host,
          port: Number(port) || 10000,
          database: database || "default",
          user,
          password: orUndef(password),
          auth: auth as "NONE" | "NOSASL" | "LDAP" | "KERBEROS",
        });
    }
  };

  const inp = (
    type: string,
    placeholder: string,
    value: string,
    onChange: (v: string) => void,
    required = true
  ) => (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      style={inputStyle}
      className="focus:border-[var(--color-accent)]"
    />
  );

  const check = (label: string, checked: boolean, onChange: (v: boolean) => void) => (
    <label style={checkboxLabelStyle}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{" "}
      {label}
    </label>
  );

  const renderFields = () => {
    switch (selectedType) {
      case "postgresql":
        return (
          <>
            {inp("text", "localhost", host, setHost)}
            {inp("number", "5432", port || "", setPort, false)}
            {inp("text", "Database", database, setDatabase)}
            {inp("text", "postgres", user, setUser)}
            {inp("password", "Password", password, setPassword)}
            {check("SSL", ssl, setSsl)}
            {inp("text", "public", schema, setSchema, false)}
          </>
        );
      case "bigquery":
        return (
          <>
            {inp("text", "my-project-123", projectId, setProjectId)}
            {inp("text", "analytics", dataset, setDataset)}
            <textarea
              placeholder="Paste service account JSON..."
              value={credentialsJson}
              onChange={(e) => setCredentialsJson(e.target.value)}
              required
              style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
              className="focus:border-[var(--color-accent)]"
            />
          </>
        );
      case "clickhouse":
        return (
          <>
            {inp("text", "localhost", host, setHost)}
            {inp("number", "8123", port || "", setPort, false)}
            {inp("text", "default", database, setDatabase)}
            {inp("text", "default", user, setUser)}
            {inp("password", "Password", password, setPassword)}
            {check("SSL", ssl, setSsl)}
          </>
        );
      case "trino":
        return (
          <>
            {inp("text", "localhost", host, setHost)}
            {inp("number", "8080", port || "", setPort, false)}
            {inp("text", "trino", user, setUser)}
            {inp("text", "hive", catalog, setCatalog)}
            {inp("text", "default", schema, setSchema, false)}
            {inp("password", "Password (optional)", password, setPassword, false)}
            {check("SSL", ssl, setSsl)}
          </>
        );
      case "hive":
        return (
          <>
            {inp("text", "localhost", host, setHost)}
            {inp("number", "10000", port || "", setPort, false)}
            {inp("text", "default", database, setDatabase, false)}
            {inp("text", "hive", user, setUser)}
            {inp("password", "Password (optional)", password, setPassword, false)}
            <select
              value={auth}
              onChange={(e) => setAuth(e.target.value)}
              style={inputStyle}
              className="focus:border-[var(--color-accent)]"
            >
              <option value="NONE">NONE</option>
              <option value="NOSASL">NOSASL</option>
              <option value="LDAP">LDAP</option>
              <option value="KERBEROS">KERBEROS</option>
            </select>
          </>
        );
      default:
        return null;
    }
  };

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
      <div className="flex flex-wrap" style={{ gap: 8 }}>
        {dbTypes.map((db) => (
          <button
            key={db.value}
            onClick={() => selectType(db.value)}
            style={{
              flex: 1,
              minWidth: 120,
              padding: 10,
              fontSize: 13,
              textAlign: "center",
              cursor: "pointer",
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
        <div className="flex flex-col" style={{ gap: 8, marginTop: 12 }}>
          {renderFields()}
          <button onClick={handleConnect} style={connectBtnStyle}>
            Connect
          </button>
        </div>
      )}
    </div>
  );
}
