import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeRemoteToFile, EgressFetchError } from "@/lib/sandbox/egress-fetch";

/**
 * Node wrapper for the Rust egress-fetch bin (build log D9). A FAKE bin (a node
 * shebang script) stands in for the real binary so we exercise the Node plumbing —
 * streaming stdout → file, exit-code → error-kind mapping, partial-file cleanup,
 * env passing — without a live network (the real §6a fetch is proven in Rust:
 * fetch/tests.rs + tests/egress_fetch_bin.rs).
 *
 * The wrapper passes the child a MINIMAL env (only HERMETIC_EGRESS_*), so the fake
 * reads its behavior from the URL host (mode) and echoes the allowlist/creds env it
 * received — proving those cross the boundary and nothing else is inherited.
 */
let dir: string;
// A pure-builtin /bin/sh fake (absolute-path shebang → no PATH lookup, and printf/[
// are shell builtins) so it runs under the MINIMAL env the wrapper passes the child
// (no PATH — correct for the real compiled bin). Behavior is chosen by the URL host.
const FAKE = `#!/bin/sh
rest="\${1#*://}"
mode="\${rest%%/*}"
if [ "$mode" = "ok" ]; then printf 'BYTES:%s' "$HERMETIC_EGRESS_ALLOWLIST"; exit 0; fi
if [ "$mode" = "bearer" ]; then printf 'AUTH:%s' "\${HERMETIC_EGRESS_BEARER:-none}"; exit 0; fi
if [ "$mode" = "deny" ]; then printf 'egress-fetch: denied: Host' >&2; exit 1; fi
if [ "$mode" = "cap" ]; then printf 'cap exceeded after 999' >&2; exit 3; fi
exit 2
`;
let binPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "egress-fetch-test-"));
  binPath = join(dir, "fake-egress-fetch.mjs");
  writeFileSync(binPath, FAKE);
  chmodSync(binPath, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("materializeRemoteToFile", () => {
  it("streams the bin's stdout into destPath and passes the allowlist via env", async () => {
    const dest = join(dir, "out-ok.parquet");
    const { bytes } = await materializeRemoteToFile({
      url: "https://ok/x.parquet",
      allowlist: ["data.example.com", "cdn.example.com"],
      destPath: dest,
      binPath,
    });
    expect(bytes).toBeGreaterThan(0);
    expect(readFileSync(dest, "utf8")).toBe("BYTES:data.example.com,cdn.example.com");
  });

  it("passes bearer creds via ENV (never argv)", async () => {
    const dest = join(dir, "out-auth.parquet");
    await materializeRemoteToFile({
      url: "https://bearer/x",
      allowlist: ["data.example.com"],
      destPath: dest,
      creds: { bearer: "sekret-token" },
      binPath,
    });
    expect(readFileSync(dest, "utf8")).toBe("AUTH:sekret-token");
  });

  it("maps exit 1 → denied and removes the partial file", async () => {
    const dest = join(dir, "out-deny.parquet");
    await expect(
      materializeRemoteToFile({
        url: "https://deny/x",
        allowlist: ["data.example.com"],
        destPath: dest,
        binPath,
      })
    ).rejects.toMatchObject({ kind: "denied", exitCode: 1 });
    expect(existsSync(dest)).toBe(false);
  });

  it("maps exit 3 → cap", async () => {
    const dest = join(dir, "out-cap.parquet");
    const err = await materializeRemoteToFile({
      url: "https://cap/big",
      allowlist: ["data.example.com"],
      destPath: dest,
      binPath,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressFetchError);
    expect(err.kind).toBe("cap");
  });

  it("maps a missing binary → spawn error", async () => {
    await expect(
      materializeRemoteToFile({
        url: "https://ok/x",
        allowlist: ["data.example.com"],
        destPath: join(dir, "nope.parquet"),
        binPath: join(dir, "does-not-exist"),
      })
    ).rejects.toMatchObject({ kind: "spawn" });
  });

  it("REJECTS on an unwritable destination instead of crashing the process", async () => {
    // createWriteStream opens asynchronously, so a bad destination surfaces as an
    // 'error' event on the stream. Without a listener Node promotes that to an
    // UNCAUGHT EXCEPTION — which is how it showed up: as a CI-only unhandled
    // error, after the owning test had already passed (build log D30).
    await expect(
      materializeRemoteToFile({
        url: "https://ok/x",
        allowlist: ["data.example.com"],
        // A directory that does not exist → ENOENT on open.
        destPath: join(dir, "no-such-dir", "out.parquet"),
        binPath,
      })
    ).rejects.toBeInstanceOf(EgressFetchError);
  });

  it("does not leave the rejection unhandled when the dest fails LATE", async () => {
    // The exact shape of the CI failure: the spawn fails first and settles the
    // promise, and the stream's open error arrives afterwards. It must be
    // swallowed by the `settled` guard, not thrown at the process.
    const seen: unknown[] = [];
    const onUncaught = (e: unknown) => seen.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      await expect(
        materializeRemoteToFile({
          url: "https://ok/x",
          allowlist: ["data.example.com"],
          destPath: join(dir, "also-missing", "out.parquet"),
          binPath: join(dir, "does-not-exist"),
        })
      ).rejects.toBeInstanceOf(EgressFetchError);
      await new Promise((r) => setTimeout(r, 50)); // let a late open error land
      expect(seen).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
