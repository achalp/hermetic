# Skills + Custom Python Modules

**Date:** 2026-07-22
**Status:** Design — supersedes the organic per-feature growth described below.
**Related:** `spec/pre-execution-code-review-gate-2026-07-18.md` (judge > prose),
`spec/competitive-feature-gaps-2026-04-25.md` (saved "recipes" gap),
memory: `project_codegen_retry_hardening`, `project_investigate_cost_levers`,
`project_sweeper_kills_live_containers` (lore-contamination motivator).

## 1. Past work — what already exists and what it taught us

There is no prior branch named "skills" or "modules". Both capabilities grew
_organically_ inside the pipeline, and each has hit a scaling wall:

### 1.1 Proto-skills (domain recipes as hardcoded prompt prose)

| Artifact | Where | What it is |
| ------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------- |
| Geospatial recipe | `prompts.ts` `buildGeospatialGuidance()` | ~6,000 words: bbox-first, two-phase boundary lookup, KD-tree routing, PLANET-SCALE counting recipe, map-must-show-answer, f-string traps |
| Gating | same fn | regex on schema column names (`geometry                                                                                                  | geom | …`) — include all-or-nothing |
| Retry re-injection | `orchestrator.ts` + `buildRetryPromptMulti` | retries re-inject the recipe so a "repair" can't drop it (codegen-retry-hardening #1/#2) |
| Review gate | `code-review.ts`, gated on `buildGeospatialGuidance() !== ""` | Opus critic checks generated code against the recipe before execution |
| Failure-time hints | `parse-output.ts` phase-keyed OOM guidance | per-phase remedies fed into the retry prompt |

**Lessons (from the review-gate spec + measured runs):**

1. **Prose guidance has a ceiling.** Guards written as prose the model must
   transcribe get lost or (worse) stripped by our own post-processors
   (`stripValueAssertions` deleted a mandated `assert`). Guards belong in
   _executable_ form (the preloaded `assert_fits`, the `.df()` hard cap) and
   compliance belongs to a _separate judge_, not longer prose.
2. **The monolith is expensive and unmaintainable.** The failed 2026-07-22 run
   burned $6.14 on code-gen alone across 8 calls with ~50k-char prompts, most
   of it recipe text. Every new failure mode grows the blob; nothing is scoped
   to the question actually asked.
