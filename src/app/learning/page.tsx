"use client";

/**
 * /learning — the exemplar bank, surfaced (learning retirement 2026-08-07):
 * runs that worked, banked as working artifacts and reused as starting
 * points for similar questions. Previously a shadow mechanism; now the user
 * sees exactly what gets reused and can delete anything. Stale-generation
 * exemplars are labeled — they are never retrieved.
 */
import { useCallback, useEffect, useState } from "react";
import { CONTRACT_GENERATION, type Exemplar } from "@/lib/contracts/learning";

export default function LearningPage() {
  const [exemplars, setExemplars] = useState<Exemplar[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    const controller = new AbortController();
    fetch("/api/learning", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { exemplars?: Exemplar[] } | null) => setExemplars(d?.exemplars ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => refresh(), [refresh]);

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await fetch(`/api/learning?exemplar=${id}`, { method: "DELETE" });
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-lg font-semibold text-t-primary" style={{ marginBottom: 4 }}>
        Learning — verified exemplars
      </h1>
      <p className="text-sm text-t-secondary" style={{ marginBottom: 20 }}>
        Runs that executed, validated, and grounded are banked here (structure and
        hermetic-generated code only — never your data values) and reused as starting points for
        similar questions on matching schemas. Delete anything you don&apos;t want reused.
      </p>

      {!exemplars ? (
        <div className="text-t-tertiary text-sm">Loading…</div>
      ) : exemplars.length === 0 ? (
        <div className="text-t-tertiary text-sm">
          Nothing banked yet — exemplars appear as analyses succeed.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {exemplars.map((e) => {
            const stale = (e.contractGen ?? 0) !== CONTRACT_GENERATION;
            return (
              <div
                key={e.id}
                className="border border-border-default"
                style={{ borderRadius: "var(--radius-card)", padding: "12px 14px" }}
              >
                <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                  <span className="text-sm text-t-primary">{e.question}</span>
                  <button
                    onClick={() => remove(e.id)}
                    disabled={busy}
                    className="text-xs shrink-0 ml-3"
                    style={{ color: "var(--color-error-text)" }}
                  >
                    Delete
                  </button>
                </div>
                <div className="text-xs text-t-tertiary" style={{ marginBottom: 6 }}>
                  {e.detectedDomain ?? "general"} · {e.columnNames.length} columns ·{" "}
                  {e.attempts === 1 ? "first-try" : `${e.attempts} attempts`}
                  {stale ? " · STALE (retired contracts — never retrieved)" : ""}
                </div>
                <details>
                  <summary className="text-xs text-accent cursor-pointer">View code</summary>
                  <pre
                    className="text-xs text-t-secondary overflow-x-auto"
                    style={{ marginTop: 6, maxHeight: 320 }}
                  >
                    {e.code}
                  </pre>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
