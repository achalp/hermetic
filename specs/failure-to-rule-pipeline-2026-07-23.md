# Failure→Rule Pipeline: provenance, telemetry, and postmortem drafting

**Date:** 2026-07-23
**Status:** Design — builds on the skills registry (`specs/skills-and-custom-modules-2026-07-22.md`) and the pre-execution review gate (`specs/pre-execution-code-review-gate-2026-07-18.md`)
**Motivating incident:** run `ebbe0d4e` — a 5-box OR in winner hydration defeated parquet pushdown, turned a seconds-long read into a 10+ hour triple full scan, and was only diagnosed manually. The fix (SCAN-OR rule + guidance patch) took ~20 minutes of hand work. This spec mechanizes that loop.

## Thesis

The system's durable asset is its rulebook: every expensive failure becomes a named rule,
and a named failure class never recurs. Today that loop is manual at every step —
diagnosis, naming, wiring, and knowing whether a rule still earns its prompt-attention
cost. Three subsystems close it:

- **A. Provenance** — every rule records which run birthed it and what it cost.
- **B. Telemetry** — journals are aggregated so rules are managed (pruned, promoted,
  recalibrated) from data instead of taste.
- **C. Postmortem pass** — an expensive failure automatically produces a _drafted_
  candidate rule for human approval; approval is one command.

Plus a migration mechanism (**D**) for moving rules down the enforcement ladder
(prose → LLM critic rule → deterministic precheck → harness invariant) so the critic's
attention budget doesn't grow monotonically.

A design constraint inherited from the review-gate spec: **the judge stays separate from
the writer**, and now the _postmortem analyst_ stays separate from both. Every stage is
fail-open — a broken pipeline stage must never block or slow a run.

---

## A. Rule provenance

### A1. Structured rules

`SkillDefinition.reviewRules` is currently a single joined string. Evolve it to accept
structured rules while keeping the string form working (user SKILL.md files and existing
builtins parse unchanged):

```ts
// skills/types.ts
export interface ReviewRule {
  /** SHOUT-KEBAB id, e.g. "SCAN-OR". Unique across the active rule set. */
  id: string;
  /** The "when to flag" body (everything after the em-dash today). */
  text: string;
  /** Where the rule came from. Never emitted into any prompt. */
  born?: {
    runId?: string;      // e.g. "ebbe0d4e"
    date?: string;       // ISO date
    incident?: string;   // one sentence: what failed and how expensively
    costNote?: string;   // e.g. "~3h wall + full-theme S3 re-scan, run killed"
  };
  /** Optional deterministic precheck — see section D. */
  precheck?: RulePrecheck;
}

// SkillDefinition:
reviewRules?: string | ReviewRule[];
```

Prompt emission is unchanged byte-for-byte: structured rules render as
`` `${id} — ${text}` `` joined by newlines — the same "ID — when to flag" lines the
critic sees today. Provenance costs zero tokens. The registry's aggregation
(`ActiveSkills.reviewRules: string[]`) keeps its type; a parallel
`ActiveSkills.reviewRuleMeta: ReviewRule[]` carries the structure for observability.

SKILL.md gains an optional structured form alongside the existing string:

```yaml
reviewRules:
  - id: COHORT-PIVOT
    text: "…when to flag…"
    born: { runId: "1a2b3c4d", date: 2026-07-20, incident: "…" }
```

(zod: `z.union([z.string(), z.array(ReviewRuleSchema)])`; the string form is split on
`/^([A-Z][A-Z0-9-]+) — /m` best-effort into ids for telemetry, falling back to an
opaque single entry.)

### A2. Backfill

One-time: convert the builtin rules to structured form with provenance recovered from
memory/spec history (SCAN-OR ← `ebbe0d4e`; MEM-RING ← the 18-min metro-ring OOM;
GUARD-NULL ← the NULL-polygon "no candidate" run; etc.). Where the runId is lost, record
`incident` only. This is a mechanical edit + equivalence-snapshot no-op (emitted text
unchanged).

### A3. The ledger

A generated document — never hand-edited — joining provenance with telemetry (B):

- `scripts/rules-ledger.ts` (run via `pnpm rules ledger`) walks the registry (builtin +
  user skills), emits `data/skills/RULES.md` (human) and `data/skills/rules-ledger.json`
  (machine). One row per rule: id, owning skill, origin, born (runId/date/cost),
  firings/outcomes since born, precheck status.
- The ledger is the artifact you consult before adding a rule (does the mechanism already
  have a name?) and during pruning (has this rule fired in the last N hundred runs?).

---

## B. Rule telemetry

### B1. What the journals already record

`data/runs/<id>/journal.jsonl` (run-recorder) has everything needed per run:
`review` events with `{attempt, severity, findings:[{rule, severity, message}]}`,
`codegen`, `exec` events with `{success, errorKind, executionMs}`, `final`, and
`skills.json` naming the active skills/rules. Two gaps to close at write time:

