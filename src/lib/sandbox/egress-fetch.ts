/**
 * The Node side of the host-side remote-read edge (build log D9). Spawns the Rust
 * `egress-fetch` bin — which runs the §6a-tested `authorize_and_fetch` (allowlist +
 * resolve-and-reject + DNS-rebinding-proof IP pinning + no-follow redirects + byte
 * cap) — and streams the vetted object bytes to a local file. The wasm runtime then
 * reads that file OFFLINE, so the untrusted worker never touches the network and
 * `codeDoesRemoteIo` stays false.
 *
 * Why a subprocess (not a native binding): it reuses the ONE adversarially-tested
 * Rust egress core with zero reimplementation, needs no napi build, and matches the
 * egress-proxy precedent. All inputs come from the trusted sidecar (the allowlist is
 * derived from the STORED source URL, never worker-supplied — no confused deputy).
 * Credentials are passed via ENV, never argv (argv is world-readable via `ps`).
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { logger } from "@/lib/logger";
import { hermeticPaths } from "@/lib/paths";

export type EgressFetchKind = "denied" | "transport" | "cap" | "redirect" | "usage" | "spawn";

export class EgressFetchError extends Error {
  constructor(
    message: string,
    readonly kind: EgressFetchKind,
    readonly exitCode: number | null
  ) {
    super(message);
    this.name = "EgressFetchError";
  }
}

/** Bearer token OR an arbitrary auth header — resolved at the executor boundary. */
export type EgressCreds = { bearer: string } | { headerName: string; headerValue: string };

export interface MaterializeRemoteOptions {
  /** The request URL (the STORED source URL — never worker-supplied). */
  url: string;
  /** Vhost allowlist derived from the source URL (fail closed if empty). */
  allowlist: string[];
  /** Local file the vetted bytes are streamed into. Deleted on any failure. */
  destPath: string;
  /** Byte cap (default: the bin's 2 GiB). */
  capBytes?: number;
  /** Auth applied inside the bin, never seen by the worker. */
  creds?: EgressCreds;
  /** Bin path override (tests / bundled Tauri app). */
  binPath?: string;
  signal?: AbortSignal;
}

/** Map the bin's documented exit codes → an error kind (see egress-fetch.rs). */
export function kindForExit(code: number | null): EgressFetchKind {
  switch (code) {
    case 1:
      return "denied";
    case 2:
      return "transport";
    case 3:
      return "cap";
    case 4:
    case 5:
      return "redirect";
    case 64:
      return "usage";
    default:
      return "transport";
  }
}

/**
 * Fetch a remote object through the Rust egress core into `destPath`. Resolves with
 * the byte count on success; rejects with an {@link EgressFetchError} (partial file
 * removed) on refusal, transport error, cap, or spawn failure.
 *
 * The child gets a MINIMAL env (only the HERMETIC_EGRESS_* vars) — the statically
 * linked Rust bin needs nothing inherited, and not spreading the parent env keeps
 * this lib module off the environment (ratchet: lib-process-env → 0).
 */
export function materializeRemoteToFile(o: MaterializeRemoteOptions): Promise<{ bytes: number }> {
  const bin = o.binPath ?? hermeticPaths.egressFetchBin();
  const env: Record<string, string> = {
    HERMETIC_EGRESS_ALLOWLIST: o.allowlist.join(","),
  };
  if (o.capBytes && o.capBytes > 0) env.HERMETIC_EGRESS_CAP_BYTES = String(o.capBytes);
  if (o.creds && "bearer" in o.creds) {
    env.HERMETIC_EGRESS_BEARER = o.creds.bearer;
  } else if (o.creds) {
    env.HERMETIC_EGRESS_HEADER_NAME = o.creds.headerName;
    env.HERMETIC_EGRESS_HEADER_VALUE = o.creds.headerValue;
  }

  return new Promise((resolve, reject) => {
    // Cast: the project augments ProcessEnv to require NODE_ENV; the child gets a
    // deliberately minimal env, so we assert the shape rather than inherit it.
    const child = spawn(bin, [o.url], { env: env as NodeJS.ProcessEnv, signal: o.signal });
    const out = createWriteStream(o.destPath);
    let bytes = 0;
    let stderr = "";
    let settled = false;

    const fail = async (err: EgressFetchError) => {
      if (settled) return;
      settled = true;
      // WAIT for the stream to close before deleting. `destroy()` is async and does
      // not cancel a pending `open()`: unlinking straight after it lets that open
      // land afterwards and RE-CREATE the file — which is precisely the partial
      // materialization this promises to remove. Surfaced as an order-dependent
      // test failure that passed in isolation; it is a real ordering bug, not a
      // flaky test.
      await new Promise<void>((res) => {
        if (out.closed) return res();
        out.once("close", () => res());
        out.destroy();
      });
      await unlink(o.destPath).catch(() => {}); // never leave a partial materialization
      reject(err);
    };

    // The destination stream needs its OWN error handler: `createWriteStream`
    // opens the file asynchronously, so a dest that is unwritable, full, or whose
    // directory vanished mid-flight emits here — and with no listener Node turns
    // that into an UNCAUGHT EXCEPTION rather than a rejected promise. After
    // `settled` this is a no-op, which is what makes a late open error harmless.
    out.on("error", (err: Error) => {
      void fail(
        new EgressFetchError(
          `egress-fetch could not write the destination: ${err.message}`,
          "transport",
          null
        )
      );
    });

    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    child.stdout.pipe(out);
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 4096) stderr += c.toString();
    });

    child.on("error", (err) => {
      // ENOENT etc. — the bin is missing / not executable.
      void fail(new EgressFetchError(`egress-fetch spawn failed: ${err.message}`, "spawn", null));
    });

    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        out.end(() => {
          if (settled) return;
          // A successful FETCH is not a successful materialization. The write
          // stream can be in an error state here — an unwritable destination
          // errors asynchronously, and `end()`'s callback can win the race
          // against the 'error' event — in which case resolving would report
          // success for a file that was never written, and hand the caller a
          // path to nothing. Check the stream, not just the exit code.
          if (out.errored) {
            void fail(
              new EgressFetchError(
                `egress-fetch could not write the destination: ${out.errored.message}`,
                "transport",
                null
              )
            );
            return;
          }
          settled = true;
          logger.debug("Remote source materialized via egress-fetch", { bytes });
          resolve({ bytes });
        });
        return;
      }
      const kind = kindForExit(code);
      void fail(
        new EgressFetchError(
          `egress-fetch failed (${kind}, exit ${code}): ${stderr.trim() || "no diagnostic"}`,
          kind,
          code
        )
      );
    });
  });
}

