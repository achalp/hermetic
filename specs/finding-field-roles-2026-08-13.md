# Declared properties, value-driven rendering: the truthful-narration fix

**Status: spec v2, 2026-08-13. v1 proposed a per-field ROLE taxonomy
(`primary`/`supporting`/`evidence`/`flag`); the principal review killed it —
this file records why (§1) and specifies the design that replaced it.
Companion to analysis-product, regime-matrix, narrative-compiler.**

## 0. Diagnosis (corrected per review)

Runs 77051c9d and f47eb42d. Ten symptoms, **four causes**. Two symptoms were
already fixed in-tree before this spec (currency formatting; the
`detected:false` projection for null step-changes), one was double-counted,
and one was a consequence, not a defect.

| Cause                                                                       | Live defects                                                                                                                                                                                                                                 | Mechanism                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B — no rendering contract for non-scalars**                               | empty ANSWER (`shares_pct`, 11-entry map); empty EXPLAIN (`slope_ci95`, 2-elem array); truncated clause (`group_ns` swept to ""); dict-dump prose (`weekday: 87.1, weekend: 12.9`); `sums_to_100` bound → boolean refused → sentence deleted | resolver: scalar → format, ≤6-leaf dict → `k: v`, else refuse. Two refusal modes were tried; sweep-to-empty leaves a dangling clause, marker-refusal deletes the node. Both wrong: these values are ordinary English.               |
| **C — invariants advisory post-render**                                     | the empty-ANSWER document SHIPPED, past a verifier that had already said `ok:false`                                                                                                                                                          | plan-time validation guarantees one ANSWER; nothing blocks after resolution. The grounding report is advisory.                                                                                                                      |
| **D — templates inert under authored text** (missed in v1; found by review) | catch-all never narrated; thin `group_ns` never caveated                                                                                                                                                                                     | `realizer.ts:189` returns authored text early, so every honesty clause in the template library (raw-beside-attested, zero screen, catch-all, relaxed bar) never runs in narrated mode.                                              |
| **A — planner can't tell what a field means**                               | (latent — the two live instances are fixed or covered by B)                                                                                                                                                                                  | the projection offers bare field names; `baseline_spread` narrated as a detected jump was this. Fixed in-tree by `PRIMARY_RESULT_FIELDS` + `detected:false`; the fix works but is a host-side table re-deriving producer knowledge. |

