/**
 * Pre-execution code review — a "lint critic" that reads the generated analysis
 * code BEFORE the sandbox runs it and flags the failure classes prose guidance
 * keeps failing to prevent: OOMs (cKDTree over millions of points, unbounded
 * `.df()`, ring materialization), container-memory-cap violations, and
 * hardcoded shortcuts where a query engine belongs (raw bbox instead of a
 * boundary polygon). Severe findings feed back to the code-gen model for a redo.
 *
 * Why a separate model pass instead of more system-prompt text: the guidance is
 * already exhaustive, yet the model still reverts to cKDTree / a fixed 10 km grid
 * on hard runs (observed repeatedly on planet-scale isolation queries). A critic
 * that ONLY judges — with the rules framed as pass/fail checks over concrete code
 * — catches what generation-time instructions don't, and does it in seconds for a
 * few thousand tokens versus a 15-minute remote scan that OOMs and burns a retry.
 *
 * Fail-open by construction: any error, timeout, or unparseable verdict returns
 * "none" so a flaky critic never blocks a legitimate run.
 */
import { generateText } from "ai";
import { z } from "zod";
import { withPhase } from "@/lib/cost/accumulator";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { getRunSignal } from "@/lib/pipeline/run-control";
import { CODE_REVIEW_MODEL } from "@/lib/constants";
import { logger } from "@/lib/logger";

export type ReviewSeverity = "none" | "minor" | "severe";

export interface ReviewFinding {
  rule: string;
  severity: "minor" | "severe";
  message: string;
}

export interface CodeReview {
  severity: ReviewSeverity;
  findings: ReviewFinding[];
  /** Ready-to-inject feedback for a redo — empty unless severity === "severe". */
  feedback: string;
}

const CLEAN_REVIEW: CodeReview = { severity: "none", findings: [], feedback: "" };

const FindingSchema = z.object({
  rule: z.string(),
  severity: z.enum(["minor", "severe"]),
  message: z.string(),
});
const VerdictSchema = z.object({
  findings: z.array(FindingSchema).default([]),
});

/**
 * The lint rules. Each is a pass/fail check the critic applies to the code.
 * `memLabel` (e.g. "3.8 GB") is the SAME hard cap the container enforces, so the
 * critic reasons against the real ceiling rather than assuming abundant RAM.
 */
