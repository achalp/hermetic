# Declared Checks: model-authored validation, executed as code

**Status: implemented 2026-08-07 (see §8). Companion to declared-findings (2026-08-06).**

## 0. Problem

Runs 8–21 produced a whack-a-mole of analytical-judgment bugs: grain choice,
comparison windows, step-vs-wave model form, outlier policy, invented
periodisation, join-vs-shortcut semantics. None were computation errors — the
arithmetic was right; the silent _assumption_ was wrong. Each was caught
post-hoc by a values-sighted reviewer and answered with a new rule/lint/helper.
Enumeration cannot win against an open decision space, and the product thesis
is the opposite of enumeration: tap the model's unbounded knowledge.

Declared-findings already solved this shape once for _conclusions_: the model
declares, code computes, output binds. This spec applies the same inversion to
_assumptions_: the model spends its domain knowledge generating **executable
checks**, code runs them, and every downstream surface can see, bind, and gate
on the results.

## 1. Design: checks ARE findings

A check is a finding **about the data or the analysis process** rather than
about the answer. It rides the existing findings channel end-to-end:

```python
declare_check("join_vs_shortcut_divergence",
    "totals computed via menu_item joins vs the dish lifetime shortcut differ by <2%",
    passed=bool(div_pct < 2), evidence={"divergence_pct": round(div_pct, 2)},
    severity="blocking")   # blocking | caveat (default "caveat")
```

`declare_check(name, definition, passed, evidence=None, severity="caveat",
derived_from_columns=None)` is sugar over `declare_finding` with:

- `dtype: "check"`, `tags: ["check", severity]`
- `value: {"passed": <bool|None>, **evidence}` (evidence keys are open
  vocabulary — the meta-schema stays content-free)

Consequences, all inherited free of new plumbing:

- validation/merge/caps: the findings meta-schema (open vocabulary, AST
  literal rule on definitions, size caps) applies verbatim;
- lineage: `derived_from_findings` lets a finding rest on a check —
  `derived_from_findings=["join_vs_shortcut_divergence"]` — and the existing
  DAG/derivation lints extend to check gating;
- binding: the composer binds `$finding:<check>.passed`/`.divergence_pct`;
- persistence/UI/MCP: sidecar, artifacts cache, findings tab, analyze caps —
  all existing surfaces carry checks with zero schema change;
- investigate: per-step namespacing (`step_N.<check>`) works unchanged.

Hermetic owns the grammar and enforcement; the model owns the vocabulary.
No hermetic-side enumeration of check types, ever — that is the point.

## 2. Contract (codegen prompt)

Before computing findings, generated code MUST interrogate the data with
checks _it derives from domain knowledge of this dataset and question_:
completeness/coverage stability, magnitude plausibility for the domain and
era, key hierarchy/grain, join-vs-shortcut agreement, window comparability,
model-form appropriateness. Checks compute real evidence — never
`passed=True` by assertion. Every semantic DECISION the code makes (grain
level, window, model form, outlier policy, periodisation) must be validated
by a named check, and findings resting on a decision declare the check in
`derived_from_findings`. Failed blocking checks: dependent findings are
still declared but must carry the lineage so the platform can gate them.

## 3. Enforcement (deterministic tier)

- **Review gate (meta-rule, replaces future rule accretion):** CHECK-COVERAGE
  — flag code whose semantic decisions have no validating check, and checks
  whose code does not actually test what the definition claims. Existing
  enumerated rules stay as the floor; new decision classes need no new rules.
- **lintCheckGating:** a finding derived from a FAILED check → advisory
  (`rests_on_failed_check`); a failed `blocking` check with no dependent
  caveat → advisory. Wired into ask + investigate beside existing lints.
- **Composer:** failed checks produce a MANDATORY caveat section (same
  mechanism as the completeness section); the projection shows checks with
  pass/fail (booleans are safe for a values-blind composer; evidence values
  are scrubbed like all finding values).
