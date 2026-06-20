"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getCostRows } from "@/lib/api";

type Row = Record<string, string>;

function usd(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
const num = (r: Row, k: string) => Number(r[k] ?? 0) || 0;

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex-1"
      style={{
        minWidth: 150,
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-default)",
        borderRadius: "var(--radius-card)",
        padding: "14px 16px",
      }}
    >
      <div style={{ fontSize: 12, color: "var(--color-t-tertiary)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export default function CostPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    getCostRows(controller.signal)
      .then(setRows)
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const totals = useMemo(() => {
    let cost = 0;
    let inTok = 0;
    let outTok = 0;
    let calls = 0;
    const byDay = new Map<string, number>();
    const byDataset = new Map<string, number>();
    for (const r of rows) {
      const c = num(r, "cost_usd");
      cost += c;
      inTok += num(r, "input_tokens");
      outTok += num(r, "output_tokens");
      calls += num(r, "llm_calls");
      byDay.set(r.date ?? "", (byDay.get(r.date ?? "") ?? 0) + c);
      byDataset.set(r.dataset ?? "", (byDataset.get(r.dataset ?? "") ?? 0) + c);
    }
    const topDatasets = [...byDataset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { cost, inTok, outTok, calls, count: rows.length, topDatasets };
  }, [rows]);

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--color-bg)", color: "var(--color-t-primary)" }}
    >
      <header
        className="fixed top-0 w-full h-14 border-b flex items-center justify-between px-6"
        style={{
          background: "var(--color-surface-1)",
          borderColor: "var(--color-border-default)",
          zIndex: 50,
        }}
      >
        <div className="flex items-center gap-4">
          <Link href="/" className="text-accent font-bold lowercase" style={{ fontSize: 16 }}>
            hermetic
          </Link>
          <span style={{ color: "var(--color-t-tertiary)" }}>/</span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Cost &amp; Usage</span>
        </div>
        <span style={{ fontSize: 13, color: "var(--color-t-tertiary)" }}>
          {totals.count} {totals.count === 1 ? "analysis" : "analyses"}
        </span>
      </header>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "80px 24px 64px" }}>
        {loading ? (
          <div style={{ color: "var(--color-t-tertiary)" }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ color: "var(--color-t-tertiary)" }}>
            No analyses recorded yet. Run a question and the cost will appear here.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-3" style={{ marginBottom: 24 }}>
              <Card label="Total spend" value={usd(totals.cost)} />
              <Card label="Analyses" value={String(totals.count)} />
              <Card label="LLM calls" value={totals.calls.toLocaleString()} />
              <Card
                label="Tokens (in / out)"
                value={`${(totals.inTok / 1000).toFixed(0)}k / ${(totals.outTok / 1000).toFixed(0)}k`}
              />
            </div>

            {totals.topDatasets.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    marginBottom: 8,
                    color: "var(--color-t-secondary)",
                  }}
                >
                  Spend by dataset
                </div>
                <div className="flex flex-wrap gap-2">
                  {totals.topDatasets.map(([name, c]) => (
                    <span
                      key={name}
                      style={{
                        fontSize: 12,
                        padding: "4px 10px",
                        borderRadius: "var(--radius-badge)",
                        background: "var(--color-surface-1)",
                        border: "1px solid var(--color-border-default)",
                      }}
                    >
                      {name || "—"}: <strong>{usd(c)}</strong>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div
              style={{
                border: "1px solid var(--color-border-default)",
                borderRadius: "var(--radius-card)",
                overflow: "hidden",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--color-surface-1)", textAlign: "left" }}>
                    {["Date", "Dataset", "Question", "Mode", "Calls", "Tokens", "Cost"].map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "8px 12px",
                          color: "var(--color-t-tertiary)",
                          fontWeight: 600,
                          borderBottom: "1px solid var(--color-border-default)",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid var(--color-border-default)" }}>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{r.date}</td>
                      <td
                        style={{
                          padding: "8px 12px",
                          maxWidth: 180,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.dataset}
                      </td>
                      <td
                        style={{
                          padding: "8px 12px",
                          maxWidth: 320,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={r.question}
                      >
                        {r.question}
                      </td>
                      <td style={{ padding: "8px 12px", color: "var(--color-t-tertiary)" }}>
                        {r.mode}
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>
                        {num(r, "llm_calls")}
                      </td>
                      <td
                        style={{
                          padding: "8px 12px",
                          textAlign: "right",
                          color: "var(--color-t-tertiary)",
                        }}
                      >
                        {(num(r, "input_tokens") + num(r, "output_tokens")).toLocaleString()}
                      </td>
                      <td
                        style={{
                          padding: "8px 12px",
                          textAlign: "right",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {usd(num(r, "cost_usd"))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
