# The Narrative Compiler: composition as compilation, editing as mutation

**Status: spec + review + implementation plan 2026-08-09; implementation
same day. Companion to analysis-product (the typed IR this compiles) and
regime-matrix (whose caveat fields it renders). Validated by the same
in-memory simulation (scratchpad/simulate-claims-compiler.py, Stages 3–5):
all eight recorded composer defects die by unrepresentability.**

## 0. Diagnosis

Every composer defect on record — fabricated mechanisms, hidden raws,
missing narrative, wrong-key bindings, unit words, duplicate/dropped tiles
— is a generative process emitting artifacts a type system would reject,
patched post-hoc by ~25 lints, repairs, and injections. The compiled
alternative: the dashboard is a **projection** `render(claims, plan,
overlay)`; the model's generative act shrinks to a five-line typed PLAN;
everything else is deterministic code whose exhaustiveness the TS compiler
proves (an unhandled claim type is a build error, not a run defect).

## 1. The three documents

**Claims** — the validated findings manifest + Analysis Product (exists).

**Plan** — a typed program of speech-acts, each referencing claims by name:

```
PlanNode = { id, op: ANSWER | SHAPE | PEAK | ENDPOINT | TREND | CONTRAST
                 | CAVEAT | NOTE | INSIGHT, refs: string[], text? }
Plan     = { nodes: PlanNode[] }
```

Validation (structural, pre-render): exactly one ANSWER (no-narrative is a
parse error); every ref resolves to a claim; CAVEAT refs must be checks
(dtype "check"/"screen") — a caveat can only render its check's own fields,
so a fabricated mechanism has NO SYNTAX; INSIGHT is the single tier-3 node
whose `text` is free prose (findings-bound, linted, audited — the one
quarantined generative surface).

**Overlay** — user layout preferences keyed by stable node/claim ids:
`{ order?: string[], hidden?: string[] }` (position/size follow when the
grid grows handles). Overlay survives recompiles and data refreshes by
identity: same claim names ⇒ same keys ⇒ durable customization.

## 2. The compiler (`src/lib/compose/`)

- `plan.ts` — types, zod schema, `validatePlan(plan, manifest)`.
- `realizer.ts` — `realizeNode(node, claims)`: one template family per
  claim dtype, exhaustive switch (default = generic template, never a
  throw at runtime; the exhaustiveness check is a compile-time union
  test). Sentences emit `$finding:` BINDINGS, not values — the existing
  finalizer resolves values and renders declared units, so the whole
  resolution/unit stack is reused. Raw-beside-attested and
  excluded_reason clauses are IN the templates: hiding them is
  unrepresentable.
- `scaffold.ts` — deterministic non-narrative layer: StatCards from the
  headline plan (exists), charts from series roles via the component
  signature map (exists; temporal/ordinal x ⇒ LineChart, categorical ⇒
  BarChart, screened measures charted with raw sibling), failed-check
  Annotations. Applies the overlay.
- `planner.ts` — the ONE LLM call: manifest projection + catalog in,
  `{plan, insight?}` JSON out (~hundreds of tokens; temperature 0;
  invalid plan → one retry with the validator's errors, then a
  deterministic default plan — the compiled pipeline CANNOT fail to
  produce a dashboard).
- `mutations.ts` — the edit grammar, ONE governed channel for UI, MCP,
  and LLM-assist alike: `move | hide | show | add_node | remove_node |
set_insight`. `applyMutations(doc, muts)` → new {plan, overlay},
  re-validated, recompiled. Humans get no path around the invariants
  either.

## 3. Wiring (all surfaces, no exclusion)

- **Mode**: `composer.mode: "generative" | "compiled"` in runtime-config
  (golden source; settings-editable). Default stays "generative" for one
  burn-in cycle — flipping the default is a config change, not a code
  change. Compiled mode REQUIRES a declared-series product; a legacy
  envelope falls back to generative (logged).
- **Ask** (`composeAndStreamDashboard`): mode=compiled → plan call →
  compile → stream the same patch protocol through the SAME finalizer
  (resolution, units, discourse checks on the insight text). Verifiability
  reports `composerMode`, the plan, and plan-validation results.
- **Investigate**: same compiler over the MERGED product/manifest
  (step-namespaced ids already align); compiled mode replaces
  composeInvestigation's dashboard call; notebook cells unaffected.
- **MCP**: analyze/analyze_start inherit the mode (same pipeline).
  New tools, library-first: `get_dashboard_plan(history_id)` and
  `edit_dashboard(history_id, mutations)` — recompile and persist, so
  conversational editing from Desktop is the identical code path as the
  future drag-drop UI.
- **Persistence**: `plan.json` joins the history record via RECORD_FILES
  (audit-record lesson: through the store, never a side file); artifacts
  cache carries `{plan, overlay}` for live mutation.
- **Web editing**: `/api/plan` GET/PATCH backed by mutations.ts. (Drag
  handles in the UI are a follow-up; the seam ships now.)

