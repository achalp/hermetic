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
      ],
      // Floors act as a regression ratchet, set a few points below current.
      // Global is low because ~69 chart components are presentational and
      // largely untested; the meaningful gate is on the src/lib logic layer.
      // Ratchet: set a few points below current so gains can't regress. The
      // src/lib LOGIC layer is gated hard; the global floor is lower because the
      // pure-render UI (chart components / app panels) sits at a ~50% floor by
      // deliberate policy (render bugs are visible; their transforms are tested).
      thresholds: {
        statements: 55,
        lines: 55,
        functions: 52,
        branches: 45,
        "src/lib/**": {
          statements: 70,
          lines: 70,
          functions: 72,
          branches: 62,
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
