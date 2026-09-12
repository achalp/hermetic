/**
 * Desktop runtime selection after un-pinning wasm.
 *
 * The packaged app used to set HERMETIC_FORCE_RUNTIME=wasm (D15: "predictable
 * even if the user has Docker"), which left every desktop user on the tier with
 * the least proof behind it and no way off — and CI never exercises that tier's
 * engine at all. It now sets HERMETIC_DEFAULT_RUNTIME=wasm, a FALLBACK that only
 * applies before anything is known, so a machine with a daemon gets Docker and a
 * machine without still works out of the box.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  cfg: {} as Record<string, unknown>,
}));

// runtime-config reads the sanctioned snapshot through the harness SLOT, not the
// harness module — mocking the wrong one silently leaves the real env in place.
vi.mock("@/lib/harness-slot", async (orig) => {
  const actual = await orig<typeof import("@/lib/harness-slot")>();
  return { ...actual, envConfig: () => state.env };
});

let dir: string;

beforeEach(() => {
  state.env = {};
  state.cfg = {};
  dir = mkdtempSync(join(tmpdir(), "hermetic-rt-"));
  vi.resetModules();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function activeRuntime() {
  vi.doMock("@/lib/runtime-config", async (orig) => {
    const actual = await orig<typeof import("@/lib/runtime-config")>();
    return { ...actual, getRuntimeConfig: () => state.cfg };
  });
  const mod = await import("@/lib/runtime-config");
  // getActiveSandboxRuntime reads getRuntimeConfig from its own module scope, so
  // drive the real function through the real config shape instead of mocking it.
  return mod.resolveActiveRuntime(
    state.cfg.sandboxRuntime as never,
    state.cfg.dockerAvailable as never
  );
}

describe("resolveActiveRuntime — what a desktop install lands on", () => {
  it("prefers Docker once the probe has found a daemon", async () => {
    state.cfg = { dockerAvailable: true };
    expect(await activeRuntime()).toBe("docker");
  });

  it("falls back to wasm when the probe found no daemon", async () => {
    // The zero-dependency promise: a fresh machine with no Docker still works.
    state.cfg = { dockerAvailable: false };
    expect(await activeRuntime()).toBe("wasm");
  });

  it("honours an explicit user pin over the probe, in both directions", async () => {
    state.cfg = { sandboxRuntime: "wasm", dockerAvailable: true };
    expect(await activeRuntime()).toBe("wasm");
    state.cfg = { sandboxRuntime: "docker", dockerAvailable: false };
    expect(await activeRuntime()).toBe("docker");
  });
});

describe("HERMETIC_DEFAULT_RUNTIME is a fallback, not a mandate", () => {
  // Exercises the REAL config path (temp data root + setRuntimeConfig) rather
  // than mocking the module's own internals, so the precedence under test is the
  // one that ships.
  async function getActive(cfg: Record<string, unknown>) {
    const { setPathRoots } = await import("@/lib/paths");
    setPathRoots({ dataRoot: dir });
    const mod = await import("@/lib/runtime-config");
    mod.setRuntimeConfig(cfg as never);
    return mod.getActiveSandboxRuntime();
  }

  it("applies only while nothing is known — the first launch before any probe", async () => {
    // Without this, an un-probed desktop resolves to docker (the web default) and
    // the first analysis fails on a machine that never had a daemon.
    state.env = { HERMETIC_DEFAULT_RUNTIME: "wasm" };
    expect(await getActive({})).toBe("wasm");
  });

  it("yields to the probe the moment boot health records a daemon", async () => {
    state.env = { HERMETIC_DEFAULT_RUNTIME: "wasm" };
    expect(await getActive({ dockerAvailable: true })).toBe("docker");
  });

  it("yields to an explicit user choice", async () => {
    state.env = { HERMETIC_DEFAULT_RUNTIME: "wasm" };
    expect(await getActive({ sandboxRuntime: "docker" })).toBe("docker");
  });

  it("FORCE still overrides everything — CI and tests need a hard pin", async () => {
    state.env = { HERMETIC_FORCE_RUNTIME: "wasm", HERMETIC_DEFAULT_RUNTIME: "docker" };
    expect(await getActive({ sandboxRuntime: "docker", dockerAvailable: true })).toBe("wasm");
  });
});

describe("one-time migration off the forced-wasm pin", () => {
  /**
   * The packaged app used to set HERMETIC_FORCE_RUNTIME=wasm, which overrode
   * config entirely — so a wasm "choice" written on that channel was an artifact
   * of the force, not a decision. Observed live: a desktop install on 0.5.12 found
   * Docker, recorded dockerAvailable:true, and still ran wasm because of that pin.
   */
  // Reads the config back from DISK rather than through the module's TTL cache:
  // what survives the write is the thing a next launch actually sees.
  async function active(cfg: Record<string, unknown>) {
    const { setPathRoots } = await import("@/lib/paths");
    setPathRoots({ dataRoot: dir });
    const mod = await import("@/lib/runtime-config");
    mod.setRuntimeConfig(cfg as never);
    const runtime = mod.getActiveSandboxRuntime();
    const onDisk = JSON.parse(readFileSync(join(dir, "runtime-config.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    return { runtime, cfg: onDisk };
  }

  it("clears a leftover wasm pin once Docker is known to be present", async () => {
    state.env = { HERMETIC_DEFAULT_RUNTIME: "wasm" };
    const { runtime, cfg } = await active({ sandboxRuntime: "wasm", dockerAvailable: true });
    expect(runtime).toBe("docker");
    // Actually CLEARED on disk — setRuntimeConfig ignores `undefined`, so a
    // migration that passed undefined would record success and change nothing.
    expect(cfg.sandboxRuntime).toBeUndefined();
    expect(cfg.runtimePinMigrated).toBe(true);
  });

  it("runs ONCE — a deliberate wasm pick afterwards is respected forever", async () => {
    state.env = { HERMETIC_DEFAULT_RUNTIME: "wasm" };
    await active({ sandboxRuntime: "wasm", dockerAvailable: true });
    const second = await active({ sandboxRuntime: "wasm" });
    expect(second.runtime).toBe("wasm");
    expect(second.cfg.sandboxRuntime).toBe("wasm");
  });

  it("leaves a DOCKER pin alone, and does not fire without a wasm fallback channel", async () => {
    state.env = { HERMETIC_DEFAULT_RUNTIME: "wasm" };
    expect((await active({ sandboxRuntime: "docker", dockerAvailable: true })).runtime).toBe(
      "docker"
    );
    // The web path has no wasm fallback configured: a wasm pin there was a real
    // choice, never a forced artifact.
    state.env = {};
    const web = await active({ sandboxRuntime: "wasm", dockerAvailable: true });
    expect(web.runtime).toBe("wasm");
    expect(web.cfg.sandboxRuntime).toBe("wasm");
  });

  it("does not fire while Docker is absent — nothing to migrate toward", async () => {
    state.env = { HERMETIC_DEFAULT_RUNTIME: "wasm" };
    const r = await active({ sandboxRuntime: "wasm", dockerAvailable: false });
    expect(r.runtime).toBe("wasm");
    expect(r.cfg.sandboxRuntime).toBe("wasm");
  });
});
