/**
 * The harvest — the diary finally gets a reader. Called fire-and-forget from
 * the orchestrator's epilogue with the run's in-memory attempt history:
 *
 *   failures  → extract lessons (diff + error) → ledger candidates
 *               → graduation (threshold, non-retreat, attributed) → proposal
 *   success   → verified exemplar into the bank
 *
 * Guards: never under replay (test runs must not write user state — the
 * recents lesson), never under vitest, never throws into the pipeline.
 * Attribution: lessons land on the highest-priority active skill (the
 * complement target); runs with no active skills stay unattributed —
 * ledger-visible for a human, no auto-proposal (v1 scope).
 */
import { logger } from "@/lib/logger";
import { llmReplayConfig } from "@/lib/llm/replay";
import { envConfig } from "@/lib/harness-slot";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import { extractLessons, type AttemptPair } from "./extract";
import { recordCandidate } from "./ledger";
import { createProposal } from "./proposals";
import { bankExemplar } from "./exemplars";

export interface HarvestInput {
  runId: string;
  question: string;
  schema: CSVSchema;
  activeSkills: string[];
  /** Chronological failed attempts: code + error, before any success. */
  failedAttempts: Array<{ code: string; error: string }>;
  /** The successful attempt's code, when the run succeeded. */
  finalCode?: string;
  success: boolean;
}

export async function harvestRun(input: HarvestInput): Promise<void> {
  if (llmReplayConfig()) return; // record AND replay: fixture runs are tests
  if (envConfig().VITEST || envConfig().NODE_ENV === "test") return;

  try {
    // ── Failures → lessons ──
    if (input.failedAttempts.length > 0) {
      const pairs: AttemptPair[] = input.failedAttempts.map((a, i) => ({
        error: a.error,
        code: a.code,
        fixedCode: input.failedAttempts[i + 1]?.code ?? input.finalCode,
      }));
      const lessons = await extractLessons(pairs);
      const parentSkill = input.activeSkills[0]; // highest-priority active skill
      for (const lesson of lessons) {
        const { entry, graduated } = await recordCandidate({
          kind: lesson.kind,
          parentSkill: lesson.kind === "engine-defect" ? undefined : parentSkill,
          failureClass: lesson.failureClass,
          lessonText: lesson.lessonText,
          retreat: lesson.retreat,
          engineSuggestion: lesson.engineSuggestion,
          errorText: lesson.errorText,
          evidence: {
            runId: input.runId,
            ts: new Date().toISOString(),
            question: input.question.slice(0, 200),
            errorHead: lesson.errorText.split("\n").slice(0, 3).join("\n").slice(0, 300),
          },
        });
        if (graduated) await createProposal(entry);
      }
    }

    // ── Success → exemplar ──
    if (input.success && input.finalCode) {
      await bankExemplar({
        runId: input.runId,
        question: input.question,
        columns: input.schema.columns.map((c) => ({ name: c.name, dtype: c.dtype })),
        detectedDomain: input.schema.detected_domain ?? null,
        activeSkills: input.activeSkills,
        code: input.finalCode,
        attempts: input.failedAttempts.length + 1,
        rowCount: input.schema.row_count,
      });
    }
  } catch (err) {
    logger.debug("Learning harvest failed — skipping (best-effort by design)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
