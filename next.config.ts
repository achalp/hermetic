import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

// The desktop channel (Tauri sidecar — build log D15/Phase 0c) ships a Next
// STANDALONE server. Gated by HERMETIC_STANDALONE so the dev/docker clone path
// (start.sh → `next dev`) is completely unaffected.
const STANDALONE = process.env.HERMETIC_STANDALONE === "1";

const nextConfig: NextConfig = {
  ...(STANDALONE ? { output: "standalone" as const } : {}),
  // @duckdb/duckdb-wasm is loaded via a runtime `createRequire` (parquet-convert,
  // duckdb-engine) so Next's tracer can't see it — force it into the standalone
  // bundle, else the host-side parquet→CSV conversion 404s in the packaged app.
  ...(STANDALONE
    ? {
        // Pin the trace root to THIS dir so the include/exclude globs resolve
        // relative to the repo (else Next may guess a parent and the globs miss).
        outputFileTracingRoot: import.meta.dirname,
        outputFileTracingIncludes: {
          "*": ["node_modules/@duckdb/duckdb-wasm/dist/**"],
        },
        // CRITICAL: never trace RUNTIME STATE or dev-only trees into the bundle.
        // `data/` holds models (multi-GB GGUFs), history, and uploads — tracing it
        // exploded the bundle + filled the disk. pyodide is copied separately by the
        // sidecar script. These are host paths the app reads AT RUNTIME, not deps.
        outputFileTracingExcludes: {
          "*": [
            "data/**",
            "node_modules/pyodide/**",
            ".git/**",
            "test-fixtures/**",
            "e2e/**",
            "src-tauri/**",
            "rust/**",
            "coverage/**",
            "playwright-report/**",
          ],
        },
      }
    : {}),
  serverExternalPackages: [
    "@e2b/code-interpreter",
    "snowflake-sdk",
    "@databricks/sql",
    // Native addon (OS keychain) — must load from node_modules, not the bundle.
    "@napi-rs/keyring",
    // Loaded via runtime createRequire (blocking Node bundle) — keep external.
    "@duckdb/duckdb-wasm",
  ],
  transpilePackages: [
    "@deck.gl/core",
    "@deck.gl/react",
    "@deck.gl/layers",
    "@deck.gl/aggregation-layers",
    "@deck.gl/geo-layers",
  ],
};

export default withBundleAnalyzer(nextConfig);
