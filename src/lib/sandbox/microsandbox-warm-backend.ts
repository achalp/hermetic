import type { WarmSandboxBackend } from "./warm-sandbox";
import type { ExecutionResult } from "@/lib/contracts/execution";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import { SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { getOrCreateSandbox, writeChunkedFile, readSandboxFile } from "./microsandbox-executor";
import { parseSandboxOutput } from "./parse-output";
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

    // Write additional files (workbook sheets, runtime package, skill/user libs)
    if (additionalFiles && additionalFiles.length > 0) {
      for (const file of additionalFiles) {
        const localPath = file.path; // already absolute under /data/
        const parent = localPath.slice(0, localPath.lastIndexOf("/")) || "/data";
        await sandbox.run(
          `import pathlib; pathlib.Path(${JSON.stringify(parent)}).mkdir(parents=True, exist_ok=True)`,
          { timeout: 5 }
        );
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

      // Shared runtime-agnostic parsing (incl. the OOM heuristic that used to
      // exist only on the Docker path) — see parse-output.ts.
      return await parseSandboxOutput({
        runtime: "microsandbox-warm",
        exitCode: parseInt(rawOutput.trim(), 10),
        executionMs,
        workDir,
        readFile: (path) => readSandboxFile(sandbox, path),
      });
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
