# Golden Fixture Recording Pass (one-time, requires a real API key)

The modularization safety net (spec: `specs/modularization-phase-1-implementation-plan-2026-08-01.md`)
bootstraps from **one real recording session**: real LLM calls, your key, a
few dollars, once. Everything after this pass runs free and offline — the
golden-transcripts CI job replays committed fixtures and never touches a
provider — until a prompt intentionally changes, at which point the PR that
changes it re-records and commits the diff.

## Prerequisites (one-time check)

1. `ANTHROPIC_API_KEY` set (or your usual provider config).
2. Docker running with the sandbox image built:
   `docker image inspect hermetic-sandbox` — if missing:
   `docker build -t hermetic-sandbox ./docker/sandbox/`.
3. **No dev server already running on :3000.** A server started without the
   record flag captures nothing.

## The recording pass

```bash
# Terminal 1 — server in record mode
HERMETIC_LLM_MODE=record pnpm dev

# Terminal 2 — drive the journeys
HERMETIC_LLM_MODE=record pnpm golden:record
```

What happens: the runner uploads `test-specs/data/01-saas-mrr.csv` and runs
three journeys — a basic ask, a follow-up on the same data, and an
investigate. Terminal 1 logs `[llm-replay] record mode` at boot. Every LLM
call is captured to `test-fixtures/llm/<costKey>-<hash>.json`; each journey's
normalized NDJSON stream lands in `test-fixtures/golden/<journey>.ndjson`.
Expect a few minutes and roughly single-digit dollars (investigate is
multi-wave and dominates the cost).

## Canonical goldens are recorded in REPLAY mode

Live recording captures the LLM fixtures, but live transcripts contain
timing-dependent frames (keepalives, progress cadence). After the live pass,
regenerate the goldens against a replay server — fully offline, seconds per
journey — so the committed transcripts are deterministic:

```bash
# server: HERMETIC_LLM_MODE=replay pnpm dev
HERMETIC_LLM_MODE=replay pnpm golden:record   # regenerate goldens from fixtures
```

## Verify the loop closes offline

```bash
# Restart the server in REPLAY mode — no real key needed, no provider network
HERMETIC_LLM_MODE=replay ANTHROPIC_API_KEY=test-key pnpm dev

# In another terminal
HERMETIC_LLM_MODE=replay pnpm golden:check
```

All three journeys printing `ok` proves the pipeline end-to-end. Then:

```bash
git add test-fixtures/
git commit -m "Record golden fixtures (journeys: ask-basic, ask-followup, investigate)"
```

The moment goldens exist on the branch, the `golden-transcripts` CI job
self-activates (gated on `hashFiles('test-fixtures/golden/*.ndjson')`) and
every future PR replays the journeys offline.

## If something trips

- **`LLM replay miss` on a later check** (especially the next day): something
  nondeterministic is inside a prompt — the classic is a current date embedded
  in prompt text, which changes the request hash. Report the `costKey` from
  the error message; the prompt's date source needs pinning. This is exactly
  the class of ambient assumption Phase 1 removes.
- **Transcript MISMATCH (not a miss)**: LLM responses were identical but the
  stream differed — the normalizer (`scripts/golden/normalize.mjs`) missed a
  volatile field. The runner writes `<journey>.received.ndjson` next to the
  golden and prints the first differing line; extend the normalizer's
  `VOLATILE_KEY_RE` (or uuid handling) accordingly.

## Ongoing discipline

- A PR that **intentionally** changes prompts or stream protocol re-records
  and commits the fixture diff **in the same PR** — review it like a schema
  migration.
- A golden diff in a PR claiming to be a pure refactor is a regression, by
  definition (implementation plan §1.5, "move, don't improve").
- The runner refuses to run without `HERMETIC_LLM_MODE` exported (or an
  explicit `--allow-live`), so a casual `golden:check` can never silently
  drive a live-mode server and spend tokens.

## Journey coverage

Recorded now: `ask-basic` (journey 1), `ask-followup` (6), `investigate` (4).
Remaining journeys from implementation-plan §1.2 land as additive recordings:
retry-loop (2, needs a failure-inducing fixture), warehouse (3, needs the
stub connector), reruns (5), reattach (7), history/saved (8).
