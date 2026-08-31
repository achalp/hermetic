import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { PersistentFetcher } from "@/lib/sandbox/persistent-fetcher";
import { EgressFetchError } from "@/lib/sandbox/egress-fetch";

/**
 * Node client for `egress-fetch serve` (build log D41, task #37). A FAKE serve
 * bin — a node script speaking the real wire protocol — stands in for the Rust
 * binary, so these tests prove the CLIENT: frame writing, response parsing
 * (header + exact body bytes), request serialization, same-process reuse,
 * error mapping, crash-restart, and frame-safety validation. The real fetch
 * semantics behind the protocol are proven in Rust (serve.rs tests +
 * egress_fetch_bin.rs), and the protocol itself is pinned on BOTH sides.
 */
let dir: string;
let binPath: string;

// The fake reads frames line-by-line; on END it answers based on the URL host:
//   ok    → body "hello!" with a content-range; body includes a per-process
//           COUNTER so tests can prove two requests hit the SAME process
//   echo  → body = JSON of the received frame lines (proves creds/cap cross)
//   deny  → ERR code 1
//   crash → exits mid-request without answering
//   split → answers the header and body in dribbled chunks (parser reassembly)
const FAKE = `#!__NODE__
let buf = "";
let count = 0;
process.stdin.on("data", (c) => {
  buf += c.toString("utf8");
  let nl;
  const lines = [];
  while ((nl = buf.indexOf("\\n")) !== -1) {
    lines.push(buf.slice(0, nl));
    buf = buf.slice(0, 0) + buf.slice(nl + 1);
  }
  for (const line of lines) frame.push(line);
  while (frame.includes("END")) {
    const end = frame.indexOf("END");
    const req = frame.splice(0, end + 1);
    handle(req.slice(0, -1));
  }
});
const frame = [];
function handle(lines) {
  const id = lines.find((l) => l.startsWith("REQ ")).slice(4);
  const url = lines.find((l) => l.startsWith("URL ")).slice(4);
  const host = url.split("://")[1].split("/")[0];
  count += 1;
  if (host === "deny") {
    process.stdout.write("ERR " + id + " 1 denied: host not in the source allowlist\\n");
    return;
  }
  if (host === "crash") {
    process.exit(2);
  }
  if (host === "echo") {
    const body = Buffer.from(JSON.stringify(lines));
    process.stdout.write("OK " + id + " " + body.length + " bytes 0-1/2\\n");
    process.stdout.write(body);
    return;
  }
  if (host === "split") {
    const body = Buffer.from("split-body");
    const head = "OK " + id + " " + body.length + " bytes 0-9/100\\n";
    process.stdout.write(head.slice(0, 5));
    setTimeout(() => {
      process.stdout.write(head.slice(5));
      setTimeout(() => {
        process.stdout.write(body.subarray(0, 4));
        setTimeout(() => process.stdout.write(body.subarray(4)), 5);
      }, 5);
    }, 5);
    return;
  }
  const body = Buffer.from("hello!" + count);
  process.stdout.write("OK " + id + " " + body.length + " bytes 0-6/525687024\\n");
  process.stdout.write(body);
}
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "persistent-fetcher-test-"));
  binPath = join(dir, "fake-serve.mjs");
  writeFileSync(binPath, FAKE.replace("__NODE__", process.execPath));
  chmodSync(binPath, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fetcher: PersistentFetcher;
afterEach(() => fetcher?.destroy());

const base = { allowlist: ["data.example.com"], range: "bytes=0-6" };

describe("PersistentFetcher", () => {
  it("answers a ranged read: body bytes, content-range, parsed total", async () => {
    fetcher = new PersistentFetcher(binPath);
    const res = await fetcher.fetchRange({ ...base, url: "https://ok/x.parquet" });
    expect(res.body.toString()).toBe("hello!1");
    expect(res.contentRange).toBe("bytes 0-6/525687024");
    expect(res.total).toBe(525687024);
  });

  it("REUSES one process across sequential requests — the whole point", async () => {
    fetcher = new PersistentFetcher(binPath);
    const a = await fetcher.fetchRange({ ...base, url: "https://ok/a.parquet" });
    const b = await fetcher.fetchRange({ ...base, url: "https://ok/b.parquet" });
    // The fake's counter lives in process memory: 2 proves the same process.
    expect(a.body.toString()).toBe("hello!1");
    expect(b.body.toString()).toBe("hello!2");
  });

  it("serializes CONCURRENT callers onto one frame at a time, in order", async () => {
    fetcher = new PersistentFetcher(binPath);
    const [a, b, c] = await Promise.all([
      fetcher.fetchRange({ ...base, url: "https://ok/a.parquet" }),
      fetcher.fetchRange({ ...base, url: "https://ok/b.parquet" }),
      fetcher.fetchRange({ ...base, url: "https://ok/c.parquet" }),
    ]);
    expect([a.body.toString(), b.body.toString(), c.body.toString()]).toEqual([
      "hello!1",
      "hello!2",
      "hello!3",
    ]);
  });

  it("reassembles a response that arrives in dribbled chunks", async () => {
    fetcher = new PersistentFetcher(binPath);
    const res = await fetcher.fetchRange({ ...base, url: "https://split/x.parquet" });
    expect(res.body.toString()).toBe("split-body");
    expect(res.contentRange).toBe("bytes 0-9/100");
  });

  it("sends cap and credentials INSIDE the frame (stdin, never argv/env)", async () => {
    fetcher = new PersistentFetcher(binPath);
    const res = await fetcher.fetchRange({
      ...base,
      url: "https://echo/x.parquet",
      capBytes: 1234,
      creds: { bearer: "sekret-token" },
    });
    const lines = JSON.parse(res.body.toString()) as string[];
    expect(lines).toContain("CAP 1234");
    expect(lines).toContain("BEARER sekret-token");
    expect(lines).toContain("ALLOW data.example.com");
  });

  it("maps an ERR line to the same EgressFetchError kinds as the one-shot bin", async () => {
    fetcher = new PersistentFetcher(binPath);
    const err = await fetcher
      .fetchRange({ ...base, url: "https://deny/x.parquet" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressFetchError);
    expect((err as EgressFetchError).kind).toBe("denied");
    expect((err as EgressFetchError).message).toContain("host not in the source allowlist");
  });

  it("an ERR response leaves the process ALIVE for the next request", async () => {
    fetcher = new PersistentFetcher(binPath);
    await fetcher.fetchRange({ ...base, url: "https://ok/a.parquet" });
    await expect(fetcher.fetchRange({ ...base, url: "https://deny/x.parquet" })).rejects.toThrow(
      /denied/
    );
    // counter=3 proves the denial did NOT restart the child.
    const res = await fetcher.fetchRange({ ...base, url: "https://ok/b.parquet" });
    expect(res.body.toString()).toBe("hello!3");
  });

  it("a mid-request CRASH rejects that request and RESPAWNS for the next", async () => {
    fetcher = new PersistentFetcher(binPath);
    await fetcher.fetchRange({ ...base, url: "https://ok/a.parquet" });
    const err = await fetcher
      .fetchRange({ ...base, url: "https://crash/x.parquet" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressFetchError);
    expect((err as EgressFetchError).kind).toBe("transport");
    // Fresh process: its counter restarts at 1.
    const res = await fetcher.fetchRange({ ...base, url: "https://ok/b.parquet" });
    expect(res.body.toString()).toBe("hello!1");
  });

  it("a crash mid-QUEUE does not strand the requests behind it", async () => {
    fetcher = new PersistentFetcher(binPath);
    const results = await Promise.allSettled([
      fetcher.fetchRange({ ...base, url: "https://crash/x.parquet" }),
      fetcher.fetchRange({ ...base, url: "https://ok/after.parquet" }),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
  });

  it("REFUSES frame-breaking values client-side (defense in depth)", async () => {
    fetcher = new PersistentFetcher(binPath);
    await expect(
      fetcher.fetchRange({ ...base, url: "https://ok/x\nEND\nREQ evil" })
    ).rejects.toThrow(/unsafe frame value/);
    await expect(
      fetcher.fetchRange({ ...base, url: "https://ok/x.parquet", creds: { bearer: "a\nb" } })
    ).rejects.toThrow(/unsafe bearer/);
    await expect(
      fetcher.fetchRange({
        ...base,
        url: "https://ok/x.parquet",
        creds: { headerName: "x\ty", headerValue: "v" },
      })
    ).rejects.toThrow(/unsafe header/);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    fetcher = new PersistentFetcher(binPath);
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      fetcher.fetchRange({ ...base, url: "https://ok/x.parquet", signal: ctl.signal })
    ).rejects.toThrow(/aborted/);
  });

  it("a missing bin surfaces as a rejection, not an unhandled error", async () => {
    fetcher = new PersistentFetcher(join(dir, "does-not-exist"));
    await expect(fetcher.fetchRange({ ...base, url: "https://ok/x.parquet" })).rejects.toThrow();
  });
});

// ── Cross-language handshake: the REAL Rust bin, the REAL Node client ────────
// Gated on the debug bin existing (cargo build --bin egress-fetch); CI's rust
// job proves the bin, this proves the two protocol implementations agree.
// A denied request needs no network: the allowlist check runs before DNS.
const RUST_BIN = join(process.cwd(), "rust/egress-core/target/debug/egress-fetch");
const gated = existsSync(RUST_BIN) ? describe : describe.skip;

gated("PersistentFetcher against the real egress-fetch serve bin", () => {
  it("speaks the wire protocol: denial maps to kind=denied, process survives", async () => {
    fetcher = new PersistentFetcher(RUST_BIN);
    const err = await fetcher
      .fetchRange({ ...base, url: "https://evil.example.com/x.parquet" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressFetchError);
    expect((err as EgressFetchError).kind).toBe("denied");
    expect((err as EgressFetchError).message).toContain("not in the source allowlist");
    // Same process answers a second frame after the denial.
    const err2 = await fetcher
      .fetchRange({ ...base, url: "https://also-evil.example.com/y.parquet" })
      .catch((e: unknown) => e);
    expect((err2 as EgressFetchError).kind).toBe("denied");
  });
});
