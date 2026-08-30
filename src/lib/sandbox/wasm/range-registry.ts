/**
 * The remote-range token registry (build log D18) — how the CSP-locked worker is
 * given RANGED read access to one already-authorized remote object.
 *
 * Why this exists: DuckDB-WASM's httpfs reads a parquet file by issuing `Range`
 * requests (HEAD for the size, then the footer, then only the row groups whose
 * statistics match). That is what makes a 257 GB remote source tractable on the
 * desktop tier — the Seattle probe in D18 read 0.168% of a 525 MB part file. But
 * the worker runs under `connect-src 'self'`, so it can only reach a SAME-ORIGIN
 * URL; the sidecar must stand between it and the network.
 *
 * SECURITY — the worker chooses OFFSETS, never a DESTINATION. `register()` binds
 * a token to one resolved URL plus the egress allowlist that URL was authorized
 * against. The endpoint forwards only a validated byte range; the URL comes from
 * this table, never from the request. So untrusted analysis code cannot point the
 * fetch anywhere new: every request still goes through the Rust core's allowlist,
 * resolve-and-reject, IP pinning, no-redirect and cap guarantees. The residual
 * channel is the offsets themselves (low bandwidth, and only observable to whoever
 * owns the third-party bucket's logs) — documented in D18, not eliminated.
 *
 * A per-token BUDGET bounds total bytes served for the run, so a loop of ranged
 * reads cannot become an unbounded transfer. Entries are released when the run ends.
 *
 * Pure + dependency-free (token generator injected for determinism) → inside the
 * wasm pure-logic isolation boundary. The globalThis singleton is the impure
 * wrapper, kept separate (mirrors input-registry / D11).
 */

export interface RemoteRangeSource {
  /** The resolved https URL this token may read — supplied by the sidecar, never the worker. */
  url: string;
  /** Egress hosts this URL was authorized against (passed through to the Rust core). */
  allowlist: string[];
  /** The run that owns this token (for bulk release on run end). */
  runId?: string;
  /**
   * Absolute epoch-ms after which the token stops resolving, for capabilities that
   * have no run to be released by — connect-time schema extraction mints tokens
   * before any run exists (build log D27). A run-scoped token needs no TTL: it is
   * released deterministically by `releaseRun`. This is the fallback for the case
   * where nothing else will ever call release, so the ceiling is TIME rather than
   * an event that might not happen.
   */
  expiresAt?: number;
  /** Total bytes this token may serve across all requests. */
  budgetBytes: number;
}

export interface RangeRegistry {
  register(src: RemoteRangeSource): string;
  /** Drop every EXPIRED token; returns how many were reaped. */
  sweep(): number;
  /** Resolve a token → its source, or undefined if unknown/released. */
  resolve(token: string): RemoteRangeSource | undefined;
  /**
   * Charge `n` bytes against the token's budget. Returns false when the charge
   * would exceed it (the caller must then refuse to serve) — checked BEFORE the
   * bytes go out, so the budget is a ceiling and not merely an after-the-fact tally.
   */
  charge(token: string, n: number): boolean;
  /** Bytes already served for a token (diagnostics / tests). */
  spent(token: string): number;
  release(token: string): boolean;
  releaseRun(runId: string): number;
  size(): number;
}

export function createRangeRegistry(
  nextToken: () => string,
  /** Injected clock — keeps expiry deterministic in tests. */
  now: () => number = Date.now
): RangeRegistry {
  /**
   * ONE entry per token, holding the source AND its spend together. Deliberately
   * not two parallel maps keyed by the same token: that shape can represent a
   * token present in one and absent from the other, which is a state this type
   * cannot express — and every `?? 0` guarding it was unreachable code that only
   * looked like safety.
   */
  const entries = new Map<string, { src: RemoteRangeSource; used: number }>();

  const isExpired = (src: RemoteRangeSource) =>
    src.expiresAt !== undefined && now() >= src.expiresAt;

  return {
    register(src): string {
      const token = nextToken();
      entries.set(token, { src, used: 0 });
      return token;
    },
    resolve(token): RemoteRangeSource | undefined {
      const e = entries.get(token);
      if (!e) return undefined;
      // Checked on READ, not only by the sweeper: a lease must stop working the
      // moment it lapses, whether or not anything has swept since.
      if (isExpired(e.src)) {
        entries.delete(token);
        return undefined;
      }
      return e.src;
    },
    sweep(): number {
      let n = 0;
      for (const [token, e] of entries) {
        if (isExpired(e.src)) {
          entries.delete(token);
          n++;
        }
      }
      return n;
    },
    charge(token, n): boolean {
      const e = entries.get(token);
      if (!e || isExpired(e.src)) return false;
      // A negative/NaN charge would silently refund budget — treat as invalid.
      if (!Number.isFinite(n) || n < 0) return false;
      if (e.used + n > e.src.budgetBytes) return false;
      e.used += n;
      return true;
    },
    spent(token): number {
      return entries.get(token)?.used ?? 0;
    },
    release(token): boolean {
      return entries.delete(token);
    },
    releaseRun(runId): number {
      let n = 0;
      for (const [token, e] of entries) {
        if (e.src.runId === runId) {
          entries.delete(token);
          n++;
        }
      }
      return n;
    },
    size(): number {
      return entries.size;
    },
  };
}

/**
 * A warmed byte window from the host-side footer prefetch (build log D21). The
 * range endpoint checks this before going upstream, so DuckDB's sequential footer
 * reads resolve against memory instead of the network.
 */
export interface WarmWindow {
  start: number;
  body: Buffer;
}

/**
 * Prefetch cache keyed by upstream URL. Deliberately separate from the token table:
 * a warmed window is derived data (it can always be re-fetched), whereas a token is
 * a capability. Keeping them apart means a cache miss can never become an
 * authorization decision.
 */
export interface WarmCache {
  put(url: string, start: number, body: Buffer): void;
  /** The warmed slice covering [start,end] inclusive, or undefined. */
  get(url: string, start: number, end: number): Buffer | undefined;
  clearUrls(urls: readonly string[]): void;
  size(): number;
}

export function createWarmCache(): WarmCache {
  const windows = new Map<string, WarmWindow>();
  return {
    put(url, start, body) {
      windows.set(url, { start, body });
    },
    get(url, start, end) {
      const w = windows.get(url);
      if (!w) return undefined;
      // Only serve a request FULLY covered by the warmed window; a partial hit
      // would silently truncate the response and corrupt DuckDB's read.
      if (start < w.start) return undefined;
      const offset = start - w.start;
      const length = end - start + 1;
      if (offset + length > w.body.length) return undefined;
      return w.body.subarray(offset, offset + length);
    },
    clearUrls(urls) {
      for (const u of urls) windows.delete(u);
    },
    size() {
      return windows.size;
    },
  };
}
