/**
 * The pending-handoff registry (spec §4a / build log D6) — the sidecar side of the
 * live sidecar↔webview execution handoff.
 *
 * A wasm run (in the Node sidecar) can't call the webview worker directly, so the
 * injected wasm executor: (1) `create()`s a pending handoff → an id + a promise;
 * (2) emits an "execute-request" carrying that id + the code/files into the
 * already-open NDJSON stream the browser is reading; (3) awaits the promise. The
 * browser runs the code in its worker and POSTs the result envelope back to
 * `/api/wasm-result?id=…`, whose handler calls `resolve(id, envelope)` — completing
 * the promise so the orchestrator resumes.
 *
 * Pure + dependency-free (id generator injectable for determinism), so it is
 * 100%-covered and lives inside the wasm pure-logic isolation boundary.
 */

/** The result the browser worker returns for a handoff (the raw output.json + exit). */
export interface HandoffEnvelope {
  exitCode: number;
  output: unknown;
  stderr?: string;
}

export interface PendingHandoff {
  id: string;
  /** Resolves when the browser POSTs the envelope; rejects on reject()/timeout. */
  promise: Promise<HandoffEnvelope>;
}

/** A validated live progress frame relayed from the worker (see relay.ts). */
export interface HandoffProgress {
  phase: string;
  detail?: string;
  fraction?: number;
}

export interface HandoffRegistry {
  create(opts?: { onProgress?: (p: HandoffProgress) => void }): PendingHandoff;
  /** Fulfill a pending handoff with the browser's envelope. False if the id is unknown/already settled. */
  resolve(id: string, envelope: HandoffEnvelope): boolean;
  /** Fail a pending handoff (timeout, closed webview, bad payload). False if unknown/settled. */
  reject(id: string, reason: string): boolean;
  /**
   * Deliver a live progress frame to a still-pending handoff's onProgress.
   * False if the id is unknown/settled or the handoff registered no listener.
   * The callback is invoked inside try/catch — a throwing consumer must never
   * break the registry (progress is best-effort by contract).
   */
  progress(id: string, frame: HandoffProgress): boolean;
  /** Number of still-pending handoffs (for tests / leak checks). */
  size(): number;
}

interface Entry {
  resolve: (e: HandoffEnvelope) => void;
  reject: (err: Error) => void;
  onProgress?: (p: HandoffProgress) => void;
}

/**
 * @param nextId injectable id generator (default: a monotonically-unique-per-call
 *   random-free counter+time-free string is impossible without a source, so a
 *   caller supplies crypto.randomUUID in production; tests inject a stub).
 */
export function createHandoffRegistry(nextId: () => string): HandoffRegistry {
  const pending = new Map<string, Entry>();

  return {
    create(opts): PendingHandoff {
      const id = nextId();
      let entry!: Entry;
      const promise = new Promise<HandoffEnvelope>((resolve, reject) => {
        entry = {
          resolve: (e) => {
            pending.delete(id);
            resolve(e);
          },
          reject: (err) => {
            pending.delete(id);
            reject(err);
          },
          ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
        };
      });
      pending.set(id, entry);
      return { id, promise };
    },

    resolve(id, envelope): boolean {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.resolve(envelope);
      return true;
    },

    reject(id, reason): boolean {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.reject(new Error(reason));
      return true;
    },

    progress(id, frame): boolean {
      const entry = pending.get(id);
      if (!entry?.onProgress) return false;
      try {
        entry.onProgress(frame);
      } catch {
        // Best-effort by contract: a throwing consumer never breaks the registry.
      }
      return true;
    },

    size(): number {
      return pending.size;
    },
  };
}
