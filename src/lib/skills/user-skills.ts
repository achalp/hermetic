/**
 * User skill loading — data/skills/<name>/SKILL.md, synchronous (it runs
 * inside prompt assembly) and mtime-cached so the per-run cost is a stat per
 * skill directory. Never throws: an unreadable dir means no user skills, an
 * invalid skill is skipped, warned about ONCE per file version, and reported
 * in the return value so callers can surface it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { logger } from "@/lib/logger";
import { diagEvent } from "@/lib/diagnostics/run-diagnostics";
import type { SkillDefinition } from "./types";
import { parseSkillMd, SkillParseError } from "./skill-md";

export interface UserSkillLoadResult {
  skills: SkillDefinition[];
  errors: { path: string; reason: string }[];
}

export function defaultUserSkillsDir(): string {
  return path.join(process.cwd(), "data", "skills");
}

interface CacheEntry {
  mtimeMs: number;
  skill: SkillDefinition | null; // null = invalid at this mtime
  reason?: string;
}

// Keyed by SKILL.md path. Module-level is fine here (worst case after an HMR
// split: a redundant re-parse), unlike liveness registries where split-brain
// kills runs — see run-control.ts.
const cache = new Map<string, CacheEntry>();

/** Test-only: reset the mtime cache. */
export function resetUserSkillCacheForTests(): void {
  cache.clear();
}

export function loadUserSkills(dir: string = defaultUserSkillsDir()): UserSkillLoadResult {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name, "SKILL.md"));
  } catch {
    return { skills: [], errors: [] }; // no user skills dir — the common case
  }

  const skills: SkillDefinition[] = [];
  const errors: UserSkillLoadResult["errors"] = [];
  for (const file of entries) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue; // skill dir without a SKILL.md — not an error, just not a skill
    }

    const cached = cache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      if (cached.skill) skills.push(cached.skill);
      else if (cached.reason) errors.push({ path: file, reason: cached.reason });
      continue;
    }

    try {
      const skill = parseSkillMd(readFileSync(file, "utf8"), file);
      cache.set(file, { mtimeMs, skill });
      skills.push(skill);
      logger.info("User skill loaded", { skill: skill.name, path: file });
    } catch (err) {
      const reason =
        err instanceof SkillParseError
          ? err.message
          : `unreadable: ${err instanceof Error ? err.message : String(err)}`;
      cache.set(file, { mtimeMs, skill: null, reason });
      errors.push({ path: file, reason });
      // Warn once per file version (the cache suppresses repeats until an edit).
      logger.warn("User skill rejected", { path: file, reason });
      diagEvent("user_skill_invalid", { path: file, reason });
    }
  }
  return { skills, errors };
}
