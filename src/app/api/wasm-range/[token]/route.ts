import { NextResponse, type NextRequest } from "next/server";
import { getRangeRegistry, getWarmCache } from "@/lib/sandbox/wasm/range-singleton";
import { fetchRemoteRange, EgressFetchError } from "@/lib/sandbox/egress-fetch";
import { logger } from "@/lib/logger";

/**
 * `/api/wasm-range/<token>` — the same-origin RANGE window onto one authorized
 * remote object (build log D18).
 *
 * The worker's DuckDB-WASM reads remote parquet by byte range: HEAD for the size,
 * then the footer, then only the row groups whose statistics match the predicate.
 * That is what makes a 257 GB source tractable on the desktop tier — the D18 probe
 * answered `count(*)` over a 525 MB part file after reading 0.168% of it. The worker
 * runs under `connect-src 'self'`, so it can only reach THIS origin; the sidecar
 * proxies each range through the Rust egress core.
 *
 * SECURITY — the worker supplies OFFSETS, never a DESTINATION:
 *   - the URL + allowlist come from the token registry, never from the request;
 *   - the Range header is re-parsed and re-serialized in Rust (`parse_byte_range`),
 *     so a malformed/multi-range/suffix spec fails closed rather than reaching the wire;
 *   - every hop keeps the core's allowlist, resolve-and-reject, IP pinning, no-follow
 *     redirect and streaming cap;
 *   - a per-token BUDGET is charged BEFORE bytes are served, so a loop of ranged reads
 *     cannot become an unbounded transfer;
 *   - an unknown/released token is a 404.
 * The residual channel is the offsets themselves — low bandwidth, and only observable
 * to whoever owns the third-party bucket's logs. Documented in D18, not eliminated.
 */

/** Max bytes any single range request may ask for (a footer/row-group, not an object). */
const MAX_RANGE_BYTES = 64 * 1024 * 1024;

/** Accept only what the Rust core accepts, so we reject early with a clear status. */
function parseRange(spec: string | null): { start: number; end?: number } | null {
  if (!spec) return null;
  const rest = spec.trim().startsWith("bytes=") ? spec.trim().slice("bytes=".length) : null;
  if (rest === null || rest.includes(",")) return null;
  const dash = rest.indexOf("-");
  if (dash <= 0) return null; // absent start (suffix form) or no separator
  const a = rest.slice(0, dash);
  const b = rest.slice(dash + 1);
  if (!/^\d+$/.test(a)) return null;
  const start = Number(a);
  if (!Number.isSafeInteger(start)) return null;
  if (b === "") return { start };
  if (!/^\d+$/.test(b)) return null;
  const end = Number(b);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const registry = getRangeRegistry();
  const src = registry.resolve(token);
  if (!src) {
    logger.debug("wasm-range: unknown token", { token });
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const rawRange = req.headers.get("range");
  const parsed = parseRange(rawRange);
  if (!parsed) {
    // A bare GET means "the whole object", which is what this endpoint exists to
    // avoid — so it is still refused. What changed (D31): it is no longer refused
    // SILENTLY. The first live connect died here and the 416 said nothing, which
    // is the same empty-diagnostics failure the egress gateway hit in PR #126.
    //
    // The comment this replaces asserted "DuckDB always sends a Range on data
    // reads". That is FALSE: Emscripten's lazy-file reader sets the header
    // conditionally (`fileSize !== chunkSize && setRequestHeader(...)`) and omits
    // it whenever it believes the chunk is the whole file. The assertion was
    // written into a security boundary and never checked.
    logger.warn("wasm-range: refused a request without a usable byte range", {
      token,
      range: rawRange ?? "(absent)",
    });
    return NextResponse.json(
      {
        error: rawRange
          ? `unsupported Range "${rawRange}" — this endpoint serves a single bytes=START-END window`
          : "a Range header is required — this endpoint never serves a whole object",
      },
      { status: 416 }
    );
  }
  // Bound one request before asking the network for it.
  const requested = parsed.end === undefined ? MAX_RANGE_BYTES : parsed.end - parsed.start + 1;
  if (requested > MAX_RANGE_BYTES) {
    return NextResponse.json({ error: "range too large" }, { status: 416 });
  }
  // Charge the run budget BEFORE the fetch, so the ceiling holds even if many
  // requests are in flight at once.
  if (!registry.charge(token, requested)) {
    logger.warn("wasm-range: budget exhausted", { token, spent: registry.spent(token) });
    return NextResponse.json({ error: "range budget exhausted" }, { status: 509 });
  }

  const canonical =
    parsed.end === undefined ? `bytes=${parsed.start}-` : `bytes=${parsed.start}-${parsed.end}`;

  // Footer prefetch (D21): DuckDB's sync-XHR reads are strictly sequential, so the
  // host warms every file's tail in parallel BEFORE the worker starts. A hit here
  // turns a ~60ms network round trip into a memory read. Only a FULLY covered range
  // is served — a partial hit would truncate the response and corrupt DuckDB's read.
  if (parsed.end !== undefined) {
    const warm = getWarmCache().get(src.url, parsed.start, parsed.end);
    if (warm) {
      return new NextResponse(new Uint8Array(warm) as unknown as BodyInit, {
        status: 206,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(warm.length),
          "accept-ranges": "bytes",
          "cache-control": "no-store",
          "content-range": `bytes ${parsed.start}-${parsed.end}/*`,
          "x-hermetic-warm": "1",
        },
      });
    }
  }

  try {
    const { body, contentRange, total } = await fetchRemoteRange({
      url: src.url,
      allowlist: src.allowlist,
      range: canonical,
      capBytes: MAX_RANGE_BYTES,
    });
    // An empty content-range means upstream IGNORED Range and sent the whole
    // object. Do not relabel that a 206 — DuckDB would mis-frame the file.
    const status = contentRange ? 206 : 200;
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    };
    if (contentRange) headers["content-range"] = contentRange;
    if (total !== null) headers["x-hermetic-total-bytes"] = String(total);
    return new NextResponse(new Uint8Array(body) as unknown as BodyInit, { status, headers });
  } catch (err) {
    const kind = err instanceof EgressFetchError ? err.kind : "transport";
    logger.warn("wasm-range: fetch failed", { token, kind });
    // Never leak the upstream URL or the core's diagnostic to worker-reachable code.
    return NextResponse.json({ error: `range fetch failed (${kind})` }, { status: 502 });
  }
}

