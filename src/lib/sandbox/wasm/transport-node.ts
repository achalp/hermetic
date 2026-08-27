/**
 * Phase 1c-transport (spec §4a) — the Node `worker_threads` implementation of the
 * `WasmTransport` contract. This is the reusable channel that ships a run to an
 * UNTRUSTED worker and relays back a VALIDATED result. It stands in for the
 * browser main-thread relay (which holds the sole sidecar channel and speaks
 * `postMessage` to a webview worker) so the transport + relay + supervisor-timeout
 * + envelope path can be hardened in CI against real `worker_threads` — before
 * any Pyodide/DuckDB-WASM wiring exists.
 *
 * What this proves (the load-bearing Phase-0 unknown, spec §4a "Transport"):
 *   1. The main thread `postMessage`s `{ code, files }` INTO the worker and gets a
 *      single message back — data is PUSHED as bytes, the worker never resolves a
 *      dataRef (a worker is not a server; §4a).
 *   2. The relay (relay.ts) accepts ONLY a strict, bounded envelope and forwards
 *      NOTHING else — a worker that posts raw chatter is dropped, never forwarded
 *      (security F2/F3/R2).
 *   3. The wall-clock timeout lives on THIS (supervisor/main) context and calls
 *      `worker.terminate()`; a busy worker cannot starve its own timer (§7 T3 /
 *      security F6).
 *
 * The worker is deliberately REPLACEABLE. For this phase there is no MEMFS and no
 * Python: the worker runs a caller-supplied JS function that produces the result
 * message from `{ code, files }`. The real phase swaps a Pyodide-in-worker body in
 * here without touching the transport, relay, timeout, or envelope decode — those
 * are exactly what this module fixes in place.
 *
 * Dependency rule (scripts/isolation-check.mjs): wasm/ may reach
 * @/lib/contracts/* and its own files only. This module is coverage-EXCLUDED
 * (vitest.config.ts) as integration glue; its guarantees are pinned by a real
 * worker_threads integration test, not unit coverage.
 */
import { Worker } from "node:worker_threads";
import { parseSandboxOutput } from "../parse-output";
import { validateWorkerResult, DEFAULT_RELAY_LIMITS, type RelayLimits } from "./relay";
import type { WasmTransport, WasmRunInput } from "./contract";
import type { ExecutionResult, AdditionalFile } from "@/lib/contracts/execution";

/** The work-dir label the readFile closure keys on. There is no real FS here —
 *  the worker returns the output.json content inline and we serve it from
 *  memory — but parseSandboxOutput addresses files by `${workDir}/name`, so we
 *  keep the same virtual paths the Docker/wasm executors use. */
const WORK_DIR = "/data";

/** Default supervisor wall-clock cap (§7 T3). Callers override per phase — the
 *  real Pyodide worker needs a much larger boot budget; the transport itself is
 *  cheap, so tests drive it far tighter. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The message the transport pushes into the worker (bytes, not a dataRef). */
interface WorkerRunMessage {
  code: string;
  files: AdditionalFile[];
}

/**
 * The worker-side body: given the pushed run, produce the message to post back.
 * Kept a PURE function (no closure over the transport) because its SOURCE is
 * shipped into the worker via `.toString()` — the whole point of the seam is
 * that a later phase drops a Pyodide-driving body in here. Its return value is
 * UNTRUSTED and always goes through the relay; a body may legitimately post a
 * non-envelope (an error shape) and the relay will drop it.
 */
export type WorkerEnvelopeFn = (run: WorkerRunMessage) => unknown;

/**
 * Placeholder worker body for the transport phase (no Pyodide yet): echo a
 * minimal, VALID result envelope so a bare transport round-trips end to end.
 * `output` is the parsed output.json value (an object) — the transport
 * re-serializes it for parseSandboxOutput. Labelled `wasm-stub` so a result that
 * escaped without the real runtime is obvious.
 */
const DEFAULT_WORKER_FN: WorkerEnvelopeFn = (run) => ({
  kind: "result",
  exitCode: 0,
  output: {
    results: {
      runtime: "wasm-stub",
      code_bytes: run.code.length,
      file_count: run.files.length,
    },
  },
});

/**
 * The fixed worker HARNESS (message plumbing only — replaceable body rides in
 * `workerData.fnSource`). Runs as CommonJS in an `eval:true` worker. It rebuilds
 * the body via indirect eval, then posts whatever the body returns — the relay on
 * the main thread is the sole gate, so the harness itself never filters. A body
 * that throws posts an error shape (dropped by the relay); a body that hangs posts
 * nothing and the supervisor timer terminates it.
 */
const WORKER_HARNESS = `
const { parentPort, workerData } = require("node:worker_threads");
const produce = (0, eval)("(" + workerData.fnSource + ")");
parentPort.on("message", async (run) => {
  try {
    const msg = await produce(run);
    parentPort.postMessage(msg);
  } catch (err) {
    // Posted, then dropped by the relay (unexpected kind) — never forwarded raw.
    parentPort.postMessage({ kind: "worker-error", error: String(err) });
  }
});
`;

