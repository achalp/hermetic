"use client";

/**
 * Advanced Configuration (secrets-and-settings spec, 2026-08-06): the
 * Settings-UI face of `data/runtime-config.json` + the OS keychain.
 *
 * - Text/number fields edit the runtime-config blocks; the env-resolved
 *   fallback shows as the placeholder, so "empty field" visibly means
 *   "inherited from environment".
 * - API keys go to the OS keychain ONLY (never files, never echoed back —
 *   the GET reports set/source status, not material). Without a credential
 *   service the key inputs are disabled with the env-var path named.
 */
import { useCallback, useEffect, useState } from "react";
import { errMessage } from "@/lib/logger";
import {
  getSettings,
  putSettings,
  type ApiKeyId,
  type SettingsInfo,
  type SettingsUpdate,
} from "@/app/lib/api";

const S = {
  label: {
    fontSize: 12,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    color: "var(--color-surface-dark-text4)",
    marginBottom: 6,
    display: "block",
  },
  input: {
    width: "100%",
    background: "var(--color-surface-dark-2)",
    border: "1px solid var(--color-surface-dark-3)",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 13,
    color: "var(--color-surface-dark-text)",
    fontFamily: "inherit",
    outline: "none",
    marginBottom: 8,
  },
  fieldLabel: {
    fontSize: 12,
    color: "var(--color-surface-dark-text3)",
    display: "block",
    marginBottom: 2,
  },
  hint: { fontSize: 12, color: "var(--color-surface-dark-text4)", marginTop: 4 },
  badge: {
    fontSize: 11,
    padding: "1px 6px",
    borderRadius: 4,
    background: "var(--color-surface-dark-2)",
    color: "var(--color-surface-dark-text3)",
    marginLeft: 6,
  },
  button: (busy: boolean) => ({
    padding: "6px 14px",
    fontSize: 12,
    borderRadius: 6,
    border: "none",
    cursor: busy ? "default" : "pointer",
    fontFamily: "inherit",
    background: "var(--color-accent)",
    color: "#fff",
    opacity: busy ? 0.6 : 1,
  }),
  divider: { borderTop: "1px solid var(--color-surface-dark-2)", margin: "14px 0" },
  error: { fontSize: 12, color: "var(--color-error, #e5484d)", marginTop: 6 },
};

const API_KEY_FIELDS: Array<{ id: ApiKeyId; label: string }> = [
  { id: "anthropic", label: "Anthropic API key" },
  { id: "openai", label: "OpenAI-compatible API key" },
  { id: "e2b", label: "E2B API key" },
  { id: "microsandbox", label: "Microsandbox API key" },
];

type Drafts = Record<string, string>;

