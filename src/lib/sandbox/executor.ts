import { Sandbox } from "@e2b/code-interpreter";
import { errMessage } from "@/lib/logger";
import type { ExecutionResult } from "@/lib/contracts/execution";
import type { AdditionalFile } from "@/lib/contracts/execution";
import { pythonNanPrelude } from "./prelude";
import { SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { parseSandboxOutput, classifyThrownError } from "./parse-output";
import { envConfig } from "@/lib/harness-slot";
import { getApiKey } from "@/lib/secrets";

export async function executeSandbox(
  csvContent: string,
  code: string,
  opts: {
    geojsonContent?: string | null;
    additionalFiles?: AdditionalFile[];
    hooks?: import("@/lib/contracts/execution").SandboxRunHooks;
  } = {}
): Promise<ExecutionResult> {
  const { geojsonContent, additionalFiles } = opts;
  const start = Date.now();
  let sandbox: Sandbox | null = null;

  try {
    sandbox = await Sandbox.create({
      apiKey: getApiKey("e2b"),
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
    await sandbox.files.write("/data/script.py", pythonNanPrelude() + code);

    // Use shell redirection to capture stdout to a file at the OS level.
    // This bypasses all SDK/Jupyter buffer limits on stdout capture.
    const result = await sandbox.commands.run(
      `python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt`,
      { timeoutMs: SANDBOX_TIMEOUT_MS }
    );

    const executionMs = Date.now() - start;
    const e2b = sandbox;

    // Shared runtime-agnostic parsing (incl. the OOM heuristic that used to
    // exist only on the Docker path) — see parse-output.ts.
    return await parseSandboxOutput({
      runtime: "e2b",
      exitCode: result.exitCode,
      executionMs,
      readFile: (path) => e2b.files.read(path).catch(() => null),
      stderrFallback: result.stderr || result.error || undefined,
    });
  } catch (err) {
    const error = errMessage(err);
    return {
      success: false,
      error,
      // A thrown SDK error (E2B deadline, create/transport failure) is an
      // environment failure, not a code failure — classify it so the retry loop
      // fast-fails instead of re-generating code that never ran (finding M7).
      errorKind: classifyThrownError(error),
      execution_ms: Date.now() - start,
    };
  } finally {
    if (sandbox) {
      await sandbox.kill().catch(() => {});
    }
  }
}