/** Options for {@link fetchRemoteRange} — a bounded, ranged read of ONE authorized URL. */
export interface FetchRemoteRangeOptions {
  url: string;
  allowlist: string[];
  /** Canonical `bytes=START-END` / `bytes=START-`; validated again in Rust. */
  range: string;
  capBytes?: number;
  creds?: { bearer: string } | { headerName: string; headerValue: string };
  binPath?: string;
  signal?: AbortSignal;
}

/** The upstream `Content-Range` total, e.g. 525687024 from "bytes 0-3/525687024". */
export function parseContentRangeTotal(contentRange: string): number | null {
  const m = /^bytes\s+\d+-\d+\/(\d+)$/.exec(contentRange.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Ranged read through the Rust egress core (build log D18). Same authorization
 * path as {@link materializeRemoteToFile} — allowlist, resolve-and-reject, IP
 * pinning, no-follow redirects, streaming cap — the only difference is that the
 * core sends a `Range` header and a 206 comes back with its `Content-Range`.
 *
 * Buffers in memory ON PURPOSE: callers request footers and row groups (KBs–MBs),
 * never whole objects, and `capBytes` bounds it. The body is the response the
 * `/api/wasm-range` route streams straight back to the worker's DuckDB.
 */
export function fetchRemoteRange(
  o: FetchRemoteRangeOptions
): Promise<{ body: Buffer; contentRange: string; total: number | null }> {
  const bin = o.binPath ?? hermeticPaths.egressFetchBin();
  const env: Record<string, string> = {
    HERMETIC_EGRESS_ALLOWLIST: o.allowlist.join(","),
    HERMETIC_EGRESS_RANGE: o.range,
  };
  if (o.capBytes && o.capBytes > 0) env.HERMETIC_EGRESS_CAP_BYTES = String(o.capBytes);
  if (o.creds && "bearer" in o.creds) {
    env.HERMETIC_EGRESS_BEARER = o.creds.bearer;
  } else if (o.creds) {
    env.HERMETIC_EGRESS_HEADER_NAME = o.creds.headerName;
    env.HERMETIC_EGRESS_HEADER_VALUE = o.creds.headerValue;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [o.url], { env: env as NodeJS.ProcessEnv, signal: o.signal });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 4096) stderr += c.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new EgressFetchError(`egress-fetch spawn failed: ${err.message}`, "spawn", null));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const kind = kindForExit(code);
        reject(
          new EgressFetchError(
            `egress-fetch range failed (${kind}, exit ${code}): ${stderr.trim() || "no diagnostic"}`,
            kind,
            code
          )
        );
        return;
      }
      // The bin emits exactly one marker-prefixed metadata line on stderr.
      const meta = /^EGRESS-META (\{.*\})$/m.exec(stderr);
      let contentRange = "";
      if (meta) {
        try {
          contentRange = String(
            (JSON.parse(meta[1]) as { contentRange?: string }).contentRange ?? ""
          );
        } catch {
          contentRange = "";
        }
      }
      resolve({
        body: Buffer.concat(chunks),
        contentRange,
        total: parseContentRangeTotal(contentRange),
      });
    });
  });
}
