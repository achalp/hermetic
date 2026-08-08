# The Analysis Product: structured output, declared relationships

**Status: phases A–C implemented 2026-08-08 (§8). Supersedes the flat
`results`/`chart_data` namespaces as the composer/validator interface.
Companion to declared-findings, declared-checks, claims-api.**

## 0. Diagnosis

Every namespace defect of runs 31–41 shares one mechanism: the platform
INFERS relationships the analysis KNEW and flattened away. `mirroredResultKeys`
guesses ownership from name morphology; the thin/attested lints regex-hunt
count columns; screen lints parse a `_screened` naming convention; chart
consistency guesses which columns are the same measure. Heuristics is where
the bugs lived. Design rule: **relationships are declared as references,
never encoded in string conventions.**

## 1. The structure

```
AnalysisProduct (envelope v2, additive):
  facts:   Fact[]     // findings + checks — UNCHANGED, the anchor layer
  series:  Series[]   // tidy data + declared ROLES — replaces chart_data authoring
  values:  Value[]    // genuinely standalone scalars — context mandatory
  meta:    completeness, runtime_fallback (existing)

Series { id, rows[],                       // tidy: one observation per row
         roles: { x: {column, kind: temporal|ordinal|categorical},
                  measures: [{column, unit?, of?: factName,
                              screened_by?: checkName, variant_of?: column}],
                  count?: {column},        // attestation, DECLARED
                  group?: {column} } }

Value  { key, value, unit?, label, of?: "fact.field" }
       // RULE: `of` (redundant, server-derivable) OR self-describing
       // (label required). An unowned, undescribed scalar is invalid.
```

**Back-compat is synthesis, not duplication**: `write_output` GENERATES
`chart_data[series.id]` from each series' rows and auto-mirrors every scalar
fact field into `results[name_field]` (authored keys win; missing mirrors
are filled). The entire render path — bindings (`$chartData:series_id`,
`$result:key`), resolver, finalizer, DataController, MCP caps, UI —
consumes the synthesized views UNCHANGED. The binding grammar does not
change; only its SOURCE becomes structured.

## 2. The composer interface: BindingCatalog

One typed catalog (replacing the results-schema + chart-shape prose) where
every binding carries identity, unit, and role:

```
## Binding Catalog
CLAIMS  $finding:median_price_trend.slope_per_period — median price trend, usd/yr, trend
SERIES  $chartData:annual_prices — x: year (temporal); measures: median_price
        (usd, screened by median_price_outlier_screen), …; count: item_count; 142 rows
VALUES  $result:total_priced_listings — "Total priced listings"
```

The composer selects from typed entries; the wrong-metric class has no
morphology to exploit. The findings projection (definitions, scrubbed)
remains as the semantic companion section. Blind/sighted is unchanged:
the catalog is structure-only; sighted appends the values section as today.

## 3. Cascade analysis (every downstream, explicit)