## 4. Principal-engineer review

1. **Biggest risk: prose quality regression.** Mitigations: templates
   carry variant phrasing; INSIGHT carries the synthesis; mode default
   stays generative until burn-in comparisons run. The sim's honest
   finding — compiled prose is flat but never wrong — is accepted as the
   trade until template libraries mature.
2. **Template bugs are code bugs** — the sim itself shipped a denominator
   bug in a template; golden-sentence tests per template are mandatory,
   and that bug class is unit-testable forever (the point).
3. **Two composers to maintain** — bounded: generative mode is frozen
   (no new lint development for defect classes the compiler makes
   unrepresentable); compiled is the investment path.
4. **Plan-call failure** — deterministic default plan (ANSWER on the
   question-primary claim + caveats for failed checks) guarantees output.
5. **Finalizer reuse** — realizer emits bindings, so mislabel-repair,
   unit rendering, sentinel refusal all still apply; the compiled path
   adds no second resolution stack.
6. **Editing identity** — claim names as keys survive re-runs; plan node
   ids are ULIDs persisted with the plan; overlay conflicts resolve
   overlay-wins (documented).

## 5. Implementation plan (both specs)

- **A (runtime)**: regimes.py (profiler, matrix, dispatchers) +
  write_output regime shipping + prelude parity + tests.
- **B (host libraries)**: contracts/plan.ts; compose/plan|realizer|
  scaffold|planner|mutations + unit tests (golden sentences, validation,
  mutation round-trips, exhaustiveness).
- **C (wiring)**: parse-output/artifacts/history plumbing for regimes +
  plan; composer mode in runtime-config + both pipelines + verifiability;
  /api/plan; MCP get_dashboard_plan/edit_dashboard.
- **D (tests e2e)**: fixture-envelope compile test (full spec from a
  recorded manifest), investigate merged-product compile test, mutation →
  recompile test, mode fallback test.

## 6. Principal-data-scientist review (post-plan)

1. The plan DSL cannot express a statistical claim — only reference one.
   Correct: the model never re-derives statistics at compose time, which
   is where sign/unit/mechanism fabrication lived.
2. INSIGHT is the residual risk surface; it inherits the full lint +
   grounding + audit battery, and its one-paragraph scope concentrates
   audit attention. Accepted.
3. Realizer templates must render uncertainty when present (slope_ci95)
   and NEVER round p-values to zero — carried from the codegen contract
   into the template tests.
4. Regime caveats (spec 1) surface in CAVEAT templates via check evidence
   fields — the two specs meet exactly here; no prose invents mechanisms.

## 10. Amendment (2026-08-09): purpose depth + the view catalog

The first style-aware review of compiled output found a compiled deep-dive
"leaner" than its generative counterpart. Root cause: the compiled path
never received the purpose dimension — the planner hard-coded "4-9 nodes"
for every style while codegen scaled the ANALYSIS to the style, so a deep
dive computed deep-dive-sized findings and told a dashboard-sized story;
and the scaffold collapsed each declared series to exactly one chart while
the generative composer could draw several views of the same data.

**Purpose threading.** `PLAN_BUDGETS` (plan.ts) is the compiled analog of
the style FORM prompt: brief 3-5 nodes, dashboard 4-9, report 8-14
(document-ordered), deep-dive 10-20 with an explicit coverage directive —
"an unnarrated finding is a coverage gap, not brevity."
`buildPlannerSystem(purpose)` carries the budget; `defaultPlan` fills to
it (caveats never cut for budget); both pipelines pass their run purpose;
`PlanDocument.purpose` records it so edit-path recompiles keep the depth.

**View catalog (views.ts).** A series' roles + regime profile derive a
FAMILY of candidate views, every one a pure projection of declared rows:
unit-split primaries (measures with different units never share a y axis
— ships for every style, the merged chart would be invalid), the coverage
companion (observations-per-period; FORCED whenever COUNT*SKEWED /
THIN_PERIODS / THIN_EDGE fired — it is the evidence behind every
attestation decision, and ships on deep-dive whenever a count role
exists), and the precision DataTable for report/deep-dive. Selection is
deterministic (purpose budget + regime flags); ids are stable derivations
(`chart*<sid>`, `chart*<sid>\_\_u<i>`, `chart*<sid>\__counts`,
`table_<sid>`) so overlays and mutations survive recompiles, and
unshipped views are still derived and reasoned — a future UI affordance
and Verify legibility. `CachedArtifacts.regimes` carries the profiles so
the edit path derives the same family live compose did.

**Deferred, by limitation not principle:** group-split and two-measure
scatter views — Line/Bar take flat wide-format data and the compiler does
not pivot rows. **Out of scope, by principle:** a visual over data the
model never declared cannot exist in compiled mode (emphasis, never
fabrication) — the closure is contract pressure ("every view you want
shipped is a declared series"), not compiler creativity.
