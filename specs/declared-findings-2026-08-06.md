# Declared findings: the model generates the vocabulary, code grounds it

**Date:** 2026-08-06 · **Status:** SPEC (not yet implemented) · **Supersedes**
the "findings as first-class taxonomy" roadmap item in
`specs/grounded-narrative-2026-08-06.md` §5.

## 0. The decision this spec records

Two architectures were considered for making findings a contract instead of
a naming convention:

**(A) Fixed taxonomy:** a closed discriminated union (trend / step_change /
decomposition / base_effect / heterogeneity / superlative), zod-validated,
computed by mandatory helpers. Strong guarantees on six kinds — and a
point-in-time corpus that caps the analytical vocabulary of an LLM whose
premise is that the vocabulary is unbounded. Rejected as primary
architecture.

**(B) Declared measures (CHOSEN):** code-gen _declares_ the measures and
findings this question warrants — name, definition, dtype, unit,
derivations — and generates the code that computes exactly those, in the
same artifact. Hermetic owns the **grammar** (a small, content-free
meta-schema and the consistency checks); the model generates the
**vocabulary** per question, bound to inspectable code. (A) survives inside
(B) as: the meta-schema, the lint layer, an optional helper library, and
well-known _tags_ (never enums).

Evidence that forced this: across runs 3–4 on identical data, the
naming-convention approach produced key drift with flipped conclusions
(`segment_heterogeneity_significant: true` + ANOVA → a test-free
`_verdict: "consistent"`), and internally contradictory outputs
(`base_effect: "amplifying"` beside its own 86.6%-rate-driven
decomposition). Prompts reduce the frequency; only a checked structure
changes the failure class.

## 1. The manifest

A run's findings manifest is assembled **during execution** — declaration
is an act in the code, not a preamble (see §2). Each entry:

```jsonc
{
  "name": "rate_vs_volume_split", // REQUIRED, unique in run
  "definition": "Jan→Dec churned-customer change attributed to rate change vs base growth", // REQUIRED, must reference real columns/measures
  "dtype": "shares", // REQUIRED, OPEN vocabulary
  "unit": "customers", // optional, open ("pp"/"pct" conventions apply)
  "value": { "rate": 1317.3, "volume": 203.8, "dominant": "rate" }, // REQUIRED
  "derived_from": ["monthly_churn_rate", "active_customers"], // optional
  "tags": ["decomposition"], // optional, open — well-known tags
  // unlock generic affordances
  "method": "linear attribution holding the other factor at Jan level", // optional
  "code_ref": "analysis.py:41", // auto-captured by declare_finding
}
```

**Meta-schema rules are content-free by design.** Hard requirements: name,
definition, dtype, value. Everything content-bearing (dtype values, tags,
units, methods) is open vocabulary with documented conventions — an enum
anywhere in this schema is the fixed taxonomy sneaking back in one level
down (§0). The only structural minimums: one finding carries one value or
one small structure (no catch-all "object of various statistics"), and the
definition must mention at least one actual column or declared measure
(mechanically checkable against the schema).

## 2. Producer: declaration at computation time

`declare_finding(...)` is a preloaded sandbox helper called ADJACENT to the
computation, wherever in the script the finding crystallizes:

```python
split = decompose(delta_churned, rate_term, volume_term)
declare_finding("rate_vs_volume_split", split,
    definition="Jan→Dec churned-customer change attributed to rate vs base growth",
    dtype="shares", unit="customers",
    derived_from=["monthly_churn_rate", "active_customers"],
    tags=["decomposition"])
```

Why not declare-first: analysis is exploratory — you compute the series,
SEE the August step, then formalize it. A manifest promised before the code
caps emergence and invites speculative declarations. Assembling it from
execution means discovery is never capped and every entry carries an
auto-captured `code_ref` (the helper reads its own call site), so
"inspectable" is a line number, not a vibe.

`findings.py` also ships tested implementations of the boring statistics
(OLS trend with p-value, changepoint scan, ANOVA/Kruskal, decomposition) —
**a library, not a menu**: generated code MAY call them and may equally
compute anything bespoke. Helper-vs-bespoke ratio and tag diversity are
recorded per run (diagnostics) so convergence-toward-the-helpers — the soft
cap — is measured, not guessed.

`write_output` gains `findings=[...]` (assembled by the helper); the loose
`results` dict remains for back-compat and for values that aren't findings.

## 3. Enforcement points (mechanical, content-free)

1. **Meta-schema validation** of every entry; failures drop the entry with
   a warning into the failure log (learning-loop food), never fail the run.
2. **Declaration ↔ computation:** every declared finding has a value of the
   declared dtype-shape; every claims-bearing output the narrative uses
   should be declared (undeclared = advisory flag, not an error).
3. **Derivation consistency:** where `derived_from` names another finding,
   referenced entries must exist; verdict-like values derived from a
   decomposition must agree with its `dominant` term (the run-4 lint).
