/**
 * Skill activation observability — one call, three sinks, per run:
 *  - console: a single INFO line naming every active skill and why
 *  - journal: diagEvent("skills_activated") in the diagnostics JSONL +
 *    recordRunEvent in the run recorder's events stream
 *  - run dir:  data/runs/<id>/skills.json — the full activation record a
 *    post-mortem reads first (which skills shaped this run's prompts/review)
 *
 * The anonymous-count lesson from the sweeper post-mortem applies here too:
 * always log NAMES, never just counts.
 */
import { logger } from "@/lib/logger";
import { diagEvent } from "@/lib/diagnostics/run-diagnostics";
import { recordRunArtifact, recordRunEvent } from "@/lib/diagnostics/run-recorder";
import type { ActiveSkills } from "./types";

export function reportSkillActivation(active: ActiveSkills): void {
  if (active.skills.length === 0) {
    logger.debug("Skills: none matched");
    return;
  }

  const names = active.skills.map((s) => s.def.name);
  const reasons = Object.fromEntries(active.skills.map((s) => [s.def.name, s.reason]));
  logger.info("Skills activated", {
    skills: names,
    reasons,
    reviewGated: active.reviewGated,
    extraReviewRules: active.reviewRules.length,
    failureHints: active.failureHints.length,
  });
  diagEvent("skills_activated", { skills: names, reasons, reviewGated: active.reviewGated });
  recordRunEvent({ type: "skills_activated", skills: names, reviewGated: active.reviewGated });
  recordRunArtifact(
    "skills.json",
    JSON.stringify(
      {
        skills: active.skills.map((s) => ({
          name: s.def.name,
          origin: s.def.origin,
          order: s.def.order,
          reason: s.reason,
          viaQuestion: s.viaQuestion,
          sourcePath: s.def.sourcePath,
        })),
        reviewGated: active.reviewGated,
        extraReviewRules: active.reviewRules.length,
        failureHints: active.failureHints.map((h) => ({ skill: h.skill, pattern: h.pattern })),
      },
      null,
      2
    )
  );
}
