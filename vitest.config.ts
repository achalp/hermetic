import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", ".next"],
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Keep the report even when the run is red — v8 defaults to false, so a
      // failing `test:coverage` used to CLEAR coverage/ and write nothing,
      // leaving only a stale (or no) summary to mislead readers.
      reportOnFailure: true,
      include: ["src/**/*.{ts,tsx}"],
      // Exclude tests, type-only files, and Next entry points (page/layout are
      // thin server wrappers exercised by e2e/build, not unit tests).
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__tests__/**",
        "src/test-setup.ts",
        "src/types/**",
        "src/**/*.d.ts",
        "src/app/**/{page,layout}.tsx",
        // Harness/bootstrap + browser-bundle ENTRY points: they wire tested
        // library functions to a transport (CLI argv, MCP stdio) or are esbuild
        // browser bundles never imported by the node graph — exercised by
        // build/e2e, not unit tests (same rationale as page/layout above). The
        // logic they call (lib/*, mcp/tools/*, mcp/**/server.ts) IS covered.
        "src/cli/main.ts",
        "src/mcp/main.ts",
        "src/mcp/viewer/{entry,export-entry,chrome}.tsx",
        "src/mcp/viewer/export-stubs/**",
        // Next.js runtime instrumentation hooks — register()/OTEL boot, run at
        // server start, not unit-testable (canonical coverage exclusion).
        "src/instrumentation.ts",
        "src/instrumentation-node.ts",
        // The wasm executor is Pyodide-in-Node integration glue — it can't be
        // unit-covered (boots the WASM runtime + fetches wheels). It is covered
        // by the opt-in wasm-parity CI job (HERMETIC_WASM_TEST=1), not this run.
        // Every OTHER PURE file under src/lib/sandbox/wasm/** is held to 100%
        // coverage by the threshold below — new wasm logic starts at 100%. The
        // few files listed here are INTEGRATION edges (boot workers / SAB /
        // Pyodide) covered by dedicated integration tests, not the unit run.
        "src/lib/sandbox/wasm/executor.ts",
        "src/lib/sandbox/wasm/transport-node.ts",
        "src/lib/sandbox/wasm/duckdb-bridge.ts",
        "src/lib/sandbox/wasm/duckdb-engine.ts",
        "src/lib/sandbox/wasm/handoff.ts",
        // globalThis-backed singleton (shared with the /api/wasm-result route);
        // its registry logic is 100%-covered in handoff-registry.test.ts.
        "src/lib/sandbox/wasm/handoff-singleton.ts",
      ],
      // Floors act as a regression ratchet, set a few points below current.
      // Global is low because ~69 chart components are presentational and
      // largely untested; the meaningful gate is on the src/lib logic layer.
      // Ratchet: set a few points below current so gains can't regress. The
      // src/lib LOGIC layer is gated hard; the global floor is lower because the
      // pure-render UI (chart components / app panels) sits at a ~50% floor by
      // deliberate policy (render bugs are visible; their transforms are tested).
      thresholds: {
        statements: 64,
        lines: 66,
        functions: 62,
        branches: 54,
        "src/lib/**": {
          statements: 73,
          lines: 75,
          functions: 75,
          branches: 64,
        },
        // The wasm subsystem is NEW and starts at 100% — every pure-logic line,
        // branch, and function is covered (the Pyodide executor is excluded above
        // and covered by the wasm-parity job). This is a hard gate, not a floor:
        // a new wasm/ module ships with full coverage or the run goes red.
        "src/lib/sandbox/wasm/**": {
          statements: 100,
          lines: 100,
          functions: 100,
          branches: 100,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // `server-only` throws under vitest's default resolve condition (its
      // job is to fail CLIENT bundles at next-build time; vitest is neither
      // graph). Stub it so node-only lib modules stay importable in tests.
      "server-only": path.resolve(__dirname, "./src/test-stubs/server-only.ts"),
    },
  },
});
