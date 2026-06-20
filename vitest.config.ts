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
      ],
      // Floors act as a regression ratchet, set a few points below current.
      // Global is low because ~69 chart components are presentational and
      // largely untested; the meaningful gate is on the src/lib logic layer.
      thresholds: {
        statements: 25,
        lines: 25,
        functions: 20,
        branches: 20,
        "src/lib/**": {
          statements: 43,
          lines: 43,
          functions: 43,
          branches: 38,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
