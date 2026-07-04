import { randomUUID } from "node:crypto";
import { dirname, basename } from "node:path";
import type { CSVSchema } from "@/lib/types";
import type { SandboxRuntimeId } from "@/lib/constants";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS, LOCAL_MOUNT_PATH } from "@/lib/constants";
import { run } from "@/lib/sandbox/docker-utils";
import { PYTHON_NAN_PRELUDE } from "@/lib/sandbox/index";
import { buildSchemaScript, buildRemoteParquetSchemaScript } from "./schema-script";
import { duckdbRemoteAuthSql, type RemoteCreds } from "./duckdb-source";
import { logger } from "@/lib/logger";

/**
 * Run a DuckDB schema-extraction script in an ephemeral Docker container and
 * parse its /data/output.json into a CSVSchema. Shared by the local (bind-mount)
 * and remote (network, no mount) extractors so the container lifecycle + output
 * parsing live in ONE place.
 */
async function runSchemaExtraction(args: {
  script: string;
  csvId: string;
  filename: string;
  /** Host path to bind-mount at LOCAL_MOUNT_PATH (local files); omit for remote. */
  mountHostPath?: string;
  /** Exec timeout — remote reads over the network need longer. */
  timeoutMs: number;
}): Promise<CSVSchema> {
  const containerId = `hermetic-parquet-schema-${randomUUID()}`;
  const runArgs = ["run", "-d", "--name", containerId];
  if (args.mountHostPath) runArgs.push("-v", `${args.mountHostPath}:${LOCAL_MOUNT_PATH}:ro`);
  runArgs.push(DOCKER_SANDBOX_IMAGE, "sleep", "300");

  try {
    await run("docker", runArgs, { timeoutMs: 15_000 });

    await run("docker", ["exec", "-i", containerId, "sh", "-c", "cat > /data/script.py"], {
      input: PYTHON_NAN_PRELUDE + "\n" + args.script,
      timeoutMs: 15_000,
    });

    const execResult = await run(
      "docker",
      [
        "exec",
        containerId,
        "sh",
        "-c",
        "python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?",
      ],
      { timeoutMs: args.timeoutMs }
    );

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

    return {
      csv_id: args.csvId,
      filename: args.filename,
      row_count: data.row_count,
      columns: data.columns,
      sample_rows: data.sample_rows,
      correlations: data.correlations ?? undefined,
      detected_domain: data.detected_domain ?? "general",
      source_type: "file",
    };
  } finally {
    await run("docker", ["rm", "-f", containerId], { timeoutMs: 10_000 }).catch(() => {});
  }
}

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

  // Mount the parent directory (single file) or the folder itself.
  const hostPath = isFolder ? localPath : dirname(localPath);
  const fileBasename = isFolder ? "" : basename(localPath);

  const schema = await runSchemaExtraction({
    script: buildSchemaScript(fileBasename, isFolder, isHivePartitioned),
    csvId,
    filename,
    mountHostPath: hostPath,
    timeoutMs: SANDBOX_TIMEOUT_MS * 3, // 90s — large Hive datasets need more time
  });

  logger.info("Parquet schema extracted", {
    csvId,
    filename,
    rowCount: schema.row_count,
    columnCount: schema.columns.length,
    isFolder,
  });
  return schema;
}

/**
 * Extract a schema from a REMOTE cloud Parquet URL (s3:// or https://) by having
 * DuckDB read it directly over the network — no bind-mount, no download. Reuses
 * the shared container runner and the same profiling logic as the local path.
 * `url` MUST be pre-validated (isSafeParquetUrl). Anonymous by default; `creds`
 * authenticates a private bucket.
 */
export async function extractRemoteParquetSchema(
  url: string,
  csvId: string,
  filename: string,
  runtime: SandboxRuntimeId,
  creds?: RemoteCreds
): Promise<CSVSchema> {
  if (runtime !== "docker") {
    throw new Error(
      "Cloud Parquet schema extraction is currently only supported with the Docker sandbox runtime."
    );
  }

  const schema = await runSchemaExtraction({
    script: buildRemoteParquetSchemaScript(url, duckdbRemoteAuthSql(creds)),
    csvId,
    filename,
    // No mount — the container reads the URL over its network.
    timeoutMs: SANDBOX_TIMEOUT_MS * 4, // 120s — remote reads are slower
  });

  logger.info("Remote Parquet schema extracted", {
    csvId,
    filename,
    rowCount: schema.row_count,
    columnCount: schema.columns.length,
  });
  return schema;
}
