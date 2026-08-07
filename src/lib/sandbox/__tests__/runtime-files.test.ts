import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  hermeticRuntimeFiles,
  extractPreloadedFns,
  buildPreloadedApiSection,
  preloadedExtrasLine,
  resetRuntimeFilesCacheForTests,
} from "@/lib/sandbox/runtime-files";

beforeEach(() => resetRuntimeFilesCacheForTests());

describe("hermeticRuntimeFiles", () => {
  it("ships every runtime module under /data/hermetic_runtime/", () => {
    const files = hermeticRuntimeFiles();
    const names = files.map((f) => f.path);
    // Derived from the package directory (run 88e5d443: a hand-maintained
    // list omitted checks.py and every stat helper silently became a stub).
    expect(names[0]).toBe("/data/hermetic_runtime/__init__.py");
    for (const mod of [
      "checks.py",
      "coerce.py",
      "findings.py",
      "frames.py",
      "guards.py",
      "output.py",
      "profile.py",
    ]) {
      expect(names).toContain(`/data/hermetic_runtime/${mod}`);
    }
    expect(names.some((n) => n.includes("test_"))).toBe(false);
    for (const f of files) expect(f.content.length).toBeGreaterThan(100);
    // Import purity: the package must not import pandas/numpy at module level
    // (the prelude imports it before user code; a heavy import there would slow
    // or break every run on a minimal image).
    const init = files.find((f) => f.path.endsWith("__init__.py"))!;
    expect(init.content).not.toMatch(/^import (pandas|numpy)/m);
  });

  it("is cached (same array identity across calls)", () => {
    expect(hermeticRuntimeFiles()).toBe(hermeticRuntimeFiles());
  });
});

describe("preloaded API generation", () => {
  it("extracts def signatures + docstring first lines", () => {
    const fns = extractPreloadedFns(
      `def foo(a, b=None):\n    """Does foo things.\n\n    More detail."""\n    pass\n\ndef _private(x):\n    """Hidden."""\n`
    );
    expect(fns).toEqual([{ name: "foo", signature: "a, b=None", summary: "Does foo things." }]);
  });

  it("the generated section covers the real package's public API", () => {
    const section = buildPreloadedApiSection();
    for (const name of ["write_output", "safe_float", "safe_int", "assert_fits", "to_num"]) {
      expect(section).toContain(`${name}(`);
    }
    expect(section).not.toContain("configure("); // prelude-internal wiring excluded
  });

  it("extras line covers exactly what the hand-curated prompt list does not", () => {
    const line = preloadedExtrasLine();
    for (const name of ["safe_float", "safe_int", "assert_fits", "to_native"]) {
      expect(line).toContain(`${name}(`);
    }
    for (const curated of ["write_output(", "to_num(", "numeric(", "safe_qcut("]) {
      expect(line).not.toContain(curated);
    }
  });
});

describe("python package parity", () => {
  // The shipped source must actually be importable/behave — run the package's
  // own unittest suite when a python3 is available (always in CI's image job;
  // usually on dev Macs). Skipped, not failed, when python3 is absent.
  const hasPython = (() => {
    try {
      execFileSync("python3", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasPython)("the runtime package's unittest suite passes", () => {
    const out = execFileSync("python3", ["-m", "unittest", "hermetic_runtime.test_runtime"], {
      cwd: path.join(process.cwd(), "docker", "sandbox"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toBeDefined(); // non-zero exit throws above
  });
});
