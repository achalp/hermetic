# Declared findings: the model generates the vocabulary, code grounds it

**Date:** 2026-08-06 · **Status:** v2 — IMPLEMENTED (phases 1–3 + phase-5 core; §13) ·
**Supersedes** the "findings as first-class taxonomy" roadmap item in
`specs/grounded-narrative-2026-08-06.md` §5.

v2 incorporates a two-lens principal review (engineering: 15 findings, 4
blockers, verified against the codebase at file:line; product: 13 findings,
3 blockers) plus the author's pass. Adjudication record in §12. The v1
architecture survived review unchanged; nearly everything AROUND it —
plumbing, privacy mechanics, rollout, metrics, trust surfaces — did not.

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
findings this question warrants — name, definition, dtype, derivations —
and generates the code that computes exactly those, in the same artifact.
Hermetic owns the **grammar** (a small, content-free meta-schema and the
consistency checks); the model generates the **vocabulary** per question,
bound to inspectable code. (A) survives inside (B) as: the meta-schema, the
lint layer, an optional helper library, and well-known _tags_ (never enums).

Evidence that forced this: across runs 3–4 on identical data, the
naming-convention approach produced key drift with flipped conclusions
(`segment_heterogeneity_significant: true` + ANOVA → a test-free
`_verdict: "consistent"`), and internally contradictory outputs
(`base_effect: "amplifying"` beside its own 86.6%-rate-driven
decomposition). Prompts reduce the frequency; only a checked structure
changes the failure class.

## 1. The manifest

The manifest is an **envelope, not a bare array** (review E9 — an
unversioned "stable contract" is a lucky one):

```jsonc
{
  "manifest_version": "1.0", // minor bump = additive fields; major =
  // semantics change (e.g. §7 namespace activation)
  "findings": [/* entries */],
}
```

Each entry:

```jsonc
{
  "name": "rate_vs_volume_split", // REQUIRED. ^[a-z][a-z0-9_]*$ — no dots
  // (dots are the reserved §7 step namespace).
  // Unique within its declaring script run
  // (= its step); run-level uniqueness in
  // investigate is DERIVED via namespacing,
  // never declared.
  "definition": "Jan→Dec churned-customer change attributed to rate change vs base growth",
  // REQUIRED; literal-only (§2.2); must
  // reference ≥1 column/measure (§3.1)
  "dtype": "shares", // REQUIRED, OPEN vocabulary
  "unit": "customers", // optional, open ("pp"/"pct" conventions)
  "value": { "rate": 1317.3, "volume": 203.8, "dominant": "rate" }, // REQUIRED
  "derived_from_findings": [], // optional: finding names (step-qualified
  // in investigate: "step_2.churn_trend")
  "derived_from_columns": ["monthly_churn_rate", "active_customers"], // optional
  "tags": ["decomposition"], // optional, open — well-known tags
  "method": "linear attribution holding the other factor at Jan level", // optional, literal-only
  "code_ref": "script.py:41", // auto-captured; generated-code-relative (§2.4)
  "redeclarations": 0, // auto: times this name was re-declared (§2.3)
}
```

**Meta-schema rules are content-free by design.** Hard requirements: name,
definition, dtype, value. Everything content-bearing (dtype values, tags,
units, methods) is open vocabulary with documented conventions — an enum
anywhere in this schema is the fixed taxonomy sneaking back one level down.

**Quantified structural limits** (review E10 — "small structure" is not a
number): serialized `value` ≤ 2 KB, depth ≤ 2, ≤ 25 leaf fields; manifest
total ≤ 100 entries / 64 KB. Beyond a limit: drop-with-warning (largest
first for the total cap), per §3.1. Additionally the definition must
mention at least one actual column or declared measure — for dependent
investigate steps the reference set is source-schema columns ∪ upstream
step-frame columns ∪ finding names in the step's `depends_on` closure
(review E13 — dependent steps run over derived frames, whose columns are
absent from the source schema).

**`derived_from` is two fields, not one** (review E14): mixing columns and
finding names in one array made §3.3's existence check unimplementable
(shadowing, typo-vs-column ambiguity). An entry in `derived_from_findings`
that resolves to no finding is an advisory "unresolved lineage" warning.

