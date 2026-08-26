import { defineConfig, devices } from "@playwright/test";

// e2e renders REAL dashboards in a real browser — the "rendering half" the unit
// suite (which stops at the NDJSON spec) can't cover. The fixture is a
// self-contained HTML export (built by scripts/e2e-build-fixture.mts), so the
// tests need no running server. Run: pnpm test:e2e.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "line",
  use: {
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
