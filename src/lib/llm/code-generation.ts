import { generateText } from "ai";
import { getModel, cachedSystem, cachedText } from "./client";
import {
  buildCodeGenSystemPrompt,
  buildCodeGenSchemaBlock,
  buildConversationHistorySection,
} from "./prompts";
import { CODE_GEN_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { CSVSchema, ConversationTurn, SchemaMode } from "@/lib/types";

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

  return code.trim();
}

/**
 * Fix filenames in generated code: local models sometimes use the original
 * filename (e.g. "/data/sales.csv") instead of the expected "/data/input.csv".
 * They also sometimes double the extension (e.g. "/data/input.csv.csv").
 */
export function fixUpFilenames(code: string, originalFilename: string): string {
  // Fix double extensions first — models see "Filename: data.csv" in the prompt
  // and construct paths like "/data/data.csv.csv" or "/data/input.csv.csv"
  code = code.replace(/\/data\/([^"'\s]+)\.csv\.csv/g, "/data/$1.csv");

  if (!originalFilename || originalFilename === "input.csv") return code;
  // Replace /data/<original-filename> with /data/input.csv
  // Handle both the exact name and common variations (with/without extension)
  const escaped = originalFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return code.replace(new RegExp(`/data/${escaped}`, "g"), "/data/input.csv");
}

/**
 * Ensure DuckDB read_csv calls include an explicit delimiter to prevent
 * auto-detection failures on small result sets (e.g. 1-2 rows from warehouse queries).
 */
export function fixReadCsvDelimiter(code: string): string {
  // Match read_csv('...' or read_csv("..." that don't already have a delimiter/delim/sep arg
  return code.replace(/read_csv\((['""][^)]*?['""]\s*)\)/g, (match, inner) => {
    if (/delimiter|delim|sep\s*=/.test(match)) return match;
    return `read_csv(${inner}, delimiter=',')`;
  });
}

/**
 * Remove hard-coded value assertions like `assert corr == 0.785` that LLMs
 * (especially weaker local models) emit as self-tests. They crash on perfectly
 * valid data — a computed correlation is 0.7849…, never exactly 0.785. Only
 * lines asserting equality against a NUMBER literal are matched; structural
 * checks like `assert len(df) > 0` are left intact. Replaced with `pass` to
 * preserve block indentation.
 */
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
  model: string = CODE_GEN_MODEL,
  workbookContext?: string,
  localFileContext?: string,
  priorTurns?: ConversationTurn[]
): Promise<string> {
  const hasTurns = priorTurns && priorTurns.length > 0;
  // Cache the stable schema/context prefix; the question (and any chat history)
  // are the variable tail. Across an Investigate run's N sub-questions and the
  // code-gen retries, the schema is identical → cache hits. Non-chat content is
  // byte-identical to buildCodeGenUserPrompt; chat moves history after the
  // (cached) schema.
  const schemaBlock = buildCodeGenSchemaBlock(schema, mode, workbookContext, localFileContext);
  const tail = hasTurns
    ? `\n${buildConversationHistorySection(priorTurns)}## Question\n${question}`
    : `\n## Question\n${question}`;

  const result = await generateText({
    model: getModel(model),
    system: cachedSystem(buildCodeGenSystemPrompt(mode, !!workbookContext, schema.detected_domain)),
    messages: [{ role: "user", content: [cachedText(schemaBlock), { type: "text", text: tail }] }],
    temperature: 0,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
  });

  return stripValueAssertions(
    fixReadCsvDelimiter(fixUpFilenames(cleanGeneratedCode(result.text), schema.filename))
  );
}
