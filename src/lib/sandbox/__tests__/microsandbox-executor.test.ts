/**
 * microsandbox-executor tests. The `microsandbox` SDK (PythonSandbox) is mocked
 * whole — create / run / command.run / stop — so nothing touches a real
 * microsandbox server. We assert the execute flow (sandbox creation, chunked
 * file writes, script exec, output parsing) and the create/repair paths.
 *
 * Module state (warmSandbox / creationPromise) lives at module scope, so each
 * test re-imports the module fresh via vi.resetModules() for isolation. The
 * mock factories reference stable top-level vi.fns, which survive resetModules.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── SDK + settings mocks (stable top-level fns) ─────────────────────────
const PythonSandboxCreate = vi.fn();
vi.mock("microsandbox", () => ({
  PythonSandbox: { create: (...a: unknown[]) => PythonSandboxCreate(...a) },
}));

const microsandboxUrl = vi.fn<() => string | undefined>(() => undefined);
const microsandboxImage = vi.fn<() => string | undefined>(() => undefined);
vi.mock("@/lib/settings", () => ({
  microsandboxUrl: () => microsandboxUrl(),
  microsandboxImage: () => microsandboxImage(),
}));

const getApiKey = vi.fn<() => string | undefined>(() => undefined);
vi.mock("@/lib/secrets", () => ({ getApiKey: () => getApiKey() }));

vi.mock("@/lib/sandbox/prelude", () => ({ pythonNanPrelude: () => "# PRELUDE\n" }));

const parseSandboxOutput = vi.fn();
vi.mock("@/lib/sandbox/parse-output", () => ({
  parseSandboxOutput: (...a: unknown[]) => parseSandboxOutput(...a),
  classifyThrownError: (msg: string) =>
    /timed?\s*out|timeout|deadline/i.test(msg) ? "timeout" : "infra",
}));

// ── Fake sandbox factory ────────────────────────────────────────────────
type RunResult = {
  hasError: () => boolean;
  error: () => Promise<string>;
  output: () => Promise<string>;
};
type CmdResult = {
  success: boolean;
  exitCode: number;
  output: () => Promise<string>;
  error: () => Promise<string>;
};
const okRun = (): RunResult => ({
  hasError: () => false,
  error: async () => "",
  output: async () => "",
});
const errRun = (msg = "boom"): RunResult => ({
  hasError: () => true,
  error: async () => msg,
  output: async () => "",
});
const cmd = (over: Partial<CmdResult> = {}): CmdResult => ({
  success: true,
  exitCode: 0,
  output: async () => "0",
  error: async () => "",
  ...over,
});

interface SandboxOpts {
  runImpl?: (code: string) => RunResult;
  cmdImpl?: (cmd: string, args: string[]) => CmdResult;
}
function makeSandbox(opts: SandboxOpts = {}) {
  const run = vi.fn(async (code: string) => (opts.runImpl ? opts.runImpl(code) : okRun()));
  const commandRun = vi.fn(async (c: string, args: string[]) => {
    if (opts.cmdImpl) return opts.cmdImpl(c, args);
    if (c === "cat") return cmd({ output: async () => "FILE-CONTENTS" });
    if (c === "python3") return cmd({ output: async () => "/bundled/pip.whl" });
    if (c === "sh" && args[1]?.includes("pip install")) return cmd();
    if (c === "sh" && args[1]?.includes("script.py")) return cmd({ output: async () => "0" });
    return cmd();
  });
  return {
    run,
    command: { run: commandRun },
    stop: vi.fn(async () => {}),
  };
}

// Default global fetch: reachability probe resolves; rawRpc returns clean JSON.
function installFetch() {
  global.fetch = vi.fn(async (url: unknown) => {
    if (String(url).includes("/api/v1/rpc")) {
      return { json: async () => ({ jsonrpc: "2.0", result: {} }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

async function loadModule() {
  vi.resetModules();
  return import("@/lib/sandbox/microsandbox-executor");
}

beforeEach(() => {
  vi.clearAllMocks();
  microsandboxUrl.mockReturnValue(undefined);
  microsandboxImage.mockReturnValue(undefined);
  getApiKey.mockReturnValue(undefined);
  parseSandboxOutput.mockResolvedValue({
    success: true,
    results: {},
    chart_data: {},
    images: {},
    execution_ms: 1,
  });
  installFetch();
});

// ── readSandboxFile ─────────────────────────────────────────────────────
describe("readSandboxFile", () => {
  it("returns the cat output on success", async () => {
    const { readSandboxFile } = await loadModule();
    const sandbox = makeSandbox();
    const out = await readSandboxFile(sandbox as never, "/data/output.json");
    expect(out).toBe("FILE-CONTENTS");
    expect(sandbox.command.run).toHaveBeenCalledWith("cat", ["/data/output.json"], 5);
  });

  it("returns null when the command throws", async () => {
    const { readSandboxFile } = await loadModule();
    const sandbox = makeSandbox({
      cmdImpl: () => {
        throw new Error("nope");
      },
    });
    expect(await readSandboxFile(sandbox as never, "/x")).toBeNull();
  });

  it("returns null when the command reports failure", async () => {
    const { readSandboxFile } = await loadModule();
    const sandbox = makeSandbox({ cmdImpl: () => cmd({ success: false, exitCode: 1 }) });
    expect(await readSandboxFile(sandbox as never, "/x")).toBeNull();
  });
});

// ── writeChunkedFile ────────────────────────────────────────────────────
describe("writeChunkedFile", () => {
  it("writes a small file in a single chunk and returns null", async () => {
    const { writeChunkedFile } = await loadModule();
    const sandbox = makeSandbox();
    const err = await writeChunkedFile(sandbox as never, "/data/input.csv", "a,b\n1,2\n");
    expect(err).toBeNull();
    expect(sandbox.run).toHaveBeenCalledTimes(1);
  });

  it("splits a >512KB payload into multiple append chunks", async () => {
    const { writeChunkedFile } = await loadModule();
    const sandbox = makeSandbox();
    const big = "x".repeat(512 * 1024 + 100); // one init chunk + one append
    const err = await writeChunkedFile(sandbox as never, "/data/big.csv", big);
    expect(err).toBeNull();
    expect(sandbox.run).toHaveBeenCalledTimes(2);
  });

  it("returns an error string when the initial write fails", async () => {
    const { writeChunkedFile } = await loadModule();
    const sandbox = makeSandbox({ runImpl: () => errRun("disk full") });
    const err = await writeChunkedFile(sandbox as never, "/data/x", "hi");
    expect(err).toContain("Failed to write file");
    expect(err).toContain("disk full");
  });

  it("returns an error string when an append chunk fails", async () => {
    const { writeChunkedFile } = await loadModule();
    let call = 0;
    const sandbox = makeSandbox({
      runImpl: () => (call++ === 0 ? okRun() : errRun("append boom")),
    });
    const big = "y".repeat(512 * 1024 + 50);
    const err = await writeChunkedFile(sandbox as never, "/data/big", big);
    expect(err).toContain("Failed to write chunk");
  });
});

// ── executeSandbox ──────────────────────────────────────────────────────
describe("executeSandbox — happy path", () => {
  it("creates a sandbox, writes files, runs the script, and parses output", async () => {
    const sandbox = makeSandbox();
    PythonSandboxCreate.mockResolvedValue(sandbox);
    const { executeSandbox } = await loadModule();

    const res = await executeSandbox("a,b\n1,2\n", "print('hi')");
    expect(res.success).toBe(true);
    expect(PythonSandboxCreate).toHaveBeenCalledTimes(1);

    // The script exec ran the patched code (prelude + code, /data → per-query).
    const execCall = sandbox.command.run.mock.calls.find(
      ([c, args]) => c === "sh" && (args as string[])[1]?.includes("script.py")
    );
    expect(execCall).toBeDefined();

    // The script write went through writeChunkedFile (base64 write_bytes to
    // .../script.py) — the prelude+code payload is base64-encoded inside it.
    const scriptWrite = sandbox.run.mock.calls.find(([code]) =>
      (code as string).includes("script.py")
    );
    expect(scriptWrite).toBeDefined();

    // parseSandboxOutput received the microsandbox runtime tag and exitCode 0.
    expect(parseSandboxOutput).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "microsandbox", exitCode: 0 })
    );
  });

  it("writes geojson and additional files when provided", async () => {
    const sandbox = makeSandbox();
    PythonSandboxCreate.mockResolvedValue(sandbox);
    const { executeSandbox } = await loadModule();

    const res = await executeSandbox("a\n1\n", "code", {
      geojsonContent: '{"type":"FeatureCollection"}',
      additionalFiles: [{ path: "/data/sheets/x.csv", content: "c\n1\n" }],
    });
    expect(res.success).toBe(true);
    // A mkdir for the additional file's parent dir ran.
    expect(sandbox.run.mock.calls.some(([c]) => (c as string).includes("sheets"))).toBe(true);
  });

  it("reuses the warm sandbox across two executions (creates once)", async () => {
    const sandbox = makeSandbox();
    PythonSandboxCreate.mockResolvedValue(sandbox);
    const { executeSandbox } = await loadModule();

    await executeSandbox("a\n1\n", "code1");
    await executeSandbox("a\n1\n", "code2");
    expect(PythonSandboxCreate).toHaveBeenCalledTimes(1);
  });
});

describe("executeSandbox — package installation path", () => {
  it("installs packages when pandas is missing, then verifies", async () => {
    // "import pandas" probe fails once → install branch; verify import passes.
    const sandbox = makeSandbox({
      runImpl: (code) => (code === "import pandas" ? errRun("no pandas") : okRun()),
    });
    PythonSandboxCreate.mockResolvedValue(sandbox);
    const { executeSandbox } = await loadModule();

    const res = await executeSandbox("a\n1\n", "code");
    expect(res.success).toBe(true);
    const install = sandbox.command.run.mock.calls.find(
      ([c, args]) => c === "sh" && (args as string[])[1]?.includes("pip install")
    );
    expect(install).toBeDefined();
  });

  it("fails when pip install fails", async () => {
    const sandbox = makeSandbox({
      runImpl: (code) => (code === "import pandas" ? errRun("no pandas") : okRun()),
      cmdImpl: (c, args) => {
        if (c === "python3") return cmd({ output: async () => "/w/pip.whl" });
        if (c === "sh" && args[1]?.includes("pip install"))
          return cmd({ success: false, exitCode: 1, error: async () => "pip exploded" });
        return cmd();
      },
    });
    PythonSandboxCreate.mockResolvedValue(sandbox);
    const { executeSandbox } = await loadModule();

    const res = await executeSandbox("a\n1\n", "code");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("Failed to install packages");
  });
});

describe("executeSandbox — failure paths", () => {
  it("errors when the microsandbox server is unreachable", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { executeSandbox } = await loadModule();

    const res = await executeSandbox("a\n1\n", "code");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("not reachable");
  });

  it("returns a failure result when a file write fails", async () => {
    const sandbox = makeSandbox({
      // Health check + pandas probe + mkdirs pass; the CSV chunk write fails.
      runImpl: (code) => (code.includes("b64decode") ? errRun("write denied") : okRun()),
    });
    PythonSandboxCreate.mockResolvedValue(sandbox);
    const { executeSandbox } = await loadModule();

    const res = await executeSandbox("a\n1\n", "code");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("Failed to write");
  });
});

describe("createHealthySandbox — repair path", () => {
  it("force-stops and recreates when the initial REPL check is broken", async () => {
    // First created sandbox: its "print('ok')" health check errors → repair.
    const broken = makeSandbox({
      runImpl: (code) => (code === "print('ok')" ? errRun() : okRun()),
    });
    const good = makeSandbox();
    PythonSandboxCreate.mockResolvedValueOnce(broken).mockResolvedValue(good);

    const { executeSandbox } = await loadModule();
    const res = await executeSandbox("a\n1\n", "code");
    expect(res.success).toBe(true);
    // create called at least twice: broken, then recreate after raw stop.
    expect(PythonSandboxCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The raw JSON-RPC stop was issued to the server.
    const rpcCall = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([u]) =>
      String(u).includes("/api/v1/rpc")
    );
    expect(rpcCall).toBeDefined();
  });
});
