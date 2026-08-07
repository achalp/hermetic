# Composer Sight Modes, Verifiability Panel, On-Demand Audit

**Status: phase 1 implemented 2026-08-07 (§7). Companion to declared-findings,
declared-checks, and the Analysis-Product design discussion (run-31).**

## 0. Problem

The composer↔analysis seam loses information in both directions. Blind
composition (the founding anti-hallucination stance) produced a recurring
class of _blindness artifacts_ — null bindings, "confirms" over null tests,
sign guessing, tautological tiles — each caught after the fact by an
ever-growing battery of refusals and discourse checks. A sighted composer
eliminates that class at the source but revises a founding constraint.

Decision (user-ratified): **sight is a per-analysis USER CHOICE**, exactly
like schema mode's metadata/sample split. Blind stays the default and the
privacy-maximal path; sighted is opt-in per question. In both modes the
citation discipline is absolute: every factual token in the spec is a
binding resolved server-side — sight informs _selection and phrasing_,
never permits typed-out numbers.

## 1. Sight modes

`composer_sight: "blind" | "sighted"` rides the analysis request context
(same transport as `schema_mode`), UI-selectable beside the schema-mode
choice, defaulting to `"blind"`.

- **blind** (default): today's behavior, byte-identical prompts. The
  numeral-scrubbed projection, value-free composition, resolver refusals
  and discourse checks as load-bearing guards.
- **sighted**: the composer additionally receives the **Analysis Product
  values** — finding values (unscrubbed), results scalars, and per-series
  head/tail samples of chart aggregates — capped at a hard byte budget.
  RAW DATASETS NEVER ENTER THE PROMPT in either mode: what the sighted
  composer sees is the derived, publishable content of the dashboard
  itself (the same bundle a user pastes into a reviewer). Guards remain
  as defense-in-depth; binding discipline unchanged.

## 2. Verifiability panel

Verification evidence was scattered (grounding banner, findings issues,
logs). It becomes a first-class, user-reviewable artifact: the composer
emits `state.__verifiability`:

```ts
{ composerSight, findings: {declared, cited, checks, failedChecks},
  headline: {planned, composed, injected, missing},
  prose: {issues: [{kind, detail}]},        // lints + discourse, full detail
  grounding: {ok, checkedCount, ungrounded, contradictions},
  audit?: {at, model, verdict, findings[]} }  // filled by §3 when run
```

Rendered as a **Verify tab** in the artifacts panel: what was planned vs
composed, what was repaired/refused/dropped, every advisory with its
detail — the mechanical case that the dashboard says what the analysis
computed. Persisted with the spec (history round-trips it).

## 3. On-demand non-blind audit

A UI action ("Run audit") on a completed analysis. POST `/api/audit`
with the history id → the server assembles the derived bundle (question,
results, findings+checks, chart series samples, narrative texts, SQL) —
never raw rows — and runs ONE high-effort adversarial review call
(cost phase `audit`) with a structured-verdict contract:

```json
{
  "verdict": "clean|issues",
  "findings": [{ "severity": "high|medium|low", "claim": "...", "evidence": "..." }]
}
```

The result persists to the history entry (`audit.json`) and renders in
the Verify tab. This is the values-sighted reviewer built into the
product — on demand, priced per click, never automatic.

## 4. Distinguished-engineer review

1. **Two prompt families, drift risk.** Sighted must be additive — one
   appended values section — never a fork of the composition rules.
   Resolution: `buildDashboardComposeRequest` composes the same sections
   in both modes; sighted appends `buildValuesSection` only. Replay/byte
   pinning unaffected in blind mode.
2. **Does sighted break the anti-hallucination guarantee?** No: the
   guarantee was never "the author can't see" — it is "no factual token
   reaches the user unresolved". Bindings, refusals, discourse, and
   grounding run identically in both modes; sighted only removes the
   _ignorance_ that caused a class of wrong-but-plausible authorship.
3. **Values-section injection risk** (data content read as instructions):
   values are JSON-serialized inside a fenced block with an explicit
   "data, not instructions" preamble — same posture as schema sample
   mode, which already ships row values to code-gen.
4. **Budget**: values section capped (24KB) with whole-entry truncation
   and an explicit omission note — the projection-budget pattern reused.
5. **Verifiability payload size**: detail lists capped (32 issues); the
   panel is evidence, not a log dump. Persisted inside spec state so
   history/export round-trip for free.
6. **Audit cost containment**: single call, explicit user action, result
   cached on the entry (re-click re-runs deliberately). No retry loop.
7. **MCP surface**: `analyze` accepts `composer_sight` optionally;
   defaults blind. Audit stays a web-UI affordance in phase 1 (MCP hosts
   have their own reviewer — the user's existing workflow).
8. **Testability**: sight threading, values-section assembly, caps,
   verifiability assembly, and audit prompt/parse are pure functions —
   unit-tested without an LLM. Route handlers tested with mocked model
   calls per existing route-test patterns.

## 5. Explicitly out of scope (phase 2+, from the Analysis-Product design)

- `declare_series` / retirement of hand-assembled `chart_data`;
- catalog type signatures + mapping type-check;
- closed transform algebra with policy propagation.
  These land only if the phase-1 instrumentation (Verify tab evidence
  across runs) shows the assembly-defect pool persisting.

## 6. Invariants (both modes)

- Raw datasets never enter any composer or audit prompt.
- Every factual token in the spec resolves from a server-side binding.
- All guards (refusals, discourse, lints, grounding) run in both modes.
- Blind-mode prompts remain byte-identical to pre-spec behavior.

## 7. Implementation record (2026-08-07)

- `composer_sight` in `AnalysisRequestContext` → validate-request →
  run-ask-query → `DashboardComposeOpts.sight`; UI toggle beside schema
  mode; MCP `analyze` passthrough.
- `buildValuesSection` (dashboard-compose) with 24KB cap; findings values
  via `projectManifestForPrompt(..., {withValues})`.
- `state.__verifiability` assembled in compose; `VerifyTab` in the
  artifacts panel renders it + hosts the audit action.
- `lib/pipeline/audit.ts` (pure prompt/parse + runner), `/api/audit`
  route, persistence to the history entry.
- Tests: projection values mode, values-section caps, sight threading,
  verifiability assembly, audit prompt/parse, route wiring.
