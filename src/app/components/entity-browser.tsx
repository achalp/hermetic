"use client";

/**
 * The dataset-manifest entity browser (spec §6, settled in review):
 * master-detail — a list of entities on the left; clicking one shows its
 * schema, sample rows, and any description carried by the manifest, with the
 * dataset-level description in the header. "Analyze this entity" hands the
 * entity's csvId to the app as the active source (single-entity until P2's
 * cross-entity question flow).
 */
import { useCallback, useState } from "react";
import type { ManifestView, ManifestEntityDetail } from "@/lib/manifest/view";

interface EntityBrowserProps {
  view: ManifestView;
  /** Resolve one entity to full detail — extracts lazily when still pending. */
  onOpenEntity: (name: string) => Promise<ManifestEntityDetail>;
  /** Make this entity the active source. */
  onUseEntity: (detail: ManifestEntityDetail) => void;
  onCancel: () => void;
}

function formatRows(n: number | undefined, exact: boolean): string {
  if (n === undefined) return "—";
  const s = n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : `${n}`;
  return exact ? s : `~${s}`;
}

const STATUS_LABEL = { ready: "ready", pending: "not read yet", failed: "failed" } as const;

export function EntityBrowser({ view, onOpenEntity, onUseEntity, onCancel }: EntityBrowserProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ManifestEntityDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(
    async (name: string) => {
      setSelected(name);
      setDetail(null);
      setError(null);
      setLoading(true);
      try {
        setDetail(await onOpenEntity(name));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't read that entity.");
      } finally {
        setLoading(false);
      }
    },
    [onOpenEntity]
  );

  const docFor = (col: string): string | undefined =>
    detail?.columnDocs?.find((d) => d.name === col)?.description;

  return (
    <div
      className="theme-card border border-border-default bg-surface-1 overflow-hidden"
      style={{ borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-card)" }}
    >
      {/* Header: the dataset-level story */}
      <div className="px-6 pt-6 pb-4">
        <h3 className="text-lg font-semibold text-t-primary">{view.title ?? "Dataset manifest"}</h3>
        <p className="mt-1 text-sm text-t-secondary">
          {view.entities.length} entities · {view.format}
          {view.license ? ` · ${view.license}` : ""}
        </p>
        {view.description && <p className="mt-2 text-sm text-t-secondary">{view.description}</p>}
        {view.excluded.length > 0 && (
          <p className="mt-2 text-xs text-warning-text">
            {view.excluded.length} entr{view.excluded.length === 1 ? "y" : "ies"} excluded
            (cross-host — not on the manifest&apos;s own host).
          </p>
        )}
      </div>

      <div className="flex border-t border-border-default" style={{ minHeight: "20rem" }}>
        {/* Entity list */}
        <div
          className="w-72 shrink-0 overflow-y-auto border-r border-border-default"
          style={{ maxHeight: "28rem" }}
        >
          {view.entities.map((e) => (
            <button
              key={e.name}
              onClick={() => void open(e.name)}
              className={`block w-full px-4 py-3 text-left transition-colors hover:bg-surface-2 ${
                selected === e.name ? "bg-surface-2" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-t-primary">{e.name}</span>
                <span
                  className={`shrink-0 text-xs ${
                    e.status === "failed" ? "text-error-text" : "text-t-tertiary"
                  }`}
                >
                  {e.status === "ready"
                    ? formatRows(e.rowCount, e.rowCountIsExact)
                    : STATUS_LABEL[e.status]}
                </span>
              </div>
              {e.description && (
                <p className="mt-0.5 truncate text-xs text-t-tertiary">{e.description}</p>
              )}
            </button>
          ))}
        </div>

        {/* Detail pane */}
        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4" style={{ maxHeight: "28rem" }}>
          {!selected && (
            <p className="text-sm text-t-tertiary">
              Select an entity to see its schema and sample data.
            </p>
          )}
          {loading && <p className="text-sm text-t-secondary">Reading {selected}…</p>}
          {error && <p className="text-sm text-error-text">{error}</p>}
          {detail && !loading && (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="text-base font-semibold text-t-primary">{detail.name}</h4>
                  {detail.description && (
                    <p className="mt-1 text-sm text-t-secondary">{detail.description}</p>
                  )}
                </div>
                {detail.schema && (
                  <button
                    onClick={() => onUseEntity(detail)}
                    className="shrink-0 bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
                    style={{
                      borderRadius: "var(--radius-button)",
                      transitionDuration: "var(--transition-speed)",
                    }}
                  >
                    Analyze this entity
                  </button>
                )}
              </div>

              {detail.error && <p className="mt-3 text-sm text-error-text">{detail.error}</p>}

              {detail.schema && (
                <>
                  <p className="mt-3 text-xs text-t-tertiary">
                    {detail.schema.row_count.toLocaleString()} rows · {detail.schema.columns.length}{" "}
                    columns
                  </p>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-border-default text-t-tertiary">
                          <th className="py-1 pr-3 font-medium">Column</th>
                          <th className="py-1 pr-3 font-medium">Type</th>
                          <th className="py-1 font-medium">Description / sample</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.schema.columns.map((c) => (
                          <tr key={c.name} className="border-b border-border-default/50">
                            <td className="py-1 pr-3 font-mono text-t-primary">{c.name}</td>
                            <td className="py-1 pr-3 text-t-secondary">{c.dtype}</td>
                            <td className="max-w-md truncate py-1 text-t-tertiary">
                              {docFor(c.name) ?? c.sample_values?.slice(0, 3).join(", ") ?? ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {detail.schema.sample_rows.length > 0 && (
                    <>
                      <p className="mt-4 text-xs font-medium text-t-tertiary">Sample rows</p>
                      <div className="mt-1 overflow-x-auto">
                        <table className="text-left text-xs">
                          <thead>
                            <tr className="border-b border-border-default text-t-tertiary">
                              {detail.schema.columns.map((c) => (
                                <th key={c.name} className="py-1 pr-4 font-medium">
                                  {c.name}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {detail.schema.sample_rows.slice(0, 6).map((row, i) => (
                              <tr key={i} className="border-b border-border-default/50">
                                {detail.schema!.columns.map((c) => (
                                  <td
                                    key={c.name}
                                    className="max-w-48 truncate py-1 pr-4 text-t-secondary"
                                  >
                                    {String((row as Record<string, unknown>)[c.name] ?? "")}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-3 border-t border-border-default px-6 py-4">
        <button
          onClick={onCancel}
          className="border border-border-default px-4 py-2 text-sm font-medium text-t-secondary transition-colors hover:bg-surface-2"
          style={{
            borderRadius: "var(--radius-button)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
