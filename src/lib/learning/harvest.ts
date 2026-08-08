/**
 * The harvest — exemplars only (learning retirement, 2026-08-07): a run
 * that executed, validated, and grounded banks its working code for reuse
 * on similar ⟨schema, question⟩ runs. The failure-lesson pipeline is
 * retired; failures are already captured by the failure log, lints, and
 * the review gate — deterministically.
 *
 * Guards: never under replay or vitest; never throws into the pipeline.
 */
import { logger } from "@/lib/logger";
import { llmReplayConfig } from "@/lib/llm/replay";
import { envConfig } from "@/lib/harness-slot";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import { bankExemplar } from "./exemplars";

export interface HarvestInput {
  runId: string;
  question: string;
  schema: CSVSchema;
  activeSkills: string[];
  /** Retained for call-site compatibility; failures are no longer harvested. */
  failedAttempts: Array<{ code: string; error: string }>;
  finalCode?: string;
  success: boolean;
}

export async function harvestRun(input: HarvestInput): Promise<void> {
  if (llmReplayConfig()) return;
  if (envConfig().VITEST || envConfig().NODE_ENV === "test") return;
  try {
    if (!input.success || !input.finalCode) return;
    await bankExemplar({
      runId: input.runId,
      question: input.question,
      columns: input.schema.columns.map((col) => ({ name: col.name, dtype: col.dtype })),
      detectedDomain: input.schema.detected_domain ?? null,
      activeSkills: input.activeSkills,
      code: input.finalCode,
      rowCount: input.schema.row_count ?? 0,
      attempts: input.failedAttempts.length + 1,
    });
  } catch (err) {
    logger.debug("harvestRun failed (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
