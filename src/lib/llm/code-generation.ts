import { generateText } from "ai";
import { getModel } from "./client";
import {
  buildCodeGenSystemPrompt,
  buildCodeGenUserPrompt,
  buildCodeGenChatPrompt,
} from "./prompts";
import { CODE_GEN_MODEL } from "@/lib/constants";
import type { CSVSchema, SchemaMode } from "@/lib/types";

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
  });

  let code = result.text.trim();

  // Strip markdown fencing if present
  if (code.startsWith("```python")) {
    code = code.slice("```python".length);
  } else if (code.startsWith("```")) {
    code = code.slice("```".length);
  }
  if (code.endsWith("```")) {
    code = code.slice(0, -"```".length);
  }

  return code.trim();
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
  });

  let code = result.text.trim();

  // Strip markdown fencing if present
  if (code.startsWith("```python")) {
    code = code.slice("```python".length);
  } else if (code.startsWith("```")) {
    code = code.slice("```".length);
  }
  if (code.endsWith("```")) {
    code = code.slice(0, -"```".length);
  }

  return code.trim();
}
