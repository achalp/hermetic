/**
 * batchReadContainerFiles (perf P3): the post-run sidecar fetch must parse the
 * single-exec delimited stream BYTE-accurately — sizes are byte counts, so
 * multi-byte UTF-8 and marker-lookalike content must not desynchronize it —
 * and a failed exec must return null so the caller falls back to per-file reads.
 * The exec is injected (intra-module calls bypass vi.mock), so no docker needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { batchReadContainerFiles, type run } from "@/lib/sandbox/docker-utils";

const exec = vi.fn() as unknown as typeof run & ReturnType<typeof vi.fn>;

/** Build the exec's stdout exactly as the in-container shell would. */
function stream(files: Record<string, string | null>): string {
  let out = "";
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      out += `===HERMETIC-SIDECAR=== ${path} -1\n`;
    } else {
      out += `===HERMETIC-SIDECAR=== ${path} ${Buffer.byteLength(content, "utf-8")}\n${content}`;
    }
  }
  return out;
}

beforeEach(() => {
  exec.mockReset();
});

describe("batchReadContainerFiles", () => {
  it("splits multiple files byte-accurately, including multi-byte UTF-8 content", async () => {
    const files = {
      "/data/stderr.txt": "Traceback: café ☕ done\n",
      "/data/stdout.txt": "", // empty file — size 0
      "/data/output.json": '{"results": {"total": 42}}\n',
    };
    exec.mockResolvedValue({ stdout: stream(files), stderr: "", exitCode: 0 });
    const map = await batchReadContainerFiles("cid", Object.keys(files), exec);
    expect(map).not.toBeNull();
    for (const [path, content] of Object.entries(files)) {
      expect(map!.get(path), path).toBe(content);
    }
  });

  it("content containing the marker string does not desynchronize parsing", async () => {
    const tricky = "log line\n===HERMETIC-SIDECAR=== /data/fake.txt 999\nmore\n";
    const files = { "/data/stderr.txt": tricky, "/data/stdout.txt": "ok\n" };
    exec.mockResolvedValue({ stdout: stream(files), stderr: "", exitCode: 0 });
    const map = await batchReadContainerFiles("cid", Object.keys(files), exec);
    expect(map!.get("/data/stderr.txt")).toBe(tricky); // marker inside content preserved
    expect(map!.get("/data/stdout.txt")).toBe("ok\n"); // and the NEXT file still parses
    expect(map!.has("/data/fake.txt")).toBe(false); // the embedded fake is not an entry
  });

  it("missing files (size -1) map to null, matching single-file cat behavior", async () => {
    exec.mockResolvedValue({
      stdout: stream({ "/data/output.json": null, "/data/stdout.txt": "x\n" }),
      stderr: "",
      exitCode: 0,
    });
    const map = await batchReadContainerFiles(
      "cid",
      ["/data/output.json", "/data/stdout.txt"],
      exec
    );
    expect(map!.get("/data/output.json")).toBeNull();
    expect(map!.get("/data/stdout.txt")).toBe("x\n");
  });

  it("returns null when the exec fails (container gone) — caller falls back per-file", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "no such container", exitCode: 1 });
    expect(await batchReadContainerFiles("cid", ["/data/stderr.txt"], exec)).toBeNull();
    exec.mockRejectedValue(new Error("spawn failed"));
    expect(await batchReadContainerFiles("cid", ["/data/stderr.txt"], exec)).toBeNull();
  });

  it("issues exactly ONE docker exec regardless of file count", async () => {
    exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    await batchReadContainerFiles(
      "cid",
      [
        "/data/stderr.txt",
        "/data/stdout.txt",
        "/data/hermetic_duckdb_cfg.txt",
        "/data/output.json",
      ],
      exec
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toContain("exec");
  });
});
