import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";

const FIXTURE = join(process.cwd(), "e2e", ".artifacts", "dashboard.html");

test.describe("dashboard renders in a real browser", () => {
  test.beforeAll(() => {
    if (!existsSync(FIXTURE))
      throw new Error(
        "fixture missing — run `tsx scripts/e2e-build-fixture.mts` (pnpm test:e2e does)"
      );
  });

  test("the self-contained export mounts a dashboard with charts, no error boundary", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(pathToFileURL(FIXTURE).href);

    // The spec's root element mounts and paints something.
    const root = page.locator("#root, [data-spec-root], main").first();
    await expect(root).toBeVisible();

    // Charts render as real SVG/canvas (not just JSON) — the coverage gap.
    await expect(page.locator("svg, canvas").first()).toBeVisible({ timeout: 15_000 });

    // No React error-boundary fallback and no uncaught page errors.
    await expect(page.getByText(/something went wrong|render error|failed to render/i)).toHaveCount(
      0
    );
    expect(errors, `uncaught page errors:\n${errors.join("\n")}`).toEqual([]);
  });
});
