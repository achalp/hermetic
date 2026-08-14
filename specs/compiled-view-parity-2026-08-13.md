# Compiled view parity: every component, licensed

**Status:** reviewed (principal pass §8, dispositions §9) — ready for P1
**Date:** 2026-08-13
**Prior art:** narrative-compiler-2026-08-09.md (plan grammar, compile, salvage),
finding-field-roles-2026-08-13.md (declare the property, not the taxonomy;
closed-vocabulary exhaustiveness), analysis-product spec (declared series roles,
COMPONENT_ROLE_SIGNATURES).

## 0. Problem

The registry renders 84 components. The compiled path can emit 11: layouts,
StatCard, TextBlock, Annotation, DataTable, BarChart, LineChart, HeatMap
(group-matrix only), SectionBreak, DataController. The other 73 are reachable
only when the generative composer — an LLM writing free-form spec JSON —
chooses them. Observed cost (run e1c88a71): a geospatial superlative computed
lat/lng for every entity it discussed and shipped a LineChart of ranks; the
generative runs of the same question shipped Map3D/MapView.

The structural cause is not missing rules but a grammar ceiling: deriveViews
derives charts deterministically from declared series roles, and the roles
vocabulary — `x {column, kind} + measures[] + count` — can only express
"measure over an axis", "matrix by group", and "rows". The claim taxonomy is
already richer than the view taxonomy: distribution, share, correlation, and
decomposition claims carry exactly the data a Histogram, Treemap, Scatter, or
Waterfall consumes, and no rule exists from dtype to view.

Growing the deriver rule-by-rule to 84 is the wrong shape of fix: beyond
licensing (which component CAN render this series), the deriver would have to
make style judgments (which of six licensed forms tells this story best) —
precisely the judgment the compiled pipeline already delegates to one
validated LLM call, the planner.

## 1. Design principle

**Judgment to the planner, authorship to the compiler.** The planner — already
trusted to author narrative under validation — gains the power to REQUEST any
catalog component for a declared series or claim. The compiler LICENSES the
request against a component signature (data-shape contract), compiles the
props deterministically from declared roles, and rejects mismatches at plan
validation, where the planner retries with an actionable message. The
deterministic 11-component derivation stops being the ceiling and becomes the
floor: the salvage/degradation target, never the cap.

Every existing truthfulness property survives:

- the planner picks among LICENSED views only; it never authors props or data;
- all data reaches components via bindings ($series/$chartData), never inline;
- a shape mismatch is a parse error, not a rendered lie;
- prose figures remain $finding bindings; nothing here touches that seam;
- when the planner fails or under-uses VIEW, deriveViews ships what it always
  shipped.

## 2. Grammar: the VIEW op

```
{"op": "VIEW", "component": "<registry name>", "series": "<declared series id>",
 "refs": ["<claim>", ...], "title": "...", "id": ...}
```

- `component`: any key of the signature registry (§3). Unknown → validation
  error naming the closest licensed alternatives.
- `series`: required for series-fed components; must be a DECLARED series id.
  Claim-fed components (TrendIndicator, Sparkline from a series-shaped claim
  value, GaugeChart from a bounded scalar claim) use `refs` instead; the
  signature says which mode it consumes.
- `refs`: the claims this view evidences (plan honesty — same rule as prose
  nodes). At least one for claim-fed views; optional for series-fed.
- `title`: plain words, validated by validateNodeText (no literal figures —
  titles carry no numbers, or bind them).
- Placement: a VIEW renders at its plan position, exactly like an anchored
  chart today. EXPLAIN anchors to a VIEW's id the same way it anchors to
  derived chart ids; the Charts list given to the planner includes both.

**Budgets** (purpose-scaled, alongside PLAN_BUDGETS): brief ≤2 views,
dashboard ≤4, report ≤8, deep-dive ≤12. Derived coverage/table variants do not
count against the budget (honesty views are never crowded out).

**Interplay with deriveViews:** at most one VIEW per series. A licensed VIEW
for series S SUPPRESSES the derived primary for S (the planner's choice is a
better telling of the same data, and two charts of one series is the
duplicate-enumeration defect in chart form). Coverage variants, unit splits,
and tables persist regardless — disclosure never competes with style.

## 3. The licensing registry

`COMPONENT_ROLE_SIGNATURES` grows from 6 advisory entries to ALL registry
components and becomes load-bearing. Schema per component:

```ts
{
  family: "axis" | "axis-multi" | "composition" | "hierarchy" | "flow" |
          "matrix" | "geo" | "distribution" | "curve" | "ohlc" | "span" |
          "vector" | "stat" | "table" | "layout" | "input" | "media",
  feeds: "series" | "claim" | "none",       // what a VIEW binds
  xKinds?: SeriesXKind[],                    // axis families
  seriesKinds?: SeriesKind[],                // §4 — which declared kinds satisfy it
  minMeasures?: number, maxMeasures?: number,
  dtypes?: string[],                         // claim-fed: accepted claim dtypes
  compile: (info, view) => props,            // FAMILY-level props compiler
}
```