| Consumer                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Checks**                                      | `declare_check` unchanged. Screen checks become REFERENCED: a measure's `screened_by` names the check; scope validation dereferences its evidence (excluded x's) instead of parsing `_screened` columns.                                                                                                                                                                                                                                                                  |
| **Validators**                                  | Roles are validated twice: at declaration (runtime drops invalid series with a sidecar diagnostic) and host-side (`lib/product` re-validates — the degraded prelude fallback skips runtime checks — dropping with an `invalid_series` issue). The chart x-key retry check is unchanged: synthesized series rows satisfy it by construction. Blocking-check, findings-collapse, checks-only: unchanged (fact-layer).                                                       |
| **Lints**                                       | Structured-first with legacy fallback: screen scope/missed/attested/thin read `roles.count` + `screened_by` deref; series-consumption reads `variant_of`; chart consistency compares measures sharing `of`; provenance = `Value.of` null-check + fact refs. Heuristic paths retained ONLY for legacy envelopes (investigate steps, old runs) — demoted, not deleted. `null_zero_mirror`/`mirror_dropped_value` retire on v2 (mirrors are synthesized — drift impossible). |
| **Headline plan**                               | Unchanged in v1 — the facts path plans tiles; labeled values reach the composer through the catalog and resolve as ordinary `$result` bindings. Value-planned tiles are recorded as a follow-up.                                                                                                                                                                                                                                                                          |
| **Resolver/finalizer**                          | UNCHANGED (binding grammar stable). `repairMetricBindings`/mislabel lint demote to legacy defense.                                                                                                                                                                                                                                                                                                                                                                        |
| **DataController / filtering**                  | UNCHANGED mechanically (datasets injection reads synthesized chart_data). Roles open a follow-up: filters proposed from `group`/categorical roles (recorded, not built).                                                                                                                                                                                                                                                                                                  |
| **Sample/metadata schema modes**                | UNCHANGED — they govern code-gen input, not composer values. Composer sight remains the values switch.                                                                                                                                                                                                                                                                                                                                                                    |
| **MCP caps / Verify / Findings tabs / exports** | UNCHANGED (consume synthesized views + manifest). `series` added to the artifacts cache passthrough for inspectability.                                                                                                                                                                                                                                                                                                                                                   |
| **Exemplars/learning**                          | Code containing `declare_series` banks normally; contract gen bumps to 3 (pre-series exemplars stale).                                                                                                                                                                                                                                                                                                                                                                    |
| **Profiler / completeness**                     | Unchanged (operates on loaded frames pre-analysis).                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 4. Principal review

1. **Why not break the binding grammar?** A `$series:` grammar forks the
   resolver, UI, MCP, exports at once. Synthesis keeps one grammar with a
   structured source — the risk-minimal inversion. Revisit only if roles
   need to travel INTO bindings (no current consumer needs that).
2. **Synthesis divergence risk** (series says one thing, synthesized view
   another): impossible by construction — the view is a projection computed
   in one place (`write_output`); nothing else writes it when series exist.
3. **Partial adoption** (model declares some series, hand-writes other
   chart_data): allowed and degrades PER-KEY — declared keys get catalog
   lines and structured lints, undeclared keys keep the legacy shape
   description and heuristic lints. A chart_data key colliding with a series
   id resolves deterministically: the series wins (synthesis is the single
   writer), so the stale authored copy can never be the one consumed.
4. **Roles vocabulary creep**: roles are STRUCTURAL (x/measure/count/group)
   — the open vocabulary lives in units/names, per the meta-schema rule.
   New role kinds require a spec amendment, deliberately.
5. **Value rule enforcement**: envelope validation drops context-free
   unowned values with an issue — same posture as findings validation.
6. **Cost**: declare_series is FEWER tokens than hand-assembling display
   dicts; the BindingCatalog is denser than three prose sections.
7. **Testability**: synthesis, catalog, roles validation, structured lints
   are pure functions; python side mirrors the findings-registry pattern.

## 5. Implementation plan

- **A (runtime + envelope)**: `declare_series`/`declare_value` (registry
  pattern, never-raise, prelude parity); `write_output` synthesis (chart_data
  from series, auto-mirrors + values into results); envelope fields; zod +
  contracts; CONTRACT_GENERATION → 3.
- **B (consumers)**: BindingCatalog section (replaces results-schema/chart
  shapes when series present); series-roles validator; structured lint paths
  with legacy fallback; headline plan values; artifacts passthrough.
- **C (contract)**: codegen contract mandates declare_series/declare_value,
  retires chart_data/results authoring guidance; series-first exemplar gen.
- **Deferred (recorded)**: catalog component-signature type-check; role-
  driven filter proposals; `$series:` grammar.

## 6. Invariants

- One source of truth per fact/series; views are synthesized projections.
- Binding grammar stable across the migration.
- Raw rows never enter prompts (series ROWS are the chart-payload tier —
  same exposure as today's chart_data; datasets remain client-only).
- Legacy envelopes (no `series`) take the heuristic paths untouched.

## 7. Out of scope

Investigate per-step series namespacing beyond the merge that exists for
findings (steps ship legacy chart_data in v1 of this spec; recorded).

## 8. Implementation record (2026-08-08)

See commit series: runtime (series/values registries + synthesis + tests),
host contracts/parse/validator/catalog/lints (structured-first), contract
phase C + generation bump, full-suite green.
