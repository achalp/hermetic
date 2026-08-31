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
import { extractParquetSchemaHost } from "./host-schema";
import { computeRemoteParquetFingerprintHost } from "./host-fingerprint";
import { logger, errMessage } from "@/lib/logger";

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
  // No Docker? Profile it in-process instead. `host-schema.ts` runs the SAME
  // DuckDB engine against the real filesystem — a container was never what made
  // local parquet profiling possible, only what we happened to use (build log
  // D24/D25). Stats come from a smaller sample there; row count and types do not.
  if (runtime !== "docker") {
    return extractParquetSchemaHost({
      localPath,
      csvId,
      filename,
      isFolder,
      ...(isHivePartitioned !== undefined ? { isHivePartitioned } : {}),
    });
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
  // Off Docker this runs IN THE WORKER, driven by the client — see
  // lib/parquet/wasm-schema-job.ts and /api/remote-parquet/schema(/complete).
  // Reaching here means something called the server-side extractor directly on a
  // runtime that has no container, which is a wiring bug, not a user error.
  if (runtime !== "docker") {
    throw new Error(
      "Cloud Parquet schema extraction on the built-in runtime runs in the browser worker " +
        "(/api/remote-parquet/schema), not here."
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
  // Off Docker, list the object store from the host through the Rust egress core
  // instead of from inside a container (build log D26). Same change-detection,
  // deliberately different digest FORMAT so the two can never be compared.
  if (runtime !== "docker") {
    return computeRemoteParquetFingerprintHost(readUrl, creds);
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

/** One entity in a manifest batch extraction (lib/manifest/connect.ts). */
export interface BatchTarget {
  name: string;
  readUrl: string;
  isHivePartitioned: boolean;
}

export interface BatchExtractionOutcome {
  results: Map<string, { schema: CSVSchema } | { error: string }>;
  /** Not attempted — the wall-clock budget ran out first (they stay pending). */
  skipped: string[];
}

/**
 * Eager manifest introspection (spec §5.5): N remote entities, ONE container,
 * one egress network, one wall-clock budget.
 *
 * Why not N calls to extractRemoteParquetSchema: container creation plus egress
 * -network setup measured ~1.5–2 s per call in live runs — 28 entities would
 * spend the whole 60 s budget on setup alone. Here the container and the L7
 * gateway are built once (every entity is on the SAME host — the same-host gate
 * ran before this), and each entity is one `docker exec` of the UNCHANGED
 * single-entity script — so the profiling logic cannot fork from the
 * single-URL path.
 *
 * Budget semantics: checked BEFORE each entity; an entity already running may
 * overshoot by up to its own exec timeout (that overshoot is bounded and
 * logged, not hidden). Per-entity failures are recorded and do NOT stop the
 * loop — one unreadable entity must not cost the other 27.
 */
export async function extractRemoteParquetSchemaBatch(
  targets: BatchTarget[],
  creds: RemoteCreds | undefined,
  budgetMs: number
): Promise<BatchExtractionOutcome> {
  const results = new Map<string, { schema: CSVSchema } | { error: string }>();
  if (targets.length === 0) return { results, skipped: [] };

  const containerId = `hermetic-manifest-batch-${randomUUID()}`;
  let egress: EgressNetwork | undefined;
  const started = Date.now();

  try {
    // Revised host policy (2026-08-31): a manifest's entities may live on
    // DIFFERENT hosts — the batch's egress allowlist is the union of every
    // target's derived hosts. A target with no derivable host contributes
    // nothing (its read will be denied at the proxy and recorded as that
    // entity's failure); a batch where NOTHING derives still fails closed.
    const hostSet = new Set<string>();
    for (const t of targets) {
      const p = egressPolicyFor(t.readUrl, creds);
      if (p.mode === "allowlist") for (const h of p.hosts ?? []) hostSet.add(h);
    }
    if (hostSet.size === 0) {
      throw new Error(
        "Refusing to read this manifest's entities: no safe egress host could be derived."
      );
    }
    egress = await setupEgressNetwork(containerId.slice(-12), [...hostSet]);
    const runArgs = ["run", "-d", "--name", containerId, "--network", egress.networkName];
    for (const [k, v] of Object.entries(egress.env)) runArgs.push("-e", `${k}=${v}`);
    // sleep outlives budget + one overshooting entity, with margin.
    runArgs.push(DOCKER_SANDBOX_IMAGE, "sleep", "900");
    await run("docker", runArgs, { timeoutMs: 15_000 });

    const authSql = duckdbRemoteAuthSql(creds);
    let index = 0;
    for (const t of targets) {
      if (Date.now() - started >= budgetMs) break;
      index++;
      try {
        const script =
          pythonNanPrelude() +
          "\n" +
          buildRemoteParquetSchemaScript(t.readUrl, authSql, t.isHivePartitioned);
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
          { timeoutMs: SANDBOX_TIMEOUT_MS * 3 }
        );
        if (parseInt(execResult.stdout.trim(), 10) !== 0) {
          const stderrResult = await run("docker", [
            "exec",
            containerId,
            "cat",
            "/data/stderr.txt",
          ]).catch(() => ({ stdout: "Unknown error", stderr: "", exitCode: 1 }));
          results.set(t.name, { error: friendlyParquetError(stderrResult.stdout) });
          continue;
        }
        const outputResult = await run("docker", ["exec", containerId, "cat", "/data/output.json"]);
        const data = parseJsonWithPythonNonFinite(outputResult.stdout) as {
          row_count: number;
          columns: CSVSchema["columns"];
          sample_rows: CSVSchema["sample_rows"];
          correlations: CSVSchema["correlations"];
          detected_domain: CSVSchema["detected_domain"];
        };
        results.set(t.name, {
          schema: {
            csv_id: "", // stamped by the caller per registration
            filename: t.name,
            row_count: data.row_count,
            columns: data.columns,
            sample_rows: data.sample_rows,
            correlations: data.correlations ?? undefined,
            detected_domain: data.detected_domain ?? "general",
            source_type: "file",
          },
        });
      } catch (err) {
        // Per-entity failure — record and move on; the batch must survive it.
        results.set(t.name, { error: errMessage(err) });
      }
    }

    const skipped = targets.slice(index).map((t) => t.name);
    const overshootMs = Math.max(0, Date.now() - started - budgetMs);
    logger.info("Manifest batch extraction finished", {
      attempted: index,
      ok: [...results.values()].filter((r) => "schema" in r).length,
      failed: [...results.values()].filter((r) => "error" in r).length,
      skipped: skipped.length,
      ms: Date.now() - started,
      ...(overshootMs > 0 ? { overshootMs } : {}),
    });
    return { results, skipped };
  } finally {
    await run("docker", ["rm", "-f", containerId], { timeoutMs: 10_000 }).catch(() => {});
    await egress?.teardown().catch(() => {});
  }
}
