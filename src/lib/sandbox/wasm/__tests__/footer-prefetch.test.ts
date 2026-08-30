import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Host-side parallel footer prefetch (build log D21). This is a LATENCY
 * optimization sitting on the security path, so two families of property matter
 * and neither is optional:
 *
 *  - it must never fail a run (best-effort, per-target isolation, abort honored);
 *  - it must never widen the trust boundary (only the URLs and allowlists it was
 *    handed, only tail ranges, always through the egress core).
 */

const fetchRemoteRange = vi.fn();
vi.mock("@/lib/sandbox/egress-fetch", () => ({
  fetchRemoteRange: (...a: unknown[]) => fetchRemoteRange(...a),
}));

import {
  prefetchFooters,
  FOOTER_TAIL_BYTES,
  PREFETCH_CONCURRENCY,
  type PrefetchTarget,
} from "@/lib/sandbox/wasm/footer-prefetch";

const target = (i: number, sizeBytes = 10 * FOOTER_TAIL_BYTES): PrefetchTarget => ({
  url: `https://b.s3.amazonaws.com/part-${i}.parquet`,
  allowlist: ["b.s3.amazonaws.com"],
  sizeBytes,
});

function okBody(n = 8): { body: Buffer; contentRange: string; total: number } {
  return { body: Buffer.alloc(n), contentRange: "", total: 0 };
}

beforeEach(() => {
  fetchRemoteRange.mockReset();
  fetchRemoteRange.mockResolvedValue(okBody());
});

describe("prefetchFooters — what it asks for", () => {
  it("requests the TAIL of each object, which is where the parquet footer lives", () => {
    // A head-anchored range would warm bytes DuckDB never reads on its footer
    // probe, so every request would miss and the optimization would be inert.
    const size = 1_000_000;
    return prefetchFooters([target(0, size)], () => {}, { concurrency: 1 }).then(() => {
      expect(fetchRemoteRange).toHaveBeenCalledWith(
        expect.objectContaining({
          range: `bytes=${size - FOOTER_TAIL_BYTES}-${size - 1}`,
          url: "https://b.s3.amazonaws.com/part-0.parquet",
          allowlist: ["b.s3.amazonaws.com"],
        })
      );
    });
  });

  it("asks for the WHOLE object when it is smaller than the tail window", async () => {
    // Clamped at 0: `bytes=-N` is the suffix form, which the Rust core rejects
    // outright, so an unclamped start would fail every small file.
    await prefetchFooters([target(0, 1000)], () => {}, { concurrency: 1 });
    expect(fetchRemoteRange).toHaveBeenCalledWith(
      expect.objectContaining({ range: "bytes=0-999" })
    );
  });

  it("skips a ZERO-BYTE object rather than emitting an inverted range", async () => {
    // start=0, end=-1 → "bytes=0--1", which the core rejects. Skipping is right:
    // there is no footer to warm.
    const r = await prefetchFooters([target(0, 0)], () => {}, { concurrency: 1 });
    expect(fetchRemoteRange).not.toHaveBeenCalled();
    expect(r).toEqual({ warmed: 0, failed: 0, bytes: 0 });
  });

  it("caps each request so a mis-sized object cannot pull an unbounded body", async () => {
    await prefetchFooters([target(0)], () => {}, { concurrency: 1 });
    expect(fetchRemoteRange.mock.calls[0]![0].capBytes).toBe(FOOTER_TAIL_BYTES * 2);
  });

  it("passes an explicit binPath through, and omits it entirely when absent", async () => {
    await prefetchFooters([target(0)], () => {}, { concurrency: 1, binPath: "/opt/egress" });
    expect(fetchRemoteRange.mock.calls[0]![0].binPath).toBe("/opt/egress");
    fetchRemoteRange.mockClear();
    await prefetchFooters([target(1)], () => {}, { concurrency: 1 });
    expect(fetchRemoteRange.mock.calls[0]![0]).not.toHaveProperty("binPath");
  });
});

