# Competitor engineering audit: Vanna vs. hermetic

**Date:** 2026-08-04
**Method:** Shallow clone of `vanna-ai/vanna` at `365d061` (v2.0.2, 2026-02-02);
adversarial code-survey agent plus direct file reads. All claims cite real files in
that checkout. Hermetic side reflects the Phase 1 exit state
(`specs/modularization-2026-08-01.md` §9). Companion:
`audits/competitor-audit-wren-2026-08-04.md`.

---

## 0. Framing: a rewrite that ships its own past

Vanna 2.x is an agent-based rewrite of the v1 mixin library — the third
"v1→v2 reset" in this competitive set (Wren pivoted too; hermetic re-architected
in place). The difference: **Vanna ships both generations in one wheel.**
`src/vanna/legacy/` is 11,088 LOC of verbatim v1 (of 36,149 total src LOC), including
the v1 `VannaBase` god class (2,125 LOC, 36 subclasses) and the v1 Flask app —
reachable via `LegacyVannaAdapter` and direct import. The v2 surface proper is
~20.5k LOC across `core/` (interfaces + Agent), `capabilities/`, `integrations/`,
`tools/`, `servers/`, `components/`. Plus 4,433 LOC of examples _inside the
installed wheel_.

## 1. LLM-output handling — three philosophies, now side by side

The core design question all three products answer differently: what may the LLM
author?

- **Vanna v2: constrain the capability.** SQL arrives only as a structured
  tool-call argument (`RunSqlToolArgs`, one pydantic `sql: str` field, validated at
  `core/registry.py:189`) — no regex scraping (v1's extractor, still shipped at
  `legacy/base/base.py:170-236`, ends in `return llm_response` — raw prose as SQL).
  Charts are **not LLM-authored at all**: `PlotlyChartGenerator`
  (`integrations/plotly/chart_generator.py:48-99`) is a deterministic if/elif
  heuristic over the DataFrame (datetime→line, 1 num+1 cat→bar, ≥3 num→heatmap…),
  emitting plotly JSON. The LLM can pass only `filename` + `title`
  (`tools/visualize_data.py:26-29`). Safest by construction; least capable — the
  model cannot choose columns, styling, or chart type.
- **Wren v1: constrained decoding + validation of an external spec** (vega-lite).
- **Hermetic: own the contract and sandbox the execution** — LLM-authored analysis
  code runs in Docker; LLM-authored specs validate against an owned, versioned,
  golden-tested runtime.

**But v1's unguarded `exec()` still ships.** `legacy/base/base.py:2095`:
`exec(plotly_code, globals(), ldict)` — LLM-generated Python executed with real
module globals, no AST check, no allowlist, no subprocess, no timeout, and the
`except Exception` fallback substitutes a heuristic chart, so exploitation is
_silent_. Sanitization is markdown-fence stripping. Any legacy-adapter deployment
carries this.

## 2. Security posture — the weakest of the three

- **v2 dropped v1's only SQL gate.** v1 had `is_sql_valid` via sqlparse checking
  `get_type() == "SELECT"` (`legacy/base/base.py:254-260`). v2 has **no equivalent**:
  runners execute first and _then_ check the first token only to shape the result —
  non-SELECT statements are explicitly **committed**
  (`integrations/postgres/sql_runner.py:88-108`, same in all 11 runners). Grep for
  read-only/allowlist/sqlparse in v2 execution paths: zero. The offered defense
  (`ToolRegistry.transform_args`) is an opt-in no-op (`registry.py:142`), yet
  `README.md:79` claims "Row-level security — Queries automatically filtered per
  user permissions."
- **Auth is a seam with zero implementations.** `UserResolver` ships no concrete
  resolver; the bundled UI sets identity from a free-text email cookie
  (`servers/base/templates.py:254`, self-labelled "Demo Mode"), and
  `MIGRATION_GUIDE.md:41-46,110-115` teaches exactly that spoofable cookie as the
  quick-start — including an admin check on it. Copying the guide verbatim yields
  forgeable admin over a tool registry that includes `run_sql`.
- **CORS defaults**: `allow_origins=["*"]` + `allow_credentials=True`, enabled by
  default, both servers (`servers/fastapi/app.py:47-56`); default bind `0.0.0.0`.
- **LLM-driven arbitrary `pip install`** (`tools/python.py:125`, no allowlist) and a
  `run_bash` that escapes the per-user workspace jail (the file tools have a real
  `resolve().relative_to()` traversal check at `integrations/local/file_system.py:62`;
  the shell tool bypasses it with `cwd`-only confinement). Opt-in tools, but
  documented ones.
- Frontend: ~15 raw `innerHTML` sites; table cells escape strings but return
  number/date/boolean branches **unescaped** with heuristic type inference
  (`rich-component-system.ts:617-636`).
- Genuinely good: group-set tool access control checked at both schema-listing and
  execution time (`registry.py:105-162`), and **audit logging on by default** with
  parameter sanitization (`core/agent/config.py:88-108`) — hermetic has run events
  but nothing this deliberate.

Hermetic contrast: sandboxed execution with code-level guards (Docker, CSP from
constants, origin guard, F3 endpoint allowlist), no auth story either — but
hermetic is explicitly local single-user, while Vanna ships multi-user servers and
a migration guide that teaches broken auth.

## 3. Contracts and typing

Strong core, unenforced edges:

- 55 pydantic models on the v2 wire surface, 19 ABCs, generic `Tool[T]` binding args
  models to implementations, JSON tool schemas auto-derived from pydantic
  (`core/tool/base.py:155-171`), `py.typed` shipped.
