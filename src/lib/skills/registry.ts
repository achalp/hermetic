/**
 * Skill activation — the single entry point the pipeline calls once per run.
 * Evaluates triggers over built-in + user skills, closes over `requires`,
 * sorts by (order, name), and aggregates the per-surface outputs (guidance,
 * critic rules, failure hints).
 */
import { logger } from "@/lib/logger";
import type {
  ActivatedSkill,
  ActiveSkills,
  SkillDefinition,
  SkillRenderContext,
  SkillTriggerContext,
} from "./types";
import { evaluateSkill } from "./triggers";
import { geoOverture } from "./builtin/geo-overture";
import { planetScaleSuperlative } from "./builtin/planet-scale-superlative";
import { mapAnswerVisibility } from "./builtin/map-answer-visibility";
import { loadUserSkills } from "./user-skills";

export const BUILTIN_SKILLS: SkillDefinition[] = [
  geoOverture,
  planetScaleSuperlative,
  mapAnswerVisibility,
];

export interface ActivateOptions {
  /** Override the user-skills directory (tests). */
  userSkillsDir?: string;
  /** Skip user-skill loading entirely (pure built-in call sites). */
  builtinOnly?: boolean;
}

function renderGuidance(skills: ActivatedSkill[], ctx: SkillRenderContext): string {
  return skills
    .map((s) => s.def.buildGuidance(ctx))
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * Evaluate every known skill against the run context. Deterministic: the same
 * schema/question always yields the same skill set, so within a run every
 * attempt shares the same prompt prefix (cache-friendly).
 */
export function activateSkills(ctx: SkillTriggerContext, opts?: ActivateOptions): ActiveSkills {
  const defs = new Map<string, SkillDefinition>();
  for (const def of BUILTIN_SKILLS) defs.set(def.name, def);
  if (!opts?.builtinOnly) {
    for (const user of loadUserSkills(opts?.userSkillsDir).skills) {
      if (defs.has(user.name)) {
        logger.warn("User skill shadows a built-in — ignored", {
          skill: user.name,
          path: user.sourcePath,
        });
        continue;
      }
      defs.set(user.name, user);
    }
  }

  const active = new Map<string, ActivatedSkill>();
  for (const def of defs.values()) {
    const match = evaluateSkill(def, ctx);
    if (match) active.set(def.name, { def, reason: match.reason, viaQuestion: match.viaQuestion });
  }

  // `requires` closure: a required skill inherits the requirer's placement so
  // dependent guidance stays adjacent in the same prompt part.
  const queue = [...active.values()];
  while (queue.length) {
    const current = queue.pop()!;
    for (const name of current.def.requires ?? []) {
      if (active.has(name)) continue;
      const req = defs.get(name);
      if (!req) {
        logger.warn("Skill requires an unknown skill — ignored", {
          skill: current.def.name,
          requires: name,
        });
        continue;
      }
      const entry: ActivatedSkill = {
        def: req,
        reason: `required by "${current.def.name}"`,
        viaQuestion: current.viaQuestion,
      };
      active.set(name, entry);
      queue.push(entry);
    }
  }

  const ordered = [...active.values()].sort(
    (a, b) => a.def.order - b.def.order || a.def.name.localeCompare(b.def.name)
  );
  const prefixSkills = ordered.filter((s) => !s.viaQuestion);
  const questionSkills = ordered.filter((s) => s.viaQuestion);

  return {
    skills: ordered,
    reviewGated: ordered.some((s) => s.def.reviewGate),
    reviewRules: ordered.flatMap((s) => (s.def.reviewRules ? [s.def.reviewRules] : [])),
    failureHints: ordered.flatMap(
      (s) => s.def.failureHints?.map((h) => ({ ...h, skill: s.def.name })) ?? []
    ),
    prefixGuidance: (renderCtx) => renderGuidance(prefixSkills, renderCtx),
    questionGuidance: (renderCtx) => renderGuidance(questionSkills, renderCtx),
  };
}
