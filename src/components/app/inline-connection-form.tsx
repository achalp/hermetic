"use client";

import { useState } from "react";
import type { WarehouseConnectionConfig, WarehouseType } from "@/lib/contracts/connection-configs";
import { ENGINES, type EngineFieldSpec } from "@/lib/warehouse/engine-descriptor";

/**
 * Warehouse connection form, rendered FROM the engine descriptor
 * (modularization M5-5g). Previously 17 useState hooks plus a hand-written
 * per-engine field switch — the audit's "engine fields enumerated in five
 * places" seam. Adding an engine is now one ENGINES entry; this form and the
 * config coercion derive from its `fields`.
 */
interface InlineConnectionFormProps {
  visible: boolean;
  onConnect: (config: WarehouseConnectionConfig, force?: boolean) => void;
}

const dbTypes: { value: WarehouseType; emoji: string }[] = [
  { value: "postgresql", emoji: "\u{1F418}" },
  { value: "bigquery", emoji: "\u{1F4CA}" },
  { value: "clickhouse", emoji: "⚡" },
  { value: "trino", emoji: "\u{1F537}" },
  { value: "hive", emoji: "\u{1F41D}" },
  { value: "snowflake", emoji: "❄️" },
  { value: "databricks", emoji: "\u{1F9F1}" },
];

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

type FieldValues = Record<string, string | boolean>;

function coerceField(spec: EngineFieldSpec, raw: string | boolean | undefined): unknown {
  if (spec.input === "checkbox") return raw === true;
  const v = typeof raw === "string" ? raw : "";
  switch (spec.coerce) {
    case "number":
      return Number(v) || spec.fallback;
    case "optional":
      return v.trim() || undefined;
    case "fallback":
      return v || spec.fallback;
    default:
      return v;
  }
}

function buildConfig(type: WarehouseType, values: FieldValues): WarehouseConnectionConfig {
  const config: Record<string, unknown> = { type };
  for (const spec of ENGINES[type].fields) {
    config[spec.key] = coerceField(spec, values[spec.key]);
  }
  // Descriptor-driven assembly can't be statically proven against the config
  // union; the server's zod boundary (api-schemas) is the real validator.
  return config as unknown as WarehouseConnectionConfig; // ratchet-allow: api-boundary-casts
}

function defaultValues(type: WarehouseType): FieldValues {
  const values: FieldValues = {};
  for (const spec of ENGINES[type].fields) {
    if (spec.input === "checkbox") values[spec.key] = false;
    else if (spec.input === "select") values[spec.key] = spec.options?.[0] ?? "";
    else values[spec.key] = "";
  }
  return values;
}

function Field({
  spec,
  value,
  onChange,
}: {
  spec: EngineFieldSpec;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
}) {
  if (spec.input === "checkbox") {
    return (
      <label style={checkboxLabelStyle}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />{" "}
        {spec.placeholder}
      </label>
    );
  }
  if (spec.input === "select") {
    return (
      <select
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
        className="focus:border-[var(--color-accent)]"
        aria-label={spec.placeholder}
      >
        {spec.options?.map((opt) => (
          <option key={opt} value={opt}>
            {spec.placeholder}: {opt}
            {opt === spec.options?.[0] ? " (plain)" : ""}
          </option>
        ))}
      </select>
    );
  }
  if (spec.input === "textarea") {
    return (
      <textarea
        placeholder={spec.placeholder}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        required={spec.required !== false}
        style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
        className="focus:border-[var(--color-accent)]"
      />
    );
  }
  return (
    <input
      type={spec.input}
      placeholder={spec.placeholder}
      value={String(value)}
      required={spec.required !== false}
      onChange={(e) => onChange(e.target.value)}
      style={inputStyle}
      className="focus:border-[var(--color-accent)]"
    />
  );
}

export function InlineConnectionForm({ visible, onConnect }: InlineConnectionFormProps) {
  const [selectedType, setSelectedType] = useState<WarehouseType | null>(null);
  const [values, setValues] = useState<FieldValues>({});
  // "Ignore cache / re-read schema" — bypass the cached introspection.
  const [ignoreCache, setIgnoreCache] = useState(false);

  if (!visible) return null;

  const selectType = (t: WarehouseType) => {
    setSelectedType(t);
    setValues(defaultValues(t));
  };

  const handleConnect = () => {
    if (!selectedType) return;
    onConnect(buildConfig(selectedType, values), ignoreCache);
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
            {db.emoji} {ENGINES[db.value].displayName}
          </button>
        ))}
      </div>
      {selectedType && (
        <div className="flex flex-col" style={{ gap: 8, marginTop: 12 }}>
          {ENGINES[selectedType].fields.map((spec) => (
            <Field
              key={spec.key}
              spec={spec}
              value={values[spec.key] ?? (spec.input === "checkbox" ? false : "")}
              onChange={(v) => setValues((prev) => ({ ...prev, [spec.key]: v }))}
            />
          ))}
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={ignoreCache}
              onChange={(e) => setIgnoreCache(e.target.checked)}
            />{" "}
            Ignore cached schema — re-introspect the warehouse
          </label>
          <button onClick={handleConnect} style={connectBtnStyle}>
            Connect
          </button>
        </div>
      )}
    </div>
  );
}
