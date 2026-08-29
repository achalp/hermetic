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
  console.log(`[smoke] spawning node server.js on :${port}…`);
  child = spawn(join(OUT, process.platform === "win32" ? "node.exe" : "node"), ["server.js"], {
    cwd: OUT,
    stdio: "inherit",
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
  });

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
  console.log("[smoke] PASS — the assembled sidecar serves the app.");
} finally {
  cleanup();
}