1. **`hint_fired`** — when a `SkillFailureHint` matches a failing phase, record
   `{type:"hint_fired", skill, pattern, phase}` via `recordRunEvent` (today it only hits
   the logger). Symmetric with review findings: hints are rules too, just later on the
   ladder.
2. **`precheck` events** — when a deterministic precheck (D) fires:
   `{type:"precheck", rule, attempt}`.

### B2. Aggregation

New module `src/lib/skills/rule-telemetry.ts` — pure function over the runs dir (bounded
by the existing 200-run prune), no live coupling to the pipeline:

```ts
export interface RuleStats {
  rule: string;
  owner: string; // skill name, from skills.json
  firedRuns: number; // runs with ≥1 finding for this rule
  firedSevere: number;
  firedMinor: number;
  probableSaves: number; // fired on attempt N, run ultimately succeeded
  ineffective: number; // fired, redo happened, run STILL failed expensively
  lastFired?: string; // ISO date
  neverFiredSince?: string; // born date, when firedRuns === 0
}
export async function aggregateRuleStats(runsDir?: string): Promise<RuleStats[]>;
```

Honest attribution limits, stated in the ledger header: a **probable save** is a proxy —
we cannot observe the counterfactual failure. The strong signals are the tails:
`neverFiredSince` (prune candidate — or the failure class is extinct, which is the same
decision), and `ineffective` (the rule fires but the redo doesn't fix it — the rule needs
to move down the ladder or its text needs sharpening).

Surfaces: `pnpm rules stats` (table to stdout), consumed by the ledger generator. No UI
in milestone scope; `data/skills/rules-ledger.json` is the API if the diagnostics UI
wants it later.

---

## C. Postmortem pass (auto-drafting)

### C1. Trigger

Two paths, one implementation:

- **Automatic:** at run finalization (where the `final` journal event is written), an
  expensive failure enqueues a postmortem. Expensive =
  `!success && (executionMs > POSTMORTEM_MS || errorKind ∈ {oom, killed} || attempts ≥ 3)`
  with `POSTMORTEM_MS` default 10 min (`HERMETIC_POSTMORTEM_MS`). Gated behind
  `HERMETIC_POSTMORTEM=1` until trusted. Fire-and-forget, same discipline as the
  run-recorder: postmortem must never delay finalization.
- **Manual:** `pnpm postmortem <runId>` — required for failures only a human recognizes
  (ebbe0d4e ended `errorKind:"stopped"`, which is ambiguous between "user changed their
  mind" and "user killed a doomed run"; auto-triggering on `stopped` alone would
  postmortem every abandoned query). Auto-trigger includes `stopped` **only when**
  `executionMs > POSTMORTEM_MS` — a run someone let grind for 10+ minutes before killing
  was almost certainly a doomed run, not a whim.

### C2. Evidence bundle

Assembled from the run dir — this is why the run-recorder exists:

- `meta.json` (question, mode, model), full `journal.jsonl` timeline
- the final attempt's code (+ earlier attempts' error/diag heads, truncated)
- `skills.json` — **which rules the critic already had**; the analyst must know what was
  already checked so it reports a _gap_, not a duplicate
- the current rulebook: all active-skill rule ids + texts (from the registry, not the
  prompt) and existing failure-hint patterns
- the death context: last progress phase, stderr tail, exec diag

### C3. The analyst

One LLM call (model: `CODE_REVIEW_MODEL` — same judge-tier reasoning, same cost logic:
a few thousand tokens vs hours of wasted scan). Structured output, zod-validated:

```ts
interface PostmortemVerdict {
  diagnosis: string; // what actually failed, mechanically
  mechanism: string; // the generalized failure class, engine-level
  novel: boolean; // false → name the existing rule that should have fired
  existingRule?: string; //   …and whether it fired-but-was-ignored vs missed
  proposal?: {
    targetSkill: string; // owning skill for the new rule
    rule: { id: string; text: string };
    failureHint?: { pattern: string; hint: string };
    guidanceNote?: string; // suggested prose addition for the skill body
  };
  confidence: "high" | "medium" | "low";
}
```

Prompt requirements distilled from the SCAN-OR incident:

- **Mechanism altitude, enforced.** The prompt demands the rule name the _engine
  mechanism_ ("OR of multi-column conjunctions cannot push into zonemap pruning"), never
  the incident ("don't OR five hydration boxes"). Incident-altitude rules don't
  generalize; the analyst is explicitly told the rule will be judged on whether it would
  catch the same mechanism in a different domain.
