/**
 * Per-dataset analysis conventions (run-27 root cause, 2026-08-07).
 *
 * Every run re-decided every convention from scratch: the median-as-headline
 * judgment (the session's best call) vanished on a re-run, the zero-handling
 * and year-set conventions drifted, and the "same" slope came out 0.0684 vs
 * 0.1251 on identical data. Judgment that isn't persisted is re-rolled.
 *
 * After a successful run, the declared CHECKS (the reified policy decisions)
 * are persisted keyed by the dataset's column fingerprint; the next run on
 * the same shape receives them as established conventions — keep unless the
 * data contradicts, and changing one requires a declared check justifying
 * the change. Hermetic stores and injects; the CONTENT stays model-authored
 * (same grammar-vs-vocabulary split as declared-checks).
 */
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { hermeticPaths } from "@/lib/paths";
import type { FindingEntry } from "@/lib/contracts/findings";
import { logger } from "@/lib/logger";

export interface StoredConvention {
  name: string;
  definition: string;
  passed: boolean | null;
  firstSeen: number;
  lastSeen: number;
  seenCount: number;
  /** Save-counter stamp of the last run that re-declared this convention. */
  lastSave: number;
}

interface ConventionRecord {
  savedAt: number;
  saveCount: number;
  question?: string;
  conventions: StoredConvention[];
}

/** A convention unseen for this many saves is stale and evicted — wrong
 *  conventions the model stops re-declaring fade instead of persisting. */
const STALE_AFTER_SAVES = 5;

function fingerprint(columns: string[]): string {
  return createHash("sha256")
    .update([...columns].sort().join(" "))
    .digest("hex")
    .slice(0, 16);
}

function fileFor(columns: string[]): string {
  return join(hermeticPaths.learningDir(), "conventions", `${fingerprint(columns)}.json`);
}

function loadRecord(columns: string[]): ConventionRecord | null {
  try {
    return JSON.parse(readFileSync(fileFor(columns), "utf-8")) as ConventionRecord;
  } catch {
    return null;
  }
}

/**
 * Merge a successful run's checks into the dataset's conventions.
 *
 * NOT last-write-wins — that would let one regression run overwrite every
 * settled judgment (observed: a mean-headline run replacing the prior
 * median-headline conventions). Rules:
 *  - a re-declared name refreshes (KEEP path) and bumps seenCount;
 *  - a `convention_change_<target>` check REPLACES the target — change is
 *    possible, but only through the explicit justification protocol;
 *  - new names append;
 *  - names unseen for STALE_AFTER_SAVES saves are evicted (decay);
 *  - a DEGRADED run (runtime fallback, findings collapse) writes NOTHING —
 *    quality-gated at the call site via `degraded`.
 */
export function saveConventions(
  columns: string[],
  findings: FindingEntry[],
  question?: string,
  opts: { degraded?: boolean } = {}
): void {
  try {
    if (opts.degraded) return;
    const now = Date.now();
    const incoming = findings
      .filter((f) => f.dtype === "check")
      .map((f) => ({
        name: f.name,
        definition: f.definition,
        passed:
          f.value !== null &&
          typeof f.value === "object" &&
          typeof (f.value as Record<string, unknown>).passed === "boolean"
            ? ((f.value as Record<string, unknown>).passed as boolean)
            : null,
      }));
    if (incoming.length === 0) return;

    const prior = loadRecord(columns);
    const saveCount = (prior?.saveCount ?? 0) + 1;
    const merged = new Map<string, StoredConvention>();
    for (const c of prior?.conventions ?? []) merged.set(c.name, c);

    for (const inc of incoming) {
      const changeTarget = /^convention_change_(.+)$/.exec(inc.name)?.[1];
      if (changeTarget) merged.delete(changeTarget);
      const existing = merged.get(inc.name);
      merged.set(inc.name, {
        name: inc.name,
        definition: inc.definition,
        passed: inc.passed,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now,
        seenCount: (existing?.seenCount ?? 0) + 1,
        lastSave: saveCount,
      });
    }
    // Decay: a convention no run has re-declared for STALE_AFTER_SAVES saves
    // is evicted — wrong conventions the model stops re-declaring fade.
    const kept = [...merged.values()].filter(
      (con) => saveCount - (con.lastSave ?? saveCount) < STALE_AFTER_SAVES
    );

    const path = fileFor(columns);
    mkdirSync(join(hermeticPaths.learningDir(), "conventions"), { recursive: true });
    const record: ConventionRecord = { savedAt: now, saveCount, question, conventions: kept };
    writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
  } catch (err) {
    logger.debug("saveConventions failed (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Prompt block of previously-settled conventions for this dataset shape. */
export function conventionsGuidance(columns: string[]): string | null {
  try {
    const record = loadRecord(columns);
    if (!record?.conventions?.length) return null;
    const lines = record.conventions.map(
      (c) => `- ${c.name}${c.passed === false ? " (FAILED last run)" : ""}: ${c.definition}`
    );
    return `## Established Conventions (prior runs of THIS dataset)
Previous analysis of this dataset settled the policies below as declared checks. These are DEFAULTS, not truths: KEEP each one — re-declare the same check — when the data still supports it; when a convention produces a worse answer or the data contradicts it, you MUST change it by declaring a check named convention_change_<name> whose computed evidence justifies the new policy (it replaces the old one). Conventions exist so the headline metric, zero-handling, outlier threshold, endpoint, and window rules do not drift between runs of the same data:
${lines.join("\n")}`;
  } catch {
    return null;
  }
}

export interface ConventionListing {
  fingerprint: string;
  savedAt: number;
  saveCount: number;
  question?: string;
  conventions: StoredConvention[];
}

/** All stored convention records, newest first — the Learning page's view. */
export function listConventionRecords(): ConventionListing[] {
  try {
    const dir = join(hermeticPaths.learningDir(), "conventions");
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const rec = JSON.parse(readFileSync(join(dir, f), "utf-8")) as ConventionRecord;
        return { fingerprint: f.replace(/\.json$/, ""), ...rec };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** Manual curation: drop a dataset's conventions entirely (Learning page). */
export function deleteConventionRecord(fp: string): boolean {
  try {
    if (!/^[a-f0-9]{16}$/.test(fp)) return false;
    unlinkSync(join(hermeticPaths.learningDir(), "conventions", `${fp}.json`));
    return true;
  } catch {
    return false;
  }
}
