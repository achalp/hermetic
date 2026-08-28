/**
 * The host-input token registry (build log D11, delivery option B) — how a
 * host-materialized data file is handed to the CSP-locked worker WITHOUT exposing
 * the filesystem.
 *
 * The sidecar materializes a remote source to a host temp file, `register()`s it →
 * an unguessable token, and tells the worker to fetch `/api/wasm-input/<token>`.
 * The endpoint resolves the token → the registered host path and streams ONLY that
 * file. The worker never supplies a path — it holds a capability (the token), so
 * untrusted code cannot read arbitrary host files (no path traversal, no guessing).
 * Entries are released when the run ends.
 *
 * Pure + dependency-free (token generator injected for determinism) → 100%-covered,
 * inside the wasm pure-logic isolation boundary. The globalThis singleton (shared
 * with the route) is the impure wrapper, kept separate.
 */

export interface HostInput {
  /** Absolute host path of the materialized file (streamed by the endpoint). */
  hostPath: string;
  /** The run that owns this input (for bulk release on run end). */
  runId?: string;
}

export interface InputRegistry {
  /** Register a host file → an unguessable token the worker fetches by. */
  register(input: HostInput): string;
  /** Resolve a token → its host path, or undefined if unknown/released. */
  resolve(token: string): string | undefined;
  /** Release one token. Returns true if it existed. */
  release(token: string): boolean;
  /** Release every token owned by a run (called on run end). Returns the count. */
  releaseRun(runId: string): number;
  /** Number of live tokens (tests / leak checks). */
  size(): number;
}

export function createInputRegistry(nextToken: () => string): InputRegistry {
  const inputs = new Map<string, HostInput>();

  return {
    register(input): string {
      const token = nextToken();
      inputs.set(token, input);
      return token;
    },
    resolve(token): string | undefined {
      return inputs.get(token)?.hostPath;
    },
    release(token): boolean {
      return inputs.delete(token);
    },
    releaseRun(runId): number {
      let n = 0;
      for (const [token, input] of inputs) {
        if (input.runId === runId) {
          inputs.delete(token);
          n++;
        }
      }
      return n;
    },
    size(): number {
      return inputs.size;
    },
  };
}
