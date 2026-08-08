/**
 * Dataset conventions — SIMPLIFIED (holistic learning review, 2026-08-07).
 *
 * The auto-injected conventions store is gone: it violated the learning
 * spec's founding rule (durable rules require approval; automatic writes
 * are for counters, not rules), needed a state machine to be safe, and its
 * KEEP-injection made adherence self-fulfilling. What replaces it: recurring
 * clean INTERPRETIVE checks — the judgments data alone cannot decide (what
 * zero means, which grain answers questions, which metric leads) — feed the
 * EXISTING lesson ledger as "dataset-convention" candidates. Same
 * 2-evidence graduation, same proposal/approval flow, same user-owned skill
 * output as every other lesson. The loop learns from what HELD, through the
 * same vetted pipeline as what broke. Mechanical checks (continuity, row
 * counts, thresholds) never persist — they re-derive deterministically.
 */
import { logger } from "@/lib/logger";
import { envConfig } from "@/lib/harness-slot";
import { llmReplayConfig } from "@/lib/llm/replay";
import type { FindingEntry } from "@/lib/contracts/findings";
import { recordCandidate } from "./ledger";
import { createProposal } from "./proposals";

/** Interpretive subjects: semantic commitments about the dataset. */
const INTERPRETIVE_RE =
  /zero|missing|unrecorded|null_polic|grain|granular|hierarch|primary_metric|primary metric|median|robust|unit|convention|semantic|treated as|means unpriced|screen|outlier_polic/i;

/** Checks that qualify as convention candidates: interpretive subject,
 *  never lint-flagged this run, numeric evidence (measured, not asserted). */
export function conventionCandidates(
  findings: FindingEntry[],
  flaggedNames: ReadonlySet<string>
): FindingEntry[] {
  return findings.filter((f) => {
    if (f.dtype !== "check" || flaggedNames.has(f.name)) return false;
    if (!INTERPRETIVE_RE.test(`${f.name} ${f.definition}`)) return false;
    if (f.value === null || typeof f.value !== "object" || Array.isArray(f.value)) return false;
    return Object.entries(f.value as Record<string, unknown>).some(
      ([k, v]) => k !== "passed" && (typeof v === "number" || Array.isArray(v))
    );
  });
}

/** Record this run's convention candidates into the lesson ledger.
 *  Fire-and-forget; never throws into the pipeline; never under tests. */
export async function recordDatasetConventions(input: {
  runId: string;
  question: string;
  findings: FindingEntry[];
  flaggedNames: ReadonlySet<string>;
  parentSkill?: string;
  degraded?: boolean;
}): Promise<void> {
  if (llmReplayConfig() || envConfig().VITEST || envConfig().NODE_ENV === "test") return;
  if (input.degraded) return;
  try {
    for (const check of conventionCandidates(input.findings, input.flaggedNames)) {
      const { entry, graduated } = await recordCandidate({
        kind: "dataset-convention",
        parentSkill: input.parentSkill,
        failureClass: "dataset-convention",
        lessonText: `${check.name}: ${check.definition}`,
        retreat: false,
        errorText: "",
        evidence: {
          runId: input.runId,
          ts: new Date().toISOString(),
          question: input.question.slice(0, 200),
          errorHead: "",
        },
      });
      // Unattributed candidates stay ledger-visible for a human (same rule
      // as every other lesson) — no shadow tier, no auto-injection.
      if (graduated && input.parentSkill) await createProposal(entry);
    }
  } catch (err) {
    logger.debug("recordDatasetConventions failed (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
