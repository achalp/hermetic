"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { LearningState, LearnedProposal, LedgerEntry } from "@/lib/contracts/learning";
import { getLearningState, decideLearningProposal } from "@/app/lib/api";

/**
 * The human half of the learning loop (specs/learning-loops-2026-08-05.md,
 * §4: durable rules require approval). Graduated lessons arrive here as
 * proposals; Accept writes a USER-level complement skill
 * (data/skills/<parent>-learned) — shipped built-ins are never touched — and
 * the skill hot-reloads on the next question. Retreat-flagged lessons (the
 * fix removed functionality instead of repairing it) never auto-graduate;
 * they surface in the candidates list with the flag visible. Engine defects
 * (contract/shape failures) are hermetic fix candidates, never prompts.
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

function SectionTitle({ children }: { children: string }) {
  return (
    <div
      style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--color-t-secondary)" }}
    >
      {children}
    </div>
  );
}

function Badge({ children, tone }: { children: string; tone: "warn" | "info" }) {
  const bg = tone === "warn" ? "var(--color-warning-bg)" : "var(--color-info-bg)";
  const fg = tone === "warn" ? "var(--color-warning-text)" : "var(--color-info-text)";
  return (
    <span
      style={{
        fontSize: 11,
        padding: "2px 8px",
        borderRadius: "var(--radius-badge)",
        background: bg,
        color: fg,
      }}
    >
      {children}
    </span>
  );
}

function ProposalRow({
  p,
  onDecide,
  busy,
}: {
  p: LearnedProposal;
  onDecide: (id: string, action: "accept" | "reject") => void;
  busy: boolean;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--color-border-default)",
        borderRadius: "var(--radius-card)",
        padding: "12px 14px",
        marginBottom: 10,
        background: "var(--color-surface-1)",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {p.skillName}{" "}
          <span style={{ color: "var(--color-t-tertiary)", fontWeight: 400 }}>
            (complements {p.parentSkill} · {p.evidenceCount} runs)
          </span>{" "}
          {p.retreat && <Badge tone="warn">retreat</Badge>}
        </div>
        {p.status === "pending" ? (
          <span className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => onDecide(p.id, "accept")}
              className="cursor-pointer rounded-badge border border-border-default bg-accent-subtle px-3 py-1 text-xs text-accent-text hover:opacity-80"
            >
              Accept
            </button>
            <button
              disabled={busy}
              onClick={() => onDecide(p.id, "reject")}
              className="cursor-pointer rounded-badge border border-border-default bg-surface-2 px-3 py-1 text-xs text-t-secondary hover:opacity-80"
            >
              Reject
            </button>
          </span>
        ) : (
          <Badge tone="info">{p.status}</Badge>
        )}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 13,
          fontFamily: "var(--font-geist-mono)",
          color: "var(--color-t-secondary)",
          whiteSpace: "pre-wrap",
        }}
      >
        {p.guidanceLine}
      </div>
    </div>
  );
}

function LedgerRow({ e }: { e: LedgerEntry }) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--color-table-divider)",
        padding: "8px 4px",
        fontSize: 13,
      }}
    >
      <div className="flex items-center gap-2">
        <span style={{ color: "var(--color-t-tertiary)", fontSize: 11 }}>{e.evidence.length}×</span>
        <span className="flex-1">{e.lessonText}</span>
        {e.retreat && <Badge tone="warn">retreat</Badge>}
        <span style={{ color: "var(--color-t-tertiary)", fontSize: 11 }}>
          {e.parentSkill ?? "unattributed"} · {e.failureClass} · {e.status}
        </span>
      </div>
    </div>
  );
}

export default function LearningPage() {
  const [state, setState] = useState<LearningState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const controller = new AbortController();
    getLearningState<LearningState>(controller.signal)
      .then(setState)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => refresh(), [refresh]);

  const decide = useCallback(
    async (id: string, action: "accept" | "reject") => {
      setBusy(true);
      try {
        const res = await decideLearningProposal(id, action);
        setNote(
          action === "accept" && res.applied
            ? `Accepted — complement skill written (live on the next question): ${res.path}`
            : action === "reject"
              ? "Rejected — this lesson will not re-propose."
              : null
        );
        refresh();
      } catch (err) {
        setNote(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const pending = state?.proposals.filter((p) => p.status === "pending") ?? [];
  const decided = state?.proposals.filter((p) => p.status !== "pending") ?? [];
  const candidates = state?.ledger.filter((e) => e.status === "candidate") ?? [];

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
          <span style={{ fontSize: 15, fontWeight: 600 }}>Learning</span>
        </div>
        <Link
          href="/diagnostics"
          style={{ fontSize: 13, color: "var(--color-t-tertiary)" }}
          className="hover:underline"
        >
          Run diagnostics →
        </Link>
      </header>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "80px 24px 64px" }}>
        {!state ? (
          <div style={{ color: "var(--color-t-tertiary)" }}>Loading…</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-3" style={{ marginBottom: 24 }}>
              <Card label="Pending proposals" value={String(pending.length)} />
              <Card label="Ledger candidates" value={String(candidates.length)} />
              <Card label="Verified exemplars" value={String(state.exemplarCount)} />
              <Card label="Engine-fix candidates" value={String(state.engineDefects.length)} />
            </div>

            {note && (
              <div
                style={{
                  marginBottom: 16,
                  padding: "10px 12px",
                  fontSize: 13,
                  background: "var(--color-info-bg)",
                  color: "var(--color-info-text)",
                  border: "1px solid var(--color-info-border)",
                  borderRadius: "var(--radius-card)",
                }}
              >
                {note}
              </div>
            )}

            {pending.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <SectionTitle>Graduated lessons awaiting review</SectionTitle>
                {pending.map((p) => (
                  <ProposalRow key={p.id} p={p} onDecide={decide} busy={busy} />
                ))}
              </div>
            )}

            {candidates.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <SectionTitle>Candidates (accumulating evidence)</SectionTitle>
                {candidates.map((e) => (
                  <LedgerRow key={e.id} e={e} />
                ))}
              </div>
            )}

            {state.engineDefects.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <SectionTitle>Engine-fix candidates (never become prompts)</SectionTitle>
                {state.engineDefects.map((e) => (
                  <LedgerRow key={e.id} e={e} />
                ))}
              </div>
            )}

            {decided.length > 0 && (
              <div>
                <SectionTitle>Decided</SectionTitle>
                {decided.map((p) => (
                  <ProposalRow key={p.id} p={p} onDecide={decide} busy={busy} />
                ))}
              </div>
            )}

            {pending.length + candidates.length + state.engineDefects.length === 0 && (
              <div style={{ color: "var(--color-t-tertiary)" }}>
                Nothing learned yet — lessons appear here as analyses fail, are fixed, and recur.
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