**Props compilers are per-FAMILY, not per-component** (~12 compilers, not 84 —
review R2): every axis chart shares one compiler (x/y/series columns, units,
drill bindings); matrix components share one (rows/cols/value); geo shares one
(markers/geojson/center); etc. Component-specific prop quirks live as small
deltas inside the family compiler, keyed by component name.

**Validation** (compiled mode): a VIEW node whose component is unlicensed for
its series' declared kind/x-kind/measure-arity is a validatePlan ERROR (the
planner retries); salvage drops the VIEW node (the derived floor persists).
`lintComponentSignature` keeps its advisory role for the GENERATIVE path
unchanged — same registry, two enforcement postures.

**Closure test** (the field-contract trick): a vitest asserts every registry
component name has a signature entry — component #85 cannot ship unlicensed.
A second assertion walks signatures → registry so a dead signature is caught.

## 4. Series-kind extensions

Today `roles.x.kind` distinguishes temporal/ordinal/categorical on one axis.
The tail components consume shapes the roles cannot carry. `declare_series`
gains a `kind` (default `"axis"` — every existing declaration unchanged), each
with a pinned row contract, runtime validation, and code-gen contract lines:

| kind           | row contract                                          | licenses                                                                                                                             |
| -------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| axis (default) | x + measures (+count)                                 | Bar, Line, Area, Scatter, DualAxis, Bump, Slope, Dumbbell, Stream, Calendar, Pareto, Control, ErrorBar, PopulationPyramid, Sparkline |
| geo            | lat + lng (aliases lon/longitude) + label? + measure? | MapView, Map3D, Globe3D                                                                                                              |
| distribution   | value column (raw sample or pre-binned bin+count)     | Histogram, BoxPlot, Violin, Ridgeline, Beeswarm, ECDF, QQPlot                                                                        |
| hierarchy      | parent + child + value (or path[] + value)            | Treemap, Sunburst, Dendrogram, DecisionTree                                                                                          |
| flow           | source + target + weight                              | Sankey, Chord, NetworkGraph                                                                                                          |
| matrix         | row + col + value                                     | HeatMap, ConfusionMatrix, Correlogram, CohortGrid, SilhouettePlot                                                                    |
| curve          | x + y (+lo/hi CI columns, +group)                     | RocCurve, LiftChart, CalibrationCurve, SurvivalChart, PartialDependence, ForestPlot                                                  |
| ohlc           | t + open/high/low/close                               | CandlestickChart                                                                                                                     |
| span           | label + start + end (+group)                          | GanttChart                                                                                                                           |
| vector         | x + y + angle/u + magnitude/v                         | QuiverChart, WindRose                                                                                                                |

Composition components (Pie, Treemap-as-share, Marimekko, Waterfall, Funnel,
Gauge, Bullet, TrendIndicator) are CLAIM-fed where a claim already carries the
shape (share → shares_pct mapping; decomposition → terms; trend →
direction+slope) — no series needed; the props compiler builds rows from the
claim value the same way the realizer builds sentences.

Runtime: `declare_series(..., kind=..., roles=...)` validates the row contract
at declaration (missing contract column → declaration error with the exact
message, never a silent axis fallback — review R3) and the kind flows through
the product to the host. The field-contract exhaustiveness discipline extends:
a `series-kind-contract.json` pins each kind's required/optional columns; a
runtime test declares one series of every kind and asserts acceptance; a host
test asserts every `seriesKinds` referenced by a signature exists in the
contract.

## 5. One source of truth for the planner

The planner prompt's component catalog is GENERATED from the signature
registry: one line per component — name, family, a hand-written "when" clause
stored IN the signature (`when: "ranked shares of a whole"`), and the shapes
it accepts. Claim→view affinities are advisory lines in the same generated
block (distribution claim → Histogram/BoxPlot; share → PieChart/Treemap;
decomposition → WaterfallChart; correlation → ScatterChart; geo series →
MapView; trend-by-group → BumpChart/SlopeChart). Values-blind is preserved:
the planner sees series ids, kinds, column NAMES, and row counts — never
values.

Prompt budget: the catalog block is ~84 short lines ≈ 3–4 KB on a ~36 KB
compose prompt; acceptable, and generated-not-authored means zero drift.

## 6. Verification

- validatePlan: VIEW licensing (blocking, compiled); budget caps; one VIEW per
  series; refs discipline; title text rules.
- salvagePlan: unlicensed/duplicate VIEW → node dropped with repair note;
  never document collapse.
- Invariant suite: one grid fixture per FAMILY (a licensed series of each kind
  - a VIEW of a representative component) must compile → render → resolve
    clean under the existing battery; the closure test (§3) rides the same file.
