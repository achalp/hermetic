# Skills Registry — Implementation Plan (Milestone A)

**Date:** 2026-07-22 · **Branch:** `skills-registry`
**Implements:** Phase 1 of `specs/skills-and-custom-modules-2026-07-22.md` plus the
user-skill surface of Phase 4. Phases 2–3 (the `hermetic` sandbox package and
per-skill `helpers.py`) are follow-ups on this branch, not in this milestone.

**STATUS UPDATE (later on 2026-07-22): ALL PHASES IMPLEMENTED** on this branch:

- Phase 2 (commit `80ebf42`): `hermetic_runtime` package — shipped PER-RUN as
  /data/hermetic_runtime/ (not baked into the image: no rebuild coupling, no
  version skew), prelude imports + overrides its inline copies (fallback kept
  one release, path observable via the `runtime_pkg` progress field), stdlib
  unittest suite runs from vitest when python3 exists, "Also preloaded" system
  prompt line GENERATED from docstrings (closes the "preloaded wording" TODO).
- Phase 3 (commit `e3d9b10`): per-skill helpers.py → /data/skill_lib/, auto-
  advertised imports (signatures extracted from source), built-in planet-scale
  helper (occ_aware_ub / chebyshev_k / scalar_nn_sql), user skills ship a
  sibling helpers.py (combined mtime cache). Equivalence snapshots updated
  KNOWINGLY for the one helper-ad extension.
- Phase 4 (commit `f2f71ff`): data/user_lib/\*.py user modules — load-time
  import validation (stdlib + image-package manifest, spec §4.5), cached-prefix
  prompt advertisement, "user-config" errorKind fast-fail backstop for missing
  packages at run time, GET /api/skills settings surface (skills + modules +
  per-file validation errors). Deliberately NOT built: a settings UI page (no
  settings page exists to extend — /api/skills is the surface), the optional
  Haiku trigger classifier, per-skill cost telemetry.
- The Investigate path needs no separate wiring — it delegates every
  sub-question to `runPipeline`, which carries all skill surfaces.
- Still open (not code): audit the "OBSERVED" scan-buffer-OOM lore in the
  planet-scale skill body against a clean post-sweeper-fix run.

## Scope decisions (deltas from the design spec)

1. **Built-in skills are TypeScript modules, not SKILL.md files.** The geo
   monolith contains live interpolations (`${sandboxMemoryGb}`, the conditional
   bbox tip) that a markdown body can't express without inventing a template
   engine. Built-ins implement the same `SkillDefinition` interface user skills
   are parsed into; migrating them to markdown becomes possible once a
   placeholder renderer exists, and nothing downstream can tell the difference.
2. **Emission order is an explicit `order` field, not alphabetical.** Exact
   text-equivalence with the monolith requires the original section order
   (geo=10, planet=20, map=30); user skills default to 1000+.