**The privacy boundary, stated honestly** (review E2): the composer never
receives VALUES; finding _names_ and value _field keys_ may carry
categorical labels (a loop declaring `churn_self_serve` exposes the segment
name) — the same exposure class as result keys and
`describeResultsSchema`'s key listing today. This spec's claim is "no
values", not "no strings derived from category labels".

## 2. Producer: declaration at computation time

### 2.1 The helper and the registry

`declare_finding(...)` is a preloaded sandbox helper called ADJACENT to the
computation, wherever in the script the finding crystallizes:

```python
split = decompose(delta_churned, rate_term, volume_term)
declare_finding("rate_vs_volume_split", split,
    definition="Jan→Dec churned-customer change attributed to rate vs base growth",
    dtype="shares", unit="customers",
    derived_from_columns=["monthly_churn_rate", "active_customers"],
    tags=["decomposition"])
```

Why not declare-first: analysis is exploratory — you compute the series,
SEE the August step, then formalize it. A manifest promised before the code
caps emergence and invites speculative declarations.

**Registry mechanics** (review E6/E7 — the v1 plumbing silently lost
everything): each `declare_finding` call appends one JSONL line to a
**sidecar file** (`/data/findings.jsonl`) as it executes — declarations
survive a later crash (partial manifests are learning-loop food), and the
host reads the sidecar independently of the output envelope.
`write_output` requires **no findings argument** — the registry is the
truth; `findings=` exists only as an explicit override, itself validated.
The five host-side touch points that must change, enumerated so none is
missed: `SandboxEnvelopeSchema`/sidecar read in `parse-output.ts` (zod
strips unknown keys silently today), `SandboxExecutionResult` in
`contracts/execution.ts`, BOTH `write_output` implementations (the
`hermetic_runtime` package AND the legacy prelude fallback — which today
even disagree on `allow_nan`), `CachedArtifacts` in
`contracts/investigation.ts`, and `capArtifacts` in `mcp/tools/analyze.ts`.
**The sidecar joins the warm-container cleanup list**
(`docker-warm-backend.ts` currently removes only
`script.py output.json stdout.txt stderr.txt`) — a stale sidecar in a
reused container is a cross-run data leak, not a bug.

### 2.2 Never-raise, coercion, and the literal rule

- `declare_finding` is **wrapped never-raise** (repo convention for sandbox
  helpers): any internal error records a dropped-declaration diagnostic and
  returns — a metadata feature must never kill an analysis (review E3).
- Values are `to_native`-coerced **at declaration time** (NaN/numpy/Timestamp
  — the frame is live, and `write_output`'s `allow_nan=False` would
  otherwise crash the whole run on a routine `np.nan`); coerced again at
  write, belt-and-braces.
- **`definition`, `method`, and `unit` must be string literals at the call
  site** (review E2 — the values-leak): `f"August spike of {delta:.1f}pp"`
  is the _natural_ way to write a definition and walks computed values
  straight through the metadata-mode wall. Enforced mechanically: the
  script is a real file, so validation parses the AST at `code_ref` and
  drops entries whose definition/method/unit are `JoinedStr`/`BinOp`/`Name`
  nodes (drop-with-warning). Defense in depth at the composer boundary:
  §4.1's projection scrubs numeric tokens from definitions regardless.

### 2.3 Collisions

Re-declaring a name is **last-wins** with an auto-incremented
`redeclarations` counter on the surviving entry plus a validation warning
(review E8). Rationale: matches the exploratory posture (a refined
redeclaration is the better entry), makes loop-abuse visible to the audit
layer, and never raises. Per-group declarations in loops should use
distinct names (`churn_{segment}` — unique, no collision).

### 2.4 `code_ref` mechanics

The generated script executes as `script.py` in every runtime, prepended by
a ~500-line prelude — a raw `inspect` line number would point ~500 lines
past the statement it claims to cite, silently corrupting the audit layer
and the host-model review (review E5). `code_ref` is therefore
**generated-code-relative**: the prelude records its own line count in a
module global at build time (never a hardcoded constant), and
`declare_finding` subtracts it. Examples and badges cite `script.py:41`.
A test asserts the microsandbox path-rewrite (same-line substitution)
preserves line counts.

