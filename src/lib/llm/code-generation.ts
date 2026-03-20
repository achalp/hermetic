import { generateText } from "ai";
import { getModel } from "./client";
import {
  buildCodeGenSystemPrompt,
  buildCodeGenUserPrompt,
  buildCodeGenChatPrompt,
} from "./prompts";
import { CODE_GEN_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { CSVSchema, SchemaMode } from "@/lib/types";

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
 */
export function fixUpFilenames(code: string, originalFilename: string): string {
  if (!originalFilename || originalFilename === "input.csv") return code;
  // Replace /data/<original-filename> with /data/input.csv
  // Handle both the exact name and common variations (with/without extension)
  const escaped = originalFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return code.replace(new RegExp(`/data/${escaped}`, "g"), "/data/input.csv");
}

export async function generateAnalysisCode(
  schema: CSVSchema,
  question: string,
  mode: SchemaMode = "metadata",
  model: string = CODE_GEN_MODEL,
  workbookContext?: string
): Promise<string> {
  const result = await generateText({
    model: getModel(model),
    system: buildCodeGenSystemPrompt(mode, !!workbookContext, schema.detected_domain),
    prompt: buildCodeGenUserPrompt(schema, question, mode, workbookContext),
    temperature: 0,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
  });

  return fixUpFilenames(cleanGeneratedCode(result.text), schema.filename);
}

export async function generateAnalysisCodeWithHistory(
  schema: CSVSchema,
  question: string,
  history: string[],
  mode: SchemaMode = "metadata",
  model: string = CODE_GEN_MODEL,
  workbookContext?: string
): Promise<string> {
  const result = await generateText({
    model: getModel(model),
    system: buildCodeGenSystemPrompt(mode, !!workbookContext, schema.detected_domain),
    prompt: buildCodeGenChatPrompt(schema, question, history, mode, workbookContext),
    temperature: 0,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
  });

  return fixUpFilenames(cleanGeneratedCode(result.text), schema.filename);
}