3. **Skills add critic rules; they don't replace them.** The review gate's rule
   list (`buildReviewSystemPrompt`) is already self-contained and battle-tested;
   active skills contribute `reviewRules` appended to it (built-ins contribute
   none, so the critic prompt is byte-identical for today's runs).
4. **Question-triggered guidance stays out of the cached schema block.** The
   schema block is the per-dataset prompt-cache prefix; question-triggered
   skills inject via the un-cached tail (initial codegen extra + retry system
   extra + review), so cache economics are unchanged.
5. **Built-in failure hints stay in `parse-output.ts`.** Skills contribute
   _additional_ hints, matched first. Migrating the built-in constants into the
   geo skills is deferred with Phase 2.

## Module layout (`src/lib/skills/`)

| File                                  | Responsibility                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                            | `SkillDefinition`, `SkillTriggerSpec`, trigger/render contexts, `ActiveSkills`, `SkillFailureHint` — no logic, imported by everything                                        |
| `triggers.ts`                         | `evaluateSkill(def, ctx)` → activation reason string or null. Pure.                                                                                                          |
| `builtin/geo-overture.ts`             | Monolith §1: spatial basics, bbox-first, two-phase boundary, f-string traps (incl. conditional bbox tip)                                                                     |
| `builtin/planet-scale-superlative.ts` | Monolith §2: KD-tree routing, canonical skeleton, ENGINE-FIRST, PLANET-SCALE counting recipe (requires geo-overture)                                                         |
| `builtin/map-answer-visibility.ts`    | Monolith §3: map-must-show-answer + scope disclosure                                                                                                                         |
| `skill-md.ts`                         | `parseSkillMd(text, path)` → `SkillDefinition` (yaml frontmatter + `## Guidance` body, zod-validated, `{{sandboxMemoryGb}}`/`{{filename}}` substitution)                     |
| `user-skills.ts`                      | `loadUserSkills(dir)` — reads `data/skills/*/SKILL.md`, mtime-cached, per-file validation errors logged (warn) and reported, never throws                                    |
| `registry.ts`                         | `activateSkills(ctx)` — evaluate triggers over builtins+user skills, `requires` closure, order sort, split prefix-safe vs question-triggered, aggregate guidance/rules/hints |
| `observability.ts`                    | `reportSkillActivation(active)` — one logger.info + `diagEvent("skills_activated")` + `recordRunEvent` + `recordRunArtifact("skills.json")`                                  |
| `index.ts`                            | Public re-exports                                                                                                                                                            |

## Wiring (existing files)

| File                       | Change                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm/prompts.ts`           | `buildGeospatialGuidance()` body moves to the three builtins; the function stays exported with the same signature as a thin delegate (schema-triggered skills only) so the cached schema block and its call sites are untouched    |
| `llm/code-generation.ts`   | `generateAnalysisCode` gains optional `extraGuidance` appended to the un-cached question tail (question-triggered skills)                                                                                                          |
| `pipeline/orchestrator.ts` | `activateSkills({schema, question})` once per run → `reportSkillActivation`, `setRunFailureHints`, `reviewEnabled = active.reviewGated`, `retrySystemExtra()` renders from the active set, review call passes `active.reviewRules` |
| `pipeline/code-review.ts`  | `reviewGeneratedCode(..., extraRules?)` — appended to the RULES section                                                                                                                                                            |
| `pipeline/run-control.ts`  | `failureHints` on `RunControl` + `setRunFailureHints`/`getRunFailureHints` (ALS-keyed, cleaned by `endRun`; map lives on the existing globalThis struct — split-brain-proof)                                                       |
| `sandbox/parse-output.ts`  | `skillFailureHints` opt matched before built-in phase hints; logs which skill's hint fired; `execDiag` records `hint=skill:<name>`                                                                                                 |
| `sandbox/docker-utils.ts`  | `parseExecutionOutput` fetches hints via `getRunFailureHints()`                                                                                                                                                                    |

## Equivalence guarantee

`__tests__/equivalence.test.ts` snapshots `buildGeospatialGuidance()` output for
five schema shapes (geometry+bbox+memGb, geometry-only no memGb, no geometry,
has*geojson, geometry+geojson) **before** the refactor (snapshots committed from
the pre-refactor implementation); the refactored delegate must reproduce them
byte-for-byte. The builtin bodies are extracted from the monolith
\_programmatically* (source-slice at section markers), not retyped.

## Test coverage by surface

| Surface                                                                                  | Test                                                        |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Trigger evaluation (columns/question/sources/always/when, no-match)                      | `skills/__tests__/triggers.test.ts`                         |
| Activation: requires-closure, dedupe, order sort, prefix/question split, aggregation     | `skills/__tests__/activation.test.ts`                       |
| SKILL.md parsing: valid, missing fields, bad yaml, bad regex, placeholder rendering      | `skills/__tests__/skill-md.test.ts`                         |
| User dir loading: absent dir, valid skill, invalid skill (skipped+reported), mtime cache | `skills/__tests__/user-skills.test.ts`                      |
| Monolith split correctness                                                               | `skills/__tests__/equivalence.test.ts` (snapshots)          |
| Activation observability payloads                                                        | `skills/__tests__/observability.test.ts`                    |
| Failure-hint registry lifecycle (set/get/end-cleanup, ALS-scoped)                        | `pipeline/__tests__/run-control.test.ts` (extended)         |
| Skill hints win over built-in phase hints; logged                                        | `sandbox/__tests__/parse-output.test.ts` (extended)         |
| Critic prompt gains extra rules verbatim                                                 | `pipeline/__tests__/code-review.test.ts` (extended)         |
| Schema block still embeds geo guidance                                                   | `llm/__tests__/prompts.test.ts` (existing, must stay green) |

## Observability (console = logger, journal = diagEvent JSONL + run recorder)

| Event                     | Console                                          | Journal / run dir                                                                                                                                  |
| ------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation (once per run) | `INFO Skills activated {skills, reasons}`        | `diagEvent("skills_activated")` + `recordRunEvent` + `data/runs/<id>/skills.json` (name, origin, order, reason, reviewGated, ruleCount, hintCount) |
| No skills active          | `DEBUG Skills: none matched`                     | — (absence is visible in skills.json not being written)                                                                                            |
| User skill loaded         | `INFO User skills loaded {count, names}`         | included in skills.json `origin:"user"`                                                                                                            |
| User skill invalid        | `WARN User skill rejected {path, reason}`        | `diagEvent("user_skill_invalid")`                                                                                                                  |
| Skill failure hint fired  | `INFO Skill failure hint applied {skill, phase}` | `hint=skill:<name>` line in `attempt-NN.diag.txt`                                                                                                  |

## Commit plan

1. `Skills registry: types, triggers, builtins split from the geo monolith` —
   lib + equivalence snapshots + unit tests (prompts.ts delegate included so
   the tree never holds two copies of the text).
2. `Wire skills through codegen, retry, review gate, and failure hints` —
   orchestrator/code-review/run-control/parse-output/docker-utils + tests.
3. `User skills: SKILL.md loader (data/skills) + observability` — parser,
   loader, observability module, yaml dep, docs.

Gate for every commit: `tsc --noEmit` clean + full vitest suite green.
