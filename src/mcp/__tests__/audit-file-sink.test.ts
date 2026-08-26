/**
 * The default file audit sink: generation-preserving rotation and a non-world-
 * readable log (F12). The old rename(file, file.1) overwrote the prior
 * generation on every rotation; this proves shifted generations survive.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathRoots, hermeticPaths } from "@/lib/paths";
import {
  fileAuditSink,
  verifyAuditChain,
  _resetAuditKeyForTests,
  AUDIT_ROTATE_BYTES,
  type AuditEntry,
} from "../audit";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  setPathRoots({ dataRoot: dir });
  _resetAuditKeyForTests();
});
afterEach(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

const entry = (tool: string): AuditEntry => ({
  ts: "2026-01-01T00:00:00Z",
  tool,
  args: {},
  outcome: "ok",
  durationMs: 1,
});
const fillPastThreshold = () =>
  writeFileSync(hermeticPaths.mcpAuditFile(), "x".repeat(AUDIT_ROTATE_BYTES + 1));

describe("fileAuditSink", () => {
  it("shifts generations on rotation without losing the older one", () => {
    const sink = fileAuditSink();
    const file = hermeticPaths.mcpAuditFile();

    fillPastThreshold();
    sink(entry("first")); // rotate #1: file -> .1
    expect(existsSync(`${file}.1`)).toBe(true);

    fillPastThreshold();
    sink(entry("second")); // rotate #2: .1 -> .2, file -> .1  (old code overwrote .1)
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("second");
  });

  it("creates the log 0600 (not world- or group-readable)", () => {
    fileAuditSink()(entry("connect_source"));
    const mode = statSync(hermeticPaths.mcpAuditFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("a clean chain verifies; an edited line breaks it at that line (F12 HMAC)", () => {
    const sink = fileAuditSink();
    sink(entry("connect_source"));
    sink(entry("run_sql"));
    sink(entry("analyze"));
    expect(verifyAuditChain()).toEqual({ ok: true });

    // Tamper with the middle entry — flip its tool but keep a plausible shape.
    const file = hermeticPaths.mcpAuditFile();
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const forged = JSON.parse(lines[1]);
    forged.tool = "exfiltrate";
    lines[1] = JSON.stringify(forged); // stale h — no key to recompute
    writeFileSync(file, lines.join("\n") + "\n");
    expect(verifyAuditChain()).toEqual({ ok: false, brokenLine: 2 });
  });

  it("the chain continues across a rotation (verify seeds from the prior generation)", () => {
    const sink = fileAuditSink();
    const file = hermeticPaths.mcpAuditFile();
    sink(entry("first")); // genesis line in the live file
    fillPastThreshold(); // force the next write to rotate (junk > threshold)
    sink(entry("second")); // rotates the junk to .1, writes a chained line
    // The live file's single line chained to lastHash(.1); verify seeds from .1
    // and must not read a rotation as a break.
    expect(verifyAuditChain()).toEqual({ ok: true });
  });
});