function Field(props: {
  id: string;
  label: string;
  value: string;
  placeholder?: string | null;
  type?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label style={S.fieldLabel} htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        type={props.type ?? "text"}
        style={S.input}
        value={props.value}
        placeholder={props.placeholder ?? undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}

export function ConfigSection() {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [keyDrafts, setKeyDrafts] = useState<Partial<Record<ApiKeyId, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getSettings(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setInfo(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const draft = useCallback(
    (key: string, stored: string | number | null | undefined): string =>
      drafts[key] !== undefined ? drafts[key] : stored == null ? "" : String(stored),
    [drafts]
  );

  const setDraft = (key: string) => (v: string) => setDrafts((d) => ({ ...d, [key]: v }));

  const save = async () => {
    if (!info) return;
    setBusy(true);
    setError(null);
    const update: SettingsUpdate = {
      providers: {
        openaiBaseUrl: draft("openaiBaseUrl", info.config.providers.openaiBaseUrl),
        openaiModel: draft("openaiModel", info.config.providers.openaiModel),
        vertexProject: draft("vertexProject", info.config.providers.vertexProject),
        vertexLocation: draft("vertexLocation", info.config.providers.vertexLocation),
        awsRegion: draft("awsRegion", info.config.providers.awsRegion),
      },
      sandbox: {
        microsandboxUrl: draft("microsandboxUrl", info.config.sandbox.microsandboxUrl),
        microsandboxImage: draft("microsandboxImage", info.config.sandbox.microsandboxImage),
        memoryFraction: draft("memoryFraction", info.config.sandbox.memoryFraction),
      },
      retention: {
        maxHistoryEntries: draft("maxHistoryEntries", info.config.retention.maxHistoryEntries),
        maxRunRecords: draft("maxRunRecords", info.config.retention.maxRunRecords),
      },
      ...(Object.keys(keyDrafts).length > 0 ? { api_keys: keyDrafts } : {}),
    };
    try {
      const next = await putSettings(update);
      setInfo(next);
      setDrafts({});
      setKeyDrafts({});
      setSavedAt(Date.now());
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!info) {
    return <div style={S.hint}>Loading configuration…</div>;
  }

  const dirty = Object.keys(drafts).length > 0 || Object.keys(keyDrafts).length > 0;

  return (
    <div>
      {/* ── API keys (OS keychain) ── */}
      <div style={S.label}>API KEYS</div>
      {info.keychain_available ? (
        <>
          {API_KEY_FIELDS.map(({ id, label }) => {
            const status = info.api_keys[id];
            return (
              <div key={id}>
                <label style={S.fieldLabel} htmlFor={`key-${id}`}>
                  {label}
                  {status?.set ? (
                    <span style={S.badge}>set · {status.source}</span>
                  ) : (
                    <span style={S.badge}>not set</span>
                  )}
                </label>
                <input
                  id={`key-${id}`}
                  type="password"
                  autoComplete="off"
                  style={S.input}
                  placeholder={status?.set ? "•••••••• (leave blank to keep)" : "sk-…"}
                  value={keyDrafts[id] ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setKeyDrafts((d) => {
                      const next = { ...d };
                      if (v === "") delete next[id];
                      else next[id] = v;
                      return next;
                    });
                  }}
                />
              </div>
            );
          })}
          <div style={S.hint}>
            Keys are stored in your OS keychain — never in files. Type a new value to replace, or a
            single space to delete a stored key.
          </div>
        </>
      ) : (
        <div style={S.hint}>
          No OS credential service detected — set keys via environment variables (e.g.
          ANTHROPIC_API_KEY in .env.local) instead.
        </div>
      )}

      <div style={S.divider} />

      {/* ── Provider endpoints ── */}
      <div style={S.label}>PROVIDER ENDPOINTS</div>
      <Field
        id="openaiBaseUrl"
        label="OpenAI-compatible base URL"
        value={draft("openaiBaseUrl", info.config.providers.openaiBaseUrl)}
        placeholder={info.effective.providers.openaiBaseUrl}
        onChange={setDraft("openaiBaseUrl")}
      />
      <Field
        id="openaiModel"
        label="OpenAI-compatible model"
        value={draft("openaiModel", info.config.providers.openaiModel)}
        placeholder={info.effective.providers.openaiModel}
        onChange={setDraft("openaiModel")}
      />
      <Field
        id="vertexProject"
        label="Vertex project"
        value={draft("vertexProject", info.config.providers.vertexProject)}
        placeholder={info.effective.providers.vertexProject}
        onChange={setDraft("vertexProject")}
      />
      <Field
        id="vertexLocation"
        label="Vertex location"
        value={draft("vertexLocation", info.config.providers.vertexLocation)}
        placeholder={info.effective.providers.vertexLocation}
        onChange={setDraft("vertexLocation")}
      />
      <Field
        id="awsRegion"
        label="AWS region (Bedrock)"
        value={draft("awsRegion", info.config.providers.awsRegion)}
        placeholder={info.effective.providers.awsRegion}
        onChange={setDraft("awsRegion")}
      />
      <div style={S.hint}>Empty fields inherit from environment variables.</div>

      <div style={S.divider} />

      {/* ── Sandbox ── */}
      <div style={S.label}>SANDBOX</div>
      <Field
        id="microsandboxUrl"
        label="Microsandbox server URL"
        value={draft("microsandboxUrl", info.config.sandbox.microsandboxUrl)}
        placeholder={info.effective.sandbox.microsandboxUrl}
        onChange={setDraft("microsandboxUrl")}
      />
      <Field
        id="microsandboxImage"
        label="Microsandbox image"
        value={draft("microsandboxImage", info.config.sandbox.microsandboxImage)}
        placeholder={info.effective.sandbox.microsandboxImage}
        onChange={setDraft("microsandboxImage")}
      />
      <Field
        id="memoryFraction"
        label="Sandbox memory fraction (0–1)"
        value={draft("memoryFraction", info.config.sandbox.memoryFraction)}
        placeholder={String(info.effective.sandbox.memoryFraction ?? "")}
        onChange={setDraft("memoryFraction")}
      />

      <div style={S.divider} />

      {/* ── Retention ── */}
      <div style={S.label}>RETENTION</div>
      <Field
        id="maxHistoryEntries"
        label="Max history entries"
        value={draft("maxHistoryEntries", info.config.retention.maxHistoryEntries)}
        placeholder={String(info.effective.retention.maxHistoryEntries ?? "")}
        onChange={setDraft("maxHistoryEntries")}
      />
      <Field
        id="maxRunRecords"
        label="Max run diagnostics records"
        value={draft("maxRunRecords", info.config.retention.maxRunRecords)}
        placeholder={String(info.effective.retention.maxRunRecords ?? "")}
        onChange={setDraft("maxRunRecords")}
      />

      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <button style={S.button(busy)} onClick={save} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save configuration"}
        </button>
        {savedAt && !dirty && !error ? <span style={S.hint}>Saved</span> : null}
      </div>
      {error ? <div style={S.error}>{error}</div> : null}
    </div>
  );
}
