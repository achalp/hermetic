import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "@/lib/types";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { ensureSuccess, run, parseExecutionOutput } from "./docker-utils";

export async function executeSandbox(
  csvContent: string,
  code: string,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[]
): Promise<ExecutionResult> {
  const start = Date.now();
  const id = `hermetic-sandbox-${randomUUID()}`;

  try {
    // 1. Create container
    ensureSuccess(
      "Create Docker sandbox container",
      await run("docker", ["run", "-d", "--name", id, DOCKER_SANDBOX_IMAGE, "sleep", "300"], {
        timeoutMs: 15_000,
      })
    );

    // 2. Write CSV via stdin
    ensureSuccess(
      "Write CSV to Docker sandbox",
      await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/input.csv"], {
        input: csvContent,
        timeoutMs: 15_000,
      })
    );

    // 2b. Write GeoJSON via stdin (if provided)
    if (geojsonContent) {
      ensureSuccess(
        "Write GeoJSON to Docker sandbox",
        await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/input.geojson"], {
          input: geojsonContent,
          timeoutMs: 15_000,
        })
      );
    }

    // 2c. Write additional files (workbook sheets)
    if (additionalFiles && additionalFiles.length > 0) {
      ensureSuccess(
        "Create workbook sheet directory in Docker sandbox",
        await run("docker", ["exec", id, "mkdir", "-p", "/data/sheets"], { timeoutMs: 5_000 })
      );
      for (const file of additionalFiles) {
        const safePath = file.path.replace(/'/g, "'\\''");
        ensureSuccess(
          `Write additional file to Docker sandbox (${file.path})`,
          await run("docker", ["exec", "-i", id, "sh", "-c", `cat > '${safePath}'`], {
            input: file.content,
            timeoutMs: 15_000,
          })
        );
      }
    }

    // 3. Write script via stdin (with NaN-safety prelude)
    ensureSuccess(
      "Write Python script to Docker sandbox",
      await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/script.py"], {
        input: PYTHON_NAN_PRELUDE + code,
        timeoutMs: 15_000,
      })
    );

    // 4. Run script
    const execResult = ensureSuccess(
      "Start Python analysis in Docker sandbox",
      await run(
        "docker",
        [
          "exec",
          id,
          "sh",
          "-c",
          "python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?",
        ],
        { timeoutMs: SANDBOX_TIMEOUT_MS }
      )
    );

    // 5. Parse output
    return await parseExecutionOutput(id, start, execResult.stdout);
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
