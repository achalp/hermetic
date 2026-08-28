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
const FAKE = `#!/usr/bin/env node
const url = process.argv[2] || "";
const mode = url.replace(/^https?:\\/\\//, "").split("/")[0]; // host = mode
if (mode === "ok") { process.stdout.write("BYTES:" + (process.env.HERMETIC_EGRESS_ALLOWLIST||"")); process.exit(0); }
if (mode === "bearer") { process.stdout.write("AUTH:" + (process.env.HERMETIC_EGRESS_BEARER||"none")); process.exit(0); }
if (mode === "deny") { process.stderr.write("egress-fetch: denied: Host"); process.exit(1); }
if (mode === "cap") { process.stderr.write("cap exceeded after 999"); process.exit(3); }
process.exit(2);
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
});
