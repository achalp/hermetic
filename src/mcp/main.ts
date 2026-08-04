/**
 * The hermetic MCP harness entry point (mcp-server spec §4).
 *
 * Harness #3: same boot as the CLI (env-config snapshot, default path roots,
 * optional LLM replay), zero Next imports, stdio transport for Claude
 * Desktop / Claude Code:
 *
 *   { "mcpServers": { "hermetic": { "command": "pnpm", "args": ["mcp"],
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

  const { realDeps } = await import("./deps");
  const { fileAuditSink } = await import("./audit");
  const { buildMcpServer } = await import("./server");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const server = buildMcpServer(realDeps(), fileAuditSink());
  await server.connect(new StdioServerTransport());
  console.error("[hermetic-mcp] serving on stdio");
}

main().catch((err) => {
  console.error("hermetic-mcp:", err instanceof Error ? err.message : err);
  process.exit(1);
});
