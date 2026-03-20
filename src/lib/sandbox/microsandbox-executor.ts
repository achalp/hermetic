import { PythonSandbox } from "microsandbox";
import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "@/lib/types";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import { SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { logger } from "@/lib/logger";

const SANDBOX_NAME = "hermetic";

const PACKAGES = ["pandas", "numpy", "scipy", "matplotlib", "seaborn", "scikit-learn"];

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

export async function getOrCreateSandbox(): Promise<PythonSandbox> {
  if (warmSandbox && sandboxReady) {
    return warmSandbox;
  }

  // If a previous sandbox exists but isn't ready (failed setup), stop it
  if (warmSandbox) {
    await warmSandbox.stop().catch(() => {});
    warmSandbox = null;
    sandboxReady = false;
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
    logger.debug("pandas not found — fixing pip and installing packages...");

    // The default microsandbox/python image has a broken pip. Download get-pip.py
    // on the HOST (reliable networking) and send it into the sandbox via base64.
    const CHUNK = 512 * 1024;
    const resp = await fetch("https://bootstrap.pypa.io/get-pip.py");
    if (!resp.ok) throw new Error(`Failed to download get-pip.py: HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());

    const first = buf.subarray(0, CHUNK).toString("base64");
    await sandbox.run(
      `import base64, pathlib; pathlib.Path("/tmp/get-pip.py").write_bytes(base64.b64decode(${JSON.stringify(first)}))`,
      { timeout: 10 }
    );
    for (let off = CHUNK; off < buf.length; off += CHUNK) {
      const chunk = buf.subarray(off, off + CHUNK).toString("base64");
      await sandbox.run(
        `import base64\nwith open("/tmp/get-pip.py", "ab") as f: f.write(base64.b64decode(${JSON.stringify(chunk)}))`,
        { timeout: 10 }
      );
    }

    // Try get-pip.py first, checking the return code
    const getPipExec = await sandbox.run(
      `import subprocess, sys\n` +
        `r = subprocess.run([sys.executable, "/tmp/get-pip.py", "--force-reinstall", "-q"], capture_output=True, text=True, timeout=120)\n` +
        `if r.returncode != 0:\n` +
        `    # Fallback: try ensurepip\n` +
        `    r2 = subprocess.run([sys.executable, "-m", "ensurepip", "--upgrade"], capture_output=True, text=True, timeout=60)\n` +
        `    assert r2.returncode == 0, f"Both get-pip.py (exit {r.returncode}: {r.stderr[:200]}) and ensurepip (exit {r2.returncode}: {r2.stderr[:200]}) failed"`,
      { timeout: 150 }
    );
    if (getPipExec.hasError()) {
      const err = await getPipExec.error().catch(() => "unknown error");
      logger.debug(`pip bootstrap warning: ${String(err).slice(0, 200)}`);
      // Still try to install packages — pip might work from a previous run
    }

    const pipExec = await sandbox.run(
      `import subprocess, sys\n` +
        `r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", ${PACKAGES.map((p) => `"${p}"`).join(", ")}], capture_output=True, text=True, timeout=300)\n` +
        `assert r.returncode == 0, f"pip failed (exit {r.returncode}):\\n{r.stderr}"`,
      { timeout: 360 }
    );
    if (pipExec.hasError()) {
      const err = await pipExec.error().catch(() => "unknown error");
      await sandbox.stop().catch(() => {});
      throw new Error(`Failed to install packages: ${String(err).slice(0, 300)}`);
    }
    logger.debug("Packages installed successfully");
  }

  // Create base /data directory
  await sandbox.run(`import pathlib; pathlib.Path("/data").mkdir(parents=True, exist_ok=True)`, {
    timeout: 5,
  });

  warmSandbox = sandbox;
  sandboxReady = true;
  return sandbox;
}

/**
 * Pre-warm the sandbox: create it and install packages.
 * Called from /api/runtimes/warmup during startup.
 */
export async function warmupSandbox(): Promise<void> {
  await getOrCreateSandbox();
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

    // Write CSV in chunks to avoid exceeding the JSON-RPC body size limit.
    const CHUNK_SIZE = 512 * 1024;
    const csvBuf = Buffer.from(csvContent);
    const firstChunk = csvBuf.subarray(0, CHUNK_SIZE).toString("base64");
    const initExec = await sandbox.run(
      `import base64, pathlib\n` +
        `pathlib.Path("${workDir}/input.csv").write_bytes(base64.b64decode(${JSON.stringify(firstChunk)}))`,
      { timeout: 15 }
    );

    if (initExec.hasError()) {
      return {
        success: false,
        error: `Failed to write files: ${await initExec.error()}`,
        execution_ms: Date.now() - start,
      };
    }

    for (let offset = CHUNK_SIZE; offset < csvBuf.length; offset += CHUNK_SIZE) {
      const chunk = csvBuf.subarray(offset, offset + CHUNK_SIZE).toString("base64");
      const appendExec = await sandbox.run(
        `import base64\n` +
          `with open("${workDir}/input.csv", "ab") as f:\n` +
          `    f.write(base64.b64decode(${JSON.stringify(chunk)}))`,
        { timeout: 15 }
      );
      if (appendExec.hasError()) {
        return {
          success: false,
          error: `Failed to write CSV chunk: ${await appendExec.error()}`,
          execution_ms: Date.now() - start,
        };
      }
    }

    // Write GeoJSON file (if provided)
    if (geojsonContent) {
      const geoBuf = Buffer.from(geojsonContent);
      const geoFirstChunk = geoBuf.subarray(0, CHUNK_SIZE).toString("base64");
      const geoInitExec = await sandbox.run(
        `import base64, pathlib\n` +
          `pathlib.Path("${workDir}/input.geojson").write_bytes(base64.b64decode(${JSON.stringify(geoFirstChunk)}))`,
        { timeout: 15 }
      );
      if (geoInitExec.hasError()) {
        return {
          success: false,
          error: `Failed to write GeoJSON: ${await geoInitExec.error()}`,
          execution_ms: Date.now() - start,
        };
      }
      for (let offset = CHUNK_SIZE; offset < geoBuf.length; offset += CHUNK_SIZE) {
        const chunk = geoBuf.subarray(offset, offset + CHUNK_SIZE).toString("base64");
        const appendExec = await sandbox.run(
          `import base64\n` +
            `with open("${workDir}/input.geojson", "ab") as f:\n` +
            `    f.write(base64.b64decode(${JSON.stringify(chunk)}))`,
          { timeout: 15 }
        );
        if (appendExec.hasError()) {
          return {
            success: false,
            error: `Failed to write GeoJSON chunk: ${await appendExec.error()}`,
            execution_ms: Date.now() - start,
          };
        }
      }
    }

    // Write additional files (workbook sheets)
    if (additionalFiles && additionalFiles.length > 0) {
      // Create sheets directory
      await sandbox.run(
        `import pathlib; pathlib.Path("${workDir}/sheets").mkdir(parents=True, exist_ok=True)`,
        { timeout: 5 }
      );
      for (const file of additionalFiles) {
        // Rewrite /data/sheets/X.csv → workDir/sheets/X.csv
        const localPath = file.path.replace(/^\/data\//, `${workDir}/`);
        const fileBuf = Buffer.from(file.content);
        const fileFirstChunk = fileBuf.subarray(0, CHUNK_SIZE).toString("base64");
        const fileInitExec = await sandbox.run(
          `import base64, pathlib\n` +
            `pathlib.Path("${localPath}").write_bytes(base64.b64decode(${JSON.stringify(fileFirstChunk)}))`,
          { timeout: 15 }
        );
        if (fileInitExec.hasError()) {
          return {
            success: false,
            error: `Failed to write additional file: ${await fileInitExec.error()}`,
            execution_ms: Date.now() - start,
          };
        }
        for (let offset = CHUNK_SIZE; offset < fileBuf.length; offset += CHUNK_SIZE) {
          const chunk = fileBuf.subarray(offset, offset + CHUNK_SIZE).toString("base64");
          const appendExec = await sandbox.run(
            `import base64\n` +
              `with open("${localPath}", "ab") as f:\n` +
              `    f.write(base64.b64decode(${JSON.stringify(chunk)}))`,
            { timeout: 15 }
          );
          if (appendExec.hasError()) {
            return {
              success: false,
              error: `Failed to write additional file chunk: ${await appendExec.error()}`,
              execution_ms: Date.now() - start,
            };
          }
        }
      }
    }

    // Write the script — rewrite /data paths to per-query paths (with NaN-safety prelude)
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
    const exitCode = parseInt(rawOutput.trim(), 10);

    if (exitCode !== 0) {
      const stderrResult = await sandbox.command
        .run("cat", [`${workDir}/stderr.txt`], 5)
        .catch(() => null);
      const stderr = stderrResult ? await stderrResult.output() : "Unknown execution error";
      return {
        success: false,
        error: stderr || "Unknown execution error",
        execution_ms: executionMs,
      };
    }

    // Read output
    let outputJson: string;
    let outputSource: string;

    const jsonResult = await sandbox.command
      .run("cat", [`${workDir}/output.json`], 5)
      .catch(() => null);

    if (jsonResult && jsonResult.success && (await jsonResult.output()).trim()) {
      outputJson = await jsonResult.output();
      outputSource = `file:${workDir}/output.json`;
    } else {
      const stdoutResult = await sandbox.command
        .run("cat", [`${workDir}/stdout.txt`], 5)
        .catch(() => null);
      if (stdoutResult && stdoutResult.success && (await stdoutResult.output()).trim()) {
        outputJson = await stdoutResult.output();
        outputSource = `file:${workDir}/stdout.txt`;
      } else {
        return {
          success: false,
          error:
            "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
          execution_ms: executionMs,
        };
      }
    }

    logger.debug("Microsandbox executor output", { source: outputSource, len: outputJson.length });

    if (!outputJson.trim()) {
      return {
        success: false,
        error:
          "Code produced no output. Ensure you print a JSON object to stdout or write to /data/output.json.",
        execution_ms: executionMs,
      };
    }

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
    // If the sandbox itself is broken, reset it so next query creates a fresh one
    if (warmSandbox) {
      await warmSandbox.stop().catch(() => {});
      warmSandbox = null;
      sandboxReady = false;
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
