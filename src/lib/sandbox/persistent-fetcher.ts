/**
 * The PERSISTENT egress fetcher (build log D41, task #37): one long-lived
 * `egress-fetch serve` child instead of a spawn per ranged read.
 *
 * Why: a per-request spawn pays process start + DNS + TLS handshake — measured
 * at ~300–500 ms per range read, on a path DuckDB hits once per footer/row
 * group. Serve mode keeps a pooled agent in the child, so sequential reads to
 * the same host pay the handshake once.
 *
 * Boundary unchanged: the child re-runs the FULL §6a authorization per request
 * (allowlist + resolve-and-reject + IP pinning + no-follow redirects + cap);
 * the transport is the child's stdin/stdout — no listener sockets. Credentials
 * ride the request frame on stdin (off argv, out of the process table — the
 * same property env gave the one-shot bin).
 *
 * Protocol (rust/egress-core/src/serve.rs is the source of truth):
 *   → REQ <id> / URL / ALLOW / RANGE / [CAP] / [BEARER | HEADERCRED] / END
 *   ← "OK <id> <nbytes> <content-range>\n" + nbytes raw bytes
 *   ← "ERR <id> <code> <message>\n"           codes mirror the bin exit codes
 *
 * Requests are strictly SERIALIZED (the serve loop answers one frame at a
 * time); a child death rejects the in-flight request and the next request
 * respawns. An idle child is reaped after IDLE_KILL_MS.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { logger } from "@/lib/logger";
import { hermeticPaths } from "@/lib/paths";
import { stateBox } from "@/lib/state-store";
import {
  EgressFetchError,
  kindForExit,
  parseContentRangeTotal,
  type FetchRemoteRangeOptions,
} from "./egress-fetch";

/** Kill a child that has served nothing for this long — a warm TLS pool is only
 *  worth holding while a run is actively reading. */
const IDLE_KILL_MS = 60_000;

/** Per-request deadline. The Rust edge's own request timeout is 60 s; this adds
 *  margin so the child's timeout (with its precise diagnostic) wins when both fire. */
const REQUEST_TIMEOUT_MS = 90_000;

export interface RangeResult {
  body: Buffer;
  contentRange: string;
  total: number | null;
}

/** True iff `v` can sit inside a line frame without breaking it. Mirrors the
 *  Rust side's `frame_safe`; checked here too so a client bug surfaces as a
 *  rejected promise instead of a killed child. */
function frameSafe(v: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(v);
}

export class PersistentFetcher {
  private child: ChildProcessWithoutNullStreams | null = null;
  /** Serialization chain — at most ONE frame is in flight at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(private readonly binPath?: string) {}

  /**
   * A ranged read through the persistent child — same result shape as
   * {@link import("./egress-fetch").fetchRemoteRange}. Serialized internally;
   * safe to call concurrently.
   */
  fetchRange(o: FetchRemoteRangeOptions): Promise<RangeResult> {
    const run = this.chain.then(
      () => this.runOne(o),
      () => this.runOne(o) // a prior request's failure never poisons the chain
    );
    this.chain = run.catch(() => {});
    return run;
  }