- `mypy --strict` — but only on `core/`, `capabilities/`, `tools/`, `components/`
  (+two _empty_ packages). **Excluded: every vendor integration, both servers, all
  of legacy** (`tox.ini:242`). The seam is typed; the implementations aren't checked.
- Release hygiene misses hermetic's gates would catch: `__all__` exports six names
  the module never imports (`from vanna import *` raises), `__version__ = "0.1.0"`
  vs `pyproject 2.0.2`, an advertised `error_recovery_strategy` that is stored and
  never read, **two different ABCs named `FileSystem`** with duplicate model classes
  and mixed imports across the codebase, ruff configured to ignore
  `F401/F811/F841` (dead-code detection off) — and `Agent.__init__` has five mutable
  default arguments with `B006` suppressed.
- `core/agent/agent.py:231-1155` is a **925-line method** (observability boilerplate
  ~3×-inflates it; duplicated blocks carry `_2` suffixes). Hermetic's largest
  post-F1 pipeline file is a third of that with the same responsibilities split.

## 4. Testing & CI — the sharpest contrast in the whole set

- **CI does not run on pull requests.** `.github/workflows/tests.yml` triggers on
  `push: branches: [main]` only. Nothing — no lint, no types, no tests — gates a PR.
  (Wren at least ran label-gated; hermetic runs everything unconditionally.)
- 241 tests, but 52% are import/construction "sanity" smoke tests; provider tests
  **skip silently** when API keys are absent (`conftest.py:29-66`) so a green run
  proves little; the shared fixture **downloads a SQLite DB from the network** at
  session scope (`conftest.py:83`). No snapshot/golden/replay infrastructure of any
  kind. `pytest-cov` declared, never invoked.
- **The eval framework is scaffolding, not capability**: 1,299 LOC
  (Trajectory/Output/LLM-as-judge/Efficiency evaluators, HTML reports) — but the
  only dataset asserts tool names (`generate_sql`, `execute_query`) that **do not
  exist in the codebase** (real names: `run_sql`, `visualize_data`), and
  `AgentResult.tool_calls` is never populated (`evaluation/runner.py:304` TODO), so
  trajectory evaluation cannot work. The one benchmark carries
  `# TODO: Add actual SQL tools`.

A pattern now confirmed across all three competitors: **quality infrastructure
that exists but doesn't run** (Wren: label-gated CI + no-op assertion; Vanna: no PR
trigger + non-functional evals). Hermetic's differentiator isn't having gates — it's
that they run unconditionally and fail closed.

## 5. Where Vanna is genuinely ahead

- **Extensibility surface — best-in-class.** `CONTRIBUTING.md:315-427` has four
  complete recipes; a new database is literally one typed async method
  (`SqlRunner.run_sql`); tool JSON schemas derive from pydantic `Field(description=)`.
  Integration breadth follows: 7 LLM services, 11 SQL runners, 11 memory backends,
  44 extras. Hermetic's engine-descriptor registry is comparable in spirit for
  warehouses, but hermetic has no documented third-party seam yet (that's Phase 2).
- **Audit logging on by default** with sanitization — worth copying when hermetic
  grows any multi-user story.
- **Structured tool-args as the SQL channel** — eliminates output-parsing by
  construction. Hermetic's patch-stream is parsed; constrained decoding (also
  Wren's trick) is the transferable idea.
- Docstring discipline (Google-style with runnable examples across v2) and a
  Storybook story for every frontend component (~3.7k LOC of stories — albeit zero
  actual JS tests).

## 6. Verdict

| Dimension                          | Edge                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| SQL safety (read-only enforcement) | **hermetic/Wren** — Vanna v2 commits non-SELECT; dropped v1's only gate                |
| LLM-code execution                 | **hermetic** (sandboxed) vs Vanna legacy `exec()` unguarded / Vanna v2 avoids entirely |
| CI gates that actually run         | **hermetic**, by a wide margin (Vanna: nothing on PRs)                                 |
| Determinism / replay / goldens     | **hermetic** (Vanna has none)                                                          |
| Answer-quality evals               | **Wren** > Vanna (scaffolding, broken) > hermetic (absent) — still hermetic's gap      |
| Typed seams / plug-in story        | **Vanna** (ABCs + recipes + breadth), with unchecked edges                             |
| Auth for shipped servers           | nobody — but Vanna actively teaches a spoofable pattern                                |
| Release hygiene                    | **hermetic** (Vanna: broken `__all__`, version mismatch, dead seams)                   |
| Chart-generation capability        | **hermetic** (40+ interactive types) ≫ Wren (7 vega-lite) > Vanna v2 (heuristic-only)  |

## 7. Recommendations for hermetic

1. Reinforces the Wren recommendation: **build the answer-quality eval harness** —
   and make it _runnable in CI_, the thing both competitors' eval investments failed
   at. Vanna's evaluator taxonomy (trajectory/output/judge/efficiency) is a
   reasonable shape to borrow; its broken dataset is the cautionary tale (evals must
   reference real tool/step names, enforced by a test).
2. **Structured outputs over parsed outputs** wherever the provider allows —
   second competitor confirming the direction (Wren via `response_format`, Vanna via
   tool args).
3. When Phase 2 opens third-party seams, Vanna's `CONTRIBUTING.md` recipes +
   one-method adapter contracts are the usability bar; hermetic's addition should be
   what Vanna lacks — type-checking the implementations, not just the interfaces,
   and a version/compat contract on the ABCs.
4. Adopt default-on **audit logging** for run events if any shared-deployment story
   emerges.
5. Anti-patterns to keep guarding against (observed here): shipping the legacy
   attack surface inside the new wheel; safety checks that run _after_ execution;
   documentation teaching insecure quick-starts; smoke tests inflating counts;
   silent test skips.
