import type { WarmSandboxBackend } from "./warm-sandbox";
import type { ExecutionResult } from "@/lib/types";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import { SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { getOrCreateSandbox, writeChunkedFile } from "./microsandbox-executor";
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";

export class MicrosandboxWarmBackend implements WarmSandboxBackend {
  async warmup(): Promise<void> {
    await getOrCreateSandbox();
  }

  async loadData(
    csvId: string,
    csvContent: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): Promise<void> {
    const sandbox = await getOrCreateSandbox();

    // Clean existing data (keep /data dir itself)
    await sandbox.command
      .run("sh", ["-c", "rm -rf /data/input.csv /data/input.geojson /data/sheets"], 5)
      .catch(() => {});

    // Write CSV to fixed path
    const csvErr = await writeChunkedFile(sandbox, "/data/input.csv", csvContent);
    if (csvErr) throw new Error(csvErr);

    // Write GeoJSON (if provided)
    if (geojsonContent) {
      const geoErr = await writeChunkedFile(sandbox, "/data/input.geojson", geojsonContent);
      if (geoErr) throw new Error(geoErr);
    }

    // Write additional files (workbook sheets)
    if (additionalFiles && additionalFiles.length > 0) {
      await sandbox.run(
        `import pathlib; pathlib.Path("/data/sheets").mkdir(parents=True, exist_ok=True)`,
        { timeout: 5 }
      );
      for (const file of additionalFiles) {
        const localPath = file.path; // already /data/sheets/X.csv
        const fileErr = await writeChunkedFile(sandbox, localPath, file.content);
        if (fileErr) throw new Error(fileErr);
      }
    }

    logger.debug("Microsandbox warm data loaded", { csvId });
  }

  async executeScript(code: string): Promise<ExecutionResult> {
    const start = Date.now();
    const queryId = randomUUID().slice(0, 8);
    const workDir = `/data/${queryId}`;

    try {
      const sandbox = await getOrCreateSandbox();

      // Create per-query directory
      await sandbox.run(
        `import pathlib; pathlib.Path("${workDir}").mkdir(parents=True, exist_ok=True)`,
        { timeout: 5 }
      );

      // Symlink pre-loaded data files into per-query dir
      await sandbox.command.run(
        "sh",
        [
          "-c",
          [
            `ln -sf /data/input.csv ${workDir}/input.csv`,
            `[ -f /data/input.geojson ] && ln -sf /data/input.geojson ${workDir}/input.geojson || true`,
            `[ -d /data/sheets ] && ln -sf /data/sheets ${workDir}/sheets || true`,
          ].join(" && "),
        ],
        5
      );

      // Rewrite /data/ paths to per-query paths and write script (with NaN-safety prelude)
      const patchedCode = PYTHON_NAN_PRELUDE + code.replace(/\/data\//g, `${workDir}/`);
      const patchedB64 = Buffer.from(patchedCode).toString("base64");
      const writeExec = await sandbox.run(
        `import base64, pathlib\n` +
          `pathlib.Path("${workDir}/script.py").write_bytes(base64.b64decode(${JSON.stringify(patchedB64)}))`,
        { timeout: 15 }
      );
      if (writeExec.hasError()) {
        return {
          success: false,
          error: `Failed to write script: ${await writeExec.error()}`,
          execution_ms: Date.now() - start,
        };
      }

      // Execute
      const timeoutSecs = Math.ceil(SANDBOX_TIMEOUT_MS / 1000);
      const execResult = await sandbox.command.run(
        "sh",
        [
          "-c",
          `python3 ${workDir}/script.py > ${workDir}/stdout.txt 2>${workDir}/stderr.txt; echo $?`,
        ],
        timeoutSecs
      );

      const executionMs = Date.now() - start;
      const rawOutput = await execResult.output();
      const exitCode = parseInt(rawOutput.trim(), 10);

      if (exitCode !== 0) {
        const stderrResult = await sandbox.command
          .run("cat", [`${workDir}/stderr.txt`], 5)
          .catch(() => null);
        const stderr = stderrResult ? await stderrResult.output() : "Unknown execution error";
        return {
          success: false,
          error: stderr || "Unknown execution error",
          execution_ms: executionMs,
        };
      }

      // Read output
      let outputJson: string;
      let outputSource: string;

      const jsonResult = await sandbox.command
        .run("cat", [`${workDir}/output.json`], 5)
        .catch(() => null);

      if (jsonResult && jsonResult.success && (await jsonResult.output()).trim()) {
        outputJson = await jsonResult.output();
        outputSource = `file:${workDir}/output.json`;
      } else {
        const stdoutResult = await sandbox.command
          .run("cat", [`${workDir}/stdout.txt`], 5)
          .catch(() => null);
        if (stdoutResult && stdoutResult.success && (await stdoutResult.output()).trim()) {
          outputJson = await stdoutResult.output();
          outputSource = `file:${workDir}/stdout.txt`;
        } else {
          return {
            success: false,
            error:
              "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
            execution_ms: executionMs,
          };
        }
      }

      logger.debug("Microsandbox warm executor output", {
        source: outputSource,
        len: outputJson.length,
      });

      if (!outputJson.trim()) {
        return {
          success: false,
          error:
            "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
          execution_ms: executionMs,
        };
      }

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
      // Clean up per-query directory
      getOrCreateSandbox()
        .then((s) => s.command.run("rm", ["-rf", workDir], 5))
        .catch(() => {});
    }
  }

  async executeFull(
    csvContent: string,
    code: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): Promise<ExecutionResult> {
    await this.warmup();
    await this.loadData("full-exec", csvContent, geojsonContent, additionalFiles);
    return this.executeScript(code);
  }

  async isHealthy(): Promise<boolean> {
    try {
      const sandbox = await getOrCreateSandbox();
      const result = await sandbox.run("print('ok')", { timeout: 5 });
      return !result.hasError();
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    // The microsandbox lifecycle is managed by getOrCreateSandbox
    // No explicit destroy needed — it stays alive for reuse
  }
}
