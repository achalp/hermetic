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
function buildReviewSystemPrompt(memLabel: string | null): string {
  const cap = memLabel ? `a HARD ~${memLabel} container memory cap` : "a HARD container memory cap";
  return (
    `You are a strict code reviewer for Python data-analysis scripts that run in a sandboxed Docker container with ${cap}, ` +
    `reading potentially planet-scale Parquet (billions of rows) over S3 via DuckDB. You do NOT rewrite the code — you ONLY report violations of the rules below.\n\n` +
    `MINDSET (read twice): treat this code as GUILTY until proven innocent on memory — assume it has ALREADY been run and OOM-KILLED at planet scale, and your only job is to find WHERE. Code that "looks reasonable" is exactly what has shipped and OOM'd before, so give it ZERO benefit of the doubt on memory: for every .df(), every in-memory index, every geometry op, prove to yourself it is bounded at the data scale in the question, and if you cannot, flag it. You may be reviewing code written by the same model that generated it — do NOT rubber-stamp; scrutinize hardest the parts that feel obviously fine, because that is where a shared blind spot hides.\n\n` +
    `Calibrate the VERDICT (not your attention): flag a rule "severe" only when it would ACTUALLY hit at the data scale implied by the question (a whole country/planet, not a small CSV); "minor" when it is suboptimal but would still run; a clean script produces an empty findings list. Hunt adversarially, but rate honestly.\n\n` +
    `RULES (id — when to flag severe):\n` +
    `MEM-KDTREE — a scipy/sklearn spatial index (cKDTree, KDTree, BallTree) is built over the RAW points/buildings of a large scan. A KD-tree over millions of points allocates several N-sized arrays and OOMs. (A KD-tree over a small aggregated CELLS table — tens of thousands of rows — is FINE, do not flag that.)\n` +
    `MEM-DF — a .df()/.fetchdf()/.arrow()/pd.read_* pulls an UNBOUNDED result into pandas: a raw SELECT * of a large/remote table, or a full column of millions of rows. .df() on an AGGREGATED (GROUP BY / COUNT) or provably-sparse (single small region, top-N) result is fine.\n` +
    `MEM-RING — a nearest-neighbour / "leaf" / farthest / most-isolated step reads a whole RING or radius of buildings into pandas, or accumulates rings across candidates. The neighbour distance must be a DuckDB aggregate (min(ST_Distance...) over a bounded bbox window) returning ONE scalar per candidate.\n` +
    `MEM-GEOM — ST_Centroid/ST_X/ST_Y/ST_Area or any geometry(WKB) decode runs over millions of rows. For point work, derive the point from the bbox struct ((xmin+xmax)/2, (ymin+ymax)/2); only decode geometry when the SHAPE genuinely matters.\n` +
    `GRID-SCALE — a grid/cell superlative uses a FIXED small cell size (e.g. 10 km) regardless of region span. Over a continent that emits far too many cells. Cell size must scale to the span (e.g. s = max(span_m/200, floor)).\n` +
    `POLY-HEAVY — a region boundary is built with ST_Union_Agg over a country/large multipolygon WITHOUT simplifying hard (ST_Simplify ~0.01), or unions full-detail geometry — that decodes the fattest geometry on the continent into memory.\n` +
    `ENGINE-BBOX — a named administrative area (country/state/city) is filtered by a HARDCODED lat/lon bounding box instead of its boundary polygon (ST_Contains against a simplified region). A raw USA box leaks Canada/Mexico and corrupts edge/superlative answers. (A bbox as a cheap PRE-filter BEFORE a polygon test is fine.)\n` +
    `ENGINE-PANDAS — filtering/joining/aggregating that should run in DuckDB SQL is instead done by pulling data into pandas and looping/filtering in Python over a large frame.\n` +
    `HARDCODE-EXTENT — magic coordinates/extents that should be DERIVED from the data (the divisions Phase-A extent) are hardcoded, so a clamp silently excludes the target (e.g. a country boundary row whose bbox spans the antimeridian).\n` +
    `GUARD-NULL — a region polygon / boundary is used in ST_Contains without a preceding \`if not n_geom: raise ...\` non-NULL check (a NULL polygon silently rejects every row → "no candidate" instead of failing loud). Note: an \`assert n_geom == 1\` does NOT count — the pipeline strips assertions comparing to a literal number, so only an \`if … raise\` guard actually runs.\n\n` +
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
  model: string = CODE_REVIEW_MODEL
): Promise<CodeReview> {
  try {
    const result = await withPhase("code_review", () =>
      generateText({
        model: getModel(model),
        system: cachedSystem(buildReviewSystemPrompt(memLabel)),
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
