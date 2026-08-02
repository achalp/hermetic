"use client";

import { useState } from "react";
import type { WarehouseConnectionConfig } from "@/lib/contracts/connection-configs";

interface InlineConnectionFormProps {
  visible: boolean;
  onConnect: (config: WarehouseConnectionConfig, force?: boolean) => void;
}

const dbTypes = [
  { value: "postgresql", label: "\u{1F418} PostgreSQL" },
  { value: "bigquery", label: "\u{1F4CA} BigQuery" },
  { value: "clickhouse", label: "\u26A1 ClickHouse" },
  { value: "trino", label: "\u{1F537} Trino" },
  { value: "hive", label: "\u{1F41D} Hive" },
  { value: "snowflake", label: "\u2744\uFE0F Snowflake" },
  { value: "databricks", label: "\u{1F9F1} Databricks" },
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
  // Snowflake-specific
  const [account, setAccount] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [role, setRole] = useState("");
  // Databricks-specific
  const [serverHostname, setServerHostname] = useState("");
  const [httpPath, setHttpPath] = useState("");
  const [token, setToken] = useState("");
  // "Ignore cache / re-read schema" — bypass the cached introspection.
  const [ignoreCache, setIgnoreCache] = useState(false);

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
    setAccount("");
    setWarehouse("");
    setRole("");
    setServerHostname("");
    setHttpPath("");
    setToken("");
  };

  const selectType = (t: DbType) => {
    resetFields();
    setSelectedType(t);
  };

  const orUndef = (v: string) => v.trim() || undefined;

  // "Ignore cache / re-read schema" — re-introspect instead of using the cache.
  const doConnect = (config: WarehouseConnectionConfig) => onConnect(config, ignoreCache);

  const handleConnect = () => {
    if (!selectedType) return;
    switch (selectedType) {
      case "postgresql":
        return doConnect({
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
        return doConnect({ type: "bigquery", projectId, dataset, credentialsJson });
      case "clickhouse":
        return doConnect({
          type: "clickhouse",
          host,
          port: Number(port) || 8123,
          database,
          user,
          password,
          ssl,
        });
      case "trino":
        return doConnect({
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
        return doConnect({
          type: "hive",
          host,
          port: Number(port) || 10000,
          database: database || "default",
          user,
          password: orUndef(password),
          auth: auth as "NONE" | "NOSASL" | "LDAP" | "KERBEROS",
        });
      case "snowflake":
        return doConnect({
          type: "snowflake",
          account,
          user,
          password,
          database,
          schema: orUndef(schema),
          warehouse: orUndef(warehouse),
          role: orUndef(role),
        });
      case "databricks":
        return doConnect({
          type: "databricks",
          serverHostname,
          httpPath,
          token,
          catalog,
          schema: orUndef(schema),
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
            {inp("text", "Host (e.g. localhost)", host, setHost)}
            {inp("number", "Port (default 5432)", port || "", setPort, false)}
            {inp("text", "Database (e.g. mydb)", database, setDatabase)}
            {inp("text", "User (e.g. postgres)", user, setUser)}
            {inp("password", "Password", password, setPassword)}
            {check("SSL (check for cloud databases)", ssl, setSsl)}
            {inp("text", "Schema (optional, default 'public')", schema, setSchema, false)}
          </>
        );
      case "bigquery":
        return (
          <>
            {inp("text", "Project ID (e.g. my-gcp-project)", projectId, setProjectId)}
            {inp(
              "text",
              "Dataset (e.g. analytics or bigquery-public-data.stackoverflow)",
              dataset,
              setDataset
            )}
            <textarea
              placeholder="Service Account JSON (paste full key file contents)"
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
            {inp("text", "Host (e.g. play.clickhouse.com)", host, setHost)}
            {inp("number", "Port (8123 for HTTP, 443 for HTTPS)", port || "", setPort, false)}
            {inp("text", "Database (e.g. default)", database, setDatabase)}
            {inp("text", "User (e.g. default or play)", user, setUser)}
            {inp("password", "Password (empty for playground)", password, setPassword, false)}
            {check("SSL (required for port 443)", ssl, setSsl)}
          </>
        );
      case "trino":
        return (
          <>
            {inp("text", "Host (e.g. localhost)", host, setHost)}
            {inp("number", "Port (default 8080)", port || "", setPort, false)}
            {inp("text", "User (e.g. trino)", user, setUser)}
            {inp("text", "Catalog (e.g. hive)", catalog, setCatalog)}
            {inp("text", "Schema (default 'default')", schema, setSchema, false)}
            {inp("password", "Password (optional)", password, setPassword, false)}
            {check("SSL", ssl, setSsl)}
          </>
        );
      case "hive":
        return (
          <>
            {inp("text", "Host (e.g. hiveserver2.example.com)", host, setHost)}
            {inp("number", "Port (default 10000)", port || "", setPort, false)}
            {inp("text", "Database (default 'default')", database, setDatabase, false)}
            {inp("text", "User (e.g. hive)", user, setUser)}
            {inp("password", "Password (optional)", password, setPassword, false)}
            <select
              value={auth}
              onChange={(e) => setAuth(e.target.value)}
              style={inputStyle}
              className="focus:border-[var(--color-accent)]"
              aria-label="Auth method"
            >
              <option value="NONE">Auth method: NONE (plain)</option>
              <option value="NOSASL">Auth method: NOSASL</option>
              <option value="LDAP">Auth method: LDAP</option>
              <option value="KERBEROS">Auth method: KERBEROS</option>
            </select>
          </>
        );
      case "snowflake":
        return (
          <>
            {inp("text", "Account (e.g. abc12345.us-east-1)", account, setAccount)}
            {inp("text", "User", user, setUser)}
            {inp("password", "Password", password, setPassword)}
            {inp("text", "Database (e.g. SNOWFLAKE_SAMPLE_DATA)", database, setDatabase)}
            {inp("text", "Schema (optional, default 'PUBLIC')", schema, setSchema, false)}
            {inp("text", "Warehouse (optional, e.g. COMPUTE_WH)", warehouse, setWarehouse, false)}
            {inp("text", "Role (optional, e.g. ANALYST)", role, setRole, false)}
          </>
        );
      case "databricks":
        return (
          <>
            {inp(
              "text",
              "Server hostname (e.g. abc-123.cloud.databricks.com)",
              serverHostname,
              setServerHostname
            )}
            {inp("text", "HTTP path (e.g. /sql/1.0/warehouses/abc123)", httpPath, setHttpPath)}
            {inp("password", "Personal Access Token (dapi...)", token, setToken)}
            {inp("text", "Catalog (Unity Catalog, e.g. samples)", catalog, setCatalog)}
            {inp("text", "Schema (optional, default 'default')", schema, setSchema, false)}
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
          {check("Ignore cached schema — re-introspect the warehouse", ignoreCache, setIgnoreCache)}
          <button onClick={handleConnect} style={connectBtnStyle}>
            Connect
          </button>
        </div>
      )}
    </div>
  );
}