3. **"OBSERVED" lore rots.** Several recipe claims ("3× 20–25 min scan-buffer
   OOMs", "threads=2 the only proven value") were built on runs we now know
   were killed by the store-sweeper bug, not OOM. Observed claims embedded in
   an 800-line template string cannot be audited or retired.
4. **Re-injection on retry is mandatory.** Any skill mechanism must feed the
   retry path with the same material as the first attempt.

### 1.2 Proto-custom-modules (helpers as an inline Python string)

| Artifact             | Where                                                                 | What it is                                                                                                                       |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PYTHON_NAN_PRELUDE` | `sandbox/index.ts` (~500 lines of Python inside a TS template string) | `safe_float`, `progress()`, `assert_fits`, memory watchdog, `.df()` row cap, `corr/cov` patches, `read_csv` fixer, DuckDB config |
| `AdditionalFile[]`   | plumbed through all 4 executors + both orchestrators                  | arbitrary text files copied to `/data/...` per run (sheets, step frames)                                                         |
| Pinned image         | `docker/sandbox/Dockerfile`                                           | pandas/numpy/scipy/sklearn/duckdb/pyflakes + baked httpfs/spatial extensions                                                     |
| Preflight lint       | `docker-utils.ts` `lintScript` (pyflakes)                             | catches undefined names before a multi-minute scan                                                                               |

**Lessons:**

1. Python-in-a-TS-string is untestable, unlintable, and now the single largest
   file-complexity hotspot in `sandbox/`. The helpers are real code and deserve
   real files with real tests.
2. The model must be _told_ what is preloaded (codegen-retry-hardening TODO #3:
   "preloaded wording") — invisible helpers don't get used.
3. There is **no path for user code today**: a team's metric definitions or a
   custom loader can only be pasted into the question.

## 2. Design overview

Two features, one shared shape:

- **Skill** = a directory bundling _prompt guidance_ + _review checklist_ +
  _optional Python helpers_ + _provenance_, activated per-run by triggers.
- **Custom module** = a real `.py` file made importable inside the sandbox,
  either shipped by us (runtime + per-skill helpers) or supplied by the user.

Skills are the routing/packaging layer; modules are the executable layer a
skill (or the user) can carry. Guidance says _what to do_; the checklist makes
the judge _enforce it_; the helper makes the guard _impossible to transcribe
away_.

## 3. Skills

### 3.1 Format

```
skills/                        # built-in, in-repo
  geo-overture/
    SKILL.md                   # frontmatter + guidance body + checklist
    helpers.py                 # optional — preloaded when skill is active
  planet-scale-superlative/
    SKILL.md
data/skills/                   # user-authored, same format (gitignored)
```

`SKILL.md` frontmatter (zod-validated on load):

```yaml
name: planet-scale-superlative
description: Count-don't-materialize recipe for spatial superlatives over remote parquet
triggers:
  columns: ["^bbox$", "^(geometry|geom|the_geom|wkb_geometry|geog|shape)$"] # any-match regexes
  source: [remote-parquet] # optional: csv|excel|parquet|remote-parquet|warehouse
  question: ["farthest", "most isolated", "nearest neighbor"] # optional keywords
requires: [geo-overture] # skills this one builds on (activated together)
provenance:
  - claim: "threads=2 completes a USA 2.5B-row scan"
    evidence: "run 2f63fcbe 2026-07-16"
    status: suspect # ok | suspect | retired — audited, not folklore
```

Body sections, split by `## ` headings the loader understands:

- `## Guidance` — goes into the codegen prompt (and retry prompts) verbatim.
- `## Review checklist` — goes ONLY to the pre-execution critic; numbered,
  each item phrased as a checkable property ("cell size is derived from the
  Phase-A span, not a literal"). This is where enforcement lives.
- `## Failure hints` (optional) — `phase-pattern: remedy` pairs merged into
  `parse-output.ts`'s phase-keyed OOM router, so failure-time guidance comes
  from the same file as generation-time guidance and cannot drift apart.

### 3.2 Activation

Deterministic first, cheap, logged:

1. Schema/source triggers (regex on column names, source kind) — this is
   exactly today's `hasGeometryColumn` gate, generalized.
2. Question keyword triggers — substring/regex on the user question.
3. `requires:` closure — activating `planet-scale-superlative` pulls in
   `geo-overture`.

No LLM router in v1. (The gate today is a regex and it has never been the
weak link; a Haiku classifier is a Phase-4 option if keyword triggers prove
too blunt.) Every run logs `{skills: [names]}` so cost and failure telemetry
can be grouped by skill.

### 3.3 Injection points (all four, from one source)

| Point                 | Today                                                     | With skills                                                                                                                       |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Codegen system prompt | monolith appended when geometry column present            | concatenated `## Guidance` of active skills, **stable order (alphabetical)** so the prompt-cache prefix stays hot across attempts |
| Retry prompt          | `buildGeospatialGuidance()` re-injected manually          | active-skill set is carried on the run context; retry rebuilds from it automatically                                              |
| Review gate           | enabled iff geo guidance non-empty; critic sees the prose | enabled iff any active skill has a checklist; critic sees ONLY the checklists (not the full guidance) — sharper, cheaper          |
| Failure parsing       | hardcoded hint constants in `parse-output.ts`             | built-ins stay as defaults; active skills' `## Failure hints` are merged in front                                                 |

### 3.4 Migration of the monolith

Split `buildGeospatialGuidance()` into three built-in skills with **zero
intended text change** (snapshot test: old output ≡ concatenation of new):

- `geo-overture` — spatial basics, bbox-first, two-phase boundary, f-strings.
- `planet-scale-superlative` — ROUTE BY SIZE, counting recipe, leaf rules
  (requires `geo-overture`).
- `map-answer-visibility` — the "map must show the answer" rules.

Then audit every `OBSERVED` claim against the sweeper-bug finding and mark
`provenance.status` accordingly. Claims with `status: suspect` get a `(?)`
marker in the emitted guidance until re-validated; `retired` claims are kept
in the file (history) but not emitted.

## 4. Custom Python modules

### 4.1 The `hermetic` runtime package (ours)

Move the prelude's _functions_ out of the TS string into
`docker/sandbox/hermetic/` (real files, unit-tested with pytest in CI, baked
into the image):

```
docker/sandbox/hermetic/
  __init__.py        # re-exports the public API
  guards.py          # safe_float, assert_fits, df row-cap install
  progressio.py      # progress(), heartbeat
  watchdog.py        # memory watchdog thread
  duckcfg.py         # DuckDB memory/threads config + self-report
```

`PYTHON_NAN_PRELUDE` shrinks to a bootstrap: `from hermetic import *` +
`hermetic.install(mem_limit=...)` (the monkeypatches and watchdog must still
run before user code — that ordering is the prelude's only remaining job).
Executors are untouched: same injected-prelude mechanism, 10 lines instead of 500. Older images without the package keep working via a fallback: the
bootstrap tries the import and falls back to the current inline string
(shipped for one release, then removed).

This closes codegen-retry-hardening TODO #3 properly: the schema block gains a
generated **"Preloaded API"** section built from the package's actual
docstrings/signatures (extracted at build time into a JSON manifest), so the
prompt can never advertise a helper that doesn't exist — the same
sync-by-construction principle as the review gate.

### 4.2 Per-skill helpers

A skill's `helpers.py` is shipped per-run via the existing `AdditionalFile[]`
plumbing to `/data/skill_lib/<name>.py` (`/data` is on `sys.path`; text-only
content is exactly what `AdditionalFile` supports). The skill's guidance
references it by import. Example: `planet-scale-superlative` ships
`occ_aware_ub()`, `chebyshev_ring()`, `scalar_nn_distance()` — the branch-and-
bound math the model currently re-derives (and gets wrong: the occ-check bug)
on every attempt. A guard that exists as a function cannot be transcribed
away, and the preflight lint (pyflakes) validates the import chain for free.

### 4.3 User modules

```
data/user_lib/          # user-managed directory (a settings page lists it)
  metrics.py            # e.g. team KPI definitions
  loaders.py
```

- Copied per-run (as `AdditionalFile`s) to `/data/user_lib/`, appended to
  `sys.path` by the bootstrap.
- The schema block advertises them the same way as the Preloaded API: module
  name + top-level `def` signatures + first docstring line, extracted
  host-side by a small AST parse (no execution of user code on the host).
- Security posture: unchanged. User modules execute _inside_ the sandbox with
  the same caps/network policy as generated code; the host never imports them.
- Size guard: refuse (with a clear settings-page error) modules > 64 KB or
  non-UTF-8 — same constraints as any `AdditionalFile`.

### 4.4 Custom dependencies (explicit non-goal in v1)

Runtime `pip install` is rejected: most runs are `--network none`, and network
runs would gain a nondeterministic multi-minute step. If demand materializes,
the design is a **derived image**: `requirements.user.txt` →
`hermetic-sandbox:custom-<hash>` built once on save, selected at container
create. Not built until asked for.

### 4.5 Dependency resolution — always before run time, never at it

Nothing "pulls in" dependencies at run time; each source of sandbox code has
its own earlier gate:

- **Skill `helpers.py` (ours):** may import only stdlib + the image's pinned
  set. CI runs each skill's pytest INSIDE the sandbox image, so an
  unsatisfiable import fails our build, never a user's run. A skill needing a
  new package adds it to the Dockerfile pin list in the same PR.
- **User modules:** validated on save. The same host-side AST parse that
  extracts signatures also extracts imports and checks them against a package
  manifest generated at image build time (`pip freeze` → JSON). Stdlib, image
  packages, and sibling `user_lib`/`skill_lib` modules pass; anything else is
  rejected with a settings-page error naming the module and missing package.
- **Runtime backstop:** `parse-output.ts` classifies a `ModuleNotFoundError`
  whose traceback originates in `user_lib`/`skill_lib` as a USER-CONFIG error
  — non-retryable, same wording as the save-time check — so the codegen retry
  loop never burns attempts regenerating analysis code against a missing
  package (no code change can fix it).
- **Derived image (4.4):** when active, the validation manifest is generated
  from the derived image instead of the base one, so save-time validation and
  the runtime environment cannot disagree.

## 5. Phasing

1. **Extract & route (no behavior change).** Skill loader + zod schema;
   split the geo monolith into 3 built-ins; wire all four injection points;
   snapshot test old-vs-new prompt text; per-run `{skills}` logging.
2. **`hermetic` runtime package.** Move prelude functions into the image;
   bootstrap + fallback; pytest in CI; generated Preloaded API section
   (closes TODO #3).
3. **Per-skill helpers.** `helpers.py` shipping + `skill_lib` path; move the
   branch-and-bound math into `planet-scale-superlative`; checklist item:
   "uses `scalar_nn_distance()` for the leaf, not a hand-rolled ring read".
4. **User surface.** `data/skills/` + `data/user_lib/` loading, settings page
   listing both with validation errors; docs. Optional: Haiku trigger
   classifier, per-skill success/cost telemetry.

Each phase ships independently; 1 and 2 have no user-visible change and
de-risk the rest.

## 6. Cost impact

- Inactive-domain text drops out entirely (a plain CSV question today still
  pays zero for geo — but a geo question pays for ALL geo text even when only
  the small-region path applies; splitting planet-scale from basics saves
  ~40% of the geo blob on small-region questions).
- Stable alphabetical skill order + static bodies keep the cached prompt
  prefix hot across the 8+ calls of a retried run (cache-ttl-1h already
  landed; the monolith's interpolated `${sandboxMemoryGb}` currently sits
  mid-text and splits the cacheable prefix — skills emit memory-cap wording
  from one small dynamic epilogue instead).
- Checklist-only review prompts shrink the critic's input (~50k → ~15k chars
  measured on the 2026-07-22 run's review calls).

## 7. Risks

- **Splitting the monolith changes behavior accidentally** → snapshot test in
  Phase 1 makes the refactor provably textual.
- **Skill sprawl** (the monolith reappears as 30 tiny files) → skills must
  carry provenance; a claim without evidence doesn't merge. The audit
  workflow (suspect/retired) gives lore a lifecycle it never had.
- **User modules that shadow stdlib/preloaded names** → bootstrap appends
  (not prepends) `user_lib` to `sys.path`; the advertisement section warns on
  collisions detected host-side.
- **Prompt-cache regression from dynamic skill sets** → the skill set is
  fixed per run (chosen once, carried on run context), so within a run every
  attempt shares the prefix; across runs the alphabetical order maximizes
  sharing between questions that activate the same skills.
