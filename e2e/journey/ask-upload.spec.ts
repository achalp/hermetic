/**
 * The browser user journey: home → upload a CSV → ask → rendered dashboard,
 * driven through the real UI against a real server and a real sandbox.
 *
 * Everything else in e2e/ renders a static export or exercises the WASM worker
 * in isolation; the goldens cover this journey only over HTTP. This spec is the
 * one place the UI wiring (upload input → ask composer → stream → renderer) is
 * exercised end to end.
 *
 * Runs against a REPLAY-mode server (HERMETIC_LLM_MODE=replay), so it is offline
 * and deterministic: the question and the upload name ("fixture.csv") match the
 * ask-basic golden, whose recorded LLM fixtures serve this run. Not part of
 * `pnpm test:e2e` — run with `pnpm test:e2e:journey` next to a replay server
 * (CI: the golden-transcripts job). A missing server FAILS; it never skips.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSV = join(process.cwd(), "test-specs", "data", "01-saas-mrr.csv");
// Must match scripts/golden/run-journeys.mjs (ask-basic): the prompt hashes
// that select the recorded fixtures include the file name and the question.
const QUESTION = "What is the MRR trend over time?";

test.beforeAll(async ({ request, baseURL }) => {
  const res = await request.get("/api/providers").catch((e: unknown) => {
    throw new Error(
      `no server at ${baseURL} — start one in replay mode first ` +
        `(HERMETIC_LLM_MODE=replay pnpm start). ${String(e)}`
    );
  });
  expect(res.ok(), `GET /api/providers → ${res.status()}`).toBeTruthy();
});

test("upload a CSV, ask a question, get a dashboard with charts", async ({ page }) => {
  const pageErrors: string[] = [];
  const renderErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    // Per-element render crashes render null and only log (spec/react/renderer.tsx).
    if (m.type() === "error" && m.text().includes("[json-render] Rendering error")) {
      renderErrors.push(m.text());
    }
  });

  await page.goto("/");

  // Upload through the real input. Setting files on it directly does not arm a
  // pending question, so the question is typed after the Ask screen appears.
  const upload = page.waitForResponse((r) => r.url().endsWith("/api/upload"));
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({ name: "fixture.csv", mimeType: "text/csv", buffer: readFileSync(CSV) });
  expect((await upload).ok(), "POST /api/upload").toBeTruthy();
  // Upload errors render as a role="alert" banner. (Next's route announcer is
  // also role="alert" but empty, hence the text filter.)
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);

  const question = page.locator("#home-question");
  await expect(question).toBeVisible();
  await question.fill(QUESTION);

  const query = page.waitForRequest((r) => r.url().endsWith("/api/query") && r.method() === "POST");
  await page.getByRole("button", { name: /^Analyze/ }).click();
  const body = (await query).postDataJSON() as { context?: { question?: string } };
  expect(body.context?.question).toBe(QUESTION);

  // Done = the follow-up query input appears (only rendered once results exist
  // and nothing is analyzing).
  await expect(page.locator("#query-input")).toBeVisible({ timeout: 120_000 });

  // The pipeline's own error spec also mounts inside [data-slides-root], so a
  // root alone is not success: require charts and no error annotation.
  const dashboard = page.locator("[data-slides-root]");
  await expect(dashboard).toBeVisible();
  await expect(page.getByText("Analysis Error")).toHaveCount(0);
  await expect(page.getByText(/Visualization render error/i)).toHaveCount(0);
  const charts = dashboard.locator('[role="img"]');
  await expect(charts.first()).toBeVisible();
  await expect(charts.first().locator("svg, canvas").first()).toBeVisible();

  expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
  expect(renderErrors, `element render errors:\n${renderErrors.join("\n")}`).toEqual([]);
});