function buildReviewSystemPrompt(memLabel: string | null, extraRules?: string[]): string {
  const cap = memLabel ? `a HARD ~${memLabel} container memory cap` : "a HARD container memory cap";
  return (
    `You are a strict code reviewer for Python data-analysis scripts that run in a sandboxed Docker container with ${cap}, ` +
    `reading potentially planet-scale Parquet (billions of rows) over S3 via DuckDB. You do NOT rewrite the code — you ONLY report violations of the rules below.\n\n` +
    `MINDSET (read twice): treat this code as GUILTY until proven innocent on memory — assume it has ALREADY been run and OOM-KILLED at planet scale, and your only job is to find WHERE. Code that "looks reasonable" is exactly what has shipped and OOM'd before, so give it ZERO benefit of the doubt on memory: for every .df(), every in-memory index, every geometry op, prove to yourself it is bounded at the data scale in the question, and if you cannot, flag it. You may be reviewing code written by the same model that generated it — do NOT rubber-stamp; scrutinize hardest the parts that feel obviously fine, because that is where a shared blind spot hides.\n\n` +
    // Findings audit (declared-findings spec §5): declarations are IN the
    // code pre-execution — the literal definitions sit beside the computing
    // statements, so the reviewer can check the highest-stakes coherence
    // class ("consistent" declared without a test) before anything runs.
    // Sampled by construction: only claims-bearing declarations get audited.
    `FINDINGS AUDIT: if the code calls declare_finding(...), audit the CLAIMS-BEARING ones (verdict/direction/attribution dtypes): does the adjacent code actually compute what the definition string claims? A significance verdict requires a real statistical test in the code; a trend direction requires a fitted slope, not eyeballing; a verdict derived from a decomposition must be computed FROM that decomposition's result. Flag any declaration whose definition promises a method the code does not perform. LINKAGE: if the code declares BOTH a step/change-point finding AND per-group trend findings but NO finding derives from both (derived_from_findings naming the two), flag it — the attribution the question needs is computable and undeclared. WINDOWS: flag any growth/ratio comparison computed over unequal time windows (a full year vs a partial year) that is not restricted to the overlapping sub-window — the derived figure is invalid regardless of labeling. RATE-EDGES: flag growth-rate/ending-state computations that read the series' raw edges — a leading zero period divides the first rate by zero, and a raw final row on a live dataset is reporting-lag noise (use finding_current_state / trim edges first).\n\n` +
    `Calibrate the VERDICT (not your attention): flag a rule "severe" only when it would ACTUALLY hit at the data scale implied by the question (a whole country/planet, not a small CSV); "minor" when it is suboptimal but would still run; a clean script produces an empty findings list. Hunt adversarially, but rate honestly.\n\n` +
    // Only DOMAIN-AGNOSTIC rules live here — the geo/Overture/superlative
    // rules that used to sit in this list (MEM-KDTREE, MEM-RING, MEM-GEOM,
    // GRID-SCALE, POLY-HEAVY, ENGINE-BBOX, HARDCODE-EXTENT, GUARD-NULL,
    // SCAN-OR) are contributed by the active skills via extraRules, so all
    // geo knowledge audits in src/lib/skills/builtin/ and a non-geo
    // review-gated skill doesn't inherit irrelevant geo rules.
    `RULES (id — when to flag severe):\n` +
    `MEM-DF — a .df()/.fetchdf()/.arrow()/pd.read_* pulls an UNBOUNDED result into pandas: a raw SELECT * of a large/remote table, or a full column of millions of rows. .df() on an AGGREGATED (GROUP BY / COUNT) or provably-sparse (single small region, top-N) result is fine.\n` +
    `ENGINE-PANDAS — filtering/joining/aggregating that should run in DuckDB SQL is instead done by pulling data into pandas and looping/filtering in Python over a large frame.\n` +
    // Rules contributed by the run's active skills (same "ID — when to flag" format).
    (extraRules?.length ? extraRules.map((r) => `${r.trim()}\n`).join("") : "") +
    `\n` +
    `Respond with ONLY a JSON object, no markdown fencing, no prose:\n` +
    `{"findings":[{"rule":"<RULE-ID>","severity":"severe|minor","message":"<one sentence: what line/pattern, why it fails at scale, the concrete fix>"}]}\n` +
    `Empty findings ({"findings":[]}) means the code is clean.`
  );
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Feedback sent back to the writer for a redo. We deliberately send EVERY finding
 * — NOT just the severe ones — and WITHOUT the severity label, with a "fix
 * everything" ask. Rationale: the critic's severity CALIBRATION is unreliable (a
 * finding it rated "minor — won't OOM" caused a 16-min OOM). The severity stays in
 * the journal for forensics, but the writer is told to fix all of it and isn't
 * given a minor/major tag to rationalize skipping any. Rule ids stay (they're
 * useful context, not a severity signal).
 */
function formatFeedback(findings: ReviewFinding[]): string {
  const lines = findings.map((f) => `- [${f.rule}] ${f.message}`).join("\n");
  return (
    "A pre-execution review flagged the issues below (memory, correctness, or engine-usage) that could crash, OOM, " +
    "produce a wrong answer, or waste a long run at this data scale. Rewrite the code to fix EVERY one of them — do " +
    "not skip any as minor — and keep everything that is already correct:\n" +
    lines
  );
}

/**
 * Review generated code against the memory/engine lint rules. Never throws —
 * returns CLEAN_REVIEW on any failure so a broken critic can't block a run.
 */
export async function reviewGeneratedCode(
  code: string,
  question: string,
  memLabel: string | null,
  model: string = CODE_REVIEW_MODEL,
  /** Extra critic rules from the run's active skills (see skills/types.ts). */
  extraRules?: string[]
): Promise<CodeReview> {
  try {
    const result = await withPhase("code_review", () =>
      generateText({
        model: getModel(model),
        system: cachedSystem(buildReviewSystemPrompt(memLabel, extraRules)),
        prompt: `## Question\n${question}\n\n## Code to review\n\`\`\`python\n${code}\n\`\`\``,
        temperature: 0,
        maxOutputTokens: 2048,
        abortSignal: getRunSignal(),
      })
    );

    const json = extractJsonObject(result.text);
    if (!json) return CLEAN_REVIEW;
    const parsed = VerdictSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return CLEAN_REVIEW;

    const findings = parsed.data.findings;
    // Severity is recorded (journal/forensics) but NO LONGER gates the redo:
    // ANY finding triggers a fix-everything redo (see formatFeedback). The
    // per-finding severity the critic assigned is kept in `findings` for the log.
    const anySevere = findings.some((f) => f.severity === "severe");
    const severity: ReviewSeverity = anySevere ? "severe" : findings.length > 0 ? "minor" : "none";
    return {
      severity,
      findings,
      feedback: findings.length > 0 ? formatFeedback(findings) : "",
    };
  } catch (err) {
    // Fail open — a flaky/unavailable critic must never block execution.
    logger.debug("Code review skipped (reviewer error)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return CLEAN_REVIEW;
  }
}
