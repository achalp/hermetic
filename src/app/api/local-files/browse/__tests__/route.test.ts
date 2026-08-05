import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

/**
 * Contract tests for GET /api/local-files/browse — the filesystem-exposure
 * route. The REAL security module (origin gate + root-jail) is exercised on
 * purpose: it is the route's whole job. Only the directory listing itself is
 * mocked, so no test depends on the machine's actual home contents.
 */

const listDirectory = vi.fn();
vi.mock("@/lib/local-files/browser", () => ({
  listDirectory: (...args: unknown[]) => listDirectory(...args),
  getHomePath: () => homedir(),
}));

// apiError logs through the real logger — keep test output quiet.
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET } from "@/app/api/local-files/browse/route";
import { PATH_NOT_ALLOWED_ERROR } from "@/lib/local-files/security";

function makeRequest(path?: string, headers: Record<string, string> = {}): NextRequest {
  const url = new URL("http://localhost:3000/api/local-files/browse");
  if (path !== undefined) url.searchParams.set("path", path);
  // No Origin header → validateLocalOrigin falls back to Host, so a loopback
  // Host is what non-browser clients / same-origin GETs present.
  return new NextRequest(url, { headers: { host: "localhost:3000", ...headers } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HERMETIC_LOCAL_FILE_ROOTS", "");
  listDirectory.mockResolvedValue([{ name: "data.csv", isDirectory: false }]);
});

describe("GET /api/local-files/browse", () => {
  it("rejects non-loopback requests (DNS-rebinding gate)", async () => {
    const url = new URL("http://evil.example/api/local-files/browse");
    const res = await GET(new NextRequest(url, { headers: { host: "evil.example" } }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Local access only");
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("rejects an absolute path outside the allowed roots", async () => {
    const res = await GET(makeRequest("/etc"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PATH_NOT_ALLOWED_ERROR);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("rejects a ..-traversal that escapes the home root", async () => {
    const res = await GET(makeRequest(join(homedir(), "..", "..", "etc")));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PATH_NOT_ALLOWED_ERROR);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("rejects a sibling prefix-escape of an allowed root (/home/x vs /home/xevil)", async () => {
    const res = await GET(makeRequest(`${homedir()}evil`));
    expect(res.status).toBe(403);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("lists the home directory by default and returns { path, entries }", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe(resolve(homedir()));
    expect(body.entries).toEqual([{ name: "data.csv", isDirectory: false }]);
    expect(listDirectory).toHaveBeenCalledWith(resolve(homedir()));
  });

  it("honors extra roots from HERMETIC_LOCAL_FILE_ROOTS", async () => {
    vi.stubEnv("HERMETIC_LOCAL_FILE_ROOTS", "/srv/datasets");
    const res = await GET(makeRequest("/srv/datasets/q3"));
    expect(res.status).toBe(200);
    expect((await res.json()).path).toBe("/srv/datasets/q3");
  });

  it("maps a listing failure to a 400 { error } body, not a throw", async () => {
    listDirectory.mockRejectedValue(new Error("EACCES: permission denied"));
    const res = await GET(makeRequest(homedir()));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("EACCES");
  });
});
