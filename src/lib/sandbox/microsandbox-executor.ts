import { PythonSandbox } from "microsandbox";
import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "@/lib/contracts/execution";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import { SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { parseSandboxOutput } from "./parse-output";
import { logger } from "@/lib/logger";

const SANDBOX_NAME = "hermetic";

/**
 * Read a file from the sandbox via `cat`; null when unreadable/absent.
 * The readFile adapter for the shared output parser (see parse-output.ts) —
 * exported for reuse by the warm backend.
 */
export async function readSandboxFile(
  sandbox: PythonSandbox,
  path: string
): Promise<string | null> {
  const result = await sandbox.command.run("cat", [path], 5).catch(() => null);
  if (!result || !result.success) return null;
  return await result.output();
}

const PACKAGES = ["pandas", "numpy", "scipy", "matplotlib", "seaborn", "scikit-learn", "duckdb"];

/**
 * Module-level persistent sandbox. Created once, reused across queries.
 */
let warmSandbox: PythonSandbox | null = null;
let sandboxReady = false;

/**
 * Send a raw JSON-RPC call to the microsandbox server.
 * Used to force-stop broken sandboxes that the SDK can't stop.
 */
async function rawRpc(
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url = process.env.MICROSANDBOX_URL || "http://127.0.0.1:5555";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.MICROSANDBOX_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.MICROSANDBOX_API_KEY}`;
  }
  const res = await fetch(`${url}/api/v1/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: randomUUID() }),
  });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Create a sandbox and verify it can execute code.
 * If the sandbox name is taken by a zombie, force-stop it first.
 */
async function createHealthySandbox(
  opts: Parameters<typeof PythonSandbox.create>[0]
): Promise<PythonSandbox> {
  const sandbox = await PythonSandbox.create(opts);

  // Verify the REPL actually works — sandbox.start can silently succeed
  // even when reconnecting to a broken/zombie sandbox.
  const check = await sandbox.run("print('ok')", { timeout: 10 }).catch(() => null);
  if (check && !check.hasError()) return sandbox;

  // REPL broken — force-stop via raw API (SDK's stop also fails with 5002
  // on broken sandboxes) and create fresh.
  const name = opts?.name ?? SANDBOX_NAME;
  logger.debug("Sandbox started but REPL is broken, force-stopping and recreating...", { name });
  const stopResult = await rawRpc("sandbox.stop", {
    namespace: "default",
    sandbox: name,
  }).catch(() => null);

  // Brief wait for the server to clean up the stopped sandbox
  await new Promise((r) => setTimeout(r, 1000));

  if (stopResult && !("error" in stopResult)) {
    // Stop succeeded — recreate with same name
    return PythonSandbox.create(opts);
  }

  // Even raw stop failed — server state is corrupted for this sandbox name.
  // Use a fresh name to sidestep the broken entry entirely.
  const freshName = `${name}-${randomUUID().slice(0, 8)}`;
  logger.debug("Force-stop failed, creating sandbox with fresh name", { freshName });
  return PythonSandbox.create({ ...opts, name: freshName });
}

/**
 * Creation memo — the check-then-act on the boolean pair raced: two
 * concurrent first-queries (an Investigate wave) both passed the null check
 * and both ran createHealthySandbox against the SAME sandbox name, one
 * force-stopping the other's live sandbox into spurious "REPL broken"
 * recreations. Concurrent callers now share one in-flight creation promise
 * (same pattern as warm-sandbox.ts warmupPromise).
 */
let creationPromise: Promise<PythonSandbox> | null = null;

export function getOrCreateSandbox(): Promise<PythonSandbox> {
  if (warmSandbox && sandboxReady) return Promise.resolve(warmSandbox);
  if (creationPromise) return creationPromise;
  creationPromise = createSandboxOnce().finally(() => {
    creationPromise = null;
  });
  return creationPromise;
}

