"use client";

/**
 * UI surfaces of the declared-findings feature
 * (specs/declared-findings-2026-08-06.md §6 "Trust surfaces", §11 phase 1).
 *
 * This file deliberately concentrates ALL new findings/grounding-advisory
 * copy in one place so the anti-laundering rules of §6 are auditable at a
 * glance (and testable): validation covers structure, never truth, so no
 * string here may contain the unqualified word "verified" — the sanctioned
 * vocabulary is "declared at computation time" / "structurally checked".
 */

import type { ReactNode } from "react";
import { downloadJson } from "@/lib/export-utils";
import type { FindingsManifest, FindingEntry } from "@/lib/contracts/findings";
import type { GroundingReport } from "@/lib/contracts/grounding";

/**
 * Parse the 1-based line out of a `code_ref` ("script.py:41" → 41).
 * Returns null for malformed refs so callers fall back to plain text
 * instead of a dead link — §6: a badge citing a line nobody can open is a
 * dangling trust claim, and so is a link that goes nowhere.
 */
export function parseCodeRefLine(ref: string): number | null {
  const m = /:(\d+)$/.exec(ref);
  if (!m) return null;
  const line = Number(m[1]);
  return Number.isInteger(line) && line > 0 ? line : null;
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span
      className="bg-surface-btn px-1.5 py-0.5 text-[10px] font-medium text-t-btn"
      style={{ borderRadius: "var(--radius-badge)" }}
    >
      {children}
    </span>
  );
}

/**
 * Compact value rendering: scalars inline, small objects as key: value rows
 * (the contract caps values at depth ≤2 / ≤25 leaves, so rows never explode).
 */
function FindingValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="font-mono text-xs text-t-tertiary">null</span>;
  }
  if (typeof value !== "object") {
    return <span className="font-mono text-xs text-t-primary">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    const s = JSON.stringify(value);
    return (
      <span className="break-all font-mono text-xs text-t-primary">
        {s.length > 200 ? s.slice(0, 200) + "…" : s}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k} className="flex gap-2 font-mono text-xs">
          <span className="text-t-tertiary">{k}:</span>
          <span className="break-all text-t-primary">
            {typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

function FindingRow({
  finding,
  onOpenCodeRef,
}: {
  finding: FindingEntry;
  onOpenCodeRef?: (line: number) => void;
}) {
  const line = finding.code_ref ? parseCodeRefLine(finding.code_ref) : null;
  return (
    <li
      className="border border-border-default px-3 py-2"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium text-t-primary">{finding.name}</span>
        <Badge>{finding.dtype}</Badge>
        {finding.unit && <Badge>{finding.unit}</Badge>}
        {finding.tags?.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        {(finding.redeclarations ?? 0) > 0 && (
          // Subtle by design: a re-declared name is last-wins merge detail,
          // not an alarm — but hiding it would launder the overwrite.
          <span className="text-[10px] text-t-tertiary">re-declared x{finding.redeclarations}</span>
        )}
        {finding.code_ref &&
          // The deep link is what earns this surface its "structurally
          // checked" wording (§6: the referenced code must be one
          // interaction away). A malformed ref degrades to plain text —
          // never a fake link.
          (line != null && onOpenCodeRef ? (
            <button
              onClick={() => onOpenCodeRef(line)}
              className="ml-auto font-mono text-xs text-accent hover:underline"
              title={`Open the Python tab at line ${line}`}
            >
              {finding.code_ref}
            </button>
          ) : (
            <span className="ml-auto font-mono text-xs text-t-tertiary">{finding.code_ref}</span>
          ))}
      </div>
      <p className="mt-1 text-sm text-t-secondary">{finding.definition}</p>
      {finding.method && <p className="mt-0.5 text-xs text-t-tertiary">{finding.method}</p>}
      <div className="mt-1.5">
        <FindingValue value={finding.value} />
      </div>
    </li>
  );
}

/**
 * The artifacts panel's Findings tab — §11 phase 1's inspectability surface:
 * every declared finding with its definition, typed value, and a deep link
 * to the generating line of code.
 */
export function FindingsTab({
  findings,
  onOpenCodeRef,
}: {
  /** undefined = legacy run persisted before the manifest existed. */
  findings?: FindingsManifest;
  /** Navigates to the Code tab at a 1-based line. Omit to render refs as text. */
  onOpenCodeRef?: (line: number) => void;
}) {
  // §6 / review P11: legacy history entries must say WHY there is nothing
  // here — an empty state would read as "this run declared nothing".
  if (!findings) {
    return <p className="p-4 text-sm text-t-tertiary">No manifest (pre-2026-08 analysis)</p>;
  }

  return (
    <div className="space-y-3 p-4">
      {/* §6 one-line disclosure — fixed copy; "structurally checked" is
          permitted here ONLY because code_ref deep-links into the Code tab. */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-t-tertiary">
          Structurally checked &mdash; definitions and values are produced by the analysis code (not
          reviewed for truth).
        </p>
        {findings.findings.length > 0 && (
          <button
            onClick={() => downloadJson(findings, "findings-manifest")}
            className="text-xs text-accent hover:underline shrink-0 ml-3"
            title="Machine-readable manifest (findings + checks), as validated"
          >
            Export JSON
          </button>
        )}
      </div>
      {findings.findings.length === 0 ? (
        <p className="text-sm text-t-secondary">No findings were declared in this run.</p>
      ) : (
        (() => {
          // Declared-checks spec §3: checks are findings about the data /
          // process — grouped separately so validations read as validations.
          const checks = findings.findings.filter((f) => f.dtype === "check");
          const rest = findings.findings.filter((f) => f.dtype !== "check");
          return (
            <>
              <ol className="flex flex-col gap-2">
                {rest.map((f) => (
                  <FindingRow key={f.name} finding={f} onOpenCodeRef={onOpenCodeRef} />
                ))}
              </ol>
              {checks.length > 0 && (
                <>
                  <h4 className="mt-3 text-xs font-medium uppercase tracking-wide text-t-tertiary">
                    Data checks
                  </h4>
                  <ol className="flex flex-col gap-2">
                    {checks.map((f) => (
                      <FindingRow key={f.name} finding={f} onOpenCodeRef={onOpenCodeRef} />
                    ))}
                  </ol>
                </>
              )}
            </>
          );
        })()
      )}
    </div>
  );
}

/** True when the report carries any of the new advisory fields (all optional
 *  — absent on reports persisted before 2026-08-06). */
export function hasGroundingAdvisories(g: GroundingReport): boolean {
  return (
    (g.contradictions?.length ?? 0) > 0 ||
    (g.unnarratedFindings?.length ?? 0) > 0 ||
    !!g.questionPrimaryMiss ||
    (g.findingIssues?.length ?? 0) > 0
  );
}

/**
 * The advisory lines the grounded-narrative checks add beside the existing
 * untraceable-figures message (declared-findings spec §3.4/§3.5). Shared by
 * the caveat banner, the notebook synthesis cell, and the artifacts Trail so
 * the copy — and its §6 constraints — exist exactly once. Renders null when
 * the report predates the fields.
 */
export function GroundingAdvisories({ grounding }: { grounding: GroundingReport }) {
  const items: string[] = [];
  for (const c of grounding.contradictions ?? []) {
    items.push(`Contradiction: ${c}.`);
  }
  if ((grounding.unnarratedFindings?.length ?? 0) > 0) {
    items.push(`Computed but not mentioned: ${grounding.unnarratedFindings!.join(", ")}.`);
  }
  if (grounding.questionPrimaryMiss) {
    items.push(
      `The finding that answers the question (${grounding.questionPrimaryMiss}) is not shown in a headline stat.`
    );
  }
  const details = grounding.findingIssues ?? [];
  if (items.length === 0 && details.length === 0) return null;
  // Two-tier rendering: the banner speaks in USER language (a rollup per
  // category); the raw engineering diagnostics ($finding: bindings, lint
  // kinds) live behind a disclosure for the Trail-inclined.
  const rollup = summarizeFindingIssues(details);
  return (
    <div
      className="mt-1 flex flex-col gap-0.5 text-xs"
      style={{ color: "var(--color-warning-text)" }}
    >
      <ul className="flex flex-col gap-0.5">
        {[...items, ...rollup].map((t, i) => (
          // Advisory, not verdicts: same ▲ warn idiom as the untraceable-
          // figures message, never blocking, never "verified".
          <li key={i}>&#9650; {t}</li>
        ))}
      </ul>
      {details.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-t-tertiary">
            {details.length} detailed diagnostic{details.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-t-tertiary">
            {details.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Roll raw finding-issue diagnostics up into user-language category lines. */
function summarizeFindingIssues(details: string[]): string[] {
  const count = (pred: (d: string) => boolean) => details.filter(pred).length;
  const out: string[] = [];
  const nulls = count((d) => d.includes('resolves to "null"') || d.includes("resolves to \u0000"));
  if (nulls > 0)
    out.push(
      `${nulls} claim${nulls === 1 ? " was" : "s were"} removed because the analysis did not compute the value cleanly.`
    );
  const units = count((d) => d.includes("unit") && d.includes("narrative"));
  if (units > 0) out.push(`${units} figure${units === 1 ? " carries" : "s carry"} a unit caveat.`);
  const dropped = count((d) => d.startsWith("dropped a sentence"));
  if (dropped > 0)
    out.push(`${dropped} sentence${dropped === 1 ? " was" : "s were"} removed as not applicable.`);
  const tiles = count((d) => d.includes("headline tile"));
  if (tiles > 0)
    out.push(`${tiles} planned headline stat${tiles === 1 ? " is" : "s are"} missing.`);
  const linkage = count((d) => d.includes("no finding derives from both"));
  if (linkage > 0) out.push("A connection the data supports is not stated in the narrative.");
  const rest = details.length - nulls - units - dropped - tiles - linkage;
  if (rest > 0) out.push(`${rest} other consistency note${rest === 1 ? "" : "s"} (see details).`);
  return out;
}