4. **Grounding, both directions (ADVISORY, never blocking):** narrative
   claims that trace to no declared finding, and declared findings the
   narrative ignored, both surface through the existing `__grounding`
   caveat channel. Hard-blocking undeclared claims would cap legitimate
   composition-time framing ("nearly double") — hermetic's grounding
   posture (caveat, don't rewrite) applies unchanged.

## 4. Consumers

- **Composer** (still values-blind in metadata mode) receives the manifest
  — names, definitions, dtypes, field names, tags; NOT values — and binds
  narrative via `$finding:<name>` / `$finding:<name>.<field>` placeholders
  (resolver extension mirroring `$result:`). Tags light up generic
  affordances (a "trend"-tagged finding offers a bindable direction word).
- **MCP / host models:** the validated manifest ships verbatim in
  `analyze` / `analyze_result` responses and feeds `verify_narrative`. This
  is the stable machine contract: consumers read self-describing entries
  instead of pattern-matching key names. Cross-run drift on re-generation
  becomes VISIBLE (two manifests, diffable) instead of a silent schema
  break; refresh/re-run flows reuse persisted code ⇒ identical manifests.
- **Skills** declare their own finding vocabularies with zero core changes
  (open meta-schema) and may ship their own audit rules.

## 5. The review stack (who reviews this)

| Layer                      | Nature                                                                                     | Catches                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta-schema + lints (§3)   | mechanical, always                                                                         | structure, drift, derivation contradictions                                                                                                                                |
| Review gate findings-audit | LLM, high effort, SAMPLED — claims-bearing entries only (verdicts/directions/attributions) | code at `code_ref` doesn't implement the definition (the "consistent-without-a-test" class)                                                                                |
| Grounding (§3.4)           | mechanical, advisory                                                                       | unbacked claims, un-narrated findings                                                                                                                                      |
| **The host model**         | on-demand                                                                                  | semantics, with full context — manifests + code_refs exist chiefly to make the CALLING model an effective auditor (it has been the sharpest reviewer of every run to date) |
| Learning loop + evals      | longitudinal                                                                               | vacuous declarations as negative exemplars; manifest quality/audit pass-rate as eval objects (unparks the answer-quality-evals spec)                                       |

**Anti-laundering rule:** validation covers structure and internal
consistency, NOT truth. Any surface that badges a finding must say so
("structurally verified · definition at analysis.py:41"), or this becomes a
machine for certifying wrong answers.

## 6. Known residual risks (accepted, monitored)

- **Vacuous compliance** (catch-all declarations) — reduced by structural
  minimums + audit + exemplars; not eliminated.
- **Semantic wrongness** behind a valid structure — reduced by the audit
  sample and host-model review; grounding-by-inspectability is a ratchet,
  not a proof.
- **Helper gravity** — monitored via diagnostics (§2); respond with prompt
  framing and exemplar diversity, not more helpers.
- **Token cost** — manifest + declarations add modest output; measure in
  the cost-by-phase line before/after.

## 7. Investigate: multi-step and cross-step (designed now, phase 5)

Investigate already has the two structures findings need: a planner-declared
dependency DAG (`depends_on` indices per sub-question, wave-scheduled) and
step-prefixed result flattening (`step_N_*`) into the composer. Findings
ride both rather than inventing parallel machinery.

**7.1 Per-step declaration, namespaced merge.** Each sub-question's sandbox
run declares findings exactly as in §2. The merged manifest namespaces
entries as `step_N.<name>` (dotted form for `$finding:` paths; aligns with
the existing `step_N_` flattening convention). Same meta-schema; a name is
unique within its step.

**7.2 Derivation edges must follow the execution DAG.** A step may declare
`derived_from: ["step_2.churn_trend"]` only for steps in its `depends_on`
set — a derivation from a step whose results this step never received is
either hallucinated lineage or a missing dependency, and both surface
(advisory). The converse is also informative: a `depends_on` edge with no
derivation touching it means a dependency was consumed silently. Analytical
lineage and execution lineage become mutually checking.

**7.3 Cross-step coherence — the lint dimension single-shot doesn't have.**
Two steps can compute overlapping measures under different filters or
denominators and disagree (the run-3-vs-run-4 drift, happening WITHIN one
investigation). Detection: entries from different steps with comparable
dtype+unit and definitions referencing the same columns, whose values
materially differ → an advisory _reconciliation_ item delivered to the
composer and the gap-check. The synthesis must then reconcile or scope
them (extending the existing SCOPE DISCLOSURE rule) — executive summaries
stop papering over intra-investigation disagreement.

**7.4 Findings as the investigation's working memory.** The planner,
re-planner, and gap-check consume the ACCUMULATED manifest (names,
definitions, tags — not values in metadata mode): next-wave planning sees
what is already established, avoids re-computing declared findings, and
targets gaps ("trend and step change declared; no decomposition yet").
The gap-check goes from prose intuition to structure-assisted enumeration.
This is the quiet payoff: investigate's working state upgrades from
accumulated prose to a queryable structure.

**7.5 Synthesis binding.** Executive summary and conclusion bind
`$finding:step_N.<name>.<field>`; grounding's step-citation machinery
(citedSteps / uncitedSuccessfulSteps) generalizes to finding-level
citations, so both "claim without a finding" and "finding no step of the
story used" report per step.

Phase 1 fixes only what future-proofs this: the dotted namespace form is
reserved in the meta-schema, and `derived_from` entries may be
step-qualified. Everything else in this section is phase 5.

## 8. Phases

1. **Grammar:** meta-schema + `declare_finding` helper (+ code_ref
   capture) + validation/lints + manifest in responses & verify_narrative.
2. **Binding:** composer manifest injection + `$finding:` resolution +
   grounding coverage both directions.
3. **Audit:** review-gate findings-audit (sampled) + diagnostics counters
   (helper ratio, tag diversity) + learning-loop wiring.
4. **Retire** the naming-convention blocks from the code-gen prompt
   (grounded-narrative spec §3 table becomes conventions documentation).
5. **Investigate** (§7): namespaced merge, DAG-checked derivations,
   cross-step reconciliation lint, manifest-aware planner/gap-check,
   synthesis binding.
