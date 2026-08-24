/**
 * Node-runtime-only half of the instrumentation. Kept in a separate module that
 * `instrumentation.ts` dynamically imports ONLY when NEXT_RUNTIME === "nodejs",
 * so the Edge bundle never pulls in node:http/node:https (which it can't run).
 *
 * Raises the HTTP `requestTimeout` on the server process that binds the port and
 * holds client sockets. That `next-server` worker is spawned with NODE_OPTIONS
 * stripped, so the `--import` preload never reaches it and its timeout stays at
 * Node's 5-min default — dropping the browser mid-request on long analyses.
 */
import { logger, serializeError } from "@/lib/logger";

const REQUEST_TIMEOUT_MS = 25 * 60 * 1000; // 25 min — matches the large-data budget

/**
 * True for the benign "client left mid-stream" errors that surface on a
 * streaming response's raw socket when a browser tab closes/reloads or the
 * machine sleeps. Node emits these BELOW the Web Streams API, so a route
 * handler can't catch them — without recognizing them here, a normal
 * disconnect prints an alarming ECONNRESET/aborted stack that reads like a
 * server fault (observed after a laptop idle-sleep dropped a long run).
 */
export function isAbortedConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null | undefined;
  const code = e?.code;
  const msg = typeof e?.message === "string" ? e.message : "";
  return (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    /\baborted\b/i.test(msg)
  );
}

let guardInstalled = false;
/**
 * Downgrade benign aborted-connection errors to a debug line so a normal client
 * disconnect can never take a worker down or masquerade as a crash. Genuine
 * errors are logged (serialized) and left otherwise untouched — we never call
 * process.exit, so this cannot turn a real crash into a silent hang, and it
 * matches the runtime's existing survive-and-log behavior for those.
 */
export function installConnectionErrorGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;

  process.on("uncaughtException", (err) => {
    if (isAbortedConnectionError(err)) {
      logger.debug("Ignored aborted-connection error (client left mid-stream)", {
        code: (err as { code?: string })?.code,
      });
      return;
    }
    logger.error("Uncaught exception", serializeError(err));
  });

  process.on("unhandledRejection", (reason) => {
    if (isAbortedConnectionError(reason)) {
      logger.debug("Ignored aborted-connection rejection (client left mid-stream)", {
        code: (reason as { code?: string })?.code,
      });
      return;
    }
    logger.error("Unhandled rejection", serializeError(reason));
  });
}

export async function raiseServerTimeouts(): Promise<void> {
  const http = await import("node:http");
  const https = await import("node:https");

  const raise = (s: { requestTimeout?: number } | null | undefined): void => {
    if (!s || typeof s.requestTimeout !== "number") return;
    // 0 means "no timeout" (already unbounded); otherwise only ever raise it.
    if (s.requestTimeout !== 0 && s.requestTimeout < REQUEST_TIMEOUT_MS) {
      s.requestTimeout = REQUEST_TIMEOUT_MS;
    }
  };

  // (a) Servers created AFTER this runs.
  for (const mod of [http.default, https.default]) {
    const orig = mod.createServer.bind(mod);
    (mod as { createServer: (...a: unknown[]) => import("node:http").Server }).createServer = (
      ...args: unknown[]
    ) => {
      const server = (orig as (...a: unknown[]) => import("node:http").Server)(...args);
      raise(server);
      return server;
    };
  }

  // (b) The server already listening (Next binds the port before app init).
  const handles =
    (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  for (const h of handles) raise(h as { requestTimeout?: number });
}

/**
 * LLM record/replay bootstrap (modularization M0-0a). Harness boot is where
 * env is read and pushed into lib as explicit config — lib itself never
 * touches process.env (ratchet-enforced). Lives here (not instrumentation.ts)
 * because node:path must stay out of the Edge bundle.
 */
export async function installBootConfig(): Promise<void> {
  const { installEnvConfig } = await import("./harness/env-config");
  installEnvConfig("snapshot");
  // Env validation is an explicit boot step, not an import side effect
  // (previously ran at config.ts module load — modularization M2-B1).
  const { validateEnv, EnvError } = await import("./lib/config");
  try {
    validateEnv();
  } catch (e) {
    if (e instanceof EnvError) console.error(`[config] ${e.message}`);
    else throw e;
  }
}

export async function configureLLMReplayFromEnv(): Promise<void> {
  const mode = process.env.HERMETIC_LLM_MODE;
  if (mode !== "record" && mode !== "replay") return;
  const { configureLLMReplay } = await import("./lib/llm/replay");
  const { resolve } = await import("node:path");
  const dir = process.env.HERMETIC_LLM_FIXTURES ?? "test-fixtures/llm";
  configureLLMReplay({
    mode,
    dir: resolve(dir),
    debug: process.env.HERMETIC_REPLAY_DEBUG === "1",
  });
  console.log(`[llm-replay] ${mode} mode, fixtures: ${dir}`);
}
