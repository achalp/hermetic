import { generateText, streamText } from "ai";
import { withPhase, withPhaseSync } from "@/lib/cost/accumulator";
import { getModel, cachedSystem, cachedText, getActiveProvider } from "./client";
import {
  buildCodeGenSystemPrompt,
  buildCodeGenSchemaBlock,
  buildConversationHistorySection,
} from "./prompts";
import { LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import { getActiveModels } from "@/lib/runtime-config";
import { getSandboxMemoryLimitGbLabel } from "@/lib/sandbox/memory-budget";
import type { CSVSchema, SchemaMode } from "@/lib/contracts/data-schema";
import type { ConversationTurn } from "@/lib/contracts/storage-types";

/**
 * Clean LLM-generated code by stripping markdown fences, chat template
 * tokens, and other artifacts that local models sometimes emit.
 */
export function cleanGeneratedCode(raw: string): string {
  let code = raw.trim();

  // Extract content from markdown code block if present (handles fences anywhere)
  const fenceMatch = code.match(/```(?:python)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    code = fenceMatch[1];
  } else {
    // Fallback: strip leading/trailing fences
    if (code.startsWith("```python")) {
      code = code.slice("```python".length);
    } else if (code.startsWith("```")) {
      code = code.slice("```".length);
    }
    if (code.endsWith("```")) {
      code = code.slice(0, -"```".length);
    }
  }

  // Strip chat template tokens that local models sometimes leak
  code = code.replace(/<\|im_end\|>/g, "");
  code = code.replace(/<\|im_start\|>[^\n]*/g, "");
  code = code.replace(/<\|end\|>/g, "");
  code = code.replace(/<\|assistant\|>/g, "");
  code = code.replace(/<\|user\|>/g, "");
  code = code.replace(/<\|eot_id\|>/g, "");

  // Remove any trailing markdown fences that remain after extraction
  code = code.replace(/\n```\s*$/g, "");

  // Strip leaked reasoning prose that precedes the script. On a retry the model
  // sometimes emits a plan ("Looking at the failures:", "3. Use DuckDB ...")
  // before the code, which is not valid Python. Analysis scripts start with
  // imports, so drop everything before the first import line WHEN what precedes
  // it has a non-comment, non-blank line (i.e. prose, not a leading #comment).
  const lines = code.split("\n");
  const firstImport = lines.findIndex((l) => /^(import\s|from\s+\S+\s+import\b)/.test(l.trim()));
  if (firstImport > 0) {
    const hasProse = lines
      .slice(0, firstImport)
      .some((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    if (hasProse) code = lines.slice(firstImport).join("\n");
  }

  return code.trim();
}

/**
 * Is this `/data/…` occurrence part of a URL rather than a sandbox path?
 *
 * A remote object stored under a `data/` prefix — `s3://bucket/data/facts.parquet`,
 * `https://acct.blob.core.windows.net/data/housing-landscape.parquet` — contains a
 * literal `/data/<basename>`, and `schema.filename` for a remote source IS that
 * basename. So the naive global replace rewrote the URL's own path and pointed the
 * analysis at an object that does not exist (run 5f8b7787: four identical 404s,
 * 13 minutes, $2.52 — the model emitted the RIGHT url every time and this rewrote
 * it every time).
 */
function isInsideUrl(code: string, matchIndex: number): boolean {
  // Walk back to the start of the string/URL token and look for a scheme.
  const from = Math.max(0, matchIndex - 2048);
  const before = code.slice(from, matchIndex);
  return /[a-z][a-z0-9+.-]*:\/\/[^\s"'`]*$/i.test(before);
}

/**
 * Fix filenames in generated code: local models sometimes use the original
 * filename (e.g. "/data/sales.csv") instead of the expected "/data/input.csv".
 * They also sometimes double the extension (e.g. "/data/input.csv.csv").
 *
 * ── Scope (tightened after run 5f8b7787) ──
 * This helper is ONLY correct when the run's input really is a CSV delivered to
 * `/data/input.csv` — i.e. an upload. On a Data Location run (remote URL, mounted
 * local file, materialized warehouse parquet) there is no `/data/input.csv` at all,
 * and rewriting toward it corrupts a correct program. `postProcessGeneratedCode`
 * gates it on exactly that; the two guards below are defense in depth, because this
 * function is exported and directly reachable.
 */
export function fixUpFilenames(code: string, originalFilename: string): string {
  // Fix double extensions first — models see "Filename: data.csv" in the prompt
  // and construct paths like "/data/data.csv.csv" or "/data/input.csv.csv".
  // URL-guarded too: an object legitimately named `input.csv.csv` is not a typo.
  code = replaceOutsideUrls(code, /\/data\/([^"'\s]+)\.csv\.csv/g, (m) =>
    m.replace(/\.csv\.csv$/, ".csv")
  );

  if (!originalFilename || originalFilename === "input.csv") return code;
  // Never rewrite a NON-CSV sandbox path to a .csv one: `/data/input.parquet` is a
  // real delivery path (a materialized warehouse pull), and "input.csv" is simply
  // the wrong file there — under any premise, not just the remote one.
  if (!/\.csv$/i.test(originalFilename)) return code;
  const escaped = originalFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return replaceOutsideUrls(code, new RegExp(`/data/${escaped}`, "g"), () => "/data/input.csv");
}

/** `String.replace` that leaves matches sitting inside a URL literal alone. */
function replaceOutsideUrls(
  code: string,
  pattern: RegExp,
  replacer: (match: string) => string
): string {
  return code.replace(pattern, (match, ...rest) => {
    const offset = rest[rest.length - 2] as number;
    return isInsideUrl(code, offset) ? match : replacer(match);
  });
}

/**
 * Rewrite `pd.read_excel(...)` calls that target the CSV input into
 * `read_csv(...)`. The sandbox input is ALWAYS a CSV at /data/input.csv —
 * Excel uploads are converted to CSV server-side, and openpyxl is not
 * installed in the sandbox — so reading it with the Excel engine is
 * unconditionally wrong. Weaker models sometimes emit
 * `pd.read_excel("/data/input.csv", engine="openpyxl")`, which fails with
 * ModuleNotFoundError. We only match read_excel calls whose path argument is a
 * `.csv` literal (so a genuine `.xlsx` read is left untouched) and drop the
 * Excel-only kwargs (engine, sheet_name, …) that read_csv doesn't accept.
 * Run after fixUpFilenames so the path is already normalized to /data/input.csv.
 */
export function fixExcelReadOnCsv(code: string): string {
  return code.replace(
    /(\bpd\s*\.\s*)?read_excel\(\s*(["'][^"']*\.csv["'])[^)]*\)/g,
    (_match, pdPrefix, path) => `${pdPrefix ?? ""}read_csv(${path})`
  );
}

/**
 * Ensure DuckDB read_csv calls include an explicit delimiter to prevent
 * auto-detection failures on small result sets (e.g. 1-2 rows from warehouse queries).
 */
export function fixReadCsvDelimiter(code: string): string {
  // Match read_csv('...' or read_csv("..." that don't already have a delimiter/delim/sep arg
  return code.replace(/read_csv\((['""][^)]*?['""]\s*)\)/g, (match, inner) => {
    if (/delimiter|delim|sep\s*=/.test(match)) return match;
    // A REMOTE csv is not ours to assume commas about. Hermetic's own delivered
    // input is comma-separated by construction, but a user's `s3://…/f.tsv` is
    // not — and forcing `delimiter=','` overrides DuckDB's auto-detection and
    // parses the whole file into ONE column. A silent wrong answer is worse than
    // the missing-delimiter warning this exists to prevent.
    if (/[a-z][a-z0-9+.-]*:\/\//i.test(inner)) return match;
    return `read_csv(${inner}, delimiter=',')`;
  });
}

/**
 * Add a missing `f` prefix to a duckdb.sql() string that interpolates a computed
 * Python value. Common first-shot bug: writing duckdb.sql("""… {xmin} …""") as a
 * PLAIN string instead of an f-string, so `{xmin}` reaches DuckDB literally and it
 * errors "Parser Error: syntax error at or near }" — which killed a USA run on its
 * very first SQL line. Deterministic and conservative: we prefix ONLY when the
 * braces clearly hold an INTERPOLATION (a bare identifier / attribute / index /
 * arithmetic on identifiers) and NEVER a DuckDB struct/map literal ({'a': 1} /
 * {k: v}) — those start with a quote or contain a colon — nor an already-escaped
 * {{ }}. So a legitimate literal brace is left untouched.
 */
export function fixMissingSqlFString(code: string): string {
  return code.replace(
    /(\bduckdb\.sql\(\s*)(f?)("""|'''|"|')([\s\S]*?)\3/g,
    (match, head, fPrefix, quote, body) => {
      if (fPrefix) return match; // already an f-string
      const interpolation = /\{\s*[A-Za-z_]\w*(?:\.\w+|\[\s*\d+\s*\])*(?:\s*[-+*/]\s*[\w.]+)*\s*\}/;
      const structOrMapLiteral = /\{\s*['":]/;
      if (interpolation.test(body) && !structOrMapLiteral.test(body) && !body.includes("{{")) {
        return `${head}f${quote}${body}${quote}`;
      }
      return match;
    }
  );
}

/**
 * Remove hard-coded value assertions like `assert corr == 0.785` that LLMs
 * (especially weaker local models) emit as self-tests. They crash on perfectly
 * valid data — a computed correlation is 0.7849…, never exactly 0.785. Only
 * lines asserting equality against a NUMBER literal are matched; structural
 * checks like `assert len(df) > 0` are left intact. Replaced with `pass` to
 * preserve block indentation.
 */
/**
 * Fix case-only column typos in `df["Col"]` access against the known schema —
 * the single most common first-shot crash (KeyError on a column that exists but
 * was referenced with the wrong case). Deliberately scoped to the canonical input
 * frame `df`, so it never rewrites output-dict keys (results/chart_data) or a
 * deliberately-created new column. Only rewrites when the literal's lowercase
 * UNIQUELY matches one real column and the exact case differs — never a guess.
 */
export function fixColumnNameCase(code: string, columnNames: string[]): string {
  if (columnNames.length === 0) return code;
  const exact = new Set(columnNames);
  const byLower = new Map<string, string | null>();
  for (const name of columnNames) {
    const lc = name.toLowerCase();
    byLower.set(lc, byLower.has(lc) ? null : name); // null = ambiguous lowercase
  }
  return code.replace(/(\bdf\s*\[\s*)(["'])([^"'\n]+)\2/g, (m, pre, q, name) => {
    if (exact.has(name)) return m;
    const fixed = byLower.get(name.toLowerCase());
    return fixed && fixed !== name ? `${pre}${q}${fixed}${q}` : m;
  });
}

export function stripValueAssertions(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*)assert\s+.+==\s*-?\d+(?:\.\d+)?(?:\s*,.*)?\s*$/);
      return m ? `${m[1]}pass  # removed hard-coded value assertion` : line;
    })
    .join("\n");
}

export async function generateAnalysisCode(
  schema: CSVSchema,
  question: string,
  mode: SchemaMode = "metadata",
  model: string = getActiveModels().codeGen,
  workbookContext?: string,
  localFileContext?: string,
  priorTurns?: ConversationTurn[],
  purpose?: string,
  /**
   * Question-triggered skill guidance. Rides in the UN-cached tail next to the
   * question (never the cached schema-block prefix) so a user skill keyed on
   * question keywords can't fragment the per-dataset prompt cache.
   */
  extraGuidance?: string,
  opts?: {
    /**
     * The run's stop signal, supplied by the pipeline caller (getRunSignal()
     * at the call site). This module never imports the run registry — same
     * layering rule as the sandbox executors ("executors never import the run
     * registry — the caller supplies these", sandbox/index.ts). Absent (tests,
     * out-of-run callers) → the stream just isn't externally abortable.
     */
    abortSignal?: AbortSignal;
  }
): Promise<string> {
  const hasTurns = priorTurns && priorTurns.length > 0;
  // Cache the stable schema/context prefix; the question (and any chat history)
  // are the variable tail. Across an Investigate run's N sub-questions and the
  // code-gen retries, the schema is identical → cache hits. Non-chat content is
  // byte-identical to buildCodeGenUserPrompt; chat moves history after the
  // (cached) schema.
  // Derived at runtime from the Docker daemon's own allocation (memoized), so the
  // model plans against the SAME hard cap the container enforces — not a stale
  // hardcoded figure. Null (docker absent) → the prompt omits a specific number.
  const sandboxMemoryGb = await getSandboxMemoryLimitGbLabel();
  const schemaBlock = buildCodeGenSchemaBlock(
    schema,
    mode,
    workbookContext,
    localFileContext,
    sandboxMemoryGb
  );
  const guidanceTail = extraGuidance ? `\n${extraGuidance}` : "";
  const tail = hasTurns
    ? `${guidanceTail}\n${buildConversationHistorySection(priorTurns)}## Question\n${question}`
    : `${guidanceTail}\n## Question\n${question}`;

  // STREAM (not generateText): a non-streaming CLI call has only a 10-min
  // wall-clock timeout and NO stall detection — a hung backend burns the full
  // 10 min then hard-fails (observed: run f3bdc1b2). Streaming routes through
  // responsesSSE's stall timeout, so a stalled generation aborts in minutes, and
  // the caller-supplied abortSignal lets /stop actually kill it mid-stream.
  // withPhaseSync because streamText kicks off the request eagerly and reports
  // usage during consumption (see cost/accumulator).
  const result = withPhaseSync("code_gen", () =>
    streamText({
      model: getModel(model),
      system: cachedSystem(
        buildCodeGenSystemPrompt(mode, !!workbookContext, schema.detected_domain, purpose)
      ),
      messages: [
        { role: "user", content: [cachedText(schemaBlock), { type: "text", text: tail }] },
      ],
      temperature: 0,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
      abortSignal: opts?.abortSignal,
    })
  );
  const generatedText = await result.text;

  return postProcessGeneratedCode(generatedText, schema, {
    hasDataLocation: Boolean(localFileContext),
  });
}

/**
 * Every deterministic repair applied to a generated program, in one place.
 *
 * It lived inline at two call sites (here and the orchestrator's retry) — byte
 * identical, and therefore free to drift. Worse, both hard-coded the assumption
 * that the input is a CSV at `/data/input.csv`.
 *
 * `hasDataLocation` is that assumption made explicit. When the prompt carries a
 * Data Location section the input is something else entirely — a remote URL, a
 * mounted local file, a materialized parquet — and `prompts.ts` already tells the
 * MODEL that section overrides every default. The repairs never got that memo, so
 * they overrode the override: run 5f8b7787 had a correct `s3`/`https` URL rewritten
 * to a nonexistent `/data/input.csv` on all four attempts.
 */
export function postProcessGeneratedCode(
  rawText: string,
  schema: { filename: string; columns: { name: string }[] },
  opts: { hasDataLocation: boolean }
): string {
  let code = cleanGeneratedCode(rawText);
  // Both of these speak specifically about the delivered `/data/input.csv`, so
  // they only apply when that file is actually what the run reads.
  if (!opts.hasDataLocation) {
    code = fixUpFilenames(code, schema.filename);
    code = fixReadCsvDelimiter(code);
  }
  code = fixExcelReadOnCsv(code);
  code = fixMissingSqlFString(code);
  code = stripValueAssertions(code);
  return fixColumnNameCase(
    code,
    schema.columns.map((c) => c.name)
  );
}

/**
 * Warm the code-gen prompt cache with a tiny (max 1 output token) request that
 * sends the EXACT same cached prefix generateAnalysisCode uses — the system
 * prompt and the schema block. Call it ONCE before an Investigate fans a wave of
 * sub-questions out in parallel: otherwise every parallel code-gen call hits a
 * cold cache (none can read another's in-flight write) and re-pays full input
 * for the shared prefix. After this, the wave reads the warm cache.
 *
 * Anthropic-only (the only provider with caching) and strictly best-effort —
 * never block the investigation.
 *
 * `systemOnly` warms ONLY the system-prompt cache breakpoint (not the schema).
 * Use it for warehouse investigations: each sub-question runs its OWN SQL → its
 * own per-step schema, so the schema block is single-use and warming it is a
 * wasted write — but the (large, ~4.9k-token) system prompt IS shared, and the
 * per-step code-gen calls read it via prefix match. File investigations share
 * the whole prefix, so they warm system + schema together (systemOnly=false).
 */
export async function prewarmCodeGenCache(
  schema: CSVSchema,
  mode: SchemaMode = "metadata",
  model: string = getActiveModels().codeGen,
  workbookContext?: string,
  localFileContext?: string,
  systemOnly = false,
  purpose?: string
): Promise<void> {
  if (getActiveProvider() !== "anthropic") return;
  try {
    // Must match generateAnalysisCode's value exactly or the cached prefix this
    // warms won't be read back. getSandboxMemoryLimitGbLabel is memoized, so it
    // returns the same figure for both.
    const sandboxMemoryGb = await getSandboxMemoryLimitGbLabel();
    const content = systemOnly
      ? [{ type: "text" as const, text: "\n## Question\nwarmup" }]
      : [
          cachedText(
            buildCodeGenSchemaBlock(
              schema,
              mode,
              workbookContext,
              localFileContext,
              sandboxMemoryGb
            )
          ),
          { type: "text" as const, text: "\n## Question\nwarmup" },
        ];
    await withPhase("prewarm", () =>
      generateText({
        model: getModel(model),
        system: cachedSystem(
          buildCodeGenSystemPrompt(mode, !!workbookContext, schema.detected_domain, purpose)
        ),
        messages: [{ role: "user", content }],
        temperature: 0,
        maxOutputTokens: 1,
      })
    );
  } catch {
    // Best-effort: a failed warm-up must never break the run.
  }
}
