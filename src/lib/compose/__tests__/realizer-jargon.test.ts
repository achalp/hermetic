/**
 * Jargon lint for user-facing realized prose. The realizer's caveat "riders"
 * are read by non-technical dashboard users, so they must avoid the internal
 * statistical vocabulary (attestation, bars, screening, thinness, observations,
 * candidates, series). This guards the plain-language rewrite from regressing:
 * a new rider that reaches for the jargon fails here.
 *
 * It checks the LITERAL prose only — ${...} interpolations (binding keys like
 * "thin_bar", field names) are stripped first, since those are data, not words
 * the reader sees.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BANNED = [
  /\battestation\b/i,
  /\bscreened?\b/i,
  /\bthin\b/i,
  /\bcandidates?\b/i,
  /\bobservations?\b/i,
  /\brelaxed to\b/i,
  /\battestation bar\b/i,
];

describe("realizer prose is jargon-free (reader-facing)", () => {
  const src = readFileSync(resolve("src/lib/compose/realizer.ts"), "utf8");
  // Strip comments (they legitimately discuss the internal terms) and keep code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Every template literal that becomes user prose, with interpolations removed.
  const templates = (code.match(/`[^`]*`/g) ?? []).map((t) => t.replace(/\$\{[^}]*\}/g, " "));

  it("no caveat rider uses banned statistical vocabulary", () => {
    const offenders: string[] = [];
    for (const t of templates) {
      for (const re of BANNED) {
        if (re.test(t)) offenders.push(`${re} → ${t.trim().slice(0, 70)}`);
      }
    }
    expect(offenders, `plain-language regression:\n${offenders.join("\n")}`).toEqual([]);
  });
});
