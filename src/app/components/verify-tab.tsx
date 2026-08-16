"use client";

/**
 * Verify tab (composer-sight spec §2/§3): the user-reviewable case that the
 * dashboard says what the analysis computed — plan-vs-composed, every
 * advisory with detail, grounding summary — plus the on-demand non-blind
 * audit action. Self-contained; renders whatever subset of the
 * verifiability payload exists (legacy runs show an empty-state note).
 */
import { useEffect, useState } from "react";
import { errMessage } from "@/lib/logger";
import { getAudit, runAudit as runAuditApi } from "@/app/lib/api";
import { downloadJson } from "@/lib/export-utils";

export interface VerifiabilityPayload {
  composerSight?: string;
  findings?: { declared?: number; cited?: number; checks?: number; failedChecks?: string[] };
  headline?: { planned?: string[]; missing?: string[] };
  prose?: { issues?: Array<{ kind: string; detail: string }> };
  grounding?: {
    ok?: boolean;
    checkedCount?: number;
    ungrounded?: string[];
    contradictions?: string[];
  };
}

interface AuditFinding {
  severity: "high" | "medium" | "low";
  claim: string;
  evidence: string;
}
interface AuditResult {
  verdict: "clean" | "issues";
  findings: AuditFinding[];
  at: number;
  model: string;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-xs">
      <span className="text-t-tertiary">{label}</span>
      <span className="text-t-primary text-right">{value}</span>
    </div>
  );
}

export function VerifyTab({
  verifiability,
  historyId,
}: {
  verifiability?: VerifiabilityPayload | null;
  historyId?: string | null;
}) {
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditErr, setAuditErr] = useState<string | null>(null);

  // Restored entries show their persisted audit without a re-run.
  useEffect(() => {
    if (!historyId) return;
    const controller = new AbortController();
    getAudit(historyId, controller.signal)
      .then((a) => {
        if (a) setAudit(a);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [historyId]);

  const runAudit = async () => {
    if (!historyId) return;
    setAuditBusy(true);
    setAuditErr(null);
    try {
      setAudit(await runAuditApi(historyId));
    } catch (e) {
      setAuditErr(errMessage(e));
    } finally {
      setAuditBusy(false);
    }
  };

  const v = verifiability;
  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      {(v || audit) && (
        <div className="flex justify-end">
          <button
            onClick={() => downloadJson({ verifiability: v ?? null, audit }, "verifiability")}
            className="text-xs text-accent hover:underline"
            title="Machine-readable verifiability record + audit verdict"
          >
            Export JSON
          </button>
        </div>
      )}
      {!v ? (
        <p className="text-t-secondary text-xs">
          No verifiability record — this analysis predates the Verify surface.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h4 className="text-xs font-medium uppercase tracking-wide text-t-tertiary">
              Composition
            </h4>
            <Row label="Composer mode" value={v.composerSight ?? "blind"} />
            <Row
              label="Findings declared / cited in narrative"
              value={`${v.findings?.declared ?? 0} / ${v.findings?.cited ?? 0}`}
            />
            <Row
              label="Checks (failed)"
              value={`${v.findings?.checks ?? 0} (${v.findings?.failedChecks?.length ?? 0}${
                v.findings?.failedChecks?.length ? `: ${v.findings.failedChecks.join(", ")}` : ""
              })`}
            />
            <Row
              label="Headline tiles planned / missing"
              value={`${v.headline?.planned?.length ?? 0} / ${v.headline?.missing?.length ?? 0}`}
            />
            <Row
              label="Grounding"
              value={
                v.grounding?.ok
                  ? `all ${v.grounding?.checkedCount ?? 0} figures traced`
                  : `${v.grounding?.ungrounded?.length ?? 0} untraceable of ${v.grounding?.checkedCount ?? 0}`
              }
            />
          </div>

          {(v.prose?.issues?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium uppercase tracking-wide text-t-tertiary">
                Advisories ({v.prose!.issues!.length})
              </h4>
              <ul className="flex flex-col gap-1 text-xs text-t-secondary">
                {v.prose!.issues!.map((i, idx) => (
                  <li key={idx}>
                    <span className="font-mono text-t-tertiary">{i.kind}</span> — {i.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="flex flex-col gap-2 border-t border-border-default pt-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium uppercase tracking-wide text-t-tertiary">
            Non-blind audit
          </h4>
          <button
            onClick={runAudit}
            disabled={auditBusy || !historyId}
            className="text-xs px-2 py-1 rounded border border-border-default text-t-primary disabled:opacity-50"
            title={
              historyId
                ? "One adversarial review call over the derived artifacts (never raw rows)"
                : "Available once the analysis is saved to history"
            }
          >
            {auditBusy ? "Auditing…" : "Run audit"}
          </button>
        </div>
        {auditErr && (
          <p className="text-xs" style={{ color: "var(--color-error-text)" }}>
            {auditErr}
          </p>
        )}
        {audit && (
          <div className="flex flex-col gap-1 text-xs">
            <Row
              label={`Verdict (${audit.model})`}
              value={
                audit.verdict === "clean"
                  ? "clean — survived scrutiny"
                  : `${audit.findings.length} issue(s)`
              }
            />
            <ul className="flex flex-col gap-1 text-t-secondary">
              {audit.findings.map((f, i) => (
                <li key={i}>
                  <span
                    className="font-medium"
                    style={{
                      color:
                        f.severity === "high"
                          ? "var(--color-error-text)"
                          : "var(--color-warning-text)",
                    }}
                  >
                    [{f.severity}]
                  </span>{" "}
                  {f.claim} <span className="text-t-tertiary">({f.evidence})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
