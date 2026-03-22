"use client";

import { useState, useCallback } from "react";
import type {
  WarehouseType,
  WarehouseConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
} from "@/lib/types";
import { getWarehouseSample, type SavedConnectionInfo } from "@/lib/api";

interface WarehouseConnectPanelProps {
  isConnected: boolean;
  isConnecting: boolean;
  warehouseId: string | null;
  tables: WarehouseTableInfo[];
  tableSchemas: WarehouseTableSchema[];
  tableCount: number;
  totalColumns: number;
  warehouseType: WarehouseType | null;
  error: string | null;
  savedConnections: SavedConnectionInfo[];
  onConnect: (config: WarehouseConnectionConfig) => void;
  onDisconnect: () => void;
  onDeleteSaved: (id: string) => void;
}

type Tab = "postgresql" | "bigquery" | "clickhouse";

const TAB_LABELS: Record<Tab, string> = {
  postgresql: "PostgreSQL",
  bigquery: "BigQuery",
  clickhouse: "ClickHouse",
};

export function WarehouseConnectPanel({
  isConnected,
  isConnecting,
  warehouseId,
  tables,
  tableSchemas,
  tableCount,
  totalColumns,
  warehouseType,
  error,
  savedConnections,
  onConnect,
  onDisconnect,
  onDeleteSaved,
}: WarehouseConnectPanelProps) {
  const [tab, setTab] = useState<Tab>((savedConnections[0]?.config.type as Tab) ?? "postgresql");
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleConnectSaved = useCallback(
    (saved: SavedConnectionInfo) => {
      setConnectingId(saved.id);
      onConnect(saved.config);
    },
    [onConnect]
  );

  if (isConnected) {
    return (
      <DataDictionary
        warehouseId={warehouseId}
        tables={tables}
        tableSchemas={tableSchemas}
        tableCount={tableCount}
        totalColumns={totalColumns}
        warehouseType={warehouseType}
        onDisconnect={onDisconnect}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Saved connections */}
      {savedConnections.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-t-secondary">Saved connections</p>
          {savedConnections.map((saved) => {
            const isThisConnecting = isConnecting && connectingId === saved.id;
            const isEditing = editingId === saved.id;
            return (
              <div key={saved.id} className="rounded-lg border border-accent/30 bg-accent/5">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    onClick={() => handleConnectSaved(saved)}
                    disabled={isConnecting}
                    className="flex flex-1 items-center justify-between text-left transition-colors hover:opacity-80 disabled:opacity-50"
                  >
                    <span className="text-sm font-medium text-t-primary">{saved.label}</span>
                    <span className="text-xs font-medium text-accent">
                      {isThisConnecting ? "Connecting..." : "Connect"}
                    </span>
                  </button>
                  <button
                    onClick={() => setEditingId(isEditing ? null : saved.id)}
                    disabled={isConnecting}
                    className="shrink-0 text-xs text-t-tertiary hover:text-t-primary transition-colors disabled:opacity-50"
                  >
                    {isEditing ? "Cancel" : "Edit"}
                  </button>
                  <button
                    onClick={() => onDeleteSaved(saved.id)}
                    disabled={isConnecting}
                    className="shrink-0 text-xs text-t-tertiary hover:text-error-text transition-colors disabled:opacity-50"
                    title="Delete saved connection"
                  >
                    Forget
                  </button>
                </div>
                {isEditing && (
                  <div className="border-t border-accent/20 px-3 py-3">
                    {saved.config.type === "postgresql" && (
                      <PostgresForm
                        isConnecting={isConnecting}
                        error={error}
                        onConnect={onConnect}
                        defaults={saved.config}
                      />
                    )}
                    {saved.config.type === "bigquery" && (
                      <BigQueryForm
                        isConnecting={isConnecting}
                        error={error}
                        onConnect={onConnect}
                        defaults={saved.config}
                      />
                    )}
                    {saved.config.type === "clickhouse" && (
                      <ClickHouseForm
                        isConnecting={isConnecting}
                        error={error}
                        onConnect={onConnect}
                        defaults={saved.config}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="text-xs text-error-text">{error}</p>}

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-surface-secondary p-1">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t
                ? "bg-surface-primary text-t-primary shadow-sm"
                : "text-t-tertiary hover:text-t-secondary"
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "postgresql" && (
        <PostgresForm isConnecting={isConnecting} error={error} onConnect={onConnect} />
      )}
      {tab === "bigquery" && (
        <BigQueryForm isConnecting={isConnecting} error={error} onConnect={onConnect} />
      )}
      {tab === "clickhouse" && (
        <ClickHouseForm isConnecting={isConnecting} error={error} onConnect={onConnect} />
      )}
    </div>
  );
}

// ── Data Dictionary ──────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  number: "bg-blue-500/15 text-blue-400",
  integer: "bg-blue-500/15 text-blue-400",
  float: "bg-blue-500/15 text-blue-400",
  string: "bg-emerald-500/15 text-emerald-400",
  text: "bg-emerald-500/15 text-emerald-400",
  date: "bg-purple-500/15 text-purple-400",
  timestamp: "bg-purple-500/15 text-purple-400",
  boolean: "bg-amber-500/15 text-amber-400",
  bool: "bg-amber-500/15 text-amber-400",
};

function getTypeBadgeClass(type: string): string {
  const lower = type.toLowerCase();
  for (const [key, cls] of Object.entries(TYPE_COLORS)) {
    if (lower.includes(key)) return cls;
  }
  return "bg-surface-secondary text-t-tertiary";
}

function DataDictionary({
  warehouseId,
  tables,
  tableSchemas,
  tableCount,
  totalColumns,
  warehouseType,
  onDisconnect,
}: {
  warehouseId: string | null;
  tables: WarehouseTableInfo[];
  tableSchemas: WarehouseTableSchema[];
  tableCount: number;
  totalColumns: number;
  warehouseType: WarehouseType | null;
  onDisconnect: () => void;
}) {
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // Build a lookup from table name → schema
  const schemaMap = new Map(tableSchemas.map((s) => [s.name, s]));

  // Filter tables and columns
  const filterLower = filter.toLowerCase();
  const filteredTables = filter
    ? tables.filter((t) => {
        if (t.name.toLowerCase().includes(filterLower)) return true;
        const schema = schemaMap.get(t.name);
        return schema?.columns.some((c) => c.name.toLowerCase().includes(filterLower));
      })
    : tables;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-primary p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          <span className="text-sm font-medium text-t-primary">
            Connected to{" "}
            {warehouseType === "postgresql"
              ? "PostgreSQL"
              : warehouseType === "bigquery"
                ? "BigQuery"
                : "ClickHouse"}
          </span>
          <span className="text-xs text-t-tertiary">
            {tableCount} tables / {totalColumns} columns
          </span>
        </div>
        <button
          onClick={onDisconnect}
          className="text-xs text-t-tertiary hover:text-error-text transition-colors"
        >
          Disconnect
        </button>
      </div>

      {/* Search */}
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Search tables and columns..."
        className="w-full rounded-md border border-border-primary bg-surface-primary px-3 py-1.5 text-xs text-t-primary placeholder:text-t-tertiary focus:border-accent focus:outline-none"
      />

      {/* Table list */}
      <div className="max-h-80 overflow-y-auto rounded-lg border border-border-primary">
        {filteredTables.map((t) => {
          const schema = schemaMap.get(t.name);
          const isExpanded = expandedTable === t.name;

          return (
            <div key={t.name} className="border-b border-border-primary last:border-b-0">
              {/* Table header row */}
              <button
                onClick={() => setExpandedTable(isExpanded ? null : t.name)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-secondary transition-colors"
              >
                <svg
                  className={`h-3 w-3 text-t-tertiary shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M8 5l8 7-8 7z" />
                </svg>
                <span className="font-mono text-xs font-medium text-t-primary">{t.name}</span>
                <span className="text-xs text-t-tertiary ml-auto">
                  {schema?.columns.length ?? t.column_count} cols
                  {t.row_count_estimate > 0 && <> / {formatRowCount(t.row_count_estimate)}</>}
                </span>
              </button>

              {/* Expanded: columns + sample data */}
              {isExpanded && schema && (
                <TableDetail
                  warehouseId={warehouseId}
                  tableName={t.name}
                  schema={schema}
                  filterText={filterLower}
                />
              )}
            </div>
          );
        })}

        {filteredTables.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-t-tertiary">
            No tables or columns match &ldquo;{filter}&rdquo;
          </div>
        )}
      </div>

      <p className="text-xs text-t-tertiary">
        Ask any question — SQL will be generated automatically across all {tableCount} tables.
      </p>
    </div>
  );
}

function TableDetail({
  warehouseId,
  tableName,
  schema,
  filterText,
}: {
  warehouseId: string | null;
  tableName: string;
  schema: WarehouseTableSchema;
  filterText: string;
}) {
  const [sampleData, setSampleData] = useState<{ headers: string[]; rows: string[][] } | null>(
    null
  );
  const [loadingSample, setLoadingSample] = useState(false);
  const [showSample, setShowSample] = useState(false);

  const pkSet = new Set(schema.primary_key ?? []);
  const fkMap = new Map(
    (schema.foreign_keys ?? []).map((fk) => [
      fk.column,
      `${fk.references_table}.${fk.references_column}`,
    ])
  );

  const loadSample = useCallback(async () => {
    if (sampleData || !warehouseId) return;
    setLoadingSample(true);
    try {
      const data = await getWarehouseSample(warehouseId, tableName);
      setSampleData(data);
    } catch {
      setSampleData({ headers: [], rows: [] });
    } finally {
      setLoadingSample(false);
    }
  }, [warehouseId, tableName, sampleData]);

  const handleToggleSample = useCallback(() => {
    if (!showSample && !sampleData) {
      loadSample();
    }
    setShowSample(!showSample);
  }, [showSample, sampleData, loadSample]);

  return (
    <div className="border-t border-border-primary bg-surface-secondary/50 px-3 py-2 space-y-2">
      {/* Column list */}
      <div className="space-y-0.5">
        {schema.columns.map((col) => {
          const isPK = pkSet.has(col.name);
          const fkRef = fkMap.get(col.name);
          const highlight = filterText && col.name.toLowerCase().includes(filterText);

          return (
            <div
              key={col.name}
              className={`flex items-center gap-2 rounded px-1.5 py-0.5 text-xs ${highlight ? "bg-accent/10" : ""}`}
            >
              <span className={`font-mono ${highlight ? "text-accent" : "text-t-primary"}`}>
                {col.name}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${getTypeBadgeClass(col.type)}`}
              >
                {col.type}
              </span>
              {isPK && (
                <span className="rounded bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                  PK
                </span>
              )}
              {fkRef && (
                <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium text-cyan-400">
                  FK→{fkRef}
                </span>
              )}
              {col.nullable && <span className="text-[10px] text-t-tertiary">null</span>}
            </div>
          );
        })}
      </div>

      {/* Sample data toggle */}
      <button
        onClick={handleToggleSample}
        className="text-[11px] text-accent hover:text-accent-hover"
      >
        {loadingSample ? "Loading..." : showSample ? "Hide sample" : "Preview 5 rows"}
      </button>

      {/* Sample data table */}
      {showSample && sampleData && sampleData.rows.length > 0 && (
        <div className="overflow-x-auto rounded border border-border-primary">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-surface-secondary">
                {sampleData.headers.map((h) => (
                  <th
                    key={h}
                    className="px-2 py-1 text-left font-mono font-medium text-t-secondary whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sampleData.rows.map((row, i) => (
                <tr key={i} className="border-t border-border-primary">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="px-2 py-1 font-mono text-t-primary whitespace-nowrap max-w-[200px] truncate"
                    >
                      {cell || <span className="text-t-tertiary italic">null</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showSample && sampleData && sampleData.rows.length === 0 && (
        <p className="text-[11px] text-t-tertiary italic">No data in table</p>
      )}
    </div>
  );
}

function formatRowCount(n: number): string {
  if (n >= 1_000_000_000) return `~${(n / 1_000_000_000).toFixed(1)}B rows`;
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M rows`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}K rows`;
  if (n > 0) return `~${n} rows`;
  return "";
}

// ── Form Components ──────────────────────────────────────────

const inputClass =
  "w-full rounded-md border border-border-primary bg-surface-primary px-3 py-1.5 text-sm text-t-primary placeholder:text-t-tertiary focus:border-accent focus:outline-none";
const labelClass = "text-xs font-medium text-t-secondary";

function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="text-xs text-error-text">{error}</p>;
}

interface FormProps {
  isConnecting: boolean;
  error: string | null;
  onConnect: (config: WarehouseConnectionConfig) => void;
  defaults?: WarehouseConnectionConfig;
}

function ConnectButton({ isConnecting }: { isConnecting: boolean }) {
  return (
    <button
      type="submit"
      disabled={isConnecting}
      className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
    >
      {isConnecting ? "Connecting..." : "Connect"}
    </button>
  );
}

function PostgresForm({ isConnecting, error, onConnect, defaults }: FormProps) {
  const pg = defaults?.type === "postgresql" ? defaults : undefined;
  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      onConnect({
        type: "postgresql",
        host: fd.get("host") as string,
        port: Number(fd.get("port")) || 5432,
        database: fd.get("database") as string,
        user: fd.get("user") as string,
        password: fd.get("password") as string,
        ssl: fd.get("ssl") === "on",
        schema: (fd.get("schema") as string) || "public",
      });
    },
    [onConnect]
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className={labelClass}>Host</label>
          <input
            name="host"
            required
            placeholder="localhost"
            defaultValue={pg?.host}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Port</label>
          <input name="port" type="number" defaultValue={pg?.port ?? 5432} className={inputClass} />
        </div>
      </div>
      <div>
        <label className={labelClass}>Database</label>
        <input
          name="database"
          required
          placeholder="mydb"
          defaultValue={pg?.database}
          className={inputClass}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>User</label>
          <input
            name="user"
            required
            placeholder="postgres"
            defaultValue={pg?.user}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Password</label>
          <input
            name="password"
            type="password"
            defaultValue={pg?.password}
            className={inputClass}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Schema</label>
          <input
            name="schema"
            placeholder="public"
            defaultValue={pg?.schema}
            className={inputClass}
          />
        </div>
        <div className="flex items-end gap-2 pb-1">
          <input
            name="ssl"
            type="checkbox"
            id="pg-ssl"
            defaultChecked={pg?.ssl}
            className="accent-accent"
          />
          <label htmlFor="pg-ssl" className={labelClass}>
            SSL
          </label>
        </div>
      </div>
      <FormError error={error} />
      <ConnectButton isConnecting={isConnecting} />
    </form>
  );
}

function BigQueryForm({ isConnecting, error, onConnect, defaults }: FormProps) {
  const bq = defaults?.type === "bigquery" ? defaults : undefined;
  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      onConnect({
        type: "bigquery",
        projectId: fd.get("projectId") as string,
        dataset: fd.get("dataset") as string,
        credentialsJson: fd.get("credentials") as string,
      });
    },
    [onConnect]
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div>
        <label className={labelClass}>Project ID</label>
        <input
          name="projectId"
          required
          placeholder="my-gcp-project"
          defaultValue={bq?.projectId}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass}>Dataset</label>
        <input
          name="dataset"
          required
          placeholder="my_dataset"
          defaultValue={bq?.dataset}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass}>Service Account JSON</label>
        <textarea
          name="credentials"
          required
          rows={4}
          placeholder="Paste your service account JSON key here..."
          defaultValue={bq?.credentialsJson}
          className={`${inputClass} resize-none font-mono text-xs`}
        />
      </div>
      <FormError error={error} />
      <ConnectButton isConnecting={isConnecting} />
    </form>
  );
}

function ClickHouseForm({ isConnecting, error, onConnect, defaults }: FormProps) {
  const ch = defaults?.type === "clickhouse" ? defaults : undefined;
  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      onConnect({
        type: "clickhouse",
        host: fd.get("host") as string,
        port: Number(fd.get("port")) || 8123,
        database: fd.get("database") as string,
        user: fd.get("user") as string,
        password: fd.get("password") as string,
        ssl: fd.get("ssl") === "on",
      });
    },
    [onConnect]
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className={labelClass}>Host</label>
          <input
            name="host"
            required
            placeholder="play.clickhouse.com"
            defaultValue={ch?.host}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Port</label>
          <input name="port" type="number" defaultValue={ch?.port ?? 8123} className={inputClass} />
        </div>
      </div>
      <div>
        <label className={labelClass}>Database</label>
        <input
          name="database"
          required
          placeholder="default"
          defaultValue={ch?.database}
          className={inputClass}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>User</label>
          <input
            name="user"
            required
            placeholder="default"
            defaultValue={ch?.user}
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Password</label>
          <input
            name="password"
            type="password"
            defaultValue={ch?.password}
            className={inputClass}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          name="ssl"
          type="checkbox"
          id="ch-ssl"
          defaultChecked={ch?.ssl}
          className="accent-accent"
        />
        <label htmlFor="ch-ssl" className={labelClass}>
          SSL
        </label>
      </div>
      <FormError error={error} />
      <ConnectButton isConnecting={isConnecting} />
    </form>
  );
}
