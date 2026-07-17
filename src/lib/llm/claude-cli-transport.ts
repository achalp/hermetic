/**
 * Claude CLI provider transport.
 *
 * Runs the `claude` command-line binary (Claude Code) as an LLM backend. Unlike
 * the cloud providers, the CLI authenticates with the machine's own Claude
 * login (subscription / OAuth) — no ANTHROPIC_API_KEY required — which is the
 * whole point of the provider. The tradeoff: the host must have `claude`
 * installed and authenticated, so this is unsuitable for locked-down serverless.
 *
 * Architecture mirrors the local-backend shims (ollama / mlx / llama.cpp): the
 * AI SDK's OpenAI client is pointed at a dummy base URL with a custom `fetch`
 * that intercepts the `/responses` request, spawns `claude`, and re-synthesizes
 * the OpenAI Responses-API surface via the shared helpers in `local-transport`.
 * The app uses no tool-calling and streams plain text deltas, so nothing more
 * is needed. Every piece that can be pure (binary resolution, argv building,
 * line parsing, usage extraction) is factored out for direct unit testing; the
 * process plumbing is the only impure part.
 */
import "server-only";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { once } from "node:events";
import { logger, serializeError } from "@/lib/logger";
import {
  responsesJSON,
  responsesSSE,
  extractMessageText,
  type ResponsesUsage,
} from "@/lib/llm/local-transport";

/** Overall wall-clock budget for a NON-streaming CLI call before we kill it.
 *  Generous because a cold `claude` start can take a few seconds and hard
 *  prompts run for a while; streaming relies on responsesSSE's stall timeout. */
export const CLAUDE_CLI_REQUEST_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/** Above this system-prompt size we fold it into the stdin prompt instead of
 *  passing `--system-prompt` as an argv (kept well under OS ARG_MAX). */
export const SYSTEM_ARG_MAX_BYTES = 32_000;

/** `which`/`existsSync` probe timeout. */
const RESOLVE_TIMEOUT_MS = 3_000;

/**
 * Resolve the `claude` binary path:
 *   1. an explicit configured path (absolute file, or a name resolved via PATH)
 *   2. `claude` on PATH
 * Throws an actionable error if neither resolves.
 */
export function resolveClaudeBinary(configuredPath?: string): string {
  if (configuredPath) {
    if (existsSync(configuredPath)) return configuredPath;
    try {
      const resolved = execSync(`which ${configuredPath}`, {
        encoding: "utf-8",
        timeout: RESOLVE_TIMEOUT_MS,
      }).trim();
      if (resolved) return resolved;
    } catch {
      /* fall through to the throw below */
    }
    throw new Error(
      `Claude CLI binary not found at "${configuredPath}". ` +
        "Install it (npm install -g @anthropic-ai/claude-code) or set the correct path in Settings."
    );
  }

  try {
    const onPath = execSync("which claude", {
      encoding: "utf-8",
      timeout: RESOLVE_TIMEOUT_MS,
    }).trim();
    if (onPath) return onPath;
  } catch {
    /* not on PATH */
  }

  throw new Error(
    "Claude CLI ('claude') not found on PATH. Install it with:\n" +
      "  npm install -g @anthropic-ai/claude-code\n" +
      "then run 'claude' once to authenticate."
  );
}

