/**
 * Tests for the Claude CLI provider transport. The pure pieces (binary
 * resolution, argv building, line parsing, usage extraction) are tested
 * directly; the impure `claudeCliFetch` is tested against a mocked `spawn`
 * that emits a fake child process, so we cover the streaming SSE path, the
 * non-streaming JSON path, and every failure branch without a real `claude`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execSync: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }),
  // Kept for any transitive run-context import; the transport itself no
  // longer pulls in run-control (the stop signal is per-request init.signal).
  setRunIdProvider: vi.fn(),
}));

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { logger } from "@/lib/logger";
import {
  resolveClaudeBinary,
  isClaudeCliAvailable,
  buildClaudeInvocation,
  parseCliResultUsage,
  claudeCliDelta,
  claudeCliUsageFromLine,
  claudeCliFetch,
  claudeCliChildEnv,
  SYSTEM_ARG_MAX_BYTES,
  resolveEffort,
  supportsEffortFlag,
  _resetEffortSupportCache,
} from "@/lib/llm/claude-cli-transport";

const mockedSpawn = vi.mocked(spawn);
const mockedExecSync = vi.mocked(execSync);
const mockedExistsSync = vi.mocked(existsSync);

beforeEach(() => {
  vi.clearAllMocks();
  // "default" bypasses the --effort flag AND its --help capability probe —
  // the probe would otherwise consume each test's single mocked child. The
  // effort suite below manages this variable itself.
  process.env.HERMETIC_CLAUDE_CLI_EFFORT = "default";
});

afterEach(() => {
  delete process.env.HERMETIC_CLAUDE_CLI_EFFORT;
});

// ── Fake child process ─────────────────────────────────────────────
interface FakeOpts {
  stdout?: string | string[];
  stderr?: string;
  exitCode?: number;
  spawnError?: Error;
}

function makeChild(opts: FakeOpts = {}) {
  const { stdout = "", stderr = "", exitCode = 0, spawnError } = opts;
  const child = new EventEmitter() as EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stderr: EventEmitter;
    stdout: Readable;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
  };
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stderr = new EventEmitter();
  // Emit byte chunks (real `claude` stdout is bytes) so Readable.toWeb + the
  // SSE decoder in responsesSSE receive Uint8Array, not object-mode strings.
  const chunks = (Array.isArray(stdout) ? stdout : [stdout]).map((s) => Buffer.from(s));
  child.stdout = Readable.from(chunks);
  child.kill = vi.fn();
  child.exitCode = null;

  if (spawnError) {
    queueMicrotask(() => child.emit("error", spawnError));
  } else {
    queueMicrotask(() => child.emit("spawn"));
    // Emit stderr + close only once stdout drains — by then claudeCliFetch has
    // attached its stderr listener (it does so after the spawn await resolves).
    child.stdout.on("end", () => {
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.exitCode = exitCode;
      child.emit("close", exitCode);
    });
  }
  return child;
}

function requestInit(body: Record<string, unknown>): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}
async function readSSE(res: Response): Promise<SSEEvent[]> {
  const text = await res.text();
  const events: SSEEvent[] = [];
  for (const block of text.split("\n\n")) {
    const e = block.match(/^event: (.+)$/m);
    const d = block.match(/^data: (.+)$/m);
    if (e && d) events.push({ event: e[1], data: JSON.parse(d[1]) });
  }
  return events;
}

// ── buildClaudeInvocation ──────────────────────────────────────────
describe("buildClaudeInvocation", () => {
  it("builds a non-streaming invocation with model + system-prompt arg", () => {
    const { args, stdin, systemFolded } = buildClaudeInvocation({
      model: "claude-sonnet-4-6",
      system: "You are helpful.",
      prompt: "Hello",
      streaming: false,
    });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--model",
      "claude-sonnet-4-6",
      "--system-prompt",
      "You are helpful.",
    ]);
    expect(stdin).toBe("Hello");
    expect(systemFolded).toBe(false);
  });

  it("disables built-in tools on every call (documented empty-string form)", () => {
    const { args } = buildClaudeInvocation({
      model: "m",
      system: "",
      prompt: "x",
      streaming: false,
    });
    const i = args.indexOf("--tools");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("");
  });

  it("adds the streaming flags for stream-json", () => {
    const { args } = buildClaudeInvocation({
      model: "claude-opus-4-8",
      system: "",
      prompt: "hi",
      streaming: true,
    });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--tools",
      "",
      "--verbose",
      "--include-partial-messages",
      "--model",
      "claude-opus-4-8",
    ]);
  });

  it("omits --model and --system-prompt when not provided", () => {
    const { args } = buildClaudeInvocation({
      model: "",
      system: "",
      prompt: "x",
      streaming: false,
    });
    expect(args).toEqual(["-p", "--output-format", "json", "--tools", ""]);
  });

  it("folds an oversized system prompt into stdin instead of argv", () => {
    const bigSystem = "S".repeat(SYSTEM_ARG_MAX_BYTES + 1);
    const { args, stdin, systemFolded } = buildClaudeInvocation({
      model: "claude-opus-4-8",
      system: bigSystem,
      prompt: "question",
      streaming: false,
    });
    expect(args).not.toContain("--system-prompt");
    expect(stdin).toBe(`${bigSystem}\n\nquestion`);
    expect(systemFolded).toBe(true);
  });

  // Regression guard for the fold that fired on 100% of code-gen calls: the cap
  // was 32,000 while every buildCodeGenSystemPrompt output is ~58 KB (and the
  // repair path ~63 KB), so --system-prompt was never passed and Claude Code's
  // own agent system prompt stayed active — ~8,840 extra input tokens per call,
  // plus the wrong framing and our instructions demoted from system to user.
  // Nothing detected it because a fold is silent by design. This pins the real
  // prompt under the cap; if it ever trips, prefer --system-prompt-file (no size
  // limit) over raising SYSTEM_ARG_MAX_BYTES past the Linux 131,072 per-arg cap.
  it("passes the REAL code-gen system prompt as argv, never folded", async () => {
    const { buildCodeGenSystemPrompt } = await import("@/lib/llm/prompts");
    for (const mode of ["metadata", "sample"] as const) {
      for (const hasWorkbook of [false, true]) {
        for (const purpose of ["dashboard", "brief", "report", "deep-dive"]) {
          const system = buildCodeGenSystemPrompt(mode, hasWorkbook, "time_series", purpose);
          const bytes = Buffer.byteLength(system, "utf8");
          const label = `${mode}/wb=${hasWorkbook}/${purpose} at ${bytes} bytes`;
          expect(bytes, label).toBeLessThan(SYSTEM_ARG_MAX_BYTES);
          const { args, systemFolded } = buildClaudeInvocation({
            model: "claude-sonnet-5",
            system,
            prompt: "question",
            streaming: true,
          });
          expect(systemFolded, `${label} folded`).toBe(false);
          expect(args).toContain("--system-prompt");
        }
      }
    }
  });

  it("keeps SYSTEM_ARG_MAX_BYTES under the Linux per-argument cap", () => {
    // MAX_ARG_STRLEN = 32 pages = 131,072 bytes on Linux; macOS has no
    // comparable per-arg limit. Headroom here is what absorbs prompt growth
    // (user skills feed into the code-gen system prompt).
    expect(SYSTEM_ARG_MAX_BYTES).toBeLessThan(131_072);
  });
});

// ── claudeCliChildEnv (use the claude.ai login, keep the app's key) ──
describe("claudeCliChildEnv", () => {
  it("strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the child env", () => {
    const { env, stripped } = claudeCliChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-live",
      ANTHROPIC_AUTH_TOKEN: "tok",
      HOME: "/home/x",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(stripped.sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    // Everything else the CLI needs (PATH, HOME, …) is preserved.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
  });

  it("is a no-op when no key is set, and reports nothing stripped", () => {
    const { env, stripped } = claudeCliChildEnv({ PATH: "/usr/bin" });
    expect(stripped).toEqual([]);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("does NOT mutate the caller's env (parent keeps the key for the API provider)", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-live", PATH: "/usr/bin" };
    claudeCliChildEnv(base);
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-live"); // parent untouched → no reload needed
  });

  it("ignores an empty-string key (treats it as unset)", () => {
    const { stripped } = claudeCliChildEnv({ ANTHROPIC_API_KEY: "" });
    expect(stripped).toEqual([]);
  });
});

// ── parseCliResultUsage ────────────────────────────────────────────
describe("parseCliResultUsage", () => {
  it("totals the prompt buckets and surfaces cache reads separately", () => {
    // Total = 100 + 20 + 5; cache reads (20) are broken out so they price at
    // the cache-read rate, not full input.
    expect(
      parseCliResultUsage({
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 40,
        },
      })
    ).toEqual({ inputTokens: 125, cachedInputTokens: 20, outputTokens: 40 });
  });

  it("defaults to zeros when usage is absent", () => {
    expect(parseCliResultUsage({})).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});

// ── claudeCliDelta / claudeCliUsageFromLine ────────────────────────
describe("stream-json line extractors", () => {
  it("claudeCliDelta reads text_delta content and ignores other events", () => {
    expect(
      claudeCliDelta(
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}'
      )
    ).toBe("hi");
    expect(claudeCliDelta('{"type":"system","subtype":"init"}')).toBeNull();
    expect(claudeCliDelta('{"type":"stream_event","event":{"type":"message_start"}}')).toBeNull();
    expect(() => claudeCliDelta("not json")).toThrow(); // caller treats throw as skip
  });

  it("claudeCliUsageFromLine returns usage only for the result line", () => {
    expect(
      claudeCliUsageFromLine('{"type":"result","usage":{"input_tokens":7,"output_tokens":3}}')
    ).toEqual({ inputTokens: 7, cachedInputTokens: 0, outputTokens: 3 });
    expect(claudeCliUsageFromLine('{"type":"assistant"}')).toBeNull();
  });
});

// ── resolveClaudeBinary / isClaudeCliAvailable ─────────────────────
describe("resolveClaudeBinary", () => {
  it("returns a configured path that exists on disk", () => {
    mockedExistsSync.mockReturnValue(true);
    expect(resolveClaudeBinary("/opt/claude")).toBe("/opt/claude");
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("resolves a configured name via PATH when it is not a file", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedExecSync.mockReturnValue("/usr/bin/claude\n" as never);
    expect(resolveClaudeBinary("claude")).toBe("/usr/bin/claude");
  });

  it("throws an actionable error for an unresolvable configured path", () => {
    mockedExistsSync.mockReturnValue(false);
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(() => resolveClaudeBinary("/nope/claude")).toThrow(/not found at "\/nope\/claude"/);
  });

  it("finds `claude` on PATH when no path is configured", () => {
    mockedExecSync.mockReturnValue("/usr/local/bin/claude\n" as never);
    expect(resolveClaudeBinary()).toBe("/usr/local/bin/claude");
    expect(mockedExecSync).toHaveBeenCalledWith("which claude", expect.anything());
  });

  it("throws install guidance when `claude` is not on PATH", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("which: no claude");
    });
    expect(() => resolveClaudeBinary()).toThrow(/not found on PATH/);
  });
});

describe("isClaudeCliAvailable", () => {
  it("is true when the binary resolves and false when it does not", () => {
    mockedExecSync.mockReturnValue("/usr/local/bin/claude\n" as never);
    expect(isClaudeCliAvailable()).toBe(true);

    mockedExecSync.mockImplementation(() => {
      throw new Error("nope");
    });
    expect(isClaudeCliAvailable()).toBe(false);
  });
});

// ── claudeCliFetch ─────────────────────────────────────────────────
describe("claudeCliFetch", () => {
  beforeEach(() => {
    // Default: `claude` resolves on PATH.
    mockedExecSync.mockReturnValue("/usr/local/bin/claude\n" as never);
    mockedExistsSync.mockReturnValue(false);
  });

  it("passes non-/responses requests straight through to global fetch", async () => {
    const sentinel = new Response("ok");
    const globalSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sentinel);
    const res = await claudeCliFetch()("http://x/other", requestInit({ input: [] }));
    expect(res).toBe(sentinel);
    expect(mockedSpawn).not.toHaveBeenCalled();
    globalSpy.mockRestore();
  });

  it("spawns the binary and returns a Responses JSON envelope (non-streaming)", async () => {
    mockedSpawn.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          result: "The answer is 42.",
          usage: { input_tokens: 30, output_tokens: 6 },
        }),
      }) as never
    );

    const res = await claudeCliFetch()(
      "http://claude-cli.local/v1/responses",
      requestInit({
        model: "claude-sonnet-4-6",
        instructions: "Be terse.",
        input: [{ role: "user", content: "What is 6*7?" }],
        stream: false,
      })
    );

    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.output[0].content[0].text).toBe("The answer is 42.");
    expect(body.usage).toEqual({ input_tokens: 30, output_tokens: 6, total_tokens: 36 });

    // Spawn was invoked with the resolved binary and the built argv.
    const [bin, args] = mockedSpawn.mock.calls[0];
    expect(bin).toBe("/usr/local/bin/claude");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).toContain("--system-prompt");
    // The flattened prompt was written to stdin.
    const child = mockedSpawn.mock.results[0].value;
    expect(child.stdin.write).toHaveBeenCalledWith("What is 6*7?");
  });

  it("SIGKILLs the CLI child when the request signal is aborted (stop)", async () => {
    // Regression: a /stop aborts the fetch, but the transport used to ignore
    // init.signal, so the spawned `claude` kept running (and billing). It must
    // now kill the child.
    const child = makeChild({
      stdout: JSON.stringify({ type: "result", subtype: "success", result: "x", usage: {} }),
    });
    mockedSpawn.mockReturnValue(child as never);

    const controller = new AbortController();
    controller.abort(); // stopped before the CLI can finish

    await claudeCliFetch()("http://claude-cli.local/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        instructions: "x",
        input: [{ role: "user", content: "hi" }],
        stream: false,
      }),
      signal: controller.signal,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("surfaces cache-read tokens as input_tokens_details so they price cheaply", async () => {
    mockedSpawn.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({
          type: "result",
          result: "hi",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 15000,
            cache_creation_input_tokens: 200,
            output_tokens: 5,
          },
        }),
      }) as never
    );
    const res = await claudeCliFetch()(
      "http://claude-cli.local/v1/responses",
      requestInit({ model: "m", input: [{ role: "user", content: "x" }], stream: false })
    );
    const body = await res.json();
    // Total prompt = 10 + 15000 + 200; the 15000 cache reads are broken out as
    // cached_tokens → the SDK prices them at the cache-read rate, not full input.
    expect(body.usage.input_tokens).toBe(15210);
    expect(body.usage.input_tokens_details).toEqual({ cached_tokens: 15000 });
  });

  it("streams stream-json deltas into Responses SSE, including terminal usage", async () => {
    mockedSpawn.mockReturnValue(
      makeChild({
        stdout: [
          '{"type":"system","subtype":"init"}\n',
          '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}\n',
          '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}\n',
          '{"type":"result","subtype":"success","result":"Hello","usage":{"input_tokens":12,"output_tokens":2}}\n',
        ],
      }) as never
    );

    const res = await claudeCliFetch()(
      "http://claude-cli.local/v1/responses",
      requestInit({
        model: "claude-opus-4-8",
        input: [{ role: "user", content: "hi" }],
        stream: true,
      })
    );

    const events = await readSSE(res);
    const done = events.find((e) => e.event === "response.output_text.done");
    expect(done?.data.text).toBe("Hello");
    // Usage from the terminal `result` line rides on the completed event.
    const completed = events.find((e) => e.event === "response.completed");
    expect((completed?.data.response as { usage?: unknown }).usage).toEqual({
      input_tokens: 12,
      output_tokens: 2,
      total_tokens: 14,
    });
  });

  it("returns a 422 (non-retryable) when the binary cannot be resolved", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("no claude");
    });
    const res = await claudeCliFetch()(
      "http://claude-cli.local/v1/responses",
      requestInit({ model: "m", input: [{ role: "user", content: "x" }], stream: false })
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.type).toBe("cli_error");
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns a 422 when the process fails to spawn (ENOENT)", async () => {
    mockedSpawn.mockReturnValue(makeChild({ spawnError: new Error("spawn ENOENT") }) as never);
    const res = await claudeCliFetch()(
      "http://claude-cli.local/v1/responses",
      requestInit({ model: "m", input: [{ role: "user", content: "x" }], stream: false })
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/Failed to start Claude CLI/);
  });

  it("returns a 422 with stderr when the CLI exits non-zero", async () => {
    mockedSpawn.mockReturnValue(
      makeChild({ stdout: "", stderr: "auth expired", exitCode: 1 }) as never
    );
    const res = await claudeCliFetch()(
      "http://claude-cli.local/v1/responses",
      requestInit({ model: "m", input: [{ role: "user", content: "x" }], stream: false })
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/exited with code 1.*auth expired/);
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns a 502 when the CLI prints non-JSON output", async () => {
    mockedSpawn.mockReturnValue(makeChild({ stdout: "not json at all" }) as never);
    const res = await claudeCliFetch()(
      "http://claude-cli.local/v1/responses",
      requestInit({ model: "m", input: [{ role: "user", content: "x" }], stream: false })
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/non-JSON/);
  });

  it("returns a 422 when the result envelope reports an error", async () => {
    mockedSpawn.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }),
      }) as never
    );
    const res = await claudeCliFetch()(
      "http://claude-cli.local/v1/responses",
      requestInit({ model: "m", input: [{ role: "user", content: "x" }], stream: false })
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/Claude CLI error/);
  });

  it("warns and folds an oversized system prompt into stdin", async () => {
    mockedSpawn.mockReturnValue(
      makeChild({
        stdout: JSON.stringify({ type: "result", result: "ok", usage: {} }),
      }) as never
    );
    const bigSystem = "S".repeat(SYSTEM_ARG_MAX_BYTES + 10);
    await claudeCliFetch()(
      "http://claude-cli.local/v1/responses",
      requestInit({
        model: "m",
        instructions: bigSystem,
        input: [{ role: "user", content: "q" }],
        stream: false,
      })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("system prompt too large"),
      expect.anything()
    );
    const child = mockedSpawn.mock.results[0].value;
    expect(child.stdin.write).toHaveBeenCalledWith(`${bigSystem}\n\nq`);
  });
});

// ── Thinking effort (--effort) ─────────────────────────────────────
describe("thinking effort", () => {
  const ENV = "HERMETIC_CLAUDE_CLI_EFFORT";
  beforeEach(() => {
    // The suite-level beforeEach sets "default" (probe bypass); these tests
    // exercise the real resolution order, so start from a clean env.
    delete process.env[ENV];
  });

  it("appends --effort to the invocation, and omits it when absent", () => {
    const withEffort = buildClaudeInvocation({
      model: "m",
      system: "",
      prompt: "p",
      streaming: false,
      effort: "low",
    });
    expect(withEffort.args).toContain("--effort");
    expect(withEffort.args[withEffort.args.indexOf("--effort") + 1]).toBe("low");

    const without = buildClaudeInvocation({
      model: "m",
      system: "",
      prompt: "p",
      streaming: false,
    });
    expect(without.args).not.toContain("--effort");
  });

  it("defaults to LOW outside any reasoning phase — the cost fix this knob exists for", () => {
    expect(resolveEffort({})).toBe("low");
  });

  it("routes reasoning and compose phases to HIGH, the rest to LOW", async () => {
    const { withPhase } = await import("@/lib/cost/accumulator");
    expect(await withPhase("code_gen", async () => resolveEffort({}))).toBe("high");
    expect(await withPhase("sql_gen", async () => resolveEffort({}))).toBe("high");
    expect(await withPhase("sql_repair", async () => resolveEffort({}))).toBe("high");
    expect(await withPhase("code_review", async () => resolveEffort({}))).toBe("high");
    // Compose writes the prose the user reads — deliberately HIGH, and the one
    // non-analysis phase we pay full reasoning for.
    expect(await withPhase("compose", async () => resolveEffort({}))).toBe("high");
    expect(await withPhase("planner", async () => resolveEffort({}))).toBe("low");
    // Explicit overrides still beat the phase policy.
    expect(
      await withPhase("code_gen", async () => resolveEffort({ reasoning: { effort: "low" } }))
    ).toBe("low");
    process.env[ENV] = "medium";
    expect(await withPhase("code_gen", async () => resolveEffort({}))).toBe("medium");
    delete process.env[ENV];
  });

  it("honors a per-request reasoning.effort override", () => {
    expect(resolveEffort({ reasoning: { effort: "high" } })).toBe("high");
    // Invalid levels fall through to the default, never onto the argv.
    expect(resolveEffort({ reasoning: { effort: "maximal" } })).toBe("low");
  });

  it("honors the env override, including 'default' meaning no flag", () => {
    process.env[ENV] = "medium";
    expect(resolveEffort({})).toBe("medium");
    process.env[ENV] = "default";
    expect(resolveEffort({})).toBe(null);
    process.env[ENV] = "turbo"; // invalid → default, not argv
    expect(resolveEffort({})).toBe("low");
    // Request override still wins over env.
    process.env[ENV] = "medium";
    expect(resolveEffort({ reasoning: { effort: "xhigh" } })).toBe("xhigh");
  });

  it("fetch passes --effort low by default when the CLI supports it", async () => {
    _resetEffortSupportCache();
    mockedExistsSync.mockReturnValue(true);
    // Lazy children: makeChild fires its lifecycle events via microtasks at
    // CREATION, so each child must be created at its own spawn call — a
    // pre-built second child would emit "spawn" before the fetch listens.
    mockedSpawn
      .mockImplementationOnce(() => makeChild({ stdout: "  --effort <level>\n" }) as never)
      .mockImplementationOnce(
        () =>
          makeChild({
            stdout: JSON.stringify({
              type: "result",
              result: "ok",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          }) as never
      );
    const fetchImpl = claudeCliFetch({ binaryPath: "/fake/claude" });
    await fetchImpl("https://x/responses", requestInit({ model: "m", input: [] }));
    const generationArgs = mockedSpawn.mock.calls[1][1] as string[];
    expect(generationArgs).toContain("--effort");
    expect(generationArgs[generationArgs.indexOf("--effort") + 1]).toBe("low");
    _resetEffortSupportCache();
  });

  it("probes --help once per binary: supported, unsupported, and broken CLIs", async () => {
    _resetEffortSupportCache();
    mockedSpawn.mockReturnValueOnce(
      makeChild({ stdout: "Usage: claude ...\n  --effort <level>  Effort level\n" }) as never
    );
    await expect(supportsEffortFlag("/fake/new-claude")).resolves.toBe(true);
    // Memoized: a second call must not spawn again.
    const calls = mockedSpawn.mock.calls.length;
    await expect(supportsEffortFlag("/fake/new-claude")).resolves.toBe(true);
    expect(mockedSpawn.mock.calls.length).toBe(calls);

    mockedSpawn.mockReturnValueOnce(makeChild({ stdout: "Usage: claude (old)\n" }) as never);
    await expect(supportsEffortFlag("/fake/old-claude")).resolves.toBe(false);

    mockedSpawn.mockReturnValueOnce(makeChild({ spawnError: new Error("ENOENT") }) as never);
    await expect(supportsEffortFlag("/fake/missing-claude")).resolves.toBe(false);
    _resetEffortSupportCache();
  });
});
