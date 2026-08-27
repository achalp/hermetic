#!/usr/bin/env node
/**
 * Isolation proof for the Phase-2 package boundaries (exit audit F4).
 *
 * For each target we resolve its full TypeScript module graph
 * (`tsc --listFilesOnly`) and fail if any resolved repo file falls outside
 * the target's allowed roots. Combined with the whole-repo typecheck this
 * proves each target compiles ALONE — i.e. the Phase 2 split of src/spec,
 * src/lib/contracts, and the renderer closure into packages stays a
 * `git mv`, not an untangling project.
 *
 * The allowed-roots lists are the DECLARED dependency surface of each
 * future package. Adding a root here is an API decision, not a fix.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  {
    name: "spec (→ @hermetic/spec)",
    include: ["src/spec/**/*.ts", "src/spec/**/*.tsx"],
    excludeTests: true,
    allowed: ["src/spec/"],
  },
  {
    name: "contracts",
    include: ["src/lib/contracts/**/*.ts"],
    excludeTests: true,
    // contracts sits on top of the spec package only
    allowed: ["src/lib/contracts/", "src/spec/core/"],
  },
  {
    name: "wasm sandbox (pure logic seam)",
    // The untrusted-execution subsystem's PURE modules (relay, phase contracts,
    // and future shim/egress/transport logic). Held to a tight surface so the
    // seam stays clean as parallel phase work lands. The Pyodide executor
    // (integration glue → parse-output/runtime-files) is the impure edge and is
    // intentionally OUTSIDE this boundary.
    include: [
      "src/lib/sandbox/wasm/relay.ts",
      "src/lib/sandbox/wasm/contract.ts",
      "src/lib/sandbox/wasm/egress-guard.ts",
      "src/lib/sandbox/wasm/prelude.ts",
      "src/lib/sandbox/wasm/handoff-registry.ts",
    ],
    excludeTests: true,
    allowed: ["src/lib/sandbox/wasm/", "src/lib/contracts/", "src/spec/core/"],
  },
  {
    name: "renderer (→ @hermetic/renderer)",
    include: [
      "src/components/charts/**/*.ts",
      "src/components/charts/**/*.tsx",
      "src/components/controllers/**/*.tsx",
      "src/components/inputs/**/*.tsx",
      "src/components/registry.tsx",
      "src/components/registry-primitives.tsx",
      "src/components/spec-view.tsx",
      "src/components/data-table.tsx",
      "src/components/definition-list.tsx",
      "src/components/pivot-table.tsx",
      "src/components/renderer-error-boundary.tsx",
    ],
    excludeTests: true,
    // The renderer package's declared internal surface: the fork, the
    // renderer-support lib modules, and its own closure. Anything else
    // (transport, hooks, app state, llm, sandbox…) is a boundary breach.
    allowed: [
      "src/components/charts/",
      "src/components/controllers/",
      "src/components/inputs/",
      "src/components/registry.tsx",
      "src/components/registry-primitives.tsx",
      "src/components/spec-view.tsx",
      "src/components/data-table.tsx",
      "src/components/definition-list.tsx",
      "src/components/pivot-table.tsx",
      "src/components/renderer-error-boundary.tsx",
      "src/components/lazy-client.tsx",
      "src/components/ui/",
      "src/components/theme/", // theme system lives with the renderer (WS-E move out of lib)
      "src/components/drill-down-context.tsx",
      "src/spec/",
      "src/lib/contracts/",
      "src/lib/catalog.ts",
      // Recorded API decision (spec §9.3 F4): the catalog was split into
      // family objects (commit c7a5503) — same declared surface as catalog.ts,
      // refactored into files; the split never widened these roots, leaving
      // main's CI red on the isolation check.
      "src/lib/catalog-components/",
      "src/lib/catalog-components/**/*.ts",
      "src/lib/chart-stats.ts",
      "src/lib/constants.ts",
      "src/lib/basemap-constants.ts",
      "src/lib/data-transforms.ts",
      "src/lib/data-transforms/",
      "src/lib/drill-resolve.ts",
      "src/lib/export-utils.ts",
      "src/lib/format.ts",
      "src/lib/utils.ts",
      "src/lib/logger.ts",
      "src/lib/harness-slot.ts", // constants.ts → envConfig seam (type-safe, globalThis only)
      "config/timeouts.json", // constants.ts data
    ],
  },
];

const scratch = mkdtempSync(join(tmpdir(), "hermetic-isolation-"));
let failed = false;

try {
  for (const t of TARGETS) {
    const cfg = {
      extends: join(ROOT, "tsconfig.json"),
      compilerOptions: { noEmit: true, incremental: false, allowJs: true },
      include: t.include.map((p) => join(ROOT, p)),
      exclude: t.excludeTests
        ? ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx", "**/test-helpers/**"]
        : [],
    };
    const cfgPath = join(scratch, `tsconfig.${t.name.split(" ")[0]}.json`);
    writeFileSync(cfgPath, JSON.stringify(cfg));

    let out;
    try {
      out = execFileSync("npx", ["tsc", "-p", cfgPath, "--listFilesOnly"], {
        cwd: ROOT,
        encoding: "utf-8",
      });
    } catch (err) {
      console.error(`✖ ${t.name}: tsc failed\n${err.stdout ?? err.message}`);
      failed = true;
      continue;
    }

    const files = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((f) => relative(ROOT, f))
      // Only repo sources count; node_modules and ambient d.ts are package deps.
      .filter((f) => !f.startsWith("..") && !f.includes("node_modules") && !f.endsWith(".d.ts"));

    const breaches = files.filter((f) => !t.allowed.some((a) => f === a || f.startsWith(a)));

    if (breaches.length) {
      failed = true;
      console.error(`✖ ${t.name}: module graph escapes its allowed roots:`);
      for (const b of breaches) console.error(`    ${b}`);
    } else {
      console.log(`✔ ${t.name}: ${files.length} files, closure contained`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failed) {
  console.error(
    "\nIsolation check failed. A file above imports outside its future package.\n" +
      "Fix the import (preferred) or make a recorded API decision to widen the\n" +
      "allowed roots in scripts/isolation-check.mjs (see spec §9.3 F4)."
  );
  process.exit(1);
}
console.log("Isolation ok.");
