/**
 * Skill registry contracts — a skill bundles the four surfaces that previously
 * lived in four unrelated places: code-gen prompt guidance (llm/prompts.ts
 * monolith), pre-execution review rules (pipeline/code-review.ts), failure-time
 * retry hints (sandbox/parse-output.ts), and — later phases — preloaded Python
 * helpers. Built-in skills are TS modules; user skills are parsed from
 * data/skills/<name>/SKILL.md into the same shape, so everything downstream of
 * `activateSkills` is origin-agnostic.
 */
import type { CSVSchema } from "@/lib/types";

/** Inputs available when deciding whether a skill applies to a run. */
export interface SkillTriggerContext {
  schema: CSVSchema;
  /** The user question — absent on schema-only call sites (cached prompt prefix). */
  question?: string;
}

/** Inputs available when rendering a skill's guidance text. */
export interface SkillRenderContext {
  schema: CSVSchema;
  /** Container memory cap label (e.g. "4.6"), null/undefined when unknown. */
  sandboxMemoryGb?: string | null;
}

/**
 * Declarative activation conditions. A skill activates when ANY declared
 * condition matches (fields are OR'd); `requires` closure can also pull it in.
 */
export interface SkillTriggerSpec {
  /** Regex sources matched (case-insensitive) against column names. */
  columns?: string[];
  /** Case-insensitive substrings matched against the user question. */
  question?: string[];
  /** Data source kinds this skill applies to. */
  sources?: ("file" | "warehouse")[];
  /** Unconditional activation (used with `label`). */
  always?: boolean;
  /** Code escape hatch for built-ins (predicates markdown can't express). */
  when?: (ctx: SkillTriggerContext) => boolean;
  /** Human-readable reason reported when `when`/`always` fires. */
  label?: string;
}

/** A file shipped into the sandbox (structurally = sandbox AdditionalFile). */
export interface SkillFile {
  path: string;
  content: string;
}

/** A Python helper module a skill ships to /data/skill_lib/<module>.py. */
export interface SkillHelperModule {
  /** Python module name (snake_case, no .py) — imported as skill_lib.<module>. */
  moduleName: string;
  content: string;
}

/** A phase-keyed remedy merged into the sandbox OOM-failure router. */
export interface SkillFailureHint {
  /** Case-insensitive regex source matched against the failing progress phase
   *  ("" when a hard kill left no heartbeat — use pattern `^` to catch that). */
  pattern: string;
  /** Remedy text injected verbatim into the retry error message. */
  hint: string;
  /** Owning skill name — logged when the hint fires. */
  skill: string;
  /**
   * Matched only for a BARE hard kill — never over a watchdog-predicted abort,
   * whose own message carries the right guidance. For catch-all (`^`) hints.
   */
  fallback?: boolean;
}

export interface SkillDefinition {
  /** Kebab-case unique id. User skills colliding with a built-in are rejected. */
  name: string;
  description: string;
  /** Emission order for guidance concatenation (built-ins 10/20/30, user default 1000). */
  order: number;
  origin: "builtin" | "user";
  /** SKILL.md path for user skills (diagnostics). */
  sourcePath?: string;
  triggers: SkillTriggerSpec;
  /** Names of skills to co-activate (missing names warn and are ignored). */
  requires?: string[];
  /** Guidance text for the code-gen prompt; "" contributes nothing. */
  buildGuidance(ctx: SkillRenderContext): string;
  /**
   * Extra RULES lines for the pre-execution critic, appended to the built-in
   * rule list verbatim (same "ID — when to flag" format).
   */
  reviewRules?: string;
  /** Activates the pre-execution review gate when this skill is active. */
  reviewGate?: boolean;
  failureHints?: Omit<SkillFailureHint, "skill">[];
  /**
   * Python helper modules shipped with the run when this skill is active.
   * Guards as functions instead of prose — the registry auto-appends an
   * import advertisement (module + signatures) to the skill's guidance.
   */
  helpers?: SkillHelperModule[];
  /**
   * Python fragment prepended to the generated code (AFTER the prelude) when
   * this skill is active — for wiring the shared runtime to the skill's
   * domain (e.g. planet-scale registers its strategy hint on the memory
   * guards). Must be side-effect-safe: wrap in try/except so a missing
   * runtime package degrades instead of killing the run.
   */
  preludeSnippet?: string;
}

/** One activated skill with the reason and placement it activated under. */
export interface ActivatedSkill {
  def: SkillDefinition;
  /** Human-readable activation reason (for logs/journal). */
  reason: string;
  /**
   * True when activation came from a question trigger (or a requirer that did).
   * Question-triggered guidance is injected in the un-cached question tail, not
   * the cached schema-block prefix — see the implementation plan.
   */
  viaQuestion: boolean;
}

/** The aggregated result of trigger evaluation for one run. */
export interface ActiveSkills {
  skills: ActivatedSkill[];
  /** True when any active skill requests the pre-execution review gate. */
  reviewGated: boolean;
  /** Aggregated extra critic rules, activation order. */
  reviewRules: string[];
  /** Aggregated failure hints, activation order, tagged with the owning skill. */
  failureHints: SkillFailureHint[];
  /** Active skills' helper modules as sandbox files (/data/skill_lib/...). */
  helperFiles: SkillFile[];
  /** Active skills' prelude fragments, activation order (run before user code). */
  preludeSnippets: string[];
  /** Guidance from schema/source-triggered skills (cache-prefix-safe). */
  prefixGuidance(ctx: SkillRenderContext): string;
  /** Guidance from question-triggered skills (un-cached tail). */
  questionGuidance(ctx: SkillRenderContext): string;
}
