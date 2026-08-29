#!/usr/bin/env node
/**
 * CI smoke for the desktop sidecar (build log D15): assemble the sidecar (skipping
 * the ~200MB pyodide copy) and confirm `node server.js` from the assembled dir
 * actually SERVES the app — GET /api/health → 200. This is the load-bearing proof
 * that the Phase-0c packaging works; the Tauri shell (cargo check) wraps it.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = mkdtempSync(join(tmpdir(), "sidecar-smoke-"));
const DATA = mkdtempSync(join(tmpdir(), "sidecar-data-"));
let child;
const cleanup = () => {
  try {
    child?.kill();
  } catch {}
  rmSync(OUT, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });
};

try {
  console.log("[smoke] assembling sidecar (SIDECAR_SKIP_PYODIDE=1)…");
  execFileSync("node", ["scripts/build-desktop-sidecar.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, SIDECAR_OUT: OUT, SIDECAR_SKIP_PYODIDE: "1", HERMETIC_STANDALONE: "1" },
  });

  const port = "3987";
  // EXACTLY how the Tauri core spawns it (build log D16): --require the hashed-
  // externals hook, then the standalone entry. Capture output so we can assert the
  // BOOT is clean, not just that /api/health returns 200 (a shallow check let the
  // Next-16 external-module bug through the first time).
  console.log(`[smoke] spawning node --require hash-externals-hook.cjs server.js on :${port}…`);
  let serverOut = "";
  child = spawn(
    join(OUT, process.platform === "win32" ? "node.exe" : "node"),
    ["--require", "./hash-externals-hook.cjs", "server.js"],
    {
      cwd: OUT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: port,
        HOSTNAME: "127.0.0.1",
        HERMETIC_ASSET_ROOT: OUT,
        HERMETIC_DATA_ROOT: join(DATA, "data"),
        HERMETIC_USER_ROOT: join(DATA, "user"),
        HERMETIC_SCRATCH_ROOT: join(DATA, "scratch"),
        HERMETIC_FORCE_RUNTIME: "wasm",
      },
    }
  );
  const capture = (b) => {
    serverOut += b.toString();
    process.stdout.write(b);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let ok = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json();
        console.log(`[smoke] /api/health → ${res.status} ${JSON.stringify(body)}`);
        ok = true;
        break;
      }
    } catch {
      /* not up yet */
    }
  }
  if (!ok) throw new Error("sidecar did not serve /api/health in time");

  // No DANGLING symlinks anywhere in the bundle (build log D22). Turbopack leaves
  // hash-suffixed links pointing at ABSOLUTE build-machine paths under
  // .next/standalone; once that dir is cleaned they dangle, and `tauri build` then
  // dies resolving its resource glob ("resource path … doesn't exist") — a failure
  // that never shows up in a boot test, because the app boots fine without them.
  {
    const { readdir, stat } = await import("node:fs/promises");
    const dangling = [];
    await (async function walk(d) {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(d, e.name);
        if (e.isSymbolicLink()) {
          try {
            await stat(full);
          } catch {
            dangling.push(full.slice(OUT.length + 1));
          }
        } else if (e.isDirectory()) await walk(full);
      }
    })(OUT);
    if (dangling.length > 0) {
      throw new Error(
        `sidecar contains ${dangling.length} dangling symlink(s) — tauri build will ` +
          `fail resolving resources: ${dangling.join(", ")}`
      );
    }
    console.log("[smoke] no dangling symlinks in the bundle");
  }

  // Give boot a beat to load warehouse/secrets modules, then assert NO external
  // module failed to load (the Next-16 Turbopack production bug the hook fixes).
  await sleep(1500);
  const extFail = serverOut.match(/Failed to load external module|ERR_MODULE_NOT_FOUND/);
  if (extFail) {
    throw new Error(
      `sidecar logged an external-module load failure (the hashed-externals hook is not working): ${extFail[0]}`
    );
  }
  console.log(
    "[smoke] PASS — the assembled sidecar serves the app with no external-load failures."
  );
} finally {
  cleanup();
}
