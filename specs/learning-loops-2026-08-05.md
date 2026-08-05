# Learning loops — "every failure is a data loop": assessment & roadmap

> Created: 2026-08-05
> Status: ASSESSMENT + TODO — parked for later pickup. The state map below
> was produced by a full-codebase investigation (file:line evidence spot
> notes retained); the opportunity list is ranked by leverage and is the
> intended pickup order.
> Related: `specs/answer-quality-evals-wip-2026-08-05.md` (opportunity #1
> feeds it: every correction-derived skill doubles as an eval case),
> `specs/skills-and-custom-modules-2026-07-22.md`,
> `release-notes/hermetic-blog-post-july.md` ("What comes next": correcting
> a flawed analysis once should be enough to teach the tool — still
> unshipped, this spec is its plan).

## 1. Verdict

**The sentence is true for exactly one horizon: the next attempt of the
same run.** Within a run, the loops are genuinely strong. Beyond the run
boundary, hermetic is a diligent diarist that never rereads its diary: it
records nearly everything about its own failures and consumes none of it.
The only channel from "this analysis was wrong" to "future analyses are
right" is a human reading `/diagnostics` or `data/runs/`, deciding what
the rule is, and hand-writing a `SKILL.md` — which the app has no code
path to create (GET /api/skills is read-only by design; no UI consumes
even that).

## 2. State map (what exists today)

### 2.1 Per-attempt / per-run — real and strong (all automatic)

| Loop                   | Signal → consumer                                                             | Notes                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Python retry           | full `(code, error)` attempt history → retry prompt (`buildRetryPromptMulti`) | anti-repetition instruction at ≥2 attempts; MAX_RETRIES=3                                |
| Semantic retry         | `validateExecutionResult` degenerate-output verdict → pseudo-traceback retry  | "ran clean but garbage" burns a retry; MAX_SEMANTIC_RETRIES=1                            |
| Review gate            | critic findings → `generateFixedCode` before execution                        | rules = 2 hardcoded + skill-contributed; MAX_REVIEW_REDOS=1                              |
| SQL repair             | engine error + failed SQL → `repairSQL`                                       | memoryless across repairs (sees only last attempt); static ~9-signature repair catalogue |
| Skill failure hints    | OOM/kill markers + phase → hint concatenated into retry error                 | hints static, human-authored (3 built-in skills)                                         |
| Investigate re-planner | step status + errorPreview → continue/amend/stop between waves                | composer can also demand 1–2 gap-fill steps                                              |

Deliberate scope limits worth knowing: skill activation is frozen at run
start (prompt-cache prefix), so a run cannot activate a new skill in
response to its own failure; timeout/stopped/user-config failures fail
fast without learning.

### 2.2 Per-session — half-real (RAM, TTL'd, lost on restart)

- **Conversation cache**: 5 turns, 1h sliding TTL, structure-only
  (result-key types, chart shapes, warehouse SQL). **Success-only — a
  failed turn teaches the conversation nothing.** Not persisted; history
  restore rebuilds ONE synthetic turn.
- **Investigation scope** (drill-down inheritance): reconstructed
  client-side from the rendered spec; dies on reload even though
  `data/history/` holds the same spec.
- **Artifacts/code caches**: "last success's outputs" for
  edit-and-rerun/save; zero failure information; 1h / 10min TTLs.
- **Auto-investigation budget**: cost governor, not learning.

### 2.3 Durable-automatic — thin, outcome-blind

Schema cache (fingerprint-gated shape memory, no notion of run outcome)
and recent-sources (access counts, never outcomes). **Absent entirely:**
circuit breakers, consecutive-failure counters, learned provider/runtime
fallbacks, duration calibration (the estimator's own comment cites
12–56min measured variance for the same query and refuses to use it).

### 2.4 Durable-manual — the human IS the write path

- **Skills**: the intended durable loop; authoring 100% by hand on disk;
  hot-reload works; no draft/propose/write flow exists anywhere.
- **Edit-and-rerun**: the user's corrected code re-executes with no retry
  and no learning; the correction lands in artifacts cache/history and is
  never fed to a future code-gen prompt as an exemplar.
- **Golden transcripts / replay fixtures**: regression pins, deliberately
  not exemplars (retry-loop journey itself still unrecorded).

### 2.5 Captured-but-unconsumed — the dead ends (ranked by wasted signal)