describe("prefetchFooters — storing what came back", () => {
  it("stores each body under its own url and START offset", async () => {
    // The warm cache only serves a FULLY covered range, so a wrong start offset
    // turns every hit into a miss (or, worse, a truncated read).
    const stored: { url: string; start: number; len: number }[] = [];
    const size = 1_000_000;
    await prefetchFooters(
      [target(0, size)],
      (url, start, body) => stored.push({ url, start, len: body.length }),
      { concurrency: 1 }
    );
    expect(stored).toEqual([
      { url: "https://b.s3.amazonaws.com/part-0.parquet", start: size - FOOTER_TAIL_BYTES, len: 8 },
    ]);
  });

  it("counts warmed files and total bytes", async () => {
    fetchRemoteRange.mockResolvedValue(okBody(100));
    const r = await prefetchFooters([target(0), target(1), target(2)], () => {}, {
      concurrency: 2,
    });
    expect(r).toEqual({ warmed: 3, failed: 0, bytes: 300 });
  });
});

describe("prefetchFooters — best-effort is the contract", () => {
  it("a failing target is counted, never thrown, and never stored", async () => {
    // The whole point: the worker can always fetch the range itself. A prefetch
    // that could fail a run would be strictly worse than no prefetch.
    fetchRemoteRange.mockRejectedValueOnce(new Error("403")).mockResolvedValue(okBody(4));
    const stored: string[] = [];
    const r = await prefetchFooters([target(0), target(1)], (u) => stored.push(u), {
      concurrency: 1,
    });
    expect(r.failed).toBe(1);
    expect(r.warmed).toBe(1);
    expect(stored).toEqual(["https://b.s3.amazonaws.com/part-1.parquet"]);
  });

  it("one failure does not abandon the remaining targets", async () => {
    fetchRemoteRange.mockRejectedValue(new Error("down"));
    const r = await prefetchFooters([target(0), target(1), target(2)], () => {}, {
      concurrency: 1,
    });
    expect(r.failed).toBe(3);
  });

  it("does nothing at all for an empty target list", async () => {
    const r = await prefetchFooters([], () => {});
    expect(r).toEqual({ warmed: 0, failed: 0, bytes: 0 });
    expect(fetchRemoteRange).not.toHaveBeenCalled();
  });
});

describe("prefetchFooters — bounds", () => {
  it("never runs more than `concurrency` fetches at once", async () => {
    let inFlight = 0;
    let peak = 0;
    fetchRemoteRange.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return okBody();
    });
    await prefetchFooters(
      Array.from({ length: 12 }, (_, i) => target(i)),
      () => {},
      { concurrency: 3 }
    );
    expect(peak).toBe(3);
    expect(fetchRemoteRange).toHaveBeenCalledTimes(12);
  });

  it("spawns no more workers than there are targets", async () => {
    let peak = 0;
    let inFlight = 0;
    fetchRemoteRange.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return okBody();
    });
    await prefetchFooters([target(0), target(1)], () => {}, { concurrency: 16 });
    expect(peak).toBe(2);
  });

  it("floors a zero or negative concurrency at 1 instead of stalling forever", async () => {
    // `Array.from({length: 0})` spawns no workers, so the await would resolve
    // having fetched nothing — a silent no-op rather than a visible error.
    const r = await prefetchFooters([target(0)], () => {}, { concurrency: 0 });
    expect(r.warmed).toBe(1);
  });

  it("defaults to PREFETCH_CONCURRENCY when none is given", async () => {
    let peak = 0;
    let inFlight = 0;
    fetchRemoteRange.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return okBody();
    });
    await prefetchFooters(
      Array.from({ length: PREFETCH_CONCURRENCY + 5 }, (_, i) => target(i)),
      () => {}
    );
    expect(peak).toBe(PREFETCH_CONCURRENCY);
  });

  it("stops taking new targets once the run is aborted", async () => {
    // Stop must not leave a fleet of fetches running against the user's bucket.
    const ctl = new AbortController();
    fetchRemoteRange.mockImplementation(async () => {
      ctl.abort();
      return okBody();
    });
    const r = await prefetchFooters(
      Array.from({ length: 10 }, (_, i) => target(i)),
      () => {},
      { concurrency: 1, signal: ctl.signal }
    );
    expect(r.warmed).toBe(1);
    expect(fetchRemoteRange).toHaveBeenCalledTimes(1);
  });

  it("forwards the abort signal so an IN-FLIGHT fetch is cancellable too", async () => {
    const ctl = new AbortController();
    await prefetchFooters([target(0)], () => {}, { concurrency: 1, signal: ctl.signal });
    expect(fetchRemoteRange.mock.calls[0]![0].signal).toBe(ctl.signal);
  });
});