## 3. Enforcement points

All mechanical and content-free. Each check names its OUTCOME (review P6 —
"advisory" into a field nothing renders is a tree in an empty forest):

| #   | Check                                                                                                                                                                                                                                        | Outcome                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1 | Meta-schema validation per entry (shape, literal rule, limits)                                                                                                                                                                               | entry dropped + failure-log record + diagnostics counter; never fails the run                                                              |
| 3.2 | Declaration ↔ computation (declared name has a value of the declared dtype-shape; claims-bearing outputs used by narrative should be declared)                                                                                               | advisory: diagnostics counter + `__grounding` caveat                                                                                       |
| 3.3 | Derivation consistency (`derived_from_findings` entries exist; a verdict-typed value derived from a decomposition agrees with its dominant term — the run-4 lint)                                                                            | entry KEPT; user-visible **caveat chip** on any narrative bound to the disagreeing verdict; never blocked (posture: caveat, don't rewrite) |
| 3.4 | Grounding, both directions                                                                                                                                                                                                                   | advisory caveats via the existing `__grounding` channel (defined below)                                                                    |
| 3.5 | Question-primary coverage (review P5 — the observed "asked for churn rate, headline shows not-X"): the finding whose definition references the question's target metric (or tagged `question-primary`) is not bound in any StatCard/headline | advisory caveat + diagnostics counter                                                                                                      |

**3.4 defined precisely** (review E15 — v1 presented a nonexistent check as
an extension): the phase-2 mechanical version is placeholder-based.
_Claim-tracing:_ a quantitative/directional sentence is "traced" iff it
contains a `$finding:`/`$result:` binding. _Declared-but-ignored:_ manifest
names never referenced by any placeholder in the composed spec — computable
from the pre-resolution stream. Semantic claim-matching (prose that
paraphrases a finding without binding it) is explicitly the §5 audit
layer's job, not this pass's.

## 4. Consumers

### 4.1 Composer

The composer (values-blind in metadata mode) receives an explicit
**projection** of the manifest: values stripped, definitions
numeral-scrubbed (§2.2's second layer), names/dtypes/field-names/tags
intact. The projection has its **own prompt budget** (8 KB), separate from
the results caps, with its own truncation rule: drop WHOLE entries
(untagged first, then largest), never partial ones — a half-definition is
worse than an omission — and the prompt states "N findings omitted for
space" so §3.4's ignored-findings check doesn't fire on entries the
composer never saw (review E12). Narrative binds via
`$finding:<name>` / `$finding:<name>.<field>`.

### 4.2 Resolver (enumerated — review E1)

The placeholder resolver gains a findings pass with ALL the shapes the
`$result:` history proved LLMs emit: value-form (`"$finding:x"`),
inline-form (mid-sentence, `unwrapScalar` semantics; structured dtypes
require a `.field` path — a bare inline "shares" finding must not print a
JSON object), and object-form normalization (`{"$finding": "x"}`).
**Both final-sweep regexes extend to `(?:result|chartData|finding)`** —
today an unresolved `$finding:` token would render raw in the UI, the exact
failure the sweep exists to prevent — with a distinct
`compose_finding_unresolved` failure-log class.

### 4.3 MCP hosts

The manifest envelope ships in `analyze`/`analyze_result` responses and
feeds `verify_narrative` — **contract version bumps MINOR at ship time**;
the field is absent in `off`/`shadow` modes (§8). Response-surface cap
(tighter than §1's storage cap — host context is billed): 50 entries /
8 KB, truncated largest-first with `findings_truncated: true` + the true
count, mirroring the `truncated_columns` pattern. Host-facing docs must
temper the "stable contract" claim precisely: the _grammar_ (envelope,
entry fields, version) is stable; the dtype/tag _vocabulary_ is open by
design — hosts may rely on structure, never on a dtype enum (review P3).

### 4.4 Skills

Skills declare their own finding vocabularies with zero core changes (open
meta-schema). Skill-shipped audit rules are a **phase 3 deliverable** (hook
into the review-gate findings-audit + a `creating-skills.md` section) — v1
promised this without any phase building it (review P8).

## 5. The review stack (who reviews this)

| Layer                      | Nature                                                                                     | Catches                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Meta-schema + lints (§3)   | mechanical, always                                                                         | structure, drift, derivation contradictions                                                                       |
| Review gate findings-audit | LLM, high effort, SAMPLED — claims-bearing entries only (verdicts/directions/attributions) | code at `code_ref` doesn't implement the definition (the "consistent-without-a-test" class)                       |
| Grounding (§3.4/3.5)       | mechanical, advisory                                                                       | unbacked claims, ignored findings, missing question-primary                                                       |
| **The host model**         | on-demand                                                                                  | semantics, with full context — manifests + code_refs exist chiefly to make the CALLING model an effective auditor |
| Learning loop + evals      | longitudinal                                                                               | vacuous declarations as negative exemplars; §9's metrics as eval objects                                          |

## 6. Trust surfaces (review P7 — the anti-laundering rule, made enforceable)

Validation covers structure and internal consistency, NOT truth. Rules:

- A "structurally checked" badge may appear ONLY where the referenced code
  is one interaction away (artifacts panel deep-linking to the `code_ref`
  line). Surfaces that ship without code — the single-file HTML export —
  downgrade to "declared at computation time", no "verified" wording: a
  badge citing a line nobody can open is a dangling trust claim.
- MCP responses name the field `structural_checks` (never `verified`) and
  include a fixed caveat string hosts are likely to quote verbatim.
- A test asserts no UI string contains unqualified "verified".
- Legacy history entries (pre-findings persisted code) show
  "no manifest (pre-2026-08)" — never an empty findings tab (review P11).

## 7. Investigate: multi-step and cross-step (phase 5)

Investigate already has the two structures findings need: a
planner-declared dependency DAG (`depends_on`) and step-prefixed result
flattening. Findings ride both.

**7.0 Numbering, pinned** (review E4 — the off-by-one is real in the code):
`step_N` in finding namespaces, `derived_from_findings`, and citations is
**1-based** and equals planner index N−1; the DAG check is
`int(N) − 1 ∈ depends_on`. Prerequisite: the re-planner's step headers are
currently 0-based while the composer's are 1-based — fix the re-planner to
1-based BEFORE feeding it manifests, or it will misattribute lineage.

**7.1 Per-step declaration, namespaced merge.** Each sub-question declares
per §2; the merged manifest namespaces entries as `step_N.<name>` (dotted —
which is why §1 forbids dots in declared names). Names are unique within
their step; run-level uniqueness is derived.

**7.2 Derivation edges must follow the execution DAG.** Step-qualified
`derived_from_findings` entries are valid only for steps in the declaring
step's `depends_on` set — a derivation from a step whose results were never
received is hallucinated lineage or a missing dependency (advisory both
ways; a `depends_on` edge no derivation touches means a dependency consumed
silently).

**7.3 Cross-step coherence.** Entries from different steps with comparable
dtype+unit and definitions referencing the same columns, whose values
materially differ → an advisory _reconciliation_ item to the composer and
gap-check; the synthesis must reconcile or scope them (extends SCOPE
DISCLOSURE). Executive summaries stop papering over intra-investigation
disagreement.

**7.4 Findings as the investigation's working memory.** Planner, re-planner,
and gap-check consume the accumulated manifest projection (names,
definitions, tags — no values): next-wave planning sees what is
established, avoids recomputation, targets gaps structurally.

**7.5 Synthesis binding.** Executive summary and conclusion bind
`$finding:step_N.<name>.<field>`. The citation extractor's regex extends to
count these as step citations (today it matches only `$result:`-prefixed
`step_N_` forms — new-mechanism runs would false-fire "step never used");
`GroundingReport` gains OPTIONAL `citedFindings?` / `unnarratedFindings?`
fields with the dated-absence comment convention, so persisted reports keep
parsing (review E11).

Phase 1 pre-reserves only: the dotted namespace form, step-qualified
`derived_from_findings`, and the no-dots name rule.

## 8. Rollout (review P1 — an unflagged prompt change to 100% of runs is not a plan)

`findings.mode: "off" | "shadow" | "on"` in runtime-config (shared by
web/MCP/CLI).

- **shadow** (default at launch): helper preloaded, sidecar collected,
  validation + lints run, manifest lands in the run record and diagnostics
  — but ships to NO consumer (no composer injection, no MCP field).
- **on**: flipped per purpose — deep-dive first, dashboard last.
- Weak/local models (Ollama tier) stay in shadow until their §9 compliance
  numbers clear the bar.
- **Kill criteria** (auto-revert to shadow for the affected provider tier):
  retry-rate delta > +20%; code-gen output-token delta > +15%; manifest
  drop-rate (entries failing meta-schema) > 30%.
- **Cost budget**: ≤10% code-gen output-token increase, ≤5% total per-run
  cost increase, tracked in the per-phase cost line (review P12).
- Zero declarations on a claims-bearing question: advisory + diagnostics
  `declaration_compliance: false`, **never a retry** — a retry teaches
  speculative declaration, exactly what §2 exists to avoid (review P9).
- One **baseline week in shadow** before phase 2, so every phase-2 metric
  has a denominator.

## 9. Success metrics (review P2 — "did it work" must be answerable)

Recorded per run in diagnostics, aggregated on /diagnostics; the phase-4
gate is evidence, not vibes.

| Phase   | Metric                                                                                                                                                                                       | Meaning                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| P1      | declaration-compliance rate; manifest drop-rate; **re-run drift rate** (same question, identical data, N repeats: % manifests diverging in names/dtypes); derivation-contradiction fires/run | the run-3-vs-4 failure, measured  |
| P2      | un-narrated-finding rate; unbacked-claim rate; % direction words bound vs free-typed; directional-contradiction rate (existing field) trending down; question-primary miss rate              | user-visible truthfulness         |
| P3      | audit pass-rate on sampled claims-bearing entries; helper-vs-bespoke ratio; tag diversity                                                                                                    | semantics + the soft-cap watch    |
| P4 gate | re-run drift and contradiction rates must NOT regress after removing the convention prompt blocks, on the eval set                                                                           | go/no-go for retiring conventions |

P3 also commits manifest-quality objectives into the answer-quality-evals
harness (unparks that spec with concrete objects).

## 10. Residual risks (accepted, monitored)

- **Vacuous compliance** — reduced by §1 limits + audit + exemplars; not
  eliminated (eliminating it by rules rebuilds the cage).
- **Semantic wrongness behind valid structure** — reduced by the audit
  sample and host-model review; grounding-by-inspectability is a ratchet,
  not a proof.
- **Categorical-label exposure in names/keys** — inherent, precedented,
  stated in §1; not closable without closing the schema channel itself.
- **Helper gravity** — measured (§9 P3), answered with framing and exemplar
  diversity, not more helpers.

## 11. Phases (rescoped — review P4: v1's phase 1 fixed nothing a web user sees)

1. **Grammar, in shadow** — meta-schema + envelope + `declare_finding`
   (sidecar, never-raise, coercion, literal rule, code_ref offset) +
   validation/lints + the five §2.1 touch points + warm-container cleanup +
   run-record/CLI inclusion (`mcp-proof` asserts manifest presence) +
   **the caveat-chip rendering** (so §3's outcomes are visible — finishes
   an already-specced grounded-narrative roadmap item) + **the artifacts
   viewer "Findings" tab** (name/definition/dtype/value/code_ref
   deep-linked — the inspectability surface §6's whole trust story rests
   on, and the first screenshot-able artifact). Docs: manifest schema in
   docs/mcp.md + "legacy entries have no manifest" note.
2. **Binding — the first user-facing release** (gated on the shadow
   baseline): composer projection + `$finding:` resolution incl. both
   sweeps + grounding coverage both directions + question-primary lint +
   the **claim-provenance popover** (direction word → finding name,
   definition, code_ref → artifacts line: the demo moment and README hero).
   MCP field + contract bump + response caps. Docs: README "Grounded
   numbers" upgraded to the traces-to-a-line story.
3. **Audit** — review-gate findings-audit (sampled) + skill-provided audit
   rule hook + diagnostics counters + evals wiring + creating-skills.md.
4. **Retire** the naming-convention prompt blocks — ONLY on the §9 P4 gate.
5. **Investigate** (§7) — after the re-planner numbering prerequisite.

## 12. Review adjudication record

28 findings across two reviews; all 7 blockers and 13 majors accepted (with
mechanical fixes folded in above); notable adjudications:

- **Cap conflict reconciled**: PM proposed 50 entries/8KB, Eng 100/64KB —
  resolved as different surfaces: storage/validation cap 100/64KB (§1),
  MCP response cap 50/8KB (§4.3), composer budget 8KB whole-entry (§4.1).
- **`derived_from` split** into two fields chosen over resolution-order
  rules (E14's cleaner option).
- **Sidecar JSONL** adopted as THE design, not an alternative (E6): crash-
  surviving partial manifests are a feature, and envelope-independence
  removes the zod-strip silent-loss class entirely.
- **Skill audit rules** kept as a promise by scoping them into phase 3
  (P8's option A) rather than struck.
- v1's `analysis.py:41` example was itself wrong twice (filename and
  offset, E5) — kept corrected in §2.4 as a reminder that inspectability
  claims need the same rigor as the code they cite.

## 13. Implementation record (2026-08-06, same day)

Shipped, default mode SHADOW per §8:

- **P1 grammar**: contracts/findings.ts + lib/findings (meta-schema, limits,
  last-wins merge, derivation/dominant-term lints, cross-step lints,
  numeral-scrubbed projection, namespacing) — 13 lib tests.
  `declare_finding` in BOTH runtimes (package + prelude fallback, atomic
  override import), sidecar JSONL, never-raise, declaration-time coercion,
  Python-AST literal rule, self-measuring prelude offset for
  generated-code-relative code_refs, stat helpers with exact pure-python
  p-values — 18 new unittest cases. Envelope carries `findings` (zod schema
  extended — no silent strip), warm-container cleanup includes the sidecar,
  runtime-config `findings.mode`, per-run diagnostics with compliance flag.
  UI: artifacts "Findings" tab with real CodeMirror line-jump on code_ref,
  §6 trust copy, legacy/no-manifest states; grounding advisories rendered
  on all three surfaces — 9 component tests.
- **P2 binding**: composer projection block (mode "on"), `$finding:` resolver
  passes (value/inline/object forms; structured values refuse bare inline)
  with BOTH final sweeps extended and a distinct failure class; pre-resolution
  citation tracking; unnarrated/question-primary/coherence fields on
  GroundingReport; MCP 0.8.0 with response caps + `findings_truncated`;
  verify_narrative ships `structural_checks` + fixed caveat string.
- **P3 audit**: review-gate FINDINGS AUDIT instruction (pre-execution — the
  literal definitions sit beside the computing code, so the
  "consistent-without-a-test" class is checkable before anything runs).
- **P5 core**: re-planner headers fixed to 1-based (the §7.0 prerequisite),
  citation regex counts `$finding:step_N.` bindings, per-step validate →
  namespace → DAG-checked derivations → cross-step reconciliation lint,
  merged manifest on investigate artifacts.

Deliberately NOT shipped (with reasons):

- **P4 retirement** — evidence-gated by §9's own rule; the naming-convention
  prompt blocks stay until the shadow-baseline metrics clear the gate.
- Investigate SYNTHESIS projection + re-planner working-memory injection
  (§7.4/§7.5 prompts) — the merged manifest exists on artifacts; the prompt
  plumbing is the next slice.
- The P2 claim-provenance popover — Findings tab + code_ref jump shipped;
  the in-dashboard popover is UI polish on top of the same data.
- Skill-shipped audit rules hook (P3) — the review gate audits all code
  incl. skill helpers already; a per-skill rule registry awaits a real skill
  needing it.

**Amendment (2026-08-06, product decision):** shadow-first rollout SKIPPED —
`findings.mode` defaults to **"on"**; full pipeline live everywhere
(code-gen declarations, composer projection + $finding binding, grounding
advisories, MCP manifest, investigate synthesis binding). The §8 kill
criteria remain operative via the flag (`shadow`/`off` are the fallback
lever, one runtime-config edit, no restart). §9's metrics still record on
every run — the baseline now accrues in production rather than before it.
Remaining deferred: the re-planner working-memory prompt block (§7.4's
planner-side injection; the merged manifest already reaches artifacts and
the synthesis) and the provenance popover.
