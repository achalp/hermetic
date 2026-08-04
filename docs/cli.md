# The hermetic CLI

The CLI harness drives the **same library functions as the web app** — the
`runAskQuery` pipeline over the `runPatchStream` core — with zero Next.js
imports. It exists both as a usable tool and as Phase 1's architectural proof:
if a library module ever re-couples to the app or framework, the CLI breaks in
CI instead of the architecture rotting silently
(`specs/modularization-2026-08-01.md`, exit criterion 1).

## Running it

```bash
pnpm cli ask "<question>" <data.csv> [--out file.ndjson]
```

Examples:

```bash
# Live: ask against a CSV with your configured provider
pnpm cli ask "What is the MRR trend over time?" ./data/sales.csv

# Save the stream to a file as well as stdout
pnpm cli ask "Top customers by revenue" ./data/sales.csv --out result.ndjson

# Fully offline: replay committed LLM fixtures (used by CI; the question,
# CSV filename, and content must match what was recorded)
cp test-specs/data/01-saas-mrr.csv /tmp/fixture.csv
HERMETIC_LLM_MODE=replay pnpm cli ask "What is the MRR trend over time?" /tmp/fixture.csv
```

`pnpm cli` maps to `tsx src/cli/main.ts` (see `package.json`), so it needs the
repo's dev dependencies installed — it is not yet a standalone binary
(packaging is Phase 2).

## Command reference

The complete surface today is one command, two positional arguments, and one
flag:

| Item         | Kind             | Required | Valid values                                                                                                                         | Example                                                       |
| ------------ | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `ask`        | command          | yes      | The only command. Runs the full pipeline: ingest CSV → generate + execute analysis code in the sandbox → compose the dashboard spec. | `pnpm cli ask "What drives churn?" ./data.csv`                |
| `<question>` | positional arg 1 | yes      | Any natural-language question, quoted.                                                                                               | `"What is the MRR trend over time?"`                          |
| `<data.csv>` | positional arg 2 | yes      | Path to a readable CSV file (UTF-8). Other formats (Excel, Parquet, warehouse) are web-harness-only for now.                         | `./data/sales.csv`                                            |
| `--out`      | flag             | no       | A writable file path; receives the complete NDJSON patch stream (stdout still gets every line). Conventionally `.ndjson`.            | `pnpm cli ask "Top customers" ./data.csv --out result.ndjson` |

Anything else — unknown command, missing arguments — prints the usage line and
exits with code `2`. There is no `--help` flag yet; the usage line doubles as
help.

## Environment variables

The CLI boots the same env-config snapshot as the Next harness
(`src/harness/env-config.ts` owns the full key list). The ones that matter
most from the command line:

| Variable                                            | Effect                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` (or your usual provider config) | LLM provider credentials for live runs.                                                                                                                             |
| `HERMETIC_LLM_MODE`                                 | `replay` serves LLM responses from committed fixtures (offline, free); `record` captures live responses into the fixture dir. Unset = live calls, nothing recorded. |
| `HERMETIC_LLM_FIXTURES`                             | Fixture directory for record/replay. Default: `test-fixtures/llm`.                                                                                                  |
| `SANDBOX_RUNTIME`                                   | Sandbox backend for code execution (`docker` default; `e2b`, `microsandbox`). Docker needs the image: `docker build -t hermetic-sandbox ./docker/sandbox/`.         |

There is currently **no environment variable** for relocating the storage
roots — the CLI writes durable state under `<cwd>/data` (and scratch/user
roots per `src/lib/paths.ts`). Embedders relocate them programmatically via
`setPathRoots()` at boot; an env override is a natural follow-up if the CLI
grows beyond the proof stage.

Note: even in replay mode the **sandbox executes for real** — only LLM calls
are replayed. Docker (or another configured runtime) must be available.

## Output

- **stdout** — the analysis as an NDJSON patch stream: one RFC 6902-style
  patch per line (`{"op":"add","path":"/root",...}`), the same stream the
  browser renders live. The final state includes a `/state/__cost` patch with
  token/cost accounting. Pipe it or use `--out` to keep it.
- **stderr** — human-readable progress (`[ingest] …`, `[llm-replay] …`,
  `[out] …`) and cost logging, kept off stdout so the stream stays parseable.

## Viewing the result in the web app

Every successful `ask` also persists a **history entry** (spec, generated
code, schema, source data, artifacts) under the shared data root and prints
a restore link:

```
[history] saved 5f2c9c1e-…
[view] http://localhost:3000/?restore=5f2c9c1e-…
```

Run the web harness from the same directory (`pnpm dev`) and open the link —
the dashboard renders fully interactive, with the artifacts panel available.
The entry also appears in the app's History page. This is the intended path
from CLI output to a visual/exportable result: restore in the browser, then
use the Export menu (PDF/DOCX/PPTX/Slides).

The NDJSON on stdout is the machine-readable stream (embedding, diffing,
piping); it is not itself importable through the web UI.

## Exit codes

| Code | Meaning                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------- |
| `0`  | Pipeline completed and composed a dashboard spec.                                                         |
| `1`  | Pipeline ran but the result is the error spec (`/root` = `"error"`), or an unexpected exception occurred. |
| `2`  | Bad usage (unknown command / missing arguments).                                                          |

## How CI uses it

`.github/workflows/ci.yml` (`golden-transcripts` job) runs the offline replay
example above and asserts the stream contains a `/root` patch and no error
spec — plus a grep proving `src/cli` and `src/harness` never import Next.

## Current limitations

- `ask` is the only command; investigate mode, warehouse sources, and Excel
  ingestion are exercised through the web harness or the golden journey
  runner (`scripts/golden/run-journeys.mjs`) for now.
- No direct spec→PDF/HTML compile: visual output goes through the web app
  (see "Viewing the result in the web app"); a `hermetic render` command is
  a Phase 2 candidate.
- CSV input only (the ingest path is `parseCSV` → `extractSchema` → `storeCSV`).
- Runs from the repo checkout via `tsx`; standalone packaging is a Phase 2
  deliverable.
