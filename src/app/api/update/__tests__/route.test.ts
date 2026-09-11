import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * /api/update — the Settings update controls' file channel to the desktop
 * shell. GET merges the shell's live check state + the boot-cleared pending
 * marker; POST writes the command file the shell's watcher consumes — but
 * ONLY on the desktop (HERMETIC_DESKTOP=1): a command nobody reads would
 * leave the UI spinning forever.
 */
const validateLocalOrigin = vi.fn();
vi.mock("@/lib/local-files/security", () => ({
  validateLocalOrigin: (...a: unknown[]) => validateLocalOrigin(...a),
}));

const readFileSync = vi.fn();
const writeFileSync = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: (...a: unknown[]) => readFileSync(...a),
  writeFileSync: (...a: unknown[]) => writeFileSync(...a),
  mkdirSync: vi.fn(),
}));

import { GET, POST } from "@/app/api/update/route";

const req = (body?: unknown) =>
  new Request("http://127.0.0.1/api/update", {
    method: body === undefined ? "GET" : "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  vi.clearAllMocks();
  validateLocalOrigin.mockReturnValue(true);
  process.env.HERMETIC_DESKTOP = "1";
});
afterEach(() => {
  delete process.env.HERMETIC_DESKTOP;
});

describe("GET /api/update", () => {
  it("merges shell state + the pending marker", async () => {
    readFileSync.mockImplementation((p: string) =>
      String(p).includes("update-state")
        ? '{"phase":"installed","detail":"0.9.9"}'
        : '{"version":"0.9.9"}'
    );
    const body = await (await GET(req())).json();
    expect(body.phase).toBe("installed");
    expect(body.detail).toBe("0.9.9");
    expect(body.update_pending).toBe("0.9.9");
    expect(body.desktop).toBe(true);
    expect(typeof body.version).toBe("string");
  });

  it("reads-and-catches: no files → idle/null, never a 500", async () => {
    readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const body = await (await GET(req())).json();
    expect(body.phase).toBe("idle");
    expect(body.update_pending).toBeNull();
  });

  it("refuses non-local origins", async () => {
    validateLocalOrigin.mockReturnValue(false);
    expect((await GET(req())).status).toBe(403);
  });
});

describe("POST /api/update", () => {
  it("writes the command file for a valid action", async () => {
    const res = await POST(req({ action: "check" }));
    expect(res.status).toBe(200);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [file, content] = writeFileSync.mock.calls[0] as [string, string];
    expect(String(file)).toContain("update-command.json");
    expect(JSON.parse(content).action).toBe("check");
  });

  it("rejects unknown actions and malformed bodies", async () => {
    expect((await POST(req({ action: "rm -rf" }))).status).toBe(400);
    expect(
      (await POST(new Request("http://127.0.0.1/api/update", { method: "POST", body: "not json" })))
        .status
    ).toBe(400);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses off the desktop — no shell is listening", async () => {
    delete process.env.HERMETIC_DESKTOP;
    expect((await POST(req({ action: "check" }))).status).toBe(400);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses non-local origins", async () => {
    validateLocalOrigin.mockReturnValue(false);
    expect((await POST(req({ action: "check" }))).status).toBe(403);
  });
});
