import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "@/lib/types";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import { SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { run, parseExecutionOutput } from "./docker-utils";

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
        const safePath = file.path.replace(/'/g, "'\\''");
        await run("docker", ["exec", "-i", id, "sh", "-c", `cat > '${safePath}'`], {
          input: file.content,
          timeoutMs: 15_000,
        });
      }
    }

    // 3. Write script via stdin (with NaN-safety prelude)
    await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/script.py"], {
      input: PYTHON_NAN_PRELUDE + code,
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
