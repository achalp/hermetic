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
import { fileAuditSink, AUDIT_ROTATE_BYTES, type AuditEntry } from "../audit";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "audit-test-"));
  setPathRoots({ dataRoot: dir });
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
});