/**
 * HEAD — DuckDB probes the object size before reading anything else. We answer it
 * with a one-byte ranged GET upstream and read the total out of `Content-Range`, so
 * the core stays GET-only (`Method` has exactly one variant on purpose) and no new
 * verb is ever issued on the worker's behalf.
 *
 * ── The status matters, and 200 was wrong (D31) ──
 * duckdb-wasm opens an HTTP-protocol file like this:
 *
 *     xhr.open("HEAD", url); xhr.setRequestHeader("Range", "bytes=0-");
 *     if (contentLength !== null && xhr.status == 206) { …use it as the size… }
 *
 * It requires **206**, not 200. Answering 200 made the size probe fail on every
 * file, every time, and sent DuckDB down fallback paths that end in a whole-object
 * GET — which this endpoint refuses. That is what killed the first live connect.
 * So: when the probe carries a Range, answer 206 with a `Content-Range`; a HEAD
 * with no Range still gets a plain 200.
 */
export async function HEAD(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const registry = getRangeRegistry();
  const src = registry.resolve(token);
  if (!src) return new NextResponse(null, { status: 404 });
  if (!registry.charge(token, 1)) return new NextResponse(null, { status: 509 });

  try {
    const { total } = await fetchRemoteRange({
      url: src.url,
      allowlist: src.allowlist,
      range: "bytes=0-0",
      capBytes: MAX_RANGE_BYTES,
    });
    if (total === null) return new NextResponse(null, { status: 502 });
    const probeRange = parseRange(req.headers.get("range"));
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      // DuckDB reads Content-Length as the FILE SIZE. For its `bytes=0-` probe the
      // range IS the whole object, so the two agree; we never claim otherwise.
      "content-length": String(total),
    };
    if (!probeRange) return new NextResponse(null, { status: 200, headers });
    const end = probeRange.end === undefined ? total - 1 : Math.min(probeRange.end, total - 1);
    headers["content-range"] = `bytes ${probeRange.start}-${end}/${total}`;
    return new NextResponse(null, { status: 206, headers });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
