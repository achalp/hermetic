import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "@/lib/types";
import type { AdditionalFile } from "./index";
import { SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { logger } from "@/lib/logger";

function run(
  cmd: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = opts?.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;

    const child = execFile(
      cmd,
      args,
      { signal: ac.signal, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        if (err && (err as NodeJS.ErrnoException).code === "ABORT_ERR") {
          reject(new Error("Sandbox execution timed out"));
          return;
        }
        // execFile passes exit-code errors through `err`
        const exitCode = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ stdout, stderr, exitCode: typeof exitCode === "number" ? exitCode : 1 });
      }
    );

    if (opts?.input && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

export async function executeSandbox(
  csvContent: string,
  code: string,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[]
): Promise<ExecutionResult> {
  const start = Date.now();
  const id = `gen-ui-sandbox-${randomUUID()}`;

  try {
    // 1. Create container
    await run("docker", ["run", "-d", "--name", id, "gen-ui-sandbox", "sleep", "300"], {
      timeoutMs: 15_000,
    });

    // 2. Write CSV via stdin
    await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/input.csv"], {
      input: csvContent,
      timeoutMs: 15_000,
    });

    // 2b. Write GeoJSON via stdin (if provided)
    if (geojsonContent) {
      await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/input.geojson"], {
        input: geojsonContent,
        timeoutMs: 15_000,
      });
    }

    // 2c. Write additional files (workbook sheets)
    if (additionalFiles && additionalFiles.length > 0) {
      await run("docker", ["exec", id, "mkdir", "-p", "/data/sheets"], { timeoutMs: 5_000 });
      for (const file of additionalFiles) {
        // Quote the path to handle sheet names with spaces/special characters
        const safePath = file.path.replace(/'/g, "'\\''");
        await run("docker", ["exec", "-i", id, "sh", "-c", `cat > '${safePath}'`], {
          input: file.content,
          timeoutMs: 15_000,
        });
      }
    }

    // 3. Write script via stdin
    await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/script.py"], {
      input: code,
      timeoutMs: 15_000,
    });

    // 4. Run script
    const execResult = await run(
      "docker",
      [
        "exec",
        id,
        "sh",
        "-c",
        "python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?",
      ],
      { timeoutMs: SANDBOX_TIMEOUT_MS }
    );

    const executionMs = Date.now() - start;
    const exitCode = parseInt(execResult.stdout.trim(), 10);

    // Check for errors via exit code
    if (exitCode !== 0) {
      const stderrResult = await run("docker", ["exec", id, "cat", "/data/stderr.txt"]).catch(
        () => ({ stdout: "Unknown execution error", stderr: "", exitCode: 1 })
      );
      return {
        success: false,
        error: stderrResult.stdout || "Unknown execution error",
        execution_ms: executionMs,
      };
    }

    // 5. Read output: prefer /data/output.json, fallback to /data/stdout.txt
    let outputJson: string;
    let outputSource: string;

    const jsonResult = await run("docker", ["exec", id, "cat", "/data/output.json"]).catch(
      () => null
    );

    if (jsonResult && jsonResult.exitCode === 0 && jsonResult.stdout.trim()) {
      outputJson = jsonResult.stdout;
      outputSource = "file:/data/output.json";
    } else {
      const stdoutResult = await run("docker", ["exec", id, "cat", "/data/stdout.txt"]).catch(
        () => null
      );
      if (stdoutResult && stdoutResult.exitCode === 0 && stdoutResult.stdout.trim()) {
        outputJson = stdoutResult.stdout;
        outputSource = "file:/data/stdout.txt";
      } else {
        return {
          success: false,
          error:
            "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
          execution_ms: executionMs,
        };
      }
    }

    logger.debug("Docker executor output", { source: outputSource, len: outputJson.length });

    if (!outputJson.trim()) {
      return {
        success: false,
        error:
          "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
        execution_ms: executionMs,
      };
    }

    // Replace Python NaN/Infinity with null for valid JSON
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
    // 6. Cleanup — always remove container
    run("docker", ["rm", "-f", id]).catch(() => {});
  }
}
