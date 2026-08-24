import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelMiddleware } from "ai";

/**
 * Record/replay layer for LLM calls (modularization M0-0a).
 *
 * Sits INNERMOST in the track() middleware chain — usage/cost middleware still
 * observes replayed results, so cost attribution stays live in replay mode.
 *
 * Configuration is pushed in by the harness (instrumentation.ts for the Next
 * server, test-setup for vitest) via configureLLMReplay(); this module reads
 * no environment and assumes no working directory, per the modularization
 * config contract (HermeticConfig, spec §3.2).
 *
 * - record: every doGenerate/doStream result is captured to
 *   `<dir>/<costKey>-<hash>.json`, keyed by a stable hash of the request
 *   params. Run against real providers once; commit the fixtures.
 * - replay: requests are served from fixtures; a miss fails loudly with the
 *   request digest. Prompt drift therefore surfaces as a visible fixture-hash
 *   failure instead of a silent output-quality change.
 */

// Config types are owned by contracts/harness-boot (the slot must not import
// this file); re-exported here for existing consumers.
export type { LLMReplayMode, LLMReplayConfig } from "@/lib/contracts/harness-boot";
import type { LLMReplayConfig } from "@/lib/contracts/harness-boot";

// Config crosses Next dev's separate module graphs via the shared harness
// slot (see lib/harness-slot.ts — the M0-0a lesson).
import { harnessSlot } from "@/lib/harness-slot";

export function configureLLMReplay(cfg: LLMReplayConfig | null): void {
  harnessSlot().llmReplay = cfg;
}

export function llmReplayConfig(): LLMReplayConfig | null {
  return harnessSlot().llmReplay ?? null;
}

/** Deterministic JSON stringify: object keys sorted recursively. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, function replacer(_key, val) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) sorted[k] = (val as Record<string, unknown>)[k];
      return sorted;
    }
    return val;
  });
}

/**
 * Hash input = the request MINUS transport metadata. `headers` carries the
 * AI SDK's user-agent (e.g. "ai/6.0.116"), so hashing it invalidated every
 * generate-kind fixture on a routine dependency bump — prompt content is
 * the identity, transport is not.
 *
 * `cacheControl` under providerOptions.anthropic is stripped for the same
 * reason: cachedSystem/cachedText (lib/llm/client.ts) inject prompt-caching
 * directives ONLY when the active provider is "anthropic", so the same
 * semantic request hashes differently per provider — fixtures recorded via
 * the claude-cli transport missed on every call in CI, where the dummy
 * ANTHROPIC_API_KEY selects the API provider (exit-audit follow-through,
 * PR #94). Caching directives change billing, not content.
 */
function stripCacheControl(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(stripCacheControl);
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k === "providerOptions" && v && typeof v === "object") {
        const po = { ...(v as Record<string, unknown>) };
        if (po.anthropic && typeof po.anthropic === "object") {
          const { cacheControl: _cc, ...anthropicRest } = po.anthropic as Record<string, unknown>;
          if (Object.keys(anthropicRest).length > 0) po.anthropic = anthropicRest;
          else delete po.anthropic;
        }
        if (Object.keys(po).length > 0) out[k] = stripCacheControl(po);
        continue; // empty providerOptions is dropped entirely
      }
      out[k] = stripCacheControl(v);
    }
    return out;
  }
  return val;
}

function hashableParams(params: unknown): unknown {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const { headers: _headers, ...rest } = params as Record<string, unknown>;
    return stripCacheControl(rest);
  }
  return params;
}

function requestHash(modelId: string, params: unknown): string {
  return createHash("sha256")
    .update(modelId)
    .update(" ")
    .update(stableStringify(hashableParams(params)))
    .digest("hex")
    .slice(0, 16);
}

function fixturePath(dir: string, costKey: string, hash: string): string {
  // costKey sanitized for filesystem use; hash carries the identity.
  const safeKey = costKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(dir, `${safeKey}-${hash}.json`);
}

interface GenerateFixture {
  kind: "generate";
  costKey: string;
  modelId: string;
  /** Truncated prompt preview for humans reviewing fixture diffs. */
  requestPreview: string;
  result: unknown;
}

interface StreamFixture {
  kind: "stream";
  costKey: string;
  modelId: string;
  requestPreview: string;
  chunks: unknown[];
}

function preview(params: unknown): string {
  return stableStringify(params).slice(0, 2000);
}

function writeMissDiagnostic(
  dir: string,
  costKey: string,
  modelId: string,
  hash: string,
  params: unknown
): void {
  // A miss means the prompt drifted since recording. Persist the FULL request
  // next to the fixtures so the drift is diffable against the stored
  // fixture's requestPreview (which truncates) — turns "re-record and hope"
  // into "diff and see exactly what changed".
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${costKey.replace(/[^a-zA-Z0-9_-]/g, "_")}-${hash}.miss.json`),
      JSON.stringify({ costKey, modelId, hash, request: params }, null, 2) + "\n"
    );
  } catch {
    // diagnostic only — never mask the real error
  }
}

/** Replay diagnostics (cfg.debug): dump every replay-mode request, hit AND
 *  miss, as *.hit.json. CI ships these in the golden-miss-diagnostics
 *  artifact so a golden failure arrives with its exact request bytes — a
 *  CI-vs-local prompt divergence becomes a file diff instead of a guessing
 *  game (this is how the fixture-chain inconsistency and the Docker 29
 *  egress regression were isolated). */
function writeHitDiagnostic(
  enabled: boolean | undefined,
  dir: string,
  costKey: string,
  modelId: string,
  hash: string,
  params: unknown
): void {
  if (!enabled) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${costKey.replace(/[^a-zA-Z0-9_-]/g, "_")}-${hash}.hit.json`),
      JSON.stringify({ costKey, modelId, hash, request: params }, null, 2) + "\n"
    );
  } catch {
    // diagnostic only
  }
}

