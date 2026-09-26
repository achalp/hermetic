import { defineConfig, devices } from "@playwright/test";

// The browser user journey (e2e/journey/): drives the real UI against an
// ALREADY-RUNNING server — in CI, the golden-transcripts job's replay-mode
// server with the Docker sandbox. Separate from playwright.config.ts because
// that suite needs no server; this one is meaningless without one.
// Run: pnpm test:e2e:journey  (E2E_BASE_URL overrides the default :3000).
export default defineConfig({
  testDir: "./e2e/journey",
  // One server, one shared sandbox: journeys run serially.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "list" : "line",
  timeout: 180_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