1. `data/diagnostics/*.jsonl` — retry classes, escalations, degraded/failed
   steps, wall times, 90-day retention, aggregated on `/diagnostics` —
   consumed by zero prompts, rules, or gates. Its own header states the
   goal ("rank the real failure modes by frequency"); the ranking
   terminates in a browser tab.
2. `data/runs/<id>/` — per-attempt code (written BEFORE execution),
   errors, exec diagnostics, review findings, skill activations — literally
   no reader but its own pruner.
3. Review-critic findings journaled per-attempt with calibration intent
   (the "minor finding → 16-min OOM" incident is recorded in a comment);
   no aggregation of rule-hit or false-positive rates.
4. **The taxonomy mismatch**: `classifyFailure` emits exactly the classes
   (`py_KeyError`, `semantic_no_output`, `sql_exec`, …) that
   `RETRY_GUIDANCE`'s "common fixes" list addresses — but the list is a
   frozen string literal. Observed distribution and guidance are wired to
   different sinks and never meet.
5. Grounding verdicts (`verifyGrounding` — untraceable narrative numbers)
   render a caveat and ship; never trigger a recompose, never record a
   pattern. `auditComputedKeys` warn-only by design.
6. Sub-question errors evaporate at run end (re-planner sees them
   mid-run only).
7. **Successes as unlearned as failures**: no exemplar bank; a
   third-attempt success teaches nothing to attempt 1 of the next similar
   question.

## 3. Opportunities — ranked pickup order

- [ ] **#1 Correction → skill draft** (the promised loop; cheapest close;
      biggest differentiator). Every ingredient exists: edit-and-rerun has
      the failed original AND the human's correction; history stores both;
      skills hot-reload from disk. Build: diff the correction → model
      drafts a `SKILL.md` (guidance + review rule + failure hint) →
      approval UI → write file. Converts "a human said _no, like this_"
      from evaporating cache state into a durable enforced rule. Also the
      adoption story ("your corrections compound") and each accepted
      draft doubles as an eval case (evals spec tie-in).
- [ ] **#2 Failure-frequency → prompt guidance.** Feed the diagnostics
      ranking into `RETRY_GUIDANCE` / SQL-repair instructions (periodic or
      build-time step; per source-type). Low risk — these prompts are
      advisory; replay fixtures force honesty about when guidance changed.
- [ ] **#3 Exemplar memory (learn from success).** Retrieval of verified
      past code ("worked on similar schema/question — ran, passed semantic
      validation, got grounded") into code-gen prompts. Vanna's RAG trick
      at the analysis level, with verification hermetic uniquely has.
      History already keys code by schema/domain.
- [ ] **#4 Grounding verdicts should bite.** One recompose retry when
      `verifyGrounding` fails (symmetric with the executor's semantic
      retry). Reconsider warn-only for `auditComputedKeys`.
- [ ] **#5 Persist the session loops that already work.** Conversation
      turns (structure-only → privacy-cheap) + investigation scope ride
      the history entry they're adjacent to; record FAILED turns too
      ("tried X, failed with Y") so follow-ups don't re-hit the wall.
- [ ] **#6 Calibration from measured reality.** Run-duration estimates
      from recorded wall times; review-rule hit/false-positive aggregation
      feeding gate thresholds. Both are counters away from
      self-calibrating.

## 4. Design constraints for whoever picks this up

- **Prompt-cache discipline**: skill activation is frozen per run for
  prefix caching — any "learned content in prompts" must respect that
  (per-run granularity, stable ordering, and replay-fixture hashes will
  flag every change loudly; re-record deliberately, never silently).
- **Privacy posture**: learned artifacts must stay structure/method-level
  (the conversation cache's values-free rule is the precedent); exemplar
  code is fine (it's hermetic-generated), user data values are not.
- **Human-in-the-loop for durable writes**: a skill draft is a PROPOSAL —
  approval before the file lands (same consent instinct as the MCP
  installer). Automatic writes are for counters and rankings, not rules.
- **The diary must stay honest**: pruning/retention already exists
  (200 runs / 90 days); new consumers must tolerate gaps rather than
  assume complete history.

## 5. One-line summary

Today: "every failure is a _retry_ opportunity, and a diary entry nobody
reads." The distance to making the sentence true is not new
infrastructure — it is six read-paths into data already being written.