export interface NodeWasmTransportOptions {
  /** Wall-clock supervisor cap; the MAIN thread (not the worker) enforces it. */
  timeoutMs?: number;
  /** Envelope size/depth caps handed to the relay (defaults to DEFAULT_RELAY_LIMITS). */
  relayLimits?: RelayLimits;
  /** The replaceable worker body. Later phases pass a Pyodide-driving function. */
  workerFn?: WorkerEnvelopeFn;
}

/**
 * A `worker_threads`-backed `WasmTransport`. One worker is spawned PER run and
 * torn down when the run settles (the concurrency model — pool vs. serialize — is
 * still open, spec §4a; per-run spawn is the safe default and keeps the timeout
 * story simple: a terminated worker is simply gone). `dispose()` reaps any worker
 * still live if a caller abandons an in-flight run.
 */
export class NodeWasmTransport implements WasmTransport {
  readonly timeoutMs: number;
  private readonly relayLimits: RelayLimits;
  private readonly fnSource: string;
  private readonly live = new Set<Worker>();

  constructor(opts: NodeWasmTransportOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.relayLimits = opts.relayLimits ?? DEFAULT_RELAY_LIMITS;
    // Ship the body's SOURCE, not the function — worker_threads cannot clone a
    // function. The body must be self-contained (no closure); the harness rebuilds
    // it inside the worker.
    this.fnSource = (opts.workerFn ?? DEFAULT_WORKER_FN).toString();
  }

  async run(input: WasmRunInput): Promise<ExecutionResult> {
    const start = Date.now();
    const worker = new Worker(WORKER_HARNESS, {
      eval: true,
      workerData: { fnSource: this.fnSource },
    });
    this.live.add(worker);

    // The supervisor timer lives HERE, on the main thread — a busy worker (real OS
    // thread) cannot starve it. On fire we terminate() and settle "timeout".
    type Outcome =
      { kind: "message"; raw: unknown } | { kind: "timeout" } | { kind: "failure"; reason: string };

    const outcome = await new Promise<Outcome>((resolve) => {
      let settled = false;
      const settle = (o: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(o);
      };
      const timer = setTimeout(() => settle({ kind: "timeout" }), this.timeoutMs);
      worker.once("message", (raw) => settle({ kind: "message", raw }));
      worker.once("error", (err: Error) =>
        settle({ kind: "failure", reason: `worker error: ${err.message}` })
      );
      worker.once("exit", (code) =>
        settle({ kind: "failure", reason: `worker exited early (code ${code})` })
      );
      // Push the run as bytes; worker_threads buffers until the harness listens.
      worker.postMessage({ code: input.code, files: input.files });
    });

    try {
      if (outcome.kind === "timeout") {
        await worker.terminate().catch(() => {});
        return {
          success: false,
          error: `Sandbox run exceeded the ${this.timeoutMs}ms wall-clock limit and was terminated.`,
          errorKind: "timeout",
          execution_ms: Date.now() - start,
        };
      }

      if (outcome.kind === "failure") {
        // The worker itself broke (threw at top level / exited before replying) —
        // an environment/transport failure, not the user's code. Fail fast.
        return {
          success: false,
          error: `WASM worker transport failed: ${outcome.reason}`,
          errorKind: "infra",
          execution_ms: Date.now() - start,
        };
      }

      // The worker replied. Run the raw message through the relay and forward
      // ONLY a valid, bounded envelope — never the raw message (security F2/F3).
      const verdict = validateWorkerResult(outcome.raw, this.relayLimits);
      if (!verdict.ok) {
        return {
          success: false,
          error: `WASM worker result rejected by the relay: ${verdict.reason}`,
          errorKind: "infra",
          execution_ms: Date.now() - start,
        };
      }

      // Decode the validated envelope through the SAME parseSandboxOutput contract
      // the Docker/wasm executors use. There is no MEMFS: the envelope carries the
      // parsed output.json value inline, so the readFile closure re-serializes it
      // and serves stderr from the message. Only the two files parseSandboxOutput
      // asks for on the success/error paths exist here.
      const { message } = verdict;
      const outputText = JSON.stringify(message.output ?? null);
      const readFile = async (path: string): Promise<string | null> => {
        if (path === `${WORK_DIR}/output.json`) return outputText;
        if (path === `${WORK_DIR}/stderr.txt`) return message.stderr ?? null;
        return null;
      };

      return parseSandboxOutput({
        readFile,
        workDir: WORK_DIR,
        runtime: "wasm",
        exitCode: message.exitCode,
        executionMs: Date.now() - start,
      });
    } finally {
      // One worker per run: reap it whatever the outcome (terminate is idempotent
      // and safe on an already-exited worker).
      this.live.delete(worker);
      await worker.terminate().catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    const workers = [...this.live];
    this.live.clear();
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }
}
