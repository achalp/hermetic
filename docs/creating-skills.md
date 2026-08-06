# Creating Skills and Helpers

A **skill** teaches the analysis engine a domain: what to do (prompt guidance),
what the pre-execution reviewer should reject (review rules), how to recover
from domain-specific failures (failure hints), and tested code the generated
script can call instead of re-deriving (Python helpers). Skills activate
per-question — a run that doesn't match a skill's triggers never pays for it.

Drop a skill in `data/skills/<name>/` and it is live on the next question — no
restart, no rebuild. Invalid files are skipped with a logged reason, never
crash anything.

```
data/skills/
  cohort-retention/
    SKILL.md          # required: frontmatter + guidance
    helpers.py        # optional: preloaded Python module
data/user_lib/
  metrics.py          # optional: modules preloaded on EVERY run (no triggers)
```

---

## Quick start: a minimal skill in five steps

1. **Create the folder and file**: `data/skills/my-skill/SKILL.md`.
2. **Write the frontmatter** — `name`, `description`, and at least one trigger:

   ```yaml
   ---
   name: my-skill
   description: One line saying what this skill teaches
   triggers:
     question: ["some keyword"]
   ---
   ```

3. **Write the guidance** under a `## Guidance` heading — the text injected
   into the code-generation prompt when the skill activates.
4. **Ask a matching question.** The console logs
   `Skills activated {skills: ["my-skill"], reasons: ...}` and the run's
   `data/runs/<id>/skills.json` records the activation.
5. **Check `GET /api/skills`** — it lists every skill (and every _rejected_
   file with its reason, so a typo is visible instead of silently absent).

---

## SKILL.md reference

```yaml
---
name: cohort-retention        # kebab-case, unique (built-in names are reserved)
description: One line shown in /api/skills and logs
order: 200                    # guidance emission order; user skills default 1000
triggers:                     # at least ONE of the four is required (OR'd)
  columns: ["^signup_date$"]  # case-insensitive regexes, any column name match
  question: ["retention"]     # case-insensitive substrings of the user question
  sources: ["warehouse"]      # data source kind: file | warehouse
  always: true                # unconditional (use sparingly — every run pays)
requires: ["geo-overture"]    # co-activate other skills (built-in or user)
reviewGate: false             # true = force the pre-execution code review on
reviewRules: |                # extra reviewer rules, "ID — when to flag" format
  MY-RULE — flag when ...
failureHints:                 # phase-keyed OOM remedies for the retry loop
  - pattern: "pivot"          # regex matched against the failing progress phase
    hint: "Aggregate in DuckDB instead ..."
  - pattern: "^"              # catch-all: matches any phase, even none
    fallback: true            # ...but only on a bare kill, never over a watchdog abort
preludeSnippet: |             # python run AFTER the shared prelude, BEFORE the script
  try:
      import hermetic_runtime.guards as g
      g.set_strategy_hint(" My domain's strategy pointer.")
  except Exception:
      pass
---
## Guidance
Text injected into the prompt. Placeholders: {{filename}}, {{sandboxMemoryGb}}.
```

### How each field reaches the pipeline

| Field            | Where it lands                                          | When                                                              |
| ---------------- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| `## Guidance`    | Code-gen prompt + every retry prompt                    | Skill active                                                      |
| `reviewRules`    | Appended to the pre-execution reviewer's rule list      | Review runs (this skill's `reviewGate` or another active skill's) |
| `failureHints`   | Matched against the OOM phase before the generic router | Skill active, execution OOMed                                     |
| `helpers.py`     | Shipped to `/data/skill_lib/`, import auto-advertised   | Skill active                                                      |
| `preludeSnippet` | Prepended to the script after the shared prelude        | Skill active                                                      |

### Trigger placement matters for cost

- **Column / source / always** triggers are _schema-derived_: their guidance
  joins the **cached** prompt prefix (cheap across retries and sub-questions).
- **Question** triggers ride the **un-cached** question tail. Prefer a column
  trigger when a distinctive column exists; add question keywords so the skill
  also fires on datasets without it.
- A skill matching both is treated as schema-triggered (the cheaper placement).

---

## Adding a helper (`helpers.py`)

Put `helpers.py` next to `SKILL.md`. When the skill activates, the file ships
into the sandbox as `skill_lib.<name_with_underscores>` (e.g.
`cohort-retention` → `from skill_lib.cohort_retention import cohort_matrix`)
and the guidance is auto-suffixed with the module's import path and function
signatures.

Rules that make helpers work well:

1. **The first docstring line IS the advertisement.** Signatures and first
   docstring lines are extracted from source and injected into the prompt —
   write them so the model knows when to reach for the function. A function
   without a docstring is not advertised.
2. **Prefix private functions with `_`** — they ship but are not advertised.
3. **Import only what the sandbox image has**: the stdlib plus pandas, numpy,
   scipy, matplotlib, seaborn, sklearn, duckdb (and pytz, dateutil, PIL,
   joblib). Anything else fails at run time — there is no pip install.
4. **Stay engine-first**: helpers should push heavy work into DuckDB (build
   SQL, run aggregations) and return small frames/scalars. A helper that
   materializes a raw table into pandas just moves the OOM into your module.
5. **Guards beat prose.** If your guidance keeps saying "always compute X this
   way", make X a function. The model can mis-transcribe advice; it cannot
   mis-transcribe `from skill_lib.my_skill import x`. (This is why the
   planet-scale built-in ships its branch-and-bound math as code.)

### Skill helpers vs `data/user_lib/` modules

|                   | `data/skills/<name>/helpers.py`        | `data/user_lib/*.py`                                            |
| ----------------- | -------------------------------------- | --------------------------------------------------------------- |
| Loaded when       | Its skill's triggers match             | **Every** run                                                   |
| Advertised in     | The skill's guidance                   | The cached schema block                                         |
| Import path       | `skill_lib.<skill_name>`               | `user_lib.<filename>`                                           |
| Import validation | Author's responsibility                | Enforced at load (invalid modules rejected with a named reason) |
| Use for           | Domain recipes tied to a question type | Team-wide definitions (metrics, loaders) that always apply      |

---

## Worked examples

Five samples ship in [`samples/skills/`](../samples/skills/) — copy any of
them into `data/skills/` to make them live (`data/` is gitignored, so the
tracked copies under `samples/` are the canonical sources). Each demonstrates
a different surface:

| Skill                | Domain                      | Demonstrates                                                                                                                               |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sales-analysis`     | Bundled sales demo CSV      | Column triggers, review rules, won-only correctness guards                                                                                 |
| `cohort-retention`   | Retention/cohorts           | DuckDB-first helper (matrix built in SQL), failure hint                                                                                    |
| `ab-experiment`      | Experiment readouts         | Question triggers, a review rule enforcing significance, stats helpers, `_private` functions                                               |
| `anomaly-windows`    | Spike/outlier detection     | Question-only triggers, robust-stats helper, chart-visibility guidance                                                                     |
| `spatial-clustering` | Overture building centroids | A named statistical test as a helper (Clark-Evans index via scipy cKDTree), sampling-bias review rule, layering on the built-in geo skills |

### `cohort-retention` — the pattern to copy

`data/skills/cohort-retention/SKILL.md`:

```markdown
---
name: cohort-retention
description: Cohort and retention analyses — period-based cohorts built in DuckDB, row-normalized curves, decided-user denominators
order: 200
triggers:
  columns: ["^(signup|created|first_seen|joined)_?(date|at)?$"]
  question: ["retention", "cohort", "churn", "come back", "repeat"]
failureHints:
  - pattern: "cohort|retention matrix|pivot"
    hint: "Build the cohort matrix as a DuckDB GROUP BY (cohort_period x offset_period -> COUNT(DISTINCT id)) and pull ONLY the aggregated matrix into pandas — never pivot raw event rows in pandas."
---

## Guidance

Cohort/retention questions on {{filename}}:

- COHORT = the period of a user's FIRST event (their signup/created date),
  bucketed with date_trunc. Assign each user ONE cohort via a MIN(date)
  GROUP BY user — never per-event.
- Build the retention matrix in DuckDB: one row per (cohort_period,
  period_offset) with COUNT(DISTINCT user_id). The matrix is tiny; the event
  table may not be. Only the matrix reaches pandas.
- RETENTION RATE is row-normalized: cell / cohort size (offset 0). Report
  rates AND cohort sizes.
- The LAST cohort and LAST period are usually PARTIAL — label or exclude
  them, never let a fake cliff at the end read as churn.
```

`data/skills/cohort-retention/helpers.py` (abridged — note the docstring
first lines, which become the prompt advertisement):

```python
"""Cohort/retention helpers — matrices built in DuckDB, only aggregates reach pandas."""

import duckdb


