/**
 * Corrupt-vs-missing handling for runtime-config.json: setRuntimeConfig is a
 * read-modify-write, so an unparsable file used to be silently replaced by
 * the next write. Missing (ENOENT) stays a quiet empty config; corrupt gets
 * warned about and backed up first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig, clearRuntimeConfigCache } from "@/lib/runtime-config";
import { hermeticPaths, setPathRoots } from "@/lib/paths";
import { logger } from "@/lib/logger";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hermetic-runtime-config-"));
  setPathRoots({ dataRoot: join(root, "data") });
  clearRuntimeConfigCache();
});

afterEach(() => {
  setPathRoots({});
  clearRuntimeConfigCache();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("runtime-config — corrupt file vs missing file", () => {
  it("missing file → empty config, no warn, no backup", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(getRuntimeConfig()).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    expect(() => readdirSync(join(root, "data"))).toThrow(); // nothing was created
  });

  it("corrupt JSON → warn, .corrupt-<ts> backup preserved, empty config returned", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const path = hermeticPaths.runtimeConfigFile();
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(path, "{ definitely not json", "utf-8");

    expect(getRuntimeConfig()).toEqual({});
    expect(warn).toHaveBeenCalledOnce();

    const backup = readdirSync(join(root, "data")).find((f) =>
      /^runtime-config\.json\.corrupt-\d+$/.test(f)
    );
    expect(backup).toBeDefined();
    expect(readFileSync(join(root, "data", backup!), "utf-8")).toBe("{ definitely not json");
  });

  it("setRuntimeConfig after a corrupt read writes fresh without destroying the backup", () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const path = hermeticPaths.runtimeConfigFile();
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(path, "garbage", "utf-8");

    const merged = setRuntimeConfig({ activeProvider: "ollama" });
    expect(merged.activeProvider).toBe("ollama");

    const files = readdirSync(join(root, "data"));
    expect(files.filter((f) => f.startsWith("runtime-config.json.corrupt-"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf-8")).activeProvider).toBe("ollama");
  });
});

describe("settings blocks (providers/sandbox/retention) persist and clear", () => {
  it("round-trips a block through disk and replaces it wholesale", () => {
    setRuntimeConfig({ retention: { maxHistoryEntries: 300 } });
    expect(getRuntimeConfig().retention).toEqual({ maxHistoryEntries: 300 });

    // Wholesale replacement: a block sent without a field CLEARS that field
    // (the /api/settings route sends complete blocks — per-field merge would
    // make clearing impossible).
    setRuntimeConfig({ retention: { maxRunRecords: 50 } });
    expect(getRuntimeConfig().retention).toEqual({ maxRunRecords: 50 });

    setRuntimeConfig({ providers: { openaiModel: "llama3.3" }, sandbox: { memoryFraction: 0.5 } });
    clearRuntimeConfigCache();
    const rc = getRuntimeConfig();
    expect(rc.providers?.openaiModel).toBe("llama3.3");
    expect(rc.sandbox?.memoryFraction).toBe(0.5);
    expect(rc.retention).toEqual({ maxRunRecords: 50 });
  });
});