- **Traceability:** checks appear in the findings manifest (artifacts cache,
  history, diagnostics `findings` event), the Findings tab (grouped under
  "Data checks"), grounding advisories, and MCP analyze output — the same
  single channel end-to-end.

## 4. Principal data scientist review

1. **Self-graded checks** — a model writing `passed=True` without computing
   is the biggest risk. Resolution: review-gate CHECK-COVERAGE audits that
   evidence is computed (same literal-definitions-beside-code audit as
   findings); `passed` without evidence keys is lint-flagged (weak_check).
2. **Check inflation** — 30 trivial checks drown 2 real ones. Resolution:
   manifest caps already bound totals; the contract says checks validate
   DECISIONS, not restate dtypes; projection budget prioritizes tagged
   entries (checks are tagged) so real ones survive truncation.
3. **False confidence from passing checks** — a green suite of weak checks
   reads as validation. Resolution: composer rule — passing checks are not
   narrated as blanket assurance; only failed/gated state is narrative-worthy.
4. **Statistical validity of model-authored tests** — the model may write a
   degenerate test (the coverage-correlation bug). Resolution: DEGENERATE-STAT
   review rule stays as floor; checks make the test _inspectable_, which is
   the improvement — a silent bad judgment becomes a visible bad check.
5. **Severity semantics** — "blocking" must not kill runs (posture: nothing
   fails a run). Resolution: blocking = gates _narrative confidence_
   (advisory + mandatory caveat), never execution. Correct for a tool whose
   contract is "never silently wrong", not "never wrong".

## 5. Principal engineer review

1. **Why not a separate channel?** A parallel checks pipeline duplicates
   validation, caps, projection, persistence, namespacing, UI, and MCP —
   seven surfaces of drift risk. Reusing findings costs one reserved dtype
   and two tags; the meta-schema stays content-free (dtype "check" is
   structural, not vocabulary — same class as the manifest_version field).
2. **Contract stability** — `declare_check` signature is additive; envelope
   unchanged; zero migration for pre-check runs (checks simply absent).
3. **Fallback parity** — prelude stub mirrors the sugar (no-op registry
   write) so runtime-package failure degrades exactly like findings.
4. **Ordering** — checks declared adjacent to the decision they validate
   (same adjacency rule as findings); last-wins merge already handles
   re-declaration after repair loops.
5. **Cost** — checks add code-gen output tokens only; no new LLM calls.
   Review-gate meta-rule replaces rule-list growth (net prompt shrink over
   time).
6. **Testability** — sugar is pure registry manipulation (unit-testable
   without pandas); lints are pure; composer section is string assembly.

## 6. Skills & helpers extension surface

- Skills contribute check _suggestions_ via the existing prompt-fragment
  seams (question/schema-triggered guidance) — e.g. a geo skill suggesting
  CRS/bounds checks — without any registry changes.
- `hermetic_runtime` helpers remain a library ("a library, not a menu"):
  helper outputs feed check evidence (e.g. `finding_yoy(...)` windows into a
  window-comparability check).

## 7. Out of scope (recorded)

- Values-sighted post-run audit phase (separate opt-in feature).
- Server-side re-execution of check predicates (checks run in-sandbox only).
- UI check-management (muting/pinning) — future.

## 8. Implementation record (2026-08-07)

- `docker/sandbox/hermetic_runtime/checks.py`: `declare_check` sugar →
  findings registry; prelude fallback stub; exported from package root.
- `src/lib/findings/lints.ts`: `lintCheckGating` (+ weak-check detection).
- Codegen contract block (§2) in `src/lib/llm/prompts.ts`; review-gate
  CHECK-COVERAGE meta-rule in `src/lib/pipeline/code-review.ts`.
- Composer: failed-check mandatory caveat section + no-blanket-assurance
  rule (`dashboard-compose.ts`, `prompt-fragments.ts`); investigate inherits
  via the shared findings channel.
- UI: Findings tab groups `dtype === "check"` entries under "Data checks".
- Tests: Python (sugar + registry), lints, compose section.
