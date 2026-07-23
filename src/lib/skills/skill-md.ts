/**
 * SKILL.md parser — turns a user-authored markdown file into the same
 * `SkillDefinition` shape the built-ins implement. Strict where it protects
 * the run (zod frontmatter, regex compilation), lenient where it doesn't
 * (a missing `## Guidance` heading falls back to the whole body).
 *
 * Format:
 *
 *   ---
 *   name: cohort-retention
 *   description: Cohort/retention analyses use period-over-period pivots
 *   order: 1000                 # optional, default 1000
 *   triggers:                   # at least one of columns/question/sources/always
 *     columns: ["^signup_date$"]
 *     question: ["retention", "cohort"]
 *     sources: ["file"]
 *     always: false
 *   requires: []                # optional co-activations
 *   reviewGate: false           # optional: turn on the pre-execution critic
 *   reviewRules: |              # optional extra critic rules ("ID — when to flag")
 *     COHORT-PIVOT — flag when retention is computed row-wise in Python...
 *   failureHints:               # optional phase-keyed OOM remedies
 *     - pattern: "pivot"
 *       hint: "Aggregate the cohort matrix in DuckDB..."
 *   ---
 *   ## Guidance
 *   <text injected into the code-gen prompt; supports {{sandboxMemoryGb}} and {{filename}}>
 */
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { SkillDefinition, SkillRenderContext } from "./types";

const FrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "name must be kebab-case (a-z, 0-9, hyphens)"),
  description: z.string().min(1),
  order: z.number().int().min(0).default(1000),
  triggers: z
    .object({
      columns: z.array(z.string()).optional(),
      question: z.array(z.string().min(1)).optional(),
      sources: z.array(z.enum(["file", "warehouse"])).optional(),
      always: z.boolean().optional(),
    })
    .refine(
      (t) => !!(t.columns?.length || t.question?.length || t.sources?.length || t.always),
      "triggers must declare at least one of columns/question/sources/always"
    ),
  requires: z.array(z.string()).optional(),
  reviewGate: z.boolean().default(false),
  reviewRules: z.string().optional(),
  failureHints: z
    .array(z.object({ pattern: z.string().min(1), hint: z.string().min(1) }))
    .optional(),
});

/** Thrown with a human-readable, settings-page-worthy reason. */
export class SkillParseError extends Error {}

function renderPlaceholders(body: string, ctx: SkillRenderContext): string {
  return body
    .replaceAll("{{sandboxMemoryGb}}", ctx.sandboxMemoryGb ?? "unknown")
    .replaceAll("{{filename}}", ctx.schema.filename);
}

export function parseSkillMd(text: string, sourcePath: string): SkillDefinition {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fm) {
    throw new SkillParseError("missing YAML frontmatter (--- ... --- block at the top)");
  }

  let raw: unknown;
  try {
    raw = parseYaml(fm[1]);
  } catch (err) {
    throw new SkillParseError(
      `invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const parsed = FrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SkillParseError(
      `invalid frontmatter — ${issue.path.join(".") || "(root)"}: ${issue.message}`
    );
  }
  const meta = parsed.data;

  // Regexes must compile NOW (activation-time failures would be silent skips).
  for (const source of [
    ...(meta.triggers.columns ?? []),
    ...(meta.failureHints ?? []).map((h) => h.pattern),
  ]) {
    try {
      new RegExp(source, "i");
    } catch {
      throw new SkillParseError(`invalid regex in frontmatter: /${source}/`);
    }
  }

  // Guidance = the `## Guidance` section when present, else the whole body.
  const bodyText = fm[2].trim();
  const guidanceMatch = bodyText.match(/^## Guidance\s*\r?\n([\s\S]*?)(?=^## |\n*$(?![\s\S]))/m);
  const guidance = (guidanceMatch ? guidanceMatch[1] : bodyText).trim();
  if (!guidance) {
    throw new SkillParseError("skill has no guidance text (empty body)");
  }

  return {
    name: meta.name,
    description: meta.description,
    order: meta.order,
    origin: "user",
    sourcePath,
    triggers: meta.triggers,
    requires: meta.requires,
    reviewGate: meta.reviewGate,
    reviewRules: meta.reviewRules?.trim() || undefined,
    failureHints: meta.failureHints,
    buildGuidance: (ctx) => `\n## Skill: ${meta.name}\n${renderPlaceholders(guidance, ctx)}`,
  };
}