- catalog-render-smoke (existing): extended with one synthetic props payload
  per newly-compilable component, produced BY the family compilers — the
  compiler output is what gets smoke-rendered, so compiler and component
  cannot drift.
- Batch eval: report gains a `views` column (which components shipped) so
  adoption and misuse are observable across runs.

## 7. Phases

- **P1 — grammar + registry + high-value families.** VIEW op end-to-end
  (schema, validatePlan, salvage, compile, budgets, suppression rule);
  signature schema; family compilers + signatures for geo, distribution,
  composition (claim-fed), axis-extended (Scatter, Area, DualAxis); planner
  catalog generation. Closes the map gap and the four claim-dtypes-without-
  visual-form gaps. One sitting.
- **P2 — series kinds in the runtime.** `kind=` on declare_series, row-contract
  validation, series-kind-contract.json + exhaustiveness tests, code-gen
  contract lines (geo included: "declare the map series"). One sitting.
- **P3 — the long tail.** Remaining signatures across matrix/flow/hierarchy/
  curve/ohlc/span/vector/stat families + fixtures + smoke payloads. Mechanical
  and batchable. One to two sittings.
- **P4 — folded through:** closure tests, invariant fixtures, batch-eval
  column, budget tuning from observed runs.

## 8. Principal review (adversarial pass)

**R1 — "The planner will choose bad charts."** It can only choose LICENSED
charts; the worst outcome is honest-but-suboptimal form — the same exposure
the generative path has today, minus its shape errors (which licensing makes
unrepresentable). Affinity lines steer; budgets bound; the derived floor
remains when the planner abstains. ACCEPTED with §5 affinities.

**R2 — "84 props compilers is the same grind wearing a hat."** Family-level
compilers (~12) with per-component deltas. The grind collapses because
components within a family genuinely share a data contract — that is what
made them a family. RESOLVED in §3.

**R3 — "Silent axis fallback for unknown kinds re-creates silent drift."**
Rejected at declaration with an exact message; kinds are a closed vocabulary
in series-kind-contract.json with an exhaustiveness test. RESOLVED in §4.

**R4 — "Prompt bloat."** ~3–4 KB generated block on ~36 KB; measured before
ship in P1; if over budget, families collapse to one line each with component
names enumerated. ACCEPTED with measurement gate.

**R5 — "A values-blind planner can't choose views."** It chooses from series
ids + kinds + column names + row counts — the same information a human chart
reviewer uses before looking at values. Shape knowledge, not value knowledge,
drives component choice; values-blindness is preserved. RESOLVED.

**R6 — "VIEW nodes create a new empty-render class."** A VIEW's data is a
binding to a declared series validated at plan time; the only render-empty
path is an empty series, which the existing M5-style invariant catches (VIEW
with 0-row series → degraded to the derived table variant + repair note).
RESOLVED — pinned in the P1 test plan.

**R7 — "Two charts of one series" (VIEW + derived primary).** Suppression
rule in §2: VIEW replaces the derived primary for its series; disclosure
variants never suppressed. RESOLVED.

**R8 — "Edit surface breaks."** A VIEW compiles to ordinary spec elements
(same patch paths as derived charts); the edit/persist path is unchanged.
RESOLVED by construction; regression-tested in P1.

**R9 — "Claim-fed views re-open value fabrication."** Claim-fed props are
compiled host-side from the claim VALUE (like the realizer), not authored by
the planner; the planner contributes only the request and the title. The
binding discipline is untouched. RESOLVED.

**R10 — "The registry will grow past the signatures again."** Closure test
fails CI on an unsigned component. RESOLVED in §3/§6.

**R11 — "The planner may never use VIEW"** (adoption risk). Acceptable — the
floor ships. Affinities nudge; batch-eval observes; if adoption is ~zero after
a batch, the affinity lines get strengthened with explicit "prefer a VIEW over
prose-only for these dtypes" guidance. ACCEPTED with observation plan.

**R12 — "Generative and compiled signatures drift."** One registry serves
both (advisory vs blocking posture is a call-site flag). RESOLVED.

## 9. Dispositions summary

R2/R3/R5/R6/R7/R8/R9/R10/R12 resolved by design changes recorded above;
R1/R4/R11 accepted with explicit gates (affinity steering, prompt-size
measurement, batch-eval observation). No open items block P1.

## 10. Test plan (P1 slice)

- plan.test: VIEW schema accept/reject (unknown component, undeclared series,
  kind mismatch, arity mismatch, budget breach, duplicate-series VIEW);
  salvage drops the offender only; suppression rule.
- signatures.test: closure both directions; family compiler outputs satisfy
  the component's prop types for one representative per family.
- invariants.test: grid gains one series per new kind + a VIEW each; battery
  unchanged plus empty-series degradation.
- catalog-render-smoke: compiler-produced payloads render for every P1
  component.
- planner prompt: generated catalog snapshot test (drift = intentional diff).
