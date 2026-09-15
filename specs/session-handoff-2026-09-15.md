# Session handoff — 2026-09-15

Written so another agent, on another machine, can continue without reconstructing
context. State as of the last commit below; verify before trusting any of it.

> **Status update (same day, machine WITH the rust toolchain):** the merge
> plan below completed (rustls #244 → #243 → v0.5.16 released), #233 merged.
> Findings **2, 3, 4** below are FIXED (negative-cached daemon probes + a
> wasm-honest memory label; CI builds `public/duckdb-wasm` for e2e; a
> `stoi: no conversion` classifier in parse-output steers retries to a
> different code shape). Finding **1** (the wasm `stoi` blocker itself)
> remains OPEN — the new hint makes it legible, not fixed; the native-oracle
> repro against real Overture data is still the next step.

## Where things stand

- `main` is at **v0.5.15** (`557954ea`). Released and published.
- Desktop app installs and updates cleanly; the user is running 0.5.15.

### In flight

| Branch                 | PR                                                  | State                        | Blocks                              |
| ---------------------- | --------------------------------------------------- | ---------------------------- | ----------------------------------- |
| `sec-rustls-2026-0285` | none yet — **open one**                             | pushed, gate green           | nothing; it UNBLOCKS the rest       |
| `fix-cli-spawn-cwd`    | [#243](https://github.com/achalp/hermetic/pull/243) | CI red on `Rust egress core` | needs the rustls bump on main first |

**Merge order: rustls first, then #243, then cut v0.5.16.** #243's CI failure is
NOT its own fault — see below.

### Why the rustls bump exists

RUSTSEC-2026-0285 was published 2026-09-14 against `rustls 0.23.43` (TLS 1.3
handshake messages accepted across encryption level boundaries, severity 5.3).
`cargo audit` runs in CI, so this fails **every branch including main** until the
lockfiles move — the clock changed, not the code. Both `rust/egress-core` and
`src-tauri` lockfiles are bumped to 0.23.45; audit clean, `cargo test --locked`
green (verified in a container).

It is worth more than an unblock: `rust/egress-core` IS the L7 allowlist proxy
that terminates TLS for every sandboxed remote read.

### What #243 fixes

An in-app update replaces `/Applications/Hermetic.app` while the sidecar is
running from inside it. Node keeps the process alive with a deleted working
directory, so **every** `spawn` of the Claude CLI fails with "The current working
directory was deleted". The app is dead until restarted and nothing says so.

The symptom lies: the pipeline reported _"Code produced no output"_ on all four
attempts in 2.5 seconds, as though the generated Python were at fault. Code
generation never happened. `/api/suggest` failed the same way, and
manifest-select degraded silently to its keyword fallback.

`spawn()` passed `stdio`/`env` but no `cwd`. Both spawn sites now pass an
explicit one. Independent benefit: on the web path the inherited cwd is the REPO,
so the CLI could pick up hermetic's own `CLAUDE.md` as ambient context.

## This machine's state (not the repo's)

- **No Rust toolchain.** No cargo, no rustup, nothing from brew. Anything Rust
  must run in a container or in CI.
- **`rust/egress-core/target/` was deleted.** I contaminated it by running cargo
  in a Linux container mounted on the repo, which overwrote the macOS
  `egress-fetch` debug binary with an ELF one — the
  `PersistentFetcher against the real egress-fetch serve bin` test then failed
  with `spawn ENOEXEC`. After deletion that test SKIPS (its gate is "does the
  debug bin exist"). It passed before, so coverage was lost locally. Restore with
  `cargo build --bin egress-fetch` in `rust/egress-core` once a toolchain exists.
  CI is unaffected — it builds its own.
- The user's Claude CLI **predates `--effort`**, so per-phase effort settings are
  inert and every call runs at the CLI's default. Upgrading the CLI is the fix;
  nothing on the hermetic side is broken.

## Open, unfiled, and at risk of being lost

None of these are tracked as issues. They came out of live runs today.

1. **wasm `stoi: no conversion` blocker.** Every Overture-shaped geo run on the
   wasm tier dies on its first query (run `3885e46a`: 35 min, 4 identical
   attempts). Three hypotheses were tested and falsified — the hive flag, the
   `key=value` path shape (native DuckDB reads it fine in all three hive modes),
   and the alias NAME (an e2e case was added and PASSES, so it is not that).
   Remaining lead: it is DuckDB-WASM-specific, and reproducing needs real
   Overture data through the range route. Docker↔WASM engine alignment (both
   1.4.3 since #229) now makes a native repro a valid oracle; it was not before.
2. **`docker info` probed twice per wasm run.** `getDaemonMemoryBytes` caches only
   SUCCESS, so on a Docker-less machine every caller re-spawns and fails. The
   failure path also means `sandboxMemoryGb` is null, so wasm runs get NO memory
   guidance in the prompt — on the tier with LESS headroom, and the planet-scale
   skill routes on exactly that number.
3. **CI never builds `public/duckdb-wasm`**, so every DuckDB-WASM e2e case hits
   `test.skip(!assetsPresent)` and the "WASM executor parity" job covers Pyodide,
   not DuckDB. The engine the desktop ships is tested only on a developer's
   machine. Recorded in `specs/sandbox-runtime-capabilities.md`.
4. **No `skillFailureHints` entry for contentless engine errors.** `stoi: no
conversion` carries no column, value or statement, so the retry loop
   regenerated identical code four times. A hint would convert a 35-minute dead
   end into a fast, legible failure even if the engine bug persists.

## Provisional decisions — do not treat as design

`specs/dashboard-integrity-thresholds-2026-09-12.md` records every constant in
`lib/compose/series-scale.ts` and `lib/pipeline/data-sanity.ts` as a judgement
from ONE dashboard, with the basis stated per constant. `lintSeriesScale` also
REWRITES charts the composer produced, which is a stronger claim than the
evidence supports. CLAUDE.md links it under "Provisional decisions". Read it
before changing, defending or citing any threshold.

The advisory asks for firing-rate evidence from more dashboards: whether charts
get split that read fine, and whether outlier caveats fire unwarranted.

## Verification habits this session paid for

Each of these cost real time before it was learned.

- **Never pipe a script through `tail`/`head` when its exit status matters.** A
  pipeline reports the LAST command's status, so `release.sh … | tail -3` made a
  failed release look successful, and a truncated pre-push log hid which tests
  failed. Redirect to a file and echo `$?`.
- **One test suite at a time.** Four concurrent background `vitest` runs produced
  5-7 failures in unrelated, timing-sensitive files (process spawning, a
  DuckDB-WASM bridge, React forms) that all pass in isolation. Three wrong
  diagnoses followed, including blaming the user's machine. Control experiment:
  main green at 4,329, branch green at 4,333, same conditions.
- **`CARGO_TARGET_DIR` outside the repo** when running cargo in a container
  mounted on a macOS checkout, or Linux artifacts overwrite native ones.
- **A test that asserts nothing passes.** A regression test read
  `spawn.mock.calls` passively; it passed while asserting zero. Verify a new test
  FAILS without its fix — sabotage the fix and watch it go red.
- **`git checkout <file>` discards uncommitted work.** Reverting a sabotage that
  way deleted the fix being tested. Commit or stash first.