function missError(costKey: string, modelId: string, hash: string, dir: string): Error {
  return new Error(
    `LLM replay miss: no fixture for costKey=${costKey} model=${modelId} hash=${hash} in ${dir}. ` +
      `The prompt or model changed since fixtures were recorded. ` +
      `Re-record with HERMETIC_LLM_MODE=record and review the fixture diff.`
  );
}

/**
 * Middleware factory. Always attach it (innermost); it is a no-op passthrough
 * until configureLLMReplay() is called, so harness boot order can't race
 * model construction.
 */
export function llmReplayMiddleware(costKey: string): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const cfg = llmReplayConfig();
      if (!cfg) return doGenerate();
      const modelId = (model as { modelId?: string }).modelId ?? "unknown-model";
      const hash = requestHash(modelId, params);
      const file = fixturePath(cfg.dir, costKey, hash);

      if (cfg.mode === "replay") {
        writeHitDiagnostic(cfg.debug, cfg.dir, costKey, modelId, hash, params);
        if (!existsSync(file)) {
          writeMissDiagnostic(cfg.dir, costKey, modelId, hash, params);
          throw missError(costKey, modelId, hash, cfg.dir);
        }
        const fixture = JSON.parse(readFileSync(file, "utf8")) as GenerateFixture;
        return fixture.result as Awaited<ReturnType<typeof doGenerate>>;
      }

      // Record-if-miss: an identical request repeated DURING a recording pass
      // must replay the already-recorded answer, not call live again. A second
      // live call gets a different (nondeterministic) answer and overwrites
      // the fixture — any later prompt that embedded the FIRST answer's
      // results then permanently misses on replay (the ask-followup journey:
      // its Q1 re-ask overwrote ask-basic's fixture, so Q2's recorded prompt
      // referenced results no replayed Q1 could ever produce). To force a
      // fresh recording, delete the fixture files first.
      if (existsSync(file)) {
        const fixture = JSON.parse(readFileSync(file, "utf8")) as GenerateFixture;
        // Same hash but a stream fixture (kinds share the file namespace):
        // record live rather than serve the wrong shape.
        if (fixture.kind === "generate") {
          return fixture.result as Awaited<ReturnType<typeof doGenerate>>;
        }
      }

      const result = await doGenerate();
      // request/response carry live wire metadata (headers, raw bodies) that
      // is neither deterministic nor needed to reproduce behavior — drop them.
      const { request: _req, response: _res, ...serializable } = result as Record<string, unknown>;
      const fixture: GenerateFixture = {
        kind: "generate",
        costKey,
        modelId,
        requestPreview: preview(params),
        result: serializable,
      };
      mkdirSync(cfg.dir, { recursive: true });
      writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
      return result;
    },
    wrapStream: async ({ doStream, params, model }) => {
      const cfg = llmReplayConfig();
      if (!cfg) return doStream();
      const modelId = (model as { modelId?: string }).modelId ?? "unknown-model";
      const hash = requestHash(modelId, params);
      const file = fixturePath(cfg.dir, costKey, hash);

      if (cfg.mode === "replay") {
        writeHitDiagnostic(cfg.debug, cfg.dir, costKey, modelId, hash, params);
        if (!existsSync(file)) {
          writeMissDiagnostic(cfg.dir, costKey, modelId, hash, params);
          throw missError(costKey, modelId, hash, cfg.dir);
        }
        const fixture = JSON.parse(readFileSync(file, "utf8")) as StreamFixture;
        const stream = new ReadableStream({
          start(controller) {
            for (const chunk of fixture.chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
        return { stream } as Awaited<ReturnType<typeof doStream>>;
      }

      // Record-if-miss — same rationale as wrapGenerate above.
      if (existsSync(file)) {
        const fixture = JSON.parse(readFileSync(file, "utf8")) as StreamFixture;
        if (fixture.kind === "stream") {
          const stream = new ReadableStream({
            start(controller) {
              for (const chunk of fixture.chunks) controller.enqueue(chunk);
              controller.close();
            },
          });
          return { stream } as Awaited<ReturnType<typeof doStream>>;
        }
      }

      const { stream, ...rest } = await doStream();
      const chunks: unknown[] = [];
      const recording = stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            chunks.push(chunk);
            controller.enqueue(chunk);
          },
          flush() {
            const fixture: StreamFixture = {
              kind: "stream",
              costKey,
              modelId,
              requestPreview: preview(params),
              chunks,
            };
            mkdirSync(cfg.dir, { recursive: true });
            writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
          },
        })
      );
      return { stream: recording, ...rest };
    },
  };
}

/** Test-only surface (hash portability tests exercise the exclusions). */
export const __testing = { requestHash, hashableParams };
