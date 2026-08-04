/**
 * The hermetic CLI harness (modularization M6-6a; spec WS8).
 *
 * Phase 1's proof artifact: drives the SAME library functions as the Next
 * routes — runAskQuery over the runPatchStream core — with zero Next
 * imports. If a lib module ever re-couples to the app or framework, this
 * harness breaks in CI instead of the architecture rotting silently.
 *
 *   hermetic ask "<question>" <data.csv> [--out file.ndjson]
 *
 * Boot mirrors the Next harness: env config snapshot, default path roots.
 * With HERMETIC_LLM_MODE=replay and committed fixtures, an ask runs fully
 * offline (LLM from fixtures; sandbox executes for real).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { installEnvConfig } from "@/harness/env-config";

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "ask" || rest.length < 2) {
    console.error('usage: hermetic ask "<question>" <data.csv> [--out file.ndjson]');
    return 2;
  }
  const outIdx = rest.indexOf("--out");
  const outFile = outIdx >= 0 ? rest[outIdx + 1] : undefined;
  const positional = outIdx >= 0 ? rest.slice(0, outIdx) : rest;
  const [question, csvPath] = positional;

  // ── Harness boot (mirrors instrumentation-node installBootConfig) ──
  installEnvConfig("snapshot");
  const { configureLLMReplay } = await import("@/lib/llm/replay");
  const mode = process.env.HERMETIC_LLM_MODE;
  if (mode === "record" || mode === "replay") {
    const { resolve } = await import("node:path");
    configureLLMReplay({
      mode,
      dir: resolve(process.env.HERMETIC_LLM_FIXTURES ?? "test-fixtures/llm"),
    });
    console.error(`[llm-replay] ${mode} mode`);
  }

  // ── Ingest (same lib calls as the upload route) ──
  const { parseCSV } = await import("@/lib/csv/parser");
  const { extractSchema } = await import("@/lib/csv/schema");
  const { storeCSV } = await import("@/lib/csv/storage");
  const text = readFileSync(csvPath, "utf-8");
  const parsed = parseCSV(text);
  const csvId = randomUUID();
  const schema = extractSchema(parsed, csvId, basename(csvPath));
  await storeCSV(csvId, text, schema);
  console.error(`[ingest] ${schema.filename}: ${schema.row_count} rows`);

  // ── Model/runtime resolution (same defaults as validate-request) ──
  const { CODE_GEN_MODEL, UI_COMPOSE_MODEL } = await import("@/lib/constants");
  const { getActiveSandboxRuntime } = await import("@/lib/runtime-config");

  // ── Run, streaming NDJSON to stdout (and optionally a file) ──
  const { runPatchStream } = await import("@/lib/pipeline/patch-stream");
  const { runAskQuery } = await import("@/lib/pipeline/run-ask-query");
  const lines: string[] = [];
  let exitCode = 0;
  await runPatchStream(
    "cli:ask",
    {
      write(data) {
        lines.push(data);
        process.stdout.write(data);
      },
    },
    async (stream) => {
      await runAskQuery({
        context: {},
        question,
        warehouseId: undefined,
        warehouseState: undefined,
        codeGenModel: CODE_GEN_MODEL,
        uiComposeModel: UI_COMPOSE_MODEL,
        sandboxRuntime: getActiveSandboxRuntime(),
        runState: { csvId, question },
        stream,
      });
      // The error path emits a spec with root="error" — surface as exit code.
      if (lines.some((l) => l.includes('"path":"/root","value":"error"'))) exitCode = 1;
    }
  );
  if (outFile) {
    writeFileSync(outFile, lines.join(""));
    console.error(`[out] ${outFile} (${lines.length} lines)`);
  }

  // ── Persist to history so the web app can render the result ──
  // The routes get this via the client (after render) or the disconnect
  // hook; the CLI has neither, so it persists directly with the same lib
  // calls. Shares the dataRoot with a web harness run from the same
  // directory — open the printed URL to view the dashboard.
  if (exitCode === 0) {
    const { assembleSpecFromPatches } = await import("@/lib/pipeline/assemble-spec");
    const { persistHistoryEntry } = await import("@/lib/history/persist");
    const patches = lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith(":"))
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return []; // progress noise
        }
      });
    const assembled = assembleSpecFromPatches(patches);
    if (assembled) {
      const persisted = await persistHistoryEntry(
        csvId,
        assembled as unknown as Record<string, unknown>,
        question
      );
      if (persisted.saved) {
        console.error(`[history] saved ${persisted.meta.id}`);
        console.error(`[view] http://localhost:3000/?restore=${persisted.meta.id}`);
      } else {
        console.error(`[history] not saved: ${persisted.reason}`);
      }
    }
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("hermetic:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
