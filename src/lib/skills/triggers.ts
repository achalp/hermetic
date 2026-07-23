/**
 * Trigger evaluation — pure functions from (skill, context) to an activation
 * reason. Returning a human-readable reason (not a boolean) is deliberate: the
 * reason flows to the console log, the diagnostics journal, and skills.json so
 * a run can always answer "why did/didn't this skill fire".
 */
import type { SkillDefinition, SkillTriggerContext } from "./types";

/**
 * Shared built-in predicate: data has a real geometry column and no GeoJSON
 * sidecar (the GeoJSON path carries its own guidance). Mirrors the gate the
 * geo monolith used, so the split preserves activation behavior exactly.
 */
export function hasBareGeometryColumn(ctx: SkillTriggerContext): boolean {
  return (
    !ctx.schema.has_geojson &&
    ctx.schema.columns.some((c) =>
      /^(geometry|geom|the_geom|wkb_geometry|geog|shape)$/i.test(c.name)
    )
  );
}

export interface TriggerMatch {
  reason: string;
  viaQuestion: boolean;
}

/**
 * Evaluate one skill against the run context. Fields of the trigger spec are
 * OR'd; the first match wins and names itself. Schema-based matches take
 * precedence over question matches so a skill that matches both is treated as
 * cache-prefix-safe (see ActivatedSkill.viaQuestion).
 */
export function evaluateSkill(def: SkillDefinition, ctx: SkillTriggerContext): TriggerMatch | null {
  const t = def.triggers;

  if (t.always) {
    return { reason: t.label ?? "always active", viaQuestion: false };
  }

  if (t.when?.(ctx)) {
    return { reason: t.label ?? "predicate matched", viaQuestion: false };
  }

  if (t.columns?.length) {
    for (const source of t.columns) {
      let re: RegExp;
      try {
        re = new RegExp(source, "i");
      } catch {
        continue; // invalid patterns are rejected at parse time; belt-and-suspenders
      }
      const hit = ctx.schema.columns.find((c) => re.test(c.name));
      if (hit) return { reason: `column "${hit.name}" matched /${source}/i`, viaQuestion: false };
    }
  }

  if (t.sources?.length) {
    const source = ctx.schema.source_type ?? "file";
    if (t.sources.includes(source)) {
      return { reason: `data source is "${source}"`, viaQuestion: false };
    }
  }

  if (t.question?.length && ctx.question) {
    const q = ctx.question.toLowerCase();
    const hit = t.question.find((kw) => q.includes(kw.toLowerCase()));
    if (hit) return { reason: `question contains "${hit}"`, viaQuestion: true };
  }

  return null;
}
