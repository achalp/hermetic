import { Sandbox } from "@e2b/code-interpreter";
import type { ExecutionResult } from "@/lib/types";
import type { AdditionalFile } from "./index";
import { SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { logger } from "@/lib/logger";

export async function executeSandbox(
  csvContent: string,
  code: string,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[]
): Promise<ExecutionResult> {
  const start = Date.now();
  let sandbox: Sandbox | null = null;

  try {
    sandbox = await Sandbox.create({
      apiKey: process.env.E2B_API_KEY,
      timeoutMs: SANDBOX_TIMEOUT_MS + 10_000, // extra buffer for sandbox setup
    });

    // Upload CSV and Python script to sandbox
    await sandbox.files.write("/data/input.csv", csvContent);
    if (geojsonContent) {
      await sandbox.files.write("/data/input.geojson", geojsonContent);
    }
    if (additionalFiles && additionalFiles.length > 0) {
      for (const file of additionalFiles) {
        await sandbox.files.write(file.path, file.content);
      }
    }
    await sandbox.files.write("/data/script.py", code);

    // Use shell redirection to capture stdout to a file at the OS level.
    // This bypasses all SDK/Jupyter buffer limits on stdout capture.
    const result = await sandbox.commands.run(
      `python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt`,
      { timeoutMs: SANDBOX_TIMEOUT_MS }
    );

    const executionMs = Date.now() - start;

    // Check for errors via exit code
    if (result.exitCode !== 0) {
      let stderr = "";
      try {
        stderr = await sandbox.files.read("/data/stderr.txt");
      } catch {
        stderr = result.stderr || result.error || "Unknown execution error";
      }
      return {
        success: false,
        error: stderr || "Unknown execution error",
        execution_ms: executionMs,
      };
    }

    // Read output: prefer /data/output.json (written by code directly),
    // fall back to /data/stdout.txt (captured from print() via shell redirect)
    let outputJson: string;
    let outputSource: string;
    try {
      outputJson = await sandbox.files.read("/data/output.json");
      outputSource = "file:/data/output.json";
    } catch {
      try {
        outputJson = await sandbox.files.read("/data/stdout.txt");
        outputSource = "file:/data/stdout.txt";
      } catch {
        return {
          success: false,
          error:
            "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
          execution_ms: executionMs,
        };
      }
    }

    logger.debug("E2B executor output", { source: outputSource, len: outputJson.length });

    if (!outputJson.trim()) {
      return {
        success: false,
        error:
          "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
        execution_ms: executionMs,
      };
    }

    // Python's json module outputs NaN/Infinity for float values, which are
    // invalid in the JSON spec and rejected by JavaScript's JSON.parse().
    // Replace them with null before parsing.
    outputJson = outputJson
      .replace(/\bNaN\b/g, "null")
      .replace(/\b-Infinity\b/g, "null")
      .replace(/\bInfinity\b/g, "null");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(outputJson);
    } catch {
      return {
        success: false,
        error: `Failed to parse output as JSON. Output was: ${outputJson.slice(0, 500)}`,
        execution_ms: executionMs,
      };
    }

    const images: Record<string, string> = (parsed.images as Record<string, string>) ?? {};

    return {
      success: true,
      results: (parsed.results as Record<string, unknown>) ?? {},
      chart_data: (parsed.chart_data as Record<string, unknown>) ?? {},
      images,
      datasets: (parsed.datasets as Record<string, Record<string, unknown>[]>) ?? undefined,
      execution_ms: executionMs,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      execution_ms: Date.now() - start,
    };
  } finally {
    if (sandbox) {
      await sandbox.kill().catch(() => {});
    }
  }
}