async function createSandboxOnce(): Promise<PythonSandbox> {
  // If a previous sandbox exists but isn't ready (failed setup), stop it
  if (warmSandbox) {
    await warmSandbox.stop().catch(() => {});
    warmSandbox = null;
    sandboxReady = false;
  }

  // Check if the microsandbox server is reachable before attempting to create
  const msbUrl = process.env.MICROSANDBOX_URL || "http://127.0.0.1:5555";
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    await fetch(msbUrl, { signal: controller.signal });
    clearTimeout(t);
  } catch {
    throw new Error(
      `Microsandbox server is not reachable at ${msbUrl}. ` +
        "Start it with: msb server start --dev — or switch to Docker in Settings → Sandbox Runtime."
    );
  }

  logger.debug("Creating persistent microsandbox...");
  const sboxOpts = {
    name: SANDBOX_NAME,
    ...(process.env.MICROSANDBOX_IMAGE && { image: process.env.MICROSANDBOX_IMAGE }),
    ...(process.env.MICROSANDBOX_URL && { serverUrl: process.env.MICROSANDBOX_URL }),
    ...(process.env.MICROSANDBOX_API_KEY && { apiKey: process.env.MICROSANDBOX_API_KEY }),
  };

  const sandbox = await createHealthySandbox(sboxOpts);

  // If the warmup script already ran, packages are installed. Otherwise install now.
  const probe = await sandbox.run("import pandas", { timeout: 10 }).catch(() => null);
  if (!probe || probe.hasError()) {
    logger.debug("pandas not found — installing packages...");

    // The base image's pip may be corrupted (missing _vendor.pygments on overlay fs).
    // Workaround: set PYTHONPATH to the pip wheel bundled with ensurepip so pip loads
    // from the pristine wheel instead of the broken site-packages installation.
    const findWheel = await sandbox.command
      .run(
        "python3",
        [
          "-c",
          'import ensurepip, os; d = os.path.join(os.path.dirname(ensurepip.__file__), "_bundled"); whl = [f for f in os.listdir(d) if f.startswith("pip")][0]; print(os.path.join(d, whl))',
        ],
        10
      )
      .catch(() => null);
    const wheelPath = findWheel ? (await findWheel.output().catch(() => "")).trim() : "";

    // Build the install command — use PYTHONPATH workaround if we found the wheel
    const pipPrefix = wheelPath ? `PYTHONPATH=${wheelPath} ` : "";
    const pkgList = PACKAGES.join(" ");
    const installResult = await sandbox.command.run(
      "sh",
      ["-c", `${pipPrefix}python3 -m pip install -q --root-user-action=ignore ${pkgList} 2>&1`],
      360
    );

    if (!installResult.success) {
      const installOut = await installResult.output().catch(() => "");
      const installErr = await installResult.error().catch(() => "");
      logger.error("pip install failed", {
        exitCode: installResult.exitCode,
        stderr: installErr.slice(0, 300),
        stdout: installOut.slice(0, 300),
      });
      await sandbox.stop().catch(() => {});
      throw new Error(
        `Failed to install packages (exit ${installResult.exitCode}): ${(installErr || installOut).slice(0, 300)}`
      );
    }
    logger.debug("Packages installed successfully");

    // Verify packages are importable
    const verify = await sandbox
      .run("import pandas, numpy, scipy", { timeout: 10 })
      .catch(() => null);
    if (!verify || verify.hasError()) {
      const verifyErr = verify ? await verify.error().catch(() => "unknown") : "no response";
      logger.error("Package verification failed after install", {
        error: String(verifyErr).slice(0, 200),
      });
      await sandbox.stop().catch(() => {});
      throw new Error(
        "Packages installed but not importable — sandbox filesystem may be corrupted"
      );
    }
  }

  // Create base /data directory
  await sandbox.run(`import pathlib; pathlib.Path("/data").mkdir(parents=True, exist_ok=True)`, {
    timeout: 5,
  });

  warmSandbox = sandbox;
  sandboxReady = true;
  return sandbox;
}

