import { randomUUID } from "node:crypto";
import { dirname, basename } from "node:path";
import type { CSVSchema } from "@/lib/types";
import type { SandboxRuntimeId } from "@/lib/constants";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS, LOCAL_MOUNT_PATH } from "@/lib/constants";
import { run } from "@/lib/sandbox/docker-utils";
import { PYTHON_NAN_PRELUDE } from "@/lib/sandbox/index";
import { buildSchemaScript } from "./schema-script";
import { logger } from "@/lib/logger";

/**
 * Extract a full CSVSchema-compatible schema from a Parquet file or folder
 * by running a DuckDB script inside a Docker sandbox with the file bind-mounted.
 *
 * This runs an ephemeral container (not the warm sandbox) since it needs
 * a bind-mount that can't be added to a running container.
 */
export async function extractParquetSchema(
  localPath: string,
  csvId: string,
  filename: string,
  isFolder: boolean,
  runtime: SandboxRuntimeId,
  isHivePartitioned?: boolean
): Promise<CSVSchema> {
  if (runtime !== "docker") {
    throw new Error(
      "Parquet schema extraction is currently only supported with the Docker sandbox runtime."
    );
  }

  const containerId = `hermetic-parquet-schema-${randomUUID()}`;

  // Mount strategy: mount the parent directory (for single file) or
  // the folder itself at LOCAL_MOUNT_PATH inside the container
  const hostPath = isFolder ? localPath : dirname(localPath);
  const fileBasename = isFolder ? "" : basename(localPath);

  const script =
    PYTHON_NAN_PRELUDE + "\n" + buildSchemaScript(fileBasename, isFolder, isHivePartitioned);

  try {
    // 1. Create container with bind-mount
    await run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        containerId,
        "-v",
        `${hostPath}:${LOCAL_MOUNT_PATH}:ro`,
        DOCKER_SANDBOX_IMAGE,
        "sleep",
        "300",
      ],
      { timeoutMs: 15_000 }
    );

    // 2. Write the schema extraction script
    await run("docker", ["exec", "-i", containerId, "sh", "-c", "cat > /data/script.py"], {
      input: script,
      timeoutMs: 15_000,
    });

    // 3. Execute the script
    const execResult = await run(
      "docker",
      [
        "exec",
        containerId,
        "sh",
        "-c",
        "python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?",
      ],
      { timeoutMs: SANDBOX_TIMEOUT_MS * 3 } // 90s — schema extraction on large Hive datasets needs more time
    );

    // 4. Check exit code
    const exitCode = parseInt(execResult.stdout.trim(), 10);
    if (exitCode !== 0) {
      const stderrResult = await run("docker", [
        "exec",
        containerId,
        "cat",
        "/data/stderr.txt",
      ]).catch(() => ({ stdout: "Unknown error", stderr: "", exitCode: 1 }));
      throw new Error(`Parquet schema extraction failed: ${stderrResult.stdout}`);
    }

    // 5. Read the output JSON directly (not through parseExecutionOutput,
    //    which expects the standard sandbox {results, chart_data} shape)
    const outputResult = await run("docker", ["exec", containerId, "cat", "/data/output.json"]);

    if (!outputResult.stdout.trim()) {
      throw new Error("Parquet schema extraction produced no output");
    }

    const rawJson = outputResult.stdout
      .replace(/\bNaN\b/g, "null")
      .replace(/\b-Infinity\b/g, "null")
      .replace(/\bInfinity\b/g, "null");

    const data = JSON.parse(rawJson) as {
      row_count: number;
      columns: CSVSchema["columns"];
      sample_rows: CSVSchema["sample_rows"];
      correlations: CSVSchema["correlations"];
      detected_domain: CSVSchema["detected_domain"];
    };

    // 6. Build CSVSchema
    const schema: CSVSchema = {
      csv_id: csvId,
      filename,
      row_count: data.row_count,
      columns: data.columns,
      sample_rows: data.sample_rows,
      correlations: data.correlations ?? undefined,
      detected_domain: data.detected_domain ?? "general",
      source_type: "file",
    };

    logger.info("Parquet schema extracted", {
      csvId,
      filename,
      rowCount: data.row_count,
      columnCount: data.columns.length,
      isFolder,
    });

    return schema;
  } finally {
    // Always clean up the container
    await run("docker", ["rm", "-f", containerId], { timeoutMs: 10_000 }).catch(() => {});
  }
}
