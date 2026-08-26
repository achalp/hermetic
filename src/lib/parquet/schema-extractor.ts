import { randomUUID } from "node:crypto";
import { dirname, basename } from "node:path";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { SandboxRuntimeId } from "@/lib/constants";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS, LOCAL_MOUNT_PATH } from "@/lib/constants";
import { run } from "@/lib/sandbox/docker-utils";
import { egressPolicyFor, setupEgressNetwork, type EgressNetwork } from "@/lib/sandbox/egress";
import { parseJsonWithPythonNonFinite } from "@/lib/sandbox/parse-output";
import { pythonNanPrelude } from "@/lib/sandbox/prelude";
import { friendlyParquetError } from "@/lib/parquet/friendly-error";
import {
  buildSchemaScript,
  buildRemoteParquetSchemaScript,
  buildParquetFingerprintScript,
} from "./schema-script";
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
  /**
   * Remote source to read over the network. When set, the container is joined
   * to the L7 egress-allowlist gateway derived from this URL (never the default
   * bridge). When omitted, the container gets `--network none`.
   */
  remoteEgress?: { url: string; creds?: RemoteCreds };
  /** Exec timeout — remote reads over the network need longer. */
  timeoutMs: number;
}): Promise<CSVSchema> {
  const containerId = `hermetic-parquet-schema-${randomUUID()}`;
  let egress: EgressNetwork | undefined;

  try {
    const runArgs = ["run", "-d", "--name", containerId];
    if (args.mountHostPath) runArgs.push("-v", `${args.mountHostPath}:${LOCAL_MOUNT_PATH}:ro`);
    if (args.remoteEgress) {
      // Remote read: the container must reach the source host and nothing else.
      // Route it through the SAME L7 allowlist gateway the analysis path uses
      // (setupEgressNetwork). The proxy resolves each host at connect time and
      // refuses any that lands on loopback / link-local / RFC-1918 / metadata —
      // defeating both a DNS name that resolves to an internal IP AND DNS
      // rebinding, neither of which the connect-time isSafeParquetUrl guard can
      // catch. A source with no derivable host FAILS CLOSED here rather than
      // silently joining the default bridge with full egress (finding F1).
      const policy = egressPolicyFor(args.remoteEgress.url, args.remoteEgress.creds);
      if (policy.mode === "deny" || !policy.hosts?.length) {
        throw new Error(
          "Refusing to read this remote source: no safe egress host could be derived from the URL."
        );
      }
      egress = await setupEgressNetwork(containerId.slice(-12), policy.hosts);
      runArgs.push("--network", egress.networkName);
      for (const [k, v] of Object.entries(egress.env)) runArgs.push("-e", `${k}=${v}`);
    } else {
      // Local bind-mounted read: no remote source, so no network at all
      // (deny-by-default, matching the analysis path). The image pre-bundles
      // the DuckDB extensions, so the offline INSTALL/LOAD still works.
      runArgs.push("--network", "none");
    }
    runArgs.push(DOCKER_SANDBOX_IMAGE, "sleep", "300");

    await run("docker", runArgs, { timeoutMs: 15_000 });

    await run("docker", ["exec", "-i", containerId, "sh", "-c", "cat > /data/script.py"], {
      input: pythonNanPrelude() + "\n" + args.script,
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
      // Log the RAW traceback server-side (full detail for debugging), but throw a
      // short, plain-English message — apiError surfaces err.message to the user,
      // and a mid-word-truncated Python traceback is not a usable error.
      logger.warn("Parquet schema extraction failed", {
        stderr: stderrResult.stdout.slice(0, 4000),
      });
      throw new Error(friendlyParquetError(stderrResult.stdout));
    }

    const outputResult = await run("docker", ["exec", containerId, "cat", "/data/output.json"]);
    if (!outputResult.stdout.trim()) {
      throw new Error("Parquet schema extraction produced no output");
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
    await egress?.teardown().catch(() => {});
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
  isHivePartitioned?: boolean,
  creds?: RemoteCreds
): Promise<CSVSchema> {
  if (runtime !== "docker") {
    throw new Error(
      "Cloud Parquet schema extraction is currently only supported with the Docker sandbox runtime."
    );
  }

  const schema = await runSchemaExtraction({
    script: buildRemoteParquetSchemaScript(url, duckdbRemoteAuthSql(creds), isHivePartitioned),
    csvId,
    filename,
    // No mount — the container reads the URL over the egress-allowlist gateway
    // derived from `url` (+ creds for region/endpoint), never the open bridge.
    remoteEgress: { url, creds },
    timeoutMs: SANDBOX_TIMEOUT_MS * 4, // 120s — remote reads are slower
  });

  logger.info("Remote Parquet schema extracted", {
    csvId,
    filename,
    rowCount: schema.row_count,
    columnCount: schema.columns.length,
    isHivePartitioned: !!isHivePartitioned,
  });
  return schema;
}

/**
 * Cheap freshness fingerprint for a remote Parquet source — its sorted
 * file-listing digest (see buildParquetFingerprintScript). Runs a tiny glob in
 * an ephemeral container and returns the digest; the schema cache compares it
 * to decide whether the (expensive) extraction can be skipped.
 */
export async function computeRemoteParquetFingerprint(
  readUrl: string,
  runtime: SandboxRuntimeId,
  creds?: RemoteCreds
): Promise<string> {
  if (runtime !== "docker") {
    throw new Error("Remote Parquet fingerprint requires the Docker sandbox runtime.");
  }
  const containerId = `hermetic-parquet-fp-${randomUUID()}`;
  let egress: EgressNetwork | undefined;
  try {
    // The fingerprint globs the remote object store — a network read — so it
    // goes through the same egress-allowlist gateway as extraction (finding F1),
    // and fails closed if no safe host derives from the URL.
    const policy = egressPolicyFor(readUrl, creds);
    if (policy.mode === "deny" || !policy.hosts?.length) {
      throw new Error(
        "Refusing to fingerprint this remote source: no safe egress host could be derived from the URL."
      );
    }
    egress = await setupEgressNetwork(containerId.slice(-12), policy.hosts);
    const runArgs = ["run", "-d", "--name", containerId, "--network", egress.networkName];
    for (const [k, v] of Object.entries(egress.env)) runArgs.push("-e", `${k}=${v}`);
    runArgs.push(DOCKER_SANDBOX_IMAGE, "sleep", "60");
    await run("docker", runArgs, { timeoutMs: 15_000 });
    await run("docker", ["exec", "-i", containerId, "sh", "-c", "cat > /data/script.py"], {
      input:
        pythonNanPrelude() +
        "\n" +
        buildParquetFingerprintScript(readUrl, duckdbRemoteAuthSql(creds)),
      timeoutMs: 15_000,
    });
    const execResult = await run(
      "docker",
      [
        "exec",
        containerId,
        "sh",
        "-c",
        "python3 /data/script.py >/dev/null 2>/data/stderr.txt; echo $?",
      ],
      { timeoutMs: SANDBOX_TIMEOUT_MS * 2 } // 60s — a listing, not a data read
    );
    if (parseInt(execResult.stdout.trim(), 10) !== 0) {
      const err = await run("docker", ["exec", containerId, "cat", "/data/stderr.txt"]).catch(
        () => ({ stdout: "unknown", stderr: "", exitCode: 1 })
      );
      throw new Error(`Parquet fingerprint failed: ${err.stdout.slice(0, 200)}`);
    }
    const out = await run("docker", ["exec", containerId, "cat", "/data/output.json"]);
    const parsed = JSON.parse(out.stdout) as { fp: string; n: number };
    // Include the file count so a fingerprint collision on the md5 is even less
    // likely, and the value is human-legible in the cache.
    return `files:${parsed.n}:${parsed.fp}`;
  } finally {
    await run("docker", ["rm", "-f", containerId], { timeoutMs: 10_000 }).catch(() => {});
    await egress?.teardown().catch(() => {});
  }
}
