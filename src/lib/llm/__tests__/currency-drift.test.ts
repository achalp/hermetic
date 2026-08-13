import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENCY_UNITS } from "@/lib/llm/resolve-placeholders";

/**
 * Cross-language drift pin (specs/finding-field-roles-2026-08-13.md §2.M6).
 *
 * The currency allowlist exists twice by necessity: the sandbox runtime
 * (regimes.py `_CURRENCIES`) decides zero-sentinel policy with it, and the
 * host resolver (CURRENCY_UNITS) decides display precision with it. A unit
 * in one set but not the other produces quiet inconsistency — zeros excluded
 * for a unit the narrative then prints as a bare float, or vice versa. This
 * test parses the Python literal out of the runtime source, so the two
 * copies cannot diverge without a red build.
 */
describe("currency allowlist drift", () => {
  it("TS CURRENCY_UNITS equals regimes.py _CURRENCIES", () => {
    const src = readFileSync(
      join(process.cwd(), "docker/sandbox/hermetic_runtime/regimes.py"),
      "utf8"
    );
    const m = src.match(/_CURRENCIES\s*=\s*\{([\s\S]*?)\}/);
    expect(m, "regimes.py no longer defines _CURRENCIES — update this test").toBeTruthy();
    const python = new Set([...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1].toLowerCase()));
    expect(python.size).toBeGreaterThan(0);
    expect([...CURRENCY_UNITS].sort()).toEqual([...python].sort());
  });
});
