import {
  generateAnalysisCode,
  generateAnalysisCodeWithHistory,
  cleanGeneratedCode,
  fixUpFilenames,
} from "@/lib/llm/code-generation";
import { buildRetryPrompt } from "@/lib/llm/prompts";
import { executeSandbox } from "@/lib/sandbox";
import type { AdditionalFile } from "@/lib/sandbox";
import { generateText } from "ai";
import { getModel } from "@/lib/llm/client";
import { CODE_GEN_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { CSVSchema, SandboxExecutionResult, SchemaMode } from "@/lib/types";
import { logger } from "@/lib/logger";

export interface PipelineResult {
  executionResult: SandboxExecutionResult;
  generatedCode: string;
  question: string;
}

export async function runPipeline(
  schema: CSVSchema,
  csvContent: string,
  question: string,
  onStage?: (stage: string) => void,
  mode: SchemaMode = "metadata",
  model: string = CODE_GEN_MODEL,
  runtime?: SandboxRuntimeId,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[],
  workbookContext?: string
): Promise<PipelineResult> {
  // Step 1: Generate analysis code
  onStage?.("generating_code");
  let code: string;
  try {
    code = await generateAnalysisCode(schema, question, mode, model, workbookContext);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Code generation failed", { error: msg });
    throw new Error(
      msg || "LLM failed to generate code — check that the model server is running and responsive."
    );
  }

  // Step 2: Execute in sandbox
  logger.debug("Generated code", { chars: code.length });
  onStage?.("executing");
  let result = await executeSandbox(
    csvContent,
    code,
    runtime,
    geojsonContent,
    additionalFiles,
    schema.csv_id
  );

  // Step 3: Retry once on failure
  if (!result.success) {
    onStage?.("retrying");
    const retryResult = await generateText({
      model: getModel(model),
      system:
        "You are a data analyst. Fix the Python code based on the error. The code must write its JSON output to /data/output.json (not print to stdout). Output ONLY the corrected Python code. No markdown fencing.",
      prompt: buildRetryPrompt(code, result.error, schema),
      temperature: 0,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    });

    const retryCode = fixUpFilenames(cleanGeneratedCode(retryResult.text), schema.filename);

    onStage?.("executing");
    result = await executeSandbox(
      csvContent,
      retryCode,
      runtime,
      geojsonContent,
      additionalFiles,
      schema.csv_id
    );

    if (!result.success) {
      throw new Error(`Analysis failed after retry: ${result.error}`);
    }

    code = retryCode;
  }

  return {
    executionResult: result,
    generatedCode: code,
    question,
  };
}

export async function runChatPipeline(
  schema: CSVSchema,
  csvContent: string,
  question: string,
  conversationHistory: string[],
  onStage?: (stage: string) => void,
  mode: SchemaMode = "metadata",
  model: string = CODE_GEN_MODEL,
  runtime?: SandboxRuntimeId,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[],
  workbookContext?: string
): Promise<PipelineResult> {
  // Step 1: Generate analysis code with conversation context
  onStage?.("generating_code");
  let code: string;
  try {
    code = await generateAnalysisCodeWithHistory(
      schema,
      question,
      conversationHistory,
      mode,
      model,
      workbookContext
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Code generation failed", { error: msg });
    throw new Error(
      msg || "LLM failed to generate code — check that the model server is running and responsive."
    );
  }

  // Step 2: Execute in sandbox
  onStage?.("executing");
  let result = await executeSandbox(
    csvContent,
    code,
    runtime,
    geojsonContent,
    additionalFiles,
    schema.csv_id
  );

  // Step 3: Retry once on failure
  if (!result.success) {
    onStage?.("retrying");
    const retryResult = await generateText({
      model: getModel(model),
      system:
        "You are a data analyst. Fix the Python code based on the error. The code must write its JSON output to /data/output.json (not print to stdout). Output ONLY the corrected Python code. No markdown fencing.",
      prompt: buildRetryPrompt(code, result.error, schema),
      temperature: 0,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    });

    const retryCode = fixUpFilenames(cleanGeneratedCode(retryResult.text), schema.filename);

    onStage?.("executing");
    result = await executeSandbox(
      csvContent,
      retryCode,
      runtime,
      geojsonContent,
      additionalFiles,
      schema.csv_id
    );

    if (!result.success) {
      throw new Error(`Analysis failed after retry: ${result.error}`);
    }

    code = retryCode;
  }

  return {
    executionResult: result,
    generatedCode: code,
    question,
  };
}
