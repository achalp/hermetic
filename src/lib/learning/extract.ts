/**
 * Lesson extraction — the retry loop already computed each fix; the raw
 * material here is (error, diff-between-attempts) pairs. One cheap LLM call
 * per failed run abstracts them into lesson candidates, with two guards the
 * a47b45ba post-mortem demanded:
 *
 * - CAPITULATION: when the "fix" removed functionality instead of repairing
 *   it (dropping percentile stats vs renaming the function), the lesson is
 *   phrased from the ERROR's own suggestion and flagged `retreat` — learned
 *   capitulations degrade the product, so they never auto-graduate.
 * - ROUTING: contract/shape failures are engine defects (hermetic should
 *   coerce or lint), never prompt text.
 *
 * Fail-open: any extraction failure returns [] — learning must never take a
 * run's epilogue down with it.
 */
import { generateText } from "ai";
import { getModel } from "@/lib/llm/client";
import { FOLLOWUP_CLASSIFIER_MODEL } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { classifyFailure } from "@/lib/diagnostics/failure-log";
import type { LessonKind } from "@/lib/contracts/learning";

export interface AttemptPair {
  /** The failing attempt's error text (head). */
  error: string;
  /** The failing attempt's code. */
  code: string;
  /** The NEXT attempt's code (the model's fix) — absent for the last failure. */
  fixedCode?: string;
}

export interface ExtractedLesson {
  kind: LessonKind;
  lessonText: string;
  retreat: boolean;
  engineSuggestion?: string;
  failureClass: string;
  errorText: string;
}

/** "Did you mean X?" and similar engine self-diagnoses. */
export function engineSuggestionOf(error: string): string | undefined {
  const m = error.match(/Did you mean ["']?([\w.]+)["']?/i);
  return m?.[1];
}

/** Output-contract violations are hermetic's to fix, not the model's. */
export function isEngineDefect(error: string): boolean {
  return /wrong shape for write_output|Invalid input: expected record|expected .* received array/i.test(
    error
  );
}

const SYSTEM = `You extract reusable lessons from failed data-analysis code attempts. For each (error, fix-diff) pair, produce ONE one-line lesson a future code generator should follow to avoid the failure.

Rules:
- Phrase the lesson as an imperative guidance bullet, general (no run-specific values, paths, or dataset names unless the lesson IS about that dataset's schema).
- kind: "dialect-fact" for engine/library facts (function names, syntax, API shapes); "domain-guidance" for dataset/schema/domain behavior.
- retreat: true when the fix REMOVED the failing functionality instead of repairing it — including REMOVING a WHERE predicate/filter (a disambiguating region/country constraint) to make an empty-result error disappear. When the error itself suggested a repair (e.g. "Did you mean X"), phrase the lesson from that repair, not from the removal.
Answer STRICT JSON: {"lessons":[{"kind":"...","lessonText":"...","retreat":false}]} — one entry per input pair, same order.`;

function buildPrompt(pairs: AttemptPair[]): string {
  return pairs
    .map((p, i) => {
      const diffNote = p.fixedCode
        ? `FIX (next attempt's relevant change): ${diffSummary(p.code, p.fixedCode)}`
        : "FIX: none — this was the final attempt.";
      return `--- PAIR ${i + 1} ---\nERROR:\n${p.error.slice(0, 800)}\n${diffNote}`;
    })
    .join("\n");
}

/**
 * Cheap line-level diff summary — added/removed lines only, capped. The
 * extractor needs the gist of what changed, not a patch.
 */
export function diffSummary(before: string, after: string, cap = 600): string {
  const b = new Set(before.split("\n").map((l) => l.trim()));
  const a = new Set(after.split("\n").map((l) => l.trim()));
  const removed = [...b].filter((l) => l && !a.has(l)).slice(0, 12);
  const added = [...a].filter((l) => l && !b.has(l)).slice(0, 12);
  return `removed: ${removed.join(" | ")}\nadded: ${added.join(" | ")}`.slice(0, cap);
}

export async function extractLessons(pairs: AttemptPair[]): Promise<ExtractedLesson[]> {
  if (pairs.length === 0) return [];

  // Pre-route engine defects — no LLM needed, and they must not be phrased
  // as model guidance.
  const routed: (ExtractedLesson | null)[] = pairs.map((p) => {
    if (!isEngineDefect(p.error)) return null;
    return {
      kind: "engine-defect",
      lessonText: `Output contract violation: ${p.error.split("\n")[0].slice(0, 160)}`,
      retreat: false,
      failureClass: classifyFailure("execution", p.error).errorClass,
      errorText: p.error,
    };
  });
  const llmPairs = pairs.filter((_, i) => routed[i] === null);
  if (llmPairs.length === 0) return routed.filter((r): r is ExtractedLesson => r !== null);

  try {
    const { text } = await generateText({
      model: getModel(FOLLOWUP_CLASSIFIER_MODEL),
      system: SYSTEM,
      prompt: buildPrompt(llmPairs),
      maxOutputTokens: 600,
    });
    const parsed = JSON.parse(text.replace(/^```(json)?|```$/gm, "").trim()) as {
      lessons?: Array<{ kind?: string; lessonText?: string; retreat?: boolean }>;
    };
    const lessons = parsed.lessons ?? [];
    let li = 0;
    return pairs
      .map((p, i) => {
        if (routed[i]) return routed[i];
        const l = lessons[li++];
        if (!l?.lessonText) return null;
        const suggestion = engineSuggestionOf(p.error);
        // Belt-and-braces capitulation check: an engine suggestion that the
        // fix did NOT adopt is a retreat even if the extractor missed it.
        const suggestedIgnored = !!suggestion && !!p.fixedCode && !p.fixedCode.includes(suggestion);
        return {
          kind: l.kind === "dialect-fact" ? "dialect-fact" : "domain-guidance",
          lessonText: l.lessonText.slice(0, 300),
          retreat: !!l.retreat || suggestedIgnored,
          engineSuggestion: suggestion,
          failureClass: classifyFailure("execution", p.error).errorClass,
          errorText: p.error,
        } satisfies ExtractedLesson;
      })
      .filter((r): r is ExtractedLesson => r !== null);
  } catch (err) {
    logger.debug("Lesson extraction failed — skipping (learning is best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return routed.filter((r): r is ExtractedLesson => r !== null);
  }
}