def cohort_matrix(id_col, date_col, source="data", period="month"):
    """Retention matrix (cohort_period x period_offset -> distinct users) as a small DataFrame."""
    return duckdb.sql(f"""
        WITH firsts AS (
            SELECT {id_col} AS uid,
                   date_trunc('{period}', MIN(CAST({date_col} AS DATE))) AS cohort
            FROM {source} GROUP BY 1
        ), events AS (
            SELECT s.{id_col} AS uid, date_trunc('{period}', CAST(s.{date_col} AS DATE)) AS p
            FROM {source} s
        )
        SELECT f.cohort, date_diff('{period}', f.cohort, e.p) AS offset,
               COUNT(DISTINCT e.uid) AS users
        FROM events e JOIN firsts f USING (uid)
        WHERE e.p >= f.cohort GROUP BY 1, 2 ORDER BY 1, 2
    """).df()


def retention_rates(matrix_df):
    """Row-normalize a cohort_matrix() result: rate = users / cohort size (offset 0)."""
    sizes = (matrix_df[matrix_df["offset"] == 0]
             .set_index("cohort")["users"].rename("cohort_size"))
    out = matrix_df.join(sizes, on="cohort")
    out["rate"] = out["users"] / out["cohort_size"]
    return out
```

### `ab-experiment` — a review rule with teeth

The interesting part is the frontmatter's `reviewRules`: when the code review
runs, the reviewer will flag any script that ranks variants without a
significance computation — and the guidance points at the preloaded
`two_proportion_ztest` / `lift_ci` helpers, so the fix is one import away:

```yaml
reviewRules: |
  EXP-SIGNIF — flag when per-variant conversion rates / means are compared, ranked, or declared a "winner" WITHOUT any significance or uncertainty computation (use skill_lib.ab_experiment.two_proportion_ztest / lift_ci — a 2% lift on 300 users is noise presented as signal).
```

### `anomaly-windows` — question-only triggers

No distinctive column exists for "find anomalies", so it triggers purely on
keywords (`anomal`, `spike`, `outlier`, ...). Its helper (`mad_zscores`) bakes
in the robust-statistics choice the guidance argues for, and its failure hint
catches the classic rolling-window-over-raw-rows OOM.

---

## Verifying and debugging

| Signal                                          | Where                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Which skills fired, and why                     | Console: `Skills activated {skills, reasons, helperModules}`                                                   |
| Full per-run activation record                  | `data/runs/<run-id>/skills.json`                                                                               |
| Every known skill + rejected files with reasons | `GET /api/skills`                                                                                              |
| A rejected SKILL.md / module                    | One `WARN User skill rejected {path, reason}` per file version                                                 |
| A skill failure hint steering a retry           | `INFO Skill failure hint applied {skill, phase}` + `hint=skill:<name>` in `data/runs/<id>/attempt-NN.diag.txt` |

Common rejection reasons:

| Reason                                                        | Fix                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `missing YAML frontmatter`                                    | The file must start with a `---` ... `---` block              |
| `name must be kebab-case`                                     | Lowercase letters, digits, hyphens only                       |
| `triggers must declare at least one of ...`                   | Add `columns`, `question`, `sources`, or `always`             |
| `invalid regex in frontmatter`                                | Column/hint patterns must compile as regexes                  |
| `skill has no guidance text`                                  | Body (or `## Guidance` section) is empty                      |
| User skill shadows a built-in — ignored                       | Rename; built-in names are reserved                           |
| (user_lib) `imports 'X' — not available in the sandbox image` | Remove the import or drop the module; there is no runtime pip |

Edits are picked up by file mtime — save the file and ask the next question.
No caches to clear, no restart.

---

## Design principles (why the system is shaped this way)

- **Skills are domain knowledge; the runtime is invariants.** Anything that
  must hold for every run (memory guards, output contract, progress
  reporting) lives in the always-on runtime — a skill only carries what is
  conditional on its domain.
- **Guidance says what to do; review rules make it enforceable; helpers make
  it impossible to mis-transcribe.** When a piece of advice matters, promote
  it up that ladder.
- **Everything observable, by name.** Activation, shipped helpers, fired
  hints, and rejections are all logged with names and reasons — if you can't
  see a skill working, that's a bug, not a mystery.

## Complement skills (`extends`)

A skill can complement another instead of declaring its own triggers:

```yaml
---
name: geo-overture-learned
description: Learned lessons complementing geo-overture
extends: geo-overture
---
## Guidance
- division_area locality lookups: filter country + subtype + names.primary; do NOT filter region.
```

An `extends` skill activates whenever its parent activates and its guidance
renders immediately after the parent's. Own triggers are optional and OR'd
in. This is the vehicle for the learning loop's accepted lessons (`/learning`
page): they land in user-level `<parent>-learned` skills under
`data/skills/`, never in the shipped built-ins.
