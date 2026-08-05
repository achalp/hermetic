import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Contract tests for POST /api/local-files/select — the second half of the
 * filesystem-exposure surface. Real security module (origin gate, root-jail,
 * extension allowlist) + real zod body validation; only the stat-level
 * getFileInfo is mocked so no test touches the real filesystem.
 */

const getFileInfo = vi.fn();
vi.mock("@/lib/local-files/browser", () => ({
  getFileInfo: (...args: unknown[]) => getFileInfo(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/local-files/select/route";
import { PATH_NOT_ALLOWED_ERROR } from "@/lib/local-files/security";

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/local-files/select", {
    method: "POST",
    headers: { host: "localhost:3000", ...headers },
    body: JSON.stringify(body),
  });
}

const csvPath = join(homedir(), "data", "sales.csv");
const fileInfo = {
  path: csvPath,
  name: "sales.csv",
  size: 1024,
  mtime: 1700000000000,
  extension: ".csv",
  isDirectory: false,
  isParquetFolder: false,
  isHivePartitioned: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HERMETIC_LOCAL_FILE_ROOTS", "");
  getFileInfo.mockResolvedValue(fileInfo);
});

describe("POST /api/local-files/select", () => {
  it("rejects non-loopback requests", async () => {
    const res = await POST(
      new Request("http://evil.example/api/local-files/select", {
        method: "POST",
        headers: { host: "evil.example" },
        body: JSON.stringify({ path: csvPath, type: "file" }),
      })
    );
    expect(res.status).toBe(403);
    expect(getFileInfo).not.toHaveBeenCalled();
  });

  it("rejects a malformed body via schema validation", async () => {
    const res = await POST(makeRequest({ path: csvPath })); // missing `type`
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Invalid request/);
    expect(getFileInfo).not.toHaveBeenCalled();
  });

  it("rejects a ..-traversal that escapes the allowed roots", async () => {
    const res = await POST(
      makeRequest({ path: join(homedir(), "..", "..", "etc", "passwd"), type: "file" })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PATH_NOT_ALLOWED_ERROR);
    expect(getFileInfo).not.toHaveBeenCalled();
  });

  it("rejects an absolute path outside the allowed roots", async () => {
    const res = await POST(makeRequest({ path: "/etc/passwd", type: "file" }));
    expect(res.status).toBe(403);
    expect(getFileInfo).not.toHaveBeenCalled();
  });

  it("rejects a disallowed file extension", async () => {
    getFileInfo.mockResolvedValue({ ...fileInfo, name: "tool.exe", extension: ".exe" });
    const res = await POST(makeRequest({ path: join(homedir(), "tool.exe"), type: "file" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(".exe");
  });

  it("rejects type=file when the path is a directory (and vice versa)", async () => {
    getFileInfo.mockResolvedValue({ ...fileInfo, isDirectory: true });
    const asFile = await POST(makeRequest({ path: csvPath, type: "file" }));
    expect(asFile.status).toBe(400);

    getFileInfo.mockResolvedValue({ ...fileInfo, isDirectory: false });
    const asFolder = await POST(makeRequest({ path: csvPath, type: "folder" }));
    expect(asFolder.status).toBe(400);
  });

  it("rejects a folder without Parquet files", async () => {
    getFileInfo.mockResolvedValue({ ...fileInfo, isDirectory: true, isParquetFolder: false });
    const res = await POST(makeRequest({ path: join(homedir(), "docs"), type: "folder" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Parquet");
  });

  it("returns the file info shape on the happy path", async () => {
    const res = await POST(makeRequest({ path: csvPath, type: "file" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      path: csvPath,
      name: "sales.csv",
      size: 1024,
      extension: ".csv",
      isDirectory: false,
    });
    expect(getFileInfo).toHaveBeenCalledWith(resolve(csvPath));
  });

  it("honors extra roots from HERMETIC_LOCAL_FILE_ROOTS", async () => {
    vi.stubEnv("HERMETIC_LOCAL_FILE_ROOTS", "/srv/datasets");
    const p = "/srv/datasets/q3.csv";
    getFileInfo.mockResolvedValue({ ...fileInfo, path: p, name: "q3.csv" });
    const res = await POST(makeRequest({ path: p, type: "file" }));
    expect(res.status).toBe(200);
  });

  it("maps a stat failure to a 400 { error } body", async () => {
    getFileInfo.mockRejectedValue(new Error("ENOENT: no such file"));
    const res = await POST(makeRequest({ path: csvPath, type: "file" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("ENOENT");
  });
});
