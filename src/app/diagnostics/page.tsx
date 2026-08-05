"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { RunDiagnostics, DiagEvent } from "@/lib/diagnostics/run-diagnostics";
import { getDiagnosticsRuns } from "@/app/lib/api";

/**
 * Run-diagnostics viewer — the in-app consumer of /api/diagnostics (which
 * itself reads the JSONL that writeRunDiagnostics appends per run). This is
 * the cross-run aggregation failure-log.ts promises ("rank the real failure
 * modes by frequency instead of by anecdote"): retry classes and run-level
 * failure kinds summed across runs, escalations counted, and the most recent
 * failing runs listed with their error evidence. Mirrors /cost's pattern:
 * fetch raw rows once, aggregate client-side.
 */

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

function Chip({ name, count }: { name: string; count: number }) {
  return (
    <span
      style={{
        fontSize: 12,
        padding: "4px 10px",
        borderRadius: "var(--radius-badge)",
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-default)",
      }}
    >
      {name || "—"}: <strong>{count}</strong>
    </span>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <div
      style={{
        fontSize: 13,
        fontWeight: 600,
        marginBottom: 8,
        color: "var(--color-t-secondary)",
      }}
    >
      {children}
    </div>
  );
}

/** Best available error evidence for a failing run, shortest useful form. */
function errorTail(run: RunDiagnostics): string {
  for (const ev of run.failures ?? []) {
    const f = ev as DiagEvent & { stderrTail?: string; stderrHead?: string; error?: string };
    const text = f.error ?? f.stderrTail ?? f.stderrHead;
    if (text) return String(text);
  }
  const failedStep = run.steps.find((s) => s.status === "failed" && s.statusReason);
  return failedStep?.statusReason ?? "";
}

interface FailureRow {
  run: RunDiagnostics;
  tail: string;
}

export default function DiagnosticsPage() {
  const [runs, setRuns] = useState<RunDiagnostics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    getDiagnosticsRuns<RunDiagnostics>(controller.signal)
      .then(setRuns)
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const agg = useMemo(() => {
    let escalated = 0;
    let failedSteps = 0;
    let degraded = 0;
    let retries = 0;
    const byDay = new Map<string, number>();
    const byClass = new Map<string, number>();
    const failureRows: FailureRow[] = [];

    for (const run of runs) {
      escalated += run.summary?.escalated ?? 0;
      failedSteps += run.summary?.failed ?? 0;
      degraded += run.summary?.degraded ?? 0;
      retries += run.summary?.totalRetries ?? 0;
      byDay.set(run.date ?? "", (byDay.get(run.date ?? "") ?? 0) + 1);
      // Retry classes (py_KeyError, sql_exec, infra_llm, …) are the frequency
      // ranking failure-log.ts classifies for; run-level failure kinds
      // (sandbox_failure, investigation_failed) join the same ranking so a
      // run that died outright counts alongside per-step retries.
      for (const [cls, n] of Object.entries(run.summary?.retryClassCounts ?? {})) {
        byClass.set(cls, (byClass.get(cls) ?? 0) + n);
      }
      for (const ev of run.failures ?? []) {
        byClass.set(ev.type, (byClass.get(ev.type) ?? 0) + 1);
      }
      if ((run.summary?.failed ?? 0) > 0 || (run.failures?.length ?? 0) > 0) {
        failureRows.push({ run, tail: errorTail(run) });
      }
    }

    const rankedClasses = [...byClass.entries()].sort((a, b) => b[1] - a[1]);
    // byDay preserves insertion order; the API returns newest-first.
    const days = [...byDay.entries()];
    return {
      escalated,
      failedSteps,
      degraded,
      retries,
      rankedClasses,
      days,
      failureRows: failureRows.slice(0, 30),
    };
  }, [runs]);

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
          <span style={{ fontSize: 15, fontWeight: 600 }}>Run Diagnostics</span>
        </div>
        <span style={{ fontSize: 13, color: "var(--color-t-tertiary)" }}>
          {runs.length} {runs.length === 1 ? "run" : "runs"}
        </span>
      </header>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "80px 24px 64px" }}>
        {loading ? (
          <div style={{ color: "var(--color-t-tertiary)" }}>Loading…</div>
        ) : runs.length === 0 ? (
          <div style={{ color: "var(--color-t-tertiary)" }}>
            No run diagnostics recorded yet. Run an analysis and its record will appear here.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-3" style={{ marginBottom: 24 }}>
              <Card label="Runs" value={String(runs.length)} />
              <Card label="Escalations" value={String(agg.escalated)} />
              <Card label="Failed steps" value={String(agg.failedSteps)} />
              <Card label="Degraded steps" value={String(agg.degraded)} />
              <Card label="Retries" value={String(agg.retries)} />
            </div>

            {agg.rankedClasses.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <SectionTitle>Failure modes by frequency</SectionTitle>
                <div className="flex flex-wrap gap-2">
                  {agg.rankedClasses.map(([cls, n]) => (
                    <Chip key={cls} name={cls} count={n} />
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 24 }}>
              <SectionTitle>Runs per day</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {agg.days.map(([day, n]) => (
                  <Chip key={day} name={day} count={n} />
                ))}
              </div>
            </div>

            {agg.failureRows.length > 0 && (
              <>
                <SectionTitle>Recent failures</SectionTitle>
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
                        {["Date", "Run", "Question", "Error"].map((h) => (
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
                      {agg.failureRows.map(({ run, tail }, i) => (
                        <tr
                          key={`${run.runId ?? "run"}-${i}`}
                          style={{ borderBottom: "1px solid var(--color-border-default)" }}
                        >
                          <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{run.date}</td>
                          <td
                            style={{
                              padding: "8px 12px",
                              maxWidth: 140,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontFamily: "monospace",
                              fontSize: 12,
                              color: "var(--color-t-tertiary)",
                            }}
                            title={run.runId}
                          >
                            {run.runId ?? "—"}
                          </td>
                          <td
                            style={{
                              padding: "8px 12px",
                              maxWidth: 280,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={run.question}
                          >
                            {run.question ?? "—"}
                          </td>
                          <td
                            style={{
                              padding: "8px 12px",
                              maxWidth: 360,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontFamily: "monospace",
                              fontSize: 12,
                            }}
                            title={tail}
                          >
                            {tail || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