**Data caveat for fixtures:** f47eb42d's `spec.json` contains a second,
unshipped element generation (`pn_msr2mgue_*`) not referenced from
`compiled_root.children`. Replay harnesses must walk from root or they count
phantom defects. (The non-blind audit made exactly this mistake: "displayed
twice".)

## 1. Why the roles design failed review

Recorded so it is not re-proposed.

1. **No transport.** `coerce.py:51` rebuilds any dict subclass as a plain
   dict inside `declare_finding` (`findings.py:175`) — a `Claim` tag dies
   before anything reads it, and `__slots__` attributes never reach JSON.
   The fallback (key-set matching by dtype) inherits a three-way vocabulary
   mismatch: helper names (`finding_decompose`) vs matrix rows (`decompose`)
   vs observed dtypes (`decomposition`; both real runs declared trends as
   `direction`). Tier-2 would silently miss every trend finding, and since
   the last tier is behaviour-preserving, the failure mode is a green test
   suite over a no-op.
2. **Role cannot carry unit.** `period` is a result field and can be an
   integer year ("at 2024 usd"); `slope_per_period` is THE result but in a
   derived unit; `multiplier` is a ratio. Unit is an independent axis, so
   the promised deletion of `MEASURE_UNIT_FIELDS` never happens.
3. **The economics were false.** Every record on disk is a legacy envelope,
   so the two host tables are retained as fallback regardless; roles ADDS
   ~120 cells net. "Deleting four tables" was v1's justification and it does
   not survive its own §6.
4. **`flag` bought nothing.** Existing string verdicts (`excluded_reason`,
   `preferred`, `direction`) are bindable BY DESIGN — the contract says to
   bind them. The only unspeakable inline values are booleans, and
   boolean-ness is visible in the value itself. A declared role adds no
   information the value doesn't carry.

The under-layer mistake: roles declared an intermediate representation and
asked every consumer to re-derive the properties they need. The properties
themselves are cheaper to declare — or already derivable from the value.

**Principle: declare the property, not the taxonomy.**

## 2. The design: six mechanisms

### M1 — the value renderer (cause B)

`renderInlineValue(value, unit?) -> string | REFUSED` in
`resolve-placeholders.ts`, replacing `renderSmallDictInline`. Dispatch on
SHAPE, derived from the value at render time — no metadata:

| Shape    | Test                              | Rendering                                                                                                                                                                                                                                                                                                                      |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| scalar   | number / non-empty string         | existing rules (currency 2dp, p-value precision, identifier humanizing)                                                                                                                                                                                                                                                        |
| interval | 2-elem numeric array              | `"-11.15 to 11.51"`, unit once at the end                                                                                                                                                                                                                                                                                      |
| sequence | array of ≤8 scalars               | `"a, b and c"`                                                                                                                                                                                                                                                                                                                 |
| mapping  | flat dict of scalars              | ranked: top-3 named, then the MINIMUM named, middle counted — `"Other at 23.5%, Membership & Dues at 19.6%, Online Shopping at 17.9%, down to Utilities at 1.1% (with 7 more in between)"`. The minimum is named deliberately: a group-sizes disclosure must surface the n = 2 group it exists for, not bury it in "8 others". |
| boolean  | `true`/`false`                    | REFUSED (defence in depth; M2 prevents these bindings upstream)                                                                                                                                                                                                                                                                |
| opaque   | nested / >25 leaves / mixed types | REFUSED                                                                                                                                                                                                                                                                                                                        |

Mapping constants, pinned here so the implementer invents nothing:
`MAPPING_NAME_ALL_MAX = 4` (n ≤ 4 → name all, no residual clause; n = 4
therefore names four and the ranked form applies only from n ≥ 5); ties
break by key order after value-desc sort (stable output); the in-between
count is singular-aware ("with 1 more in between"); the unit renders per
named entry (currency words and `%` suffixes both read per-figure). Mixed
scalar dicts (strings among numbers) keep the plain `k: v` form, small
only — ranking strings is meaningless.

REFUSED **never deletes a sentence**. It marks the node for M5. The
77051c9d/f47eb42d pair is the proof both deletion modes are wrong.

### M2 — boolean gates, value-driven (cause A's live half)

Three layers, no tables:

1. **Projection**: `leafFields` drops `typeof v === "boolean"` from
   `value_fields` — the planner is never offered `sums_to_100`,
   `bar_relaxed`, `passed`, `significant`, `weighted`.
2. **Plan validation**: `validateNodeText` already resolves each binding
   path against `f.value`; add: resolved boolean ⇒ ERROR ("binding
   `$finding:x.sums_to_100` resolves to a yes/no flag — state the fact in
   words or gate with $cond"). This is rejection at authoring time — the
   "by construction" v1 falsely claimed. Feeds the existing retry/salvage
   loop like any other validation error.
3. **Resolver**: `isInlineRefused` stays as depth defence.

Whole-value boolean bindings in generative specs (a StatCard showing a
boolean) are untouched — the gate applies to plan-node prose only.

### M3 — non-detection declared by the producer (cause A's root)

The helpers already know when they found nothing — they construct the null
result deliberately. They now SAY it: every legitimate looked-and-found-
nothing branch (and the degenerate/failed dicts, which are all-null anyway)
adds `"detected": False` to the returned dict. Detected results carry no
key (absent = detected).

Why this transport is correct where `Claim` was not: it is data inside the
value. It survives `to_native`, `{**spread}`, comprehensions, JSON,
pandas round-trips, and investigate namespacing (the value travels with the
renamed finding) — for free. No envelope schema change (`value` is already
`unknown` / passthrough), no zod change, no vocabulary mapping.

Projection rule: `value.detected === false` ⇒ project
`{name, definition, dtype, detected: false}` with NO `value_fields` — the
generic rule replaces per-dtype knowledge. `PRIMARY_RESULT_FIELDS` is
DEMOTED to the legacy fallback for envelopes predating the key (every
record on disk), not deleted. The `detected` key itself is a boolean, so M2
already keeps it out of `value_fields` on any path.

Contract note (prompts.ts): the helper return-key documentation gains
`detected` where applicable, documented as "absent when the claim found
something; False otherwise — never bind it, the projection handles it."
`_synthesize` will mirror it into results as `<name>_detected` like other
scalars; harmless (booleans already mirror), and the generative composer's
results-side hygiene is explicitly out of scope here.

### M4 — templates append, never vanish (cause D)

`realizeNode` stops returning authored text INSTEAD of the template's
honesty clauses. Authored text replaces the template's HEADLINE sentence
only; the per-dtype rider clauses — raw-beside-attested, zero screen,
catch-all, relaxed bar, excluded-trailing — are computed as today and
APPENDED to the authored text when their condition fires.

Riders are deterministic, findings-bound, and short; the planner cannot be
trusted to volunteer them and can no longer suppress them by writing
prose. (This is the fix that makes `label_is_catchall`/`bar_relaxed`
actually reach the reader; v1's realizer edit was correct but inert.)

### M5 — post-render invariants, blocking (cause C)

In the compiled branch of `dashboard-compose.ts` (NOT `compile.ts`, which
runs pre-resolution and cannot know what resolves empty): compiled mode
already yields the document as one chunk; buffer it through the finalizer,
then per plan node:

- non-empty content → ship;
- empty or REFUSED-marked → substitute `realizeNode`'s deterministic
  template output for that node (which cannot be empty for findings-bound
  ops);
- ANSWER still empty after substitution → substitute the deterministic
  default plan's ANSWER and record a structural failure
  (`compose_answer_missing`) — the document NEVER ships answer-less.

Generative mode is untouched (its specs have no plan nodes). The verifier
stays advisory for everything else; only the credibility floor becomes
blocking, matching its name.

### M6 — units: keep the tuned table, pin the drift

`MEASURE_UNIT_FIELDS` stays — it is small, hand-tuned, and correct
(review: the fields it excludes are exactly the ones role-derivation would
have broken). `CURRENCY_UNITS` stays in TS with a new cross-language drift
test: parse `_CURRENCIES` out of `regimes.py` in the test and assert set
equality, so the two copies cannot diverge silently.

## 3. Defect → mechanism

| Defect                        | Fix                                                                     |
| ----------------------------- | ----------------------------------------------------------------------- |
| fabricated "sharpest jump"    | M3 (producer-declared; legacy via demoted table) — shipped fix retained |
| `sums_to_100` bound inline    | M2 (projection filter + validator rejection)                            |
| empty ANSWER (`shares_pct`)   | M1 mapping + M5 backstop                                                |
| empty EXPLAIN (`slope_ci95`)  | M1 interval                                                             |
| truncated clause (`group_ns`) | M1 mapping                                                              |
| dict-dump prose               | M1 mapping                                                              |
| money as floats               | shipped (currency 2dp) — M1 preserves                                   |
| catch-all unnarrated          | M4                                                                      |
| thin groups uncaveated        | M4 (heterogeneity rider binds `group_ns` via M1)                        |
| empty ANSWER shipped          | M5                                                                      |

## 4. Cascade

| Surface                             | Change                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `hermetic_runtime/findings.py`      | `"detected": False` on null-result branches (~8 helpers); contract strings updated                                      |
| `lib/findings/project.ts`           | generic `detected` rule first; boolean filter in `leafFields`; `PRIMARY_RESULT_FIELDS` demoted with a comment saying so |
| `lib/compose/plan.ts`               | boolean-binding rejection in `validateNodeText`                                                                         |
| `lib/llm/resolve-placeholders.ts`   | `renderInlineValue`; `renderSmallDictInline` deleted; refusal never strips                                              |
| `lib/compose/realizer.ts`           | headline/rider split; riders append to authored text                                                                    |
| `lib/pipeline/dashboard-compose.ts` | compiled branch buffers finalized doc; M5 invariants                                                                    |
| `lib/compose/planner.ts`            | prompt: booleans are stated in words; `detected:false` claims have nothing to bind (rule shipped in v1, kept)           |
| envelope / zod / MCP / exports      | **no change** — the one structural advantage over v1                                                                    |

## 5. Review dispositions (v1 amendments A1–A9)

- A1 transport → resolved by elimination: M3 ships data, not metadata.
- A2 unit-by-role → M6 keeps the tuned table.
- A3 "by construction" false → M2's validator rejection makes it true for
  plan prose; the `_synthesize` mirror is documented out of scope.
- A4 sequencing → §6 phases; renderer+invariants first, standalone.
- A5 realizer inertness → M4, promoted to a root cause.
- A6 envelope location / vocabulary → moot (no envelope field, no
  vocabulary).
- A7 legacy vs deletion → tables demoted, framing corrected (§1.3).
- A8 mapping constants → pinned in M1.
- A9 collapse roles → the taxonomy is gone entirely.

## 6. Implementation plan

- **P1 (host-only, lands first)**: M1 renderer + M5 invariants + M4
  realizer split. Closes every live rendering defect; testable today
  against both fixtures.
- **P2 (gates)**: M2 projection filter + validator rejection. Small,
  independent.
- **P3 (runtime)**: M3 `detected` emission + contract strings + runtime
  tests; host projection rule (which no-ops until new runs arrive).
- **P4 (drift)**: M6 currency drift test.

## 7. Tests

- **Renderer**: table-driven per shape; the n=4 boundary; tie order; the
  1-entry residual phrasing; unit placement per shape; currency vs pct.
- **Projection**: `detected:false` withholds everything; booleans filtered;
  legacy (no `detected` key) falls back to the demoted table byte-for-byte.
- **Validator**: boolean binding rejected with the actionable message;
  string verdicts (`direction`, `excluded_reason`) still accepted.
- **Realizer**: authored text + riders compose; riders fire exactly when
  their condition holds; template-only path unchanged.
- **Invariants**: a doc whose ANSWER resolves empty ships the template
  ANSWER; `compose_answer_missing` recorded; generative path untouched.
- **Runtime**: each helper's null branch carries `detected: False`; the
  `{**helper(...)}` spread PRESERVES it (the test `Claim` could never
  pass); `_synthesize` mirrors it without error.
- **Replays**: `artifacts.json` from both runs copied to `__fixtures__`
  (data/history is user data), walked from `compiled_root.children`;
  assert: ANSWER non-empty, no `"content": ""` on plan nodes, no dangling
  "sizes of " clause, money formatted, no boolean words in prose.
- **Drift**: TS `CURRENCY_UNITS` === parsed `regimes.py _CURRENCIES`.
