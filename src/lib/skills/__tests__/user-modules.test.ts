import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/logger", () => ({
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setRunIdProvider: vi.fn(),
}));

import {
  loadUserModules,
  userModuleFiles,
  buildUserModulesSection,
  extractImports,
  findUnavailableImports,
  resetUserModuleCacheForTests,
} from "@/lib/skills/user-modules";
import { logger } from "@/lib/logger";

const METRICS = `"""Team KPI definitions."""

import math
import duckdb
from user_lib.loaders import load_thing


def net_revenue(source="data"):
    """Net revenue per the finance definition (returns a float)."""
    return 0.0
`;

let dir: string;
beforeEach(() => {
  resetUserModuleCacheForTests();
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(tmpdir(), "hermetic-userlib-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("import extraction & validation", () => {
  it("extracts first dotted segments from import/from lines", () => {
    expect(extractImports(METRICS).sort()).toEqual(["duckdb", "math", "user_lib"]);
  });

  it("allows stdlib, image packages, and sandbox namespaces; flags the rest", () => {
    expect(findUnavailableImports(METRICS)).toEqual([]);
    expect(findUnavailableImports("import polars\nimport requests\nimport os")).toEqual([
      "polars",
      "requests",
    ]);
  });
});

describe("loadUserModules", () => {
  it("returns empty for a missing directory", () => {
    expect(loadUserModules(path.join(dir, "absent"))).toEqual({ modules: [], errors: [] });
  });

  it("loads a valid module with extracted function signatures", () => {
    writeFileSync(path.join(dir, "metrics.py"), METRICS);
    const { modules, errors } = loadUserModules(dir);
    expect(errors).toEqual([]);
    expect(modules).toHaveLength(1);
    expect(modules[0].moduleName).toBe("metrics");
    expect(modules[0].functions).toEqual([
      {
        name: "net_revenue",
        signature: 'source="data"',
        summary: "Net revenue per the finance definition (returns a float).",
      },
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "User module loaded",
      expect.objectContaining({ module: "user_lib.metrics" })
    );
  });

  it("rejects a module importing an unavailable package, naming it (spec §4.5)", () => {
    writeFileSync(path.join(dir, "fancy.py"), "import polars\n\ndef f():\n    pass\n");
    const { modules, errors } = loadUserModules(dir);
    expect(modules).toEqual([]);
    expect(errors[0].reason).toContain("'polars'");
    expect(errors[0].reason).toContain("not available in the sandbox image");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    loadUserModules(dir); // cached → no repeat warn
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid module filenames and ignores underscore/non-py files", () => {
    writeFileSync(path.join(dir, "my-metrics.py"), "def f():\n    pass\n");
    writeFileSync(path.join(dir, "_private.py"), "import polars\n");
    writeFileSync(path.join(dir, "notes.txt"), "not python");
    const { modules, errors } = loadUserModules(dir);
    expect(modules).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toContain("not a valid Python module name");
  });
});

describe("shipping + advertisement", () => {
  it("ships valid modules under /data/user_lib/", () => {
    writeFileSync(path.join(dir, "metrics.py"), METRICS);
    expect(userModuleFiles(dir).map((f) => f.path)).toEqual(["/data/user_lib/metrics.py"]);
  });

  it("builds the cached-prefix prompt section from extracted signatures", () => {
    writeFileSync(path.join(dir, "metrics.py"), METRICS);
    const section = buildUserModulesSection(dir);
    expect(section).toContain("## User Python modules");
    expect(section).toContain("from user_lib.metrics import ...");
    expect(section).toContain('net_revenue(source="data")');
    expect(buildUserModulesSection(path.join(dir, "absent"))).toBe("");
  });
});
