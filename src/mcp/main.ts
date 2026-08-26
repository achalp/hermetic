/**
 * The hermetic MCP harness entry point (mcp-server spec §4).
 *
 * Harness #3: same boot as the CLI (env-config snapshot, default path roots,
 * optional LLM replay), zero Next imports, stdio transport for Claude
 * Desktop / Claude Code:
 *
 *   { "mcpServers": { "hermetic": { "command": "pnpm", "args": ["--silent", "mcp"],
 *       "cwd": "<hermetic checkout>" } } }
 *
 * stdout belongs to the MCP protocol. hermetic's logger writes info/debug via
 * console to stdout, so the FIRST act here rebinds console to stderr — every
 * lib log line stays human-visible without corrupting the channel.
 */
import { Console } from "node:console";
import { installEnvConfig } from "@/harness/env-config";

// Protocol protection — before any lib module logs.
const stderrConsole = new Console(process.stderr, process.stderr);
console.log = stderrConsole.log.bind(stderrConsole);
console.info = stderrConsole.info.bind(stderrConsole);
console.debug = stderrConsole.debug.bind(stderrConsole);
console.warn = stderrConsole.warn.bind(stderrConsole);

async function main(): Promise<void> {
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

  // Store sweeper (review S13): this process lives as long as the host app,
  // so without it scratch CSVs, caches, and orphaned containers accumulate
  // for the whole session — the Next harness has run it since M0.
  const { startStoreSweeper } = await import("@/lib/store-sweeper");
  startStoreSweeper();

  const { realDeps } = await import("./deps");
  const { fileAuditSink } = await import("./audit");
  const { buildMcpServer } = await import("./server");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  // Embedded viewer: dashboard links resolve without the web harness.
  // HERMETIC_MCP_VIEWER=off disables (links fall back to localhost:3000).
  let viewerHandle: { port: number; token: string; close(): Promise<void> } | null = null;
  if (process.env.HERMETIC_MCP_VIEWER !== "off") {
    const { startViewerServer } = await import("./viewer/server");
    const { setViewUrlBase } = await import("./view-url");
    const preferred = Number(process.env.HERMETIC_MCP_VIEWER_PORT ?? 4848);
    try {
      viewerHandle = await startViewerServer(preferred);
      setViewUrlBase(`http://127.0.0.1:${viewerHandle.port}`, viewerHandle.token);
      console.error(`[hermetic-mcp] viewer on http://127.0.0.1:${viewerHandle.port}`);
    } catch (err) {
      console.error(
        "[hermetic-mcp] viewer failed to start (links fall back to the web app):",
        err instanceof Error ? err.message : err
      );
    }
  }

  const deps = realDeps();

  // Rehydrate source_ids from the previous server life BEFORE serving:
  // Claude Desktop chat recycles this process on conversation resume, and
  // the host's next call may reference a source connected pre-recycle.
  const { restoreSources } = await import("./source-persist");
  await restoreSources(deps).catch(() => {});

  const server = buildMcpServer(deps, fileAuditSink());
  await server.connect(new StdioServerTransport());
  console.error("[hermetic-mcp] serving on stdio");

  // ── Shutdown (review S16 / task 41) ──────────────────────────────────
  // The viewer's HTTP listener keeps the event loop alive, so without this
  // the process outlives its host. Hosts end a server three different ways,
  // and the `pnpm → sh → tsx → node` wrapper chain can swallow the first:
  //   1. stdio EOF ("end"/"close" on stdin)
  //   2. SIGTERM/SIGINT
  //   3. neither — the host is SIGKILLed and we are reparented to init
  // All three are handled; shutdown is idempotent.
  let shuttingDown = false;
  const shutdown = (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[hermetic-mcp] ${why} — shutting down`);
    const done = () => process.exit(0);
    // Never hang on a stuck close.
    setTimeout(done, 2000).unref();
    if (viewerHandle) void viewerHandle.close().then(done, done);
    else done();
  };

  process.stdin.on("end", () => shutdown("stdio closed"));
  process.stdin.on("close", () => shutdown("stdio closed"));
  process.stdin.resume(); // ensure the events actually fire
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Orphan watchdog: if our parent dies without closing stdio, we are
  // reparented (ppid becomes 1 on Linux, or the original ppid disappears).
  const initialPpid = process.ppid;
  setInterval(() => {
    if (process.ppid !== initialPpid || process.ppid === 1) {
      shutdown(`parent process gone (ppid ${initialPpid} → ${process.ppid})`);
    }
  }, 5000).unref();
}

main().catch((err) => {
  console.error("hermetic-mcp:", err instanceof Error ? err.message : err);
  process.exit(1);
});
