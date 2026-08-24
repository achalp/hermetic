# CLAUDE.md — engineering knowledge for AI agents working on hermetic

Auto-loaded by Claude Code sessions. Distilled from adversarially-verified
review cycles (PRs #98–#119: security, correctness, performance, L3 path-walk).
Findings below were TRACED, not assumed — do not re-litigate without new evidence.

## Do NOT "fix" these (verified intentional / fixes were refuted)

- `sql-guard.ts stripNoise` ends strings at the first unescaped quote ON PURPOSE:
  shortest-string → maximal keyword scanning → a write is never hidden. Adding
  backslash-escape handling INTRODUCES a Postgres bypass (`\` is literal there).
- Do NOT dedupe the "duplicate" regime profiles in `finding_correlation`/
  `finding_heterogeneity`: they run over DIFFERENT arrays (raw vs post-screen);
  reuse flips Pearson/Spearman and ANOVA/Kruskal dispatch.
- `lazyChart` uses `jsonValueEqual` (JSON-semantics structural compare), NOT a
  shallow compare: `resolveElementProps` rebuilds literal props with fresh
  identities every render — shallow compare would defeat the memo entirely.
- Snowflake connector stays BUFFERED: its only streaming path is an event
  stream unverifiable without a live warehouse; blind switching risks a
  per-query correctness regression (other 4 connectors stream with byte budget).
- The egress proxy is written per-run from the HOST, never baked into the
  image: it is the security boundary; a stale image must not run an old proxy.
- The exact p-value machinery (`_t_p_two_sided`, `_betainc_reg`, `_t_crit_95`)
  runs per-finding, not per-row. Never "vectorize" it; verdicts depend on it.

## Standing invariants (tests pin these — keep them true)

- Warm sandbox: per-run cleanup runs in `writeFiles` BEFORE staging (moving it
  after deletes the current run's `/data/step_N.csv` dep frames). The nested-
  file skip-set is taught ONLY by exit-0 writes and cleared on every wipe.
- Remote-bucket creds: placeholders in prompts, real values only at the
  executor boundary (`applyRemoteAuth`); RemoteCreds live in the OS keychain.
- `getCSVContent` must never evict an entry with empty `filePath` (parquet/
  remote refs) — doing so destroys the live source.
- `runWarehouseQuery` callers pass `getRunSignal()` — Stop must cancel
  server-side (BigQuery billing).
- Docker is the ONLY sandbox runtime (E2B/microsandbox removed — they cannot
  enforce `--network none`). The capability gate rejects rather than degrades.
- Long-lived processes inside containers start via `docker exec -d`, NEVER
  `sh -c "... nohup ... &"` in a foreground exec: Docker >= 28 kills the exec
  session's process group on exit (broke the egress gateway proxy — every
  allowed remote read failed with EMPTY proxy diagnostics; PR #126).
- Golden recording must pin machine state to CI's resolution (models +
  composer.mode from repo defaults; fixtures on disk == HEAD) and re-emit
  goldens from a REPLAY server (CI compares replay-vs-replay ordering).
  Record mode is record-if-miss. Anything nondeterministic or host-derived
  that feeds a prompt must be gated under llmReplayConfig() (exemplars,
  harvest, sandboxMemoryGb label). HERMETIC_REPLAY_DEBUG=1 dumps full
  request bytes per replay lookup for CI-vs-local diffing.

## Deferred with rationale (decide before attempting)

- BigQuery introspection N+1 → `INFORMATION_SCHEMA.TABLE_STORAGE`: needs LIVE
  BigQuery validation (region qualifiers, grants) or it breaks connects.
- scanWindow LLM pick caching: question-dependent — a cache serves a WRONG
  scope to a different question. Only the single-table skip is safe.
- Per-key spec subscription (React): the resolver deep-rebuilds the 5000-row
  data literal per element render; fixing it is a large refactor, own PR.
- csvId→history index: any in-memory index needs a scan-fallback (multi-process:
  web + MCP + CLI share the data dir — see the schedule-storage lost-update fix).
- generative-dashboard editing: WON'T DO (decided) — edit recompiles via the
  compiled compiler; "parity" would silently convert generative→compiled.
- `ensureChecksDeclared` redo (~10-40s when it fires): grep
  `data/runs/*/journal.jsonl` for `checks_redo` rate BEFORE optimizing — it is
  the credibility-floor quality gate.

## Working conventions observed here

- Branch → PR → squash-merge; pre-push runs type-check + FULL suite (never
  bypass with --no-verify). Every fix ships with a regression test.
- Verify findings against code before fixing: across the review cycles, ~1/3
  of plausible-sounding findings did not survive tracing.
- Multi-process safety: any file-backed store mutation must re-read-merge or
  serialize (see schedule-storage/recent-sources writeChains).