/** Cheap boolean check used by provider auto-detection and the /api/providers route. */
export function isClaudeCliAvailable(configuredPath?: string): boolean {
  try {
    resolveClaudeBinary(configuredPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the exact `claude` invocation (argv + stdin) for a single generation.
 * Pure and centralized so the CLI contract lives in one tested place.
 *
 * - `-p` runs print (non-interactive) mode; the prompt is read from stdin.
 * - `--output-format json` returns one result object; `stream-json` (which
 *   requires `--verbose`) emits JSONL, and `--include-partial-messages` adds
 *   token-level `content_block_delta` events for real streaming.
 * - `--model` selects the model; `--system-prompt` REPLACES Claude Code's
 *   default agent system prompt so the CLI behaves as a plain generator.
 * - A system prompt too large for argv is folded into the stdin prompt instead
 *   (signalled via `systemFolded` so the caller can log it).
 */
export function buildClaudeInvocation(input: {
  model: string;
  system: string;
  prompt: string;
  streaming: boolean;
}): { args: string[]; stdin: string; systemFolded: boolean } {
  const { model, system, prompt, streaming } = input;

  const args: string[] = ["-p", "--output-format", streaming ? "stream-json" : "json"];
  if (streaming) args.push("--verbose", "--include-partial-messages");
  if (model) args.push("--model", model);

  let stdin = prompt;
  let systemFolded = false;
  if (system) {
    if (Buffer.byteLength(system, "utf8") <= SYSTEM_ARG_MAX_BYTES) {
      args.push("--system-prompt", system);
    } else {
      // Too large for a safe argv — prepend to the prompt. The default agent
      // system prompt stays active in this rare case, but the generation still
      // sees our instructions first.
      stdin = `${system}\n\n${prompt}`;
      systemFolded = true;
    }
  }

  return { args, stdin, systemFolded };
}

/**
 * Token usage from a CLI `result` object. Cache tokens are folded into the
 * input total (the downstream V3 usage mapping only reads input/output totals).
 */
export function parseCliResultUsage(result: Record<string, unknown>): ResponsesUsage {
  const u = (result.usage ?? {}) as Record<string, number>;
  const inputTokens =
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return { inputTokens, outputTokens: u.output_tokens ?? 0 };
}

/**
 * Text-delta extractor for `stream-json --include-partial-messages` lines.
 * Returns the delta text for a `content_block_delta` / `text_delta` event, else
 * null. Throws on non-JSON — `responsesSSE` treats a throw as a skippable line
 * (same contract as `ollamaDelta` / `openAISSEDelta`).
 */
export function claudeCliDelta(trimmedLine: string): string | null {
  const evt = JSON.parse(trimmedLine) as {
    type?: string;
    event?: { type?: string; delta?: { type?: string; text?: string } };
  };
  if (
    evt?.type === "stream_event" &&
    evt.event?.type === "content_block_delta" &&
    evt.event.delta?.type === "text_delta"
  ) {
    return evt.event.delta.text ?? null;
  }
  return null;
}

/** Usage extractor for the terminal `result` line of a stream-json response. */
export function claudeCliUsageFromLine(trimmedLine: string): ResponsesUsage | null {
  const evt = JSON.parse(trimmedLine) as Record<string, unknown>;
  if (evt?.type === "result") return parseCliResultUsage(evt);
  return null;
}

/** Non-retryable error Response (status 422 so the AI SDK does not retry). */
function cliError(message: string, status = 422): Response {
  return new Response(JSON.stringify({ error: { message, type: "cli_error" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readableToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Custom `fetch` for the claude-cli provider. Intercepts the AI SDK's
 * `/responses` request, spawns `claude`, and translates its stdout back into the
 * Responses-API shape (streaming SSE or a single JSON envelope). Non-`/responses`
 * requests pass through untouched.
 */
export function claudeCliFetch(opts: { binaryPath?: string; timeoutMs?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? CLAUDE_CLI_REQUEST_TIMEOUT_MS;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (!url.includes("/responses") || !init?.body) {
      return globalThis.fetch(input, init);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body as string);
    } catch {
      return globalThis.fetch(input, init);
    }

    const isStreaming = body.stream === true;
    const model = String(body.model ?? "");
    const system = (body.instructions as string) ?? "";
    const rawMessages = (body.input ?? []) as Array<Record<string, unknown>>;
    const prompt = rawMessages
      .map((m) => extractMessageText(m.content))
      .filter(Boolean)
      .join("\n\n");

    // Resolve the binary here (not at client-construction) so a missing/broken
    // install surfaces as a normal request error the SDK reports, not a throw
    // deep in getModel().
    let binary: string;
    try {
      binary = resolveClaudeBinary(opts.binaryPath);
    } catch (err) {
      logger.error("claudeCliFetch: binary resolution failed", serializeError(err));
      return cliError(err instanceof Error ? err.message : String(err));
    }

    const { args, stdin, systemFolded } = buildClaudeInvocation({
      model,
      system,
      prompt,
      streaming: isStreaming,
    });
    if (systemFolded) {
      logger.warn("claudeCliFetch: system prompt too large for argv, folded into stdin", {
        systemChars: system.length,
        limitBytes: SYSTEM_ARG_MAX_BYTES,
      });
    }
    logger.info("claudeCliFetch spawn", {
      binary,
      model,
      streaming: isStreaming,
      systemChars: system.length,
      promptChars: prompt.length,
    });

    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });

    // Distinguish a failed spawn (ENOENT) from a running process: `spawn` fires
    // on success, `error` (without `spawn`) on failure.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (e: Error) => {
          cleanup();
          reject(e);
        };
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (err) {
      logger.error("claudeCliFetch: spawn failed", serializeError(err));
      return cliError(`Failed to start Claude CLI: ${err instanceof Error ? err.message : err}`);
    }

    // Late errors (after a successful spawn) must not crash the process.
    child.on("error", (err) => logger.error("claudeCliFetch: child error", serializeError(err)));

    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    try {
      child.stdin.write(stdin);
      child.stdin.end();
    } catch (err) {
      logger.error("claudeCliFetch: stdin write failed", serializeError(err));
    }

    // ── Streaming: stdout JSONL → Responses SSE (shared synthesizer) ──
    if (isStreaming) {
      child.once("close", (code) => {
        if (code === 0) logger.debug("claudeCliFetch: stream complete", { code });
        else
          logger.warn("claudeCliFetch: stream exited non-zero", {
            code,
            stderr: stderr.slice(0, 500),
          });
      });
      return responsesSSE({
        upstream: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        model,
        deltaFromLine: claudeCliDelta,
        usageFromLine: claudeCliUsageFromLine,
        backend: "claude-cli",
      });
    }

    // ── Non-streaming: read all stdout, parse the result envelope ──
    const killTimer = setTimeout(() => {
      logger.error("claudeCliFetch: timed out, killing process", { timeoutMs });
      child.kill("SIGKILL");
    }, timeoutMs);

    let stdout: string;
    let code: number | null;
    try {
      const [out, closeArgs] = await Promise.all([
        readableToString(child.stdout),
        once(child, "close") as Promise<[number | null]>,
      ]);
      stdout = out;
      code = closeArgs[0];
    } finally {
      clearTimeout(killTimer);
    }

    if (code !== 0) {
      logger.error("claudeCliFetch: exited non-zero", { code, stderr: stderr.slice(0, 500) });
      return cliError(
        `Claude CLI exited with code ${code}. ${stderr.slice(0, 300) || "No error output."}`
      );
    }

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(stdout);
    } catch {
      logger.error("claudeCliFetch: non-JSON output", { body: stdout.slice(0, 500) });
      return cliError(`Claude CLI returned non-JSON output: ${stdout.slice(0, 200)}`, 502);
    }

    if (result.is_error || typeof result.result !== "string") {
      const detail = typeof result.result === "string" ? result.result : JSON.stringify(result);
      logger.error("claudeCliFetch: result reported an error", {
        subtype: result.subtype,
        detail: detail.slice(0, 300),
      });
      return cliError(`Claude CLI error: ${detail.slice(0, 300)}`);
    }

    const usage = parseCliResultUsage(result);
    logger.info("claudeCliFetch: complete", {
      model,
      outputChars: (result.result as string).length,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    return responsesJSON(model, result.result as string, usage);
  };
}