  /** Kill the child (tests / shutdown). The next fetchRange respawns. */
  destroy(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.child?.kill();
    this.child = null;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const bin = this.binPath ?? hermeticPaths.egressFetchBin();
    // Minimal env on purpose (the statically linked bin needs nothing) — and in
    // serve mode even allowlist/creds arrive per-frame, so the env carries NOTHING.
    const child = spawn(bin, ["serve"], { env: {} as NodeJS.ProcessEnv });
    child.on("error", () => {
      /* surfaced per-request via the 'close'/spawn handling in runOne */
    });
    child.on("close", (code) => {
      if (this.child === child) this.child = null;
      if (code !== 0 && code !== null) {
        logger.warn("persistent egress-fetch exited", { code });
      }
    });
    this.child = child;
    return child;
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logger.debug("persistent egress-fetch idle — reaping");
      this.destroy();
    }, IDLE_KILL_MS);
    this.idleTimer.unref?.();
  }

  private buildFrame(id: string, o: FetchRemoteRangeOptions): string {
    const unsafe = [o.url, o.range, ...o.allowlist].find((v) => !frameSafe(v));
    if (unsafe !== undefined) {
      throw new EgressFetchError(`unsafe frame value: ${JSON.stringify(unsafe)}`, "usage", null);
    }
    const lines = [`REQ ${id}`, `URL ${o.url}`, `ALLOW ${o.allowlist.join(",")}`];
    lines.push(`RANGE ${o.range}`);
    if (o.capBytes && o.capBytes > 0) lines.push(`CAP ${Math.floor(o.capBytes)}`);
    if (o.creds && "bearer" in o.creds) {
      if (!frameSafe(o.creds.bearer)) {
        throw new EgressFetchError("unsafe bearer credential", "usage", null);
      }
      lines.push(`BEARER ${o.creds.bearer}`);
    } else if (o.creds) {
      const { headerName, headerValue } = o.creds;
      if (!frameSafe(headerName) || !frameSafe(headerValue) || headerName.length === 0) {
        throw new EgressFetchError("unsafe header credential", "usage", null);
      }
      lines.push(`HEADERCRED ${headerName}\t${headerValue}`);
    }
    lines.push("END");
    return lines.join("\n") + "\n";
  }

  private runOne(o: FetchRemoteRangeOptions): Promise<RangeResult> {
    if (o.signal?.aborted) {
      return Promise.reject(new EgressFetchError("aborted before start", "transport", null));
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const id = `r${++this.seq}`;
    const frame = this.buildFrame(id, o);
    const child = this.ensureChild();

    return new Promise<RangeResult>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let header: { ok: boolean; nbytes: number; contentRange: string } | null = null;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.removeListener("data", onData);
        child.removeListener("close", onClose);
        o.signal?.removeEventListener("abort", onAbort);
        this.armIdleTimer();
        fn();
      };

      const failAndRestart = (err: EgressFetchError) => {
        // The stream position is unknown after any protocol anomaly — never try
        // to resync; kill and let the next request respawn (crash-restart).
        finish(() => {
          this.destroy();
          reject(err);
        });
      };

      const timer = setTimeout(() => {
        failAndRestart(
          new EgressFetchError(
            `persistent egress-fetch timed out after ${REQUEST_TIMEOUT_MS} ms`,
            "transport",
            null
          )
        );
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();

      const onAbort = () => {
        failAndRestart(new EgressFetchError("range read aborted", "transport", null));
      };
      o.signal?.addEventListener("abort", onAbort, { once: true });

      const onClose = () => {
        failAndRestart(
          new EgressFetchError(
            "persistent egress-fetch died mid-request",
            "transport",
            child.exitCode
          )
        );
      };
      child.on("close", onClose);

      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!header) {
          const nl = buf.indexOf(0x0a);
          if (nl === -1) return;
          const line = buf.subarray(0, nl).toString("utf8");
          buf = buf.subarray(nl + 1);
          // "OK <id> <nbytes> <content-range...>" | "ERR <id> <code> <message...>"
          const ok = /^OK (\S+) (\d+) ?(.*)$/.exec(line);
          const er = /^ERR (\S+) (\d+) ?(.*)$/.exec(line);
          const gotId = ok?.[1] ?? er?.[1];
          if (gotId !== id) {
            failAndRestart(
              new EgressFetchError(
                `persistent egress-fetch protocol error: ${JSON.stringify(line.slice(0, 200))}`,
                "transport",
                null
              )
            );
            return;
          }
          if (er) {
            const code = Number(er[2]);
            const kind = kindForExit(code);
            finish(() =>
              reject(
                new EgressFetchError(
                  `egress-fetch range failed (${kind}, code ${code}): ${er[3] || "no diagnostic"}`,
                  kind,
                  code
                )
              )
            );
            return;
          }
          header = { ok: true, nbytes: Number(ok![2]), contentRange: ok![3] ?? "" };
        }
        if (header && buf.length >= header.nbytes) {
          if (buf.length > header.nbytes) {
            // Bytes past the declared body ⇒ the framing is out of step.
            failAndRestart(
              new EgressFetchError("persistent egress-fetch over-read", "transport", null)
            );
            return;
          }
          const contentRange = header.contentRange;
          const body = buf.subarray(0, header.nbytes);
          finish(() =>
            resolve({
              body: Buffer.from(body),
              contentRange,
              total: parseContentRangeTotal(contentRange),
            })
          );
        }
      };
      child.stdout.on("data", onData);

      child.stdin.write(frame, (err) => {
        if (err) {
          failAndRestart(
            new EgressFetchError(
              `persistent egress-fetch write failed: ${err.message}`,
              "spawn",
              null
            )
          );
        }
      });
    });
  }
}

const box = stateBox<PersistentFetcher>("persistent-egress-fetcher", () => new PersistentFetcher());

/** The process-wide persistent fetcher — shared by every wasm-range request. */
export function getPersistentFetcher(): PersistentFetcher {
  return box.get();
}
