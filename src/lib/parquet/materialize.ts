import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, stat } from "node:fs/promises";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { SandboxRuntimeId } from "@/lib/constants";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS, LOCAL_MOUNT_PATH } from "@/lib/constants";
import { run } from "@/lib/sandbox/docker-utils";
import { parseJsonWithPythonNonFinite } from "@/lib/sandbox/parse-output";
import { pythonNanPrelude } from "@/lib/sandbox/prelude";
import { buildSchemaScript } from "./schema-script";
import { logger } from "@/lib/logger";
import { hermeticPaths } from "@/lib/paths";

/**
 * Host dir holding materialized Parquet files, bind-mounted into analysis
 * sandboxes. MUST live somewhere Docker Desktop shares for bind-mounts — the OS
 * temp dir (/var/folders on macOS) is NOT shared, so the mount comes up empty
 * and read_parquet finds nothing. The home dir (/Users/...) is shared by default
 * (it's where the working local-files mounts live), so we anchor here.
 */
export const PARQUET_DIR = hermeticPaths.parquetCacheDir();

/**
 * Convert CSV text into a Parquet file on the host AND extract its schema, in a
 * single ephemeral Docker/DuckDB pass with ZERO Node-side parsing. This is the
 * foundation of the "data is what it is" path: DuckDB reads the CSV out-of-core,
 * writes a compact, typed Parquet, and computes the schema over a large sample —
 * so analysis can scale far past the pandas-era row cap. Returns the host Parquet
 * path (for later bind-mount into the analysis sandbox) and the CSVSchema.
 *
 * Reuses the UNMODIFIED local-files schema script by writing the Parquet to the
 * mount path and pointing the script at "output.parquet" — so this adds no risk
 * to the existing local-files Parquet flow.
 */
export async function materializeCsvToParquet(
  csvContent: string,
  csvId: string,
  filename: string,
  runtime: SandboxRuntimeId
): Promise<{ parquetPath: string; schema: CSVSchema }> {
  if (runtime !== "docker") {
    throw new Error("Parquet materialization is only supported with the Docker sandbox runtime.");
  }
  await mkdir(PARQUET_DIR, { recursive: true });
  const parquetPath = join(PARQUET_DIR, `${csvId}.parquet`);
  const containerId = `hermetic-materialize-${randomUUID()}`;

  // Convert, then run the existing schema script over the result. Writing the
  // Parquet to LOCAL_MOUNT_PATH/output.parquet lets buildSchemaScript read it
  // unchanged (it builds DATA_PATH = `${LOCAL_MOUNT_PATH}/<filename>`).
  const conversionPrefix = `
import os as _os, duckdb as _ddb
_os.makedirs('${LOCAL_MOUNT_PATH}', exist_ok=True)
_con = _ddb.connect()
_con.execute("COPY (SELECT * FROM read_csv_auto('/data/input.csv', header=true)) TO '${LOCAL_MOUNT_PATH}/output.parquet' (FORMAT PARQUET)")
_con.close()
`;
  const script = pythonNanPrelude() + conversionPrefix + buildSchemaScript("output.parquet", false);

  try {
    await run(
      "docker",
      ["run", "-d", "--name", containerId, DOCKER_SANDBOX_IMAGE, "sleep", "300"],
      { timeoutMs: 15_000 }
    );
    await run("docker", ["exec", "-i", containerId, "sh", "-c", "cat > /data/input.csv"], {
      input: csvContent,
      timeoutMs: 60_000,
    });
    await run("docker", ["exec", "-i", containerId, "sh", "-c", "cat > /data/script.py"], {
      input: script,
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
      { timeoutMs: SANDBOX_TIMEOUT_MS * 4 } // 120s — conversion + schema over large data
    );
    const exitCode = parseInt(execResult.stdout.trim(), 10);
    if (exitCode !== 0) {
      const stderr = await run("docker", ["exec", containerId, "cat", "/data/stderr.txt"]).catch(
        () => ({ stdout: "unknown error", stderr: "", exitCode: 1 })
      );
      throw new Error(`Parquet materialization failed: ${stderr.stdout.slice(0, 500)}`);
    }

    // Copy the Parquet out to the host so the analysis sandbox can bind-mount it.
    const cp = await run(
      "docker",
      ["cp", `${containerId}:${LOCAL_MOUNT_PATH}/output.parquet`, parquetPath],
      { timeoutMs: 60_000 }
    );
    // Verify it actually landed and is non-empty — otherwise the analysis mount
    // would be broken and every step would fail with "no parquet found". Throwing
    // here makes the caller fall back to the proven CSV path instead.
    const size = await stat(parquetPath)
      .then((s) => s.size)
      .catch(() => 0);
    if (cp.exitCode !== 0 || size === 0) {
      throw new Error(
        `Parquet copy-out failed (exit ${cp.exitCode}, ${size} bytes): ${cp.stderr.slice(0, 200)}`
      );
    }

    const outputResult = await run("docker", ["exec", containerId, "cat", "/data/output.json"]);
    if (!outputResult.stdout.trim()) {
      throw new Error("Parquet materialization produced no schema output");
    }
    // Parse first; regex-sanitize Python NaN/Infinity only on parse failure —
    // the unconditional regex corrupted legitimate strings ("NaN Zhu").
    const data = parseJsonWithPythonNonFinite(outputResult.stdout) as {
      row_count: number;
      columns: CSVSchema["columns"];
      sample_rows: CSVSchema["sample_rows"];
      correlations: CSVSchema["correlations"];
      detected_domain: CSVSchema["detected_domain"];
    };

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
    logger.info("Materialized CSV to Parquet", {
      csvId,
      rows: data.row_count,
      columns: data.columns.length,
    });
    return { parquetPath, schema };
  } finally {
    await run("docker", ["rm", "-f", containerId], { timeoutMs: 10_000 }).catch(() => {});
  }
}