export async function executeSandbox(
  csvContent: string,
  code: string,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[]
): Promise<ExecutionResult> {
  const start = Date.now();
  // Per-query working directory for isolation
  const queryId = randomUUID().slice(0, 8);
  const workDir = `/data/${queryId}`;

  try {
    const sandbox = await getOrCreateSandbox();

    // Create per-query directory
    await sandbox.run(
      `import pathlib; pathlib.Path("${workDir}").mkdir(parents=True, exist_ok=True)`,
      { timeout: 5 }
    );

    // All file writes go through the ONE chunked writer this file exports —
    // previously this function hand-rolled the same base64 chunk loop four
    // times (with four distinct error strings) while writeChunkedFile sat
    // unused right below it.
    const fail = (what: string, err: string): ExecutionResult => ({
      success: false,
      error: `Failed to write ${what}: ${err}`,
      execution_ms: Date.now() - start,
    });

    const csvErr = await writeChunkedFile(sandbox, `${workDir}/input.csv`, csvContent);
    if (csvErr) return fail("CSV", csvErr);

    if (geojsonContent) {
      const geoErr = await writeChunkedFile(sandbox, `${workDir}/input.geojson`, geojsonContent);
      if (geoErr) return fail("GeoJSON", geoErr);
    }

    // Additional files (workbook sheets, runtime package, skill/user libs)
    if (additionalFiles && additionalFiles.length > 0) {
      for (const file of additionalFiles) {
        // Rewrite /data/sheets/X.csv → workDir/sheets/X.csv; create each
        // file's own parent dir (paths span sheets/, hermetic_runtime/, ...).
        const localPath = file.path.replace(/^\/data\//, `${workDir}/`);
        const parent = localPath.slice(0, localPath.lastIndexOf("/")) || workDir;
        await sandbox.run(
          `import pathlib; pathlib.Path(${JSON.stringify(parent)}).mkdir(parents=True, exist_ok=True)`,
          { timeout: 5 }
        );
        const fileErr = await writeChunkedFile(sandbox, localPath, file.content);
        if (fileErr) return fail(`additional file ${file.path}`, fileErr);
      }
    }

    // Write the script — rewrite /data paths to per-query paths. The rewrite
    // includes the prelude, so write_output()'s /data/output.json maps correctly.
    const patchedCode = (PYTHON_NAN_PRELUDE + code).replace(/\/data\//g, `${workDir}/`);
    const scriptErr = await writeChunkedFile(sandbox, `${workDir}/script.py`, patchedCode);
    if (scriptErr) return fail("script", scriptErr);

    // Execute the script
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
      runtime: "microsandbox",
      exitCode: parseInt(rawOutput.trim(), 10),
      executionMs,
      workDir,
      readFile: (path) => readSandboxFile(sandbox, path),
    });
  } catch (err) {
    // Reset the SHARED sandbox only when it is actually broken — a health
    // probe decides. Unconditionally stopping it here killed the warm sandbox
    // out from under concurrent queries for per-query failures (a bad script,
    // a transient write error) that the sandbox itself survived fine.
    if (warmSandbox) {
      const probe = await warmSandbox.run("print('ok')", { timeout: 5 }).catch(() => null);
      if (!probe || probe.hasError()) {
        logger.warn("Microsandbox health probe failed after error — resetting", {
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
        await warmSandbox.stop().catch(() => {});
        warmSandbox = null;
        sandboxReady = false;
      }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      execution_ms: Date.now() - start,
    };
  } finally {
    // Clean up per-query directory (best effort, don't await)
    if (warmSandbox) {
      warmSandbox.command.run("rm", ["-rf", workDir], 5).catch(() => {});
    }
  }
}

/**
 * Write content to a file in the sandbox using base64 chunking.
 * Exported for reuse by the warm backend.
 */
export async function writeChunkedFile(
  sandbox: PythonSandbox,
  filePath: string,
  content: string
): Promise<string | null> {
  const CHUNK_SIZE = 512 * 1024;
  const buf = Buffer.from(content);
  const firstChunk = buf.subarray(0, CHUNK_SIZE).toString("base64");

  const initExec = await sandbox.run(
    `import base64, pathlib\n` +
      `pathlib.Path("${filePath}").write_bytes(base64.b64decode(${JSON.stringify(firstChunk)}))`,
    { timeout: 15 }
  );
  if (initExec.hasError()) {
    return `Failed to write file ${filePath}: ${await initExec.error()}`;
  }

  for (let offset = CHUNK_SIZE; offset < buf.length; offset += CHUNK_SIZE) {
    const chunk = buf.subarray(offset, offset + CHUNK_SIZE).toString("base64");
    const appendExec = await sandbox.run(
      `import base64\n` +
        `with open("${filePath}", "ab") as f:\n` +
        `    f.write(base64.b64decode(${JSON.stringify(chunk)}))`,
      { timeout: 15 }
    );
    if (appendExec.hasError()) {
      return `Failed to write chunk for ${filePath}: ${await appendExec.error()}`;
    }
  }

  return null; // success
}

export { PACKAGES, SANDBOX_NAME };
