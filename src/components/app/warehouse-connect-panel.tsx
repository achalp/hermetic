"use client";

import { useState, useCallback } from "react";
import type { WarehouseType, WarehouseConnectionConfig, WarehouseTableInfo } from "@/lib/types";

interface WarehouseConnectPanelProps {
  isConnected: boolean;
  isConnecting: boolean;
  tables: WarehouseTableInfo[];
  tableCount: number;
  totalColumns: number;
  warehouseType: WarehouseType | null;
  error: string | null;
  onConnect: (config: WarehouseConnectionConfig) => void;
  onDisconnect: () => void;
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
  tables,
  tableCount,
  totalColumns,
  warehouseType,
  error,
  onConnect,
  onDisconnect,
}: WarehouseConnectPanelProps) {
  const [tab, setTab] = useState<Tab>("postgresql");

  if (isConnected) {
    return (
      <ConnectedSummary
        tables={tables}
        tableCount={tableCount}
        totalColumns={totalColumns}
        warehouseType={warehouseType}
        onDisconnect={onDisconnect}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
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

      {/* Forms */}
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

// ── Connected Summary ────────────────────────────────────────

function ConnectedSummary({
  tables,
  tableCount,
  totalColumns,
  warehouseType,
  onDisconnect,
}: {
  tables: WarehouseTableInfo[];
  tableCount: number;
  totalColumns: number;
  warehouseType: WarehouseType | null;
  onDisconnect: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border-primary p-4">
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
        </div>
        <button
          onClick={onDisconnect}
          className="text-xs text-t-tertiary hover:text-error-text transition-colors"
        >
          Disconnect
        </button>
      </div>

      <div className="flex gap-4 text-xs text-t-secondary">
        <span>{tableCount} tables</span>
        <span>{totalColumns} columns</span>
      </div>

      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-accent hover:text-accent-hover text-left"
      >
        {expanded ? "Hide tables" : "Show tables"}
      </button>

      {expanded && (
        <div className="max-h-48 overflow-y-auto rounded border border-border-primary">
          {tables.map((t) => (
            <div
              key={`${t.schema}.${t.name}`}
              className="flex items-center justify-between border-b border-border-primary px-3 py-1.5 last:border-b-0"
            >
              <span className="font-mono text-xs text-t-primary">{t.name}</span>
              <span className="text-xs text-t-tertiary">
                {formatRowCount(t.row_count_estimate)}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-t-tertiary">
        Ask any question — SQL will be generated automatically across all {tableCount} tables.
      </p>
    </div>
  );
}

function formatRowCount(n: number): string {
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

function PostgresForm({
  isConnecting,
  error,
  onConnect,
}: {
  isConnecting: boolean;
  error: string | null;
  onConnect: (config: WarehouseConnectionConfig) => void;
}) {
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
          <input name="host" required placeholder="localhost" className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Port</label>
          <input name="port" type="number" defaultValue={5432} className={inputClass} />
        </div>
      </div>
      <div>
        <label className={labelClass}>Database</label>
        <input name="database" required placeholder="mydb" className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>User</label>
          <input name="user" required placeholder="postgres" className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Password</label>
          <input name="password" type="password" className={inputClass} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Schema</label>
          <input name="schema" placeholder="public" className={inputClass} />
        </div>
        <div className="flex items-end gap-2 pb-1">
          <input name="ssl" type="checkbox" id="pg-ssl" className="accent-accent" />
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

function BigQueryForm({
  isConnecting,
  error,
  onConnect,
}: {
  isConnecting: boolean;
  error: string | null;
  onConnect: (config: WarehouseConnectionConfig) => void;
}) {
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
        <input name="projectId" required placeholder="my-gcp-project" className={inputClass} />
      </div>
      <div>
        <label className={labelClass}>Dataset</label>
        <input name="dataset" required placeholder="my_dataset" className={inputClass} />
      </div>
      <div>
        <label className={labelClass}>Service Account JSON</label>
        <textarea
          name="credentials"
          required
          rows={4}
          placeholder="Paste your service account JSON key here..."
          className={`${inputClass} resize-none font-mono text-xs`}
        />
      </div>
      <FormError error={error} />
      <ConnectButton isConnecting={isConnecting} />
    </form>
  );
}

function ClickHouseForm({
  isConnecting,
  error,
  onConnect,
}: {
  isConnecting: boolean;
  error: string | null;
  onConnect: (config: WarehouseConnectionConfig) => void;
}) {
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
          <input name="host" required placeholder="play.clickhouse.com" className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Port</label>
          <input name="port" type="number" defaultValue={8123} className={inputClass} />
        </div>
      </div>
      <div>
        <label className={labelClass}>Database</label>
        <input name="database" required placeholder="default" className={inputClass} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>User</label>
          <input name="user" required placeholder="default" className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Password</label>
          <input name="password" type="password" className={inputClass} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input name="ssl" type="checkbox" id="ch-ssl" className="accent-accent" />
        <label htmlFor="ch-ssl" className={labelClass}>
          SSL
        </label>
      </div>
      <FormError error={error} />
      <ConnectButton isConnecting={isConnecting} />
    </form>
  );
}