- **Dedup against the rulebook.** If the mechanism is already named, the output is a
  calibration report (rule exists but didn't fire / fired minor and was under-weighted),
  not a new rule. `novel:false` verdicts are still recorded — they are the signal that a
  rule needs sharpening or ladder migration, feeding B2's `ineffective` count.
- **Root-cause the guidance, not just the code.** The analyst is asked _what in the
  active guidance steered generation toward the failing pattern_ (for SCAN-OR: the
  IN-list skeleton + shapeless "second remote read" + scan-minimization pressure). That
  lands in `guidanceNote` — the fix is often a guidance patch _plus_ a rule.

### C4. Proposals are never auto-applied

Output lands as a reviewable file, journal event, and nothing else:

- `data/skills/proposals/<runId>-<ruleId>.md` — a complete SKILL.md-format fragment
  (frontmatter `reviewRules` entry with `born` pre-filled from the run, optional
  `failureHints` entry, guidance note) plus the analyst's diagnosis as prose.
- Approval:
  - **User-skill target:** `pnpm rules approve <proposal-file>` appends the rule to the
    target SKILL.md's frontmatter (or scaffolds a new user skill when none fits),
    deletes the proposal, regenerates the ledger. Live at next run — no rebuild.
  - **Builtin target:** the proposal stays a draft; promotion into the TS module is a
    deliberate code change (edit, tests, equivalence-snapshot update, PR). The command
    prints the target file and the exact block to paste. This asymmetry is intentional:
    builtin rules ship to everyone and deserve code review.

Rejection is `rm` (or `pnpm rules reject <file>`, which also records the rejection in a
`proposals-log.jsonl` so a repeatedly re-proposed mechanism becomes visible instead of
silently re-drafted every failure).

---

## D. Ladder migration: deterministic prechecks

Rules whose pattern is mechanically checkable should not spend LLM-critic attention:

```ts
export interface RulePrecheck {
  /** Regex source applied to the generated Python (multiline). High precision
   *  required: a precheck match is treated as a DEFINITE finding. */
  pattern: string;
  /** Feedback message when it fires (same voice as critic messages). */
  message: string;
}
```

- Runs host-side in `code-review.ts` _before_ the LLM call — plain regex over the code
  string, zero latency, zero tokens, deterministic. A precheck hit produces a finding
  `{rule, severity:"severe", message}` merged into the same redo path; the LLM critic
  still runs for everything else.
- Precision policy: prechecks are for patterns with effectively zero false-positive rate.
  SCAN-OR's candidate: an `OR` joining parenthesized groups that each contain a
  `bbox.` comparison, inside a `duckdb.sql(...)` string. If a pattern can't hit that
  bar it stays LLM-only — a false-positive severe finding forces a pointless redo, which
  is worse than critic attention.
- Shrink policy: once a precheck has ≥3 confirmed catches and 0 observed false positives
  (from B's telemetry), the rule's prose in the critic prompt collapses to its one-line
  id + pointer, reclaiming attention budget. The full text lives on in the ledger.
- End state for any rule is level 5 (harness invariant — like the `.df()` cap or the
  threads clamp) when enforcement can be made unconditional; prechecks are the staging
  area that proves a rule out.

---

## Milestones

**M1 — Provenance (no behavior change).**
Structured `ReviewRule` + string-form compat; builtin backfill; SKILL.md union schema;
`pnpm rules ledger`. Equivalence snapshots must not change (emission is byte-identical).
Tests: rendering equivalence string-vs-structured; SKILL.md parse of both forms; ledger
output golden test.

**M2 — Telemetry.**
`hint_fired` journal event; `rule-telemetry.ts` aggregation; `pnpm rules stats`; ledger
joins stats. Tests: aggregation over a fixture runs dir covering fired/saved/ineffective/
never-fired cases; hint event write.

**M3 — Postmortem.**
Trigger wiring (flagged) + manual CLI; evidence bundler; analyst call + zod verdict;
proposal writer; `pnpm rules approve|reject`. Tests: trigger predicate table
(oom/killed/stopped×duration/attempts); bundler on a fixture run dir; verdict parse
fail-open; approve appends valid SKILL.md frontmatter (round-trips through the parser);
builtin-target prints-not-writes.

**M4 — Prechecks.**
`RulePrecheck` on `ReviewRule`; host-side pass in `code-review.ts`; SCAN-OR precheck as
the pilot; precheck findings in journal + telemetry; shrink policy applied manually first.
Tests: SCAN-OR precheck against the actual `ebbe0d4e` attempt code (must fire) and the
successful `03501b18` per-box loop (must not); merged-findings redo path.

## Decisions taken (defaults, overridable)

- Postmortem auto-trigger threshold 10 min; `stopped` counts only past the threshold.
- Proposals are never auto-applied; user-skill approval is one command, builtin approval
  is a code change by design.
- Provenance/telemetry never enter any prompt — zero token cost, forensics only.
- Prechecks are definite findings; anything short of near-zero false-positive precision
  stays with the LLM critic.
- All new stages are fail-open and fire-and-forget, matching the run-recorder discipline.

## Non-goals

- No UI in this scope (ledger + CLI only; `rules-ledger.json` is the future UI's feed).
- No cross-installation rule sharing.
- No auto-migration of rules to harness invariants (level 5) — that remains a deliberate
  engineering act per rule.
- No attempt to measure true counterfactual savings; telemetry reports proxies and
  labels them as such.
