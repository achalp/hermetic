/**
 * Embedded viewer server tests (M3): id validation, traversal containment,
 * history-entry serving from a temp data root, loopback bind.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startViewerServer, type ViewerServer } from "../viewer/server";
import { setPathRoots } from "@/lib/paths";

const ENTRY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let dir: string;
let viewer: ViewerServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcp-viewer-"));
  setPathRoots({ dataRoot: dir });
  const entryDir = join(dir, "history", ENTRY_ID);
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(
    join(entryDir, "spec.json"),
    JSON.stringify({ root: "r", elements: { r: { type: "Text", props: { content: "hi" } } } })
  );
  writeFileSync(join(entryDir, "meta.json"), JSON.stringify({ question: "What is up?" }));
  viewer = await startViewerServer(0); // ephemeral port
});

afterEach(async () => {
  await viewer.close();
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string) => fetch(`http://127.0.0.1:${viewer.port}${path}`);

describe("viewer server", () => {
  it("serves a persisted spec with its question", async () => {
    const res = await get(`/api/spec/${ENTRY_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.question).toBe("What is up?");
    expect(body.spec.root).toBe("r");
  });

  it("rejects non-uuid ids and unknown entries", async () => {
    // URL normalization collapses traversal before routing — lands outside
    // /api/spec/ entirely (404), never reaching a filesystem join.
    expect((await get("/api/spec/../../etc/passwd")).status).toBe(404);
    expect((await get("/api/spec/not-a-uuid")).status).toBe(400);
    expect((await get("/api/spec/aaaaaaaa-bbbb-4ccc-8ddd-000000000000")).status).toBe(404);
  });

  it("contains asset requests inside dist (traversal collapses then 403s)", async () => {
    const res = await get("/assets/../../../../etc/passwd");
    expect([403, 404]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("root:");
  });

  it("export route validates ids the way /api/spec does", async () => {
    expect((await get("/api/export/not-a-uuid")).status).toBe(400);
    expect((await get("/api/export/aaaaaaaa-bbbb-4ccc-8ddd-000000000000")).status).toBe(404);
  });

  it("export route serves a self-contained attachment, or a 503 naming the build step", async () => {
    const res = await get(`/api/export/${ENTRY_ID}`);
    // The route reads the REAL viewer dist; when the export bundles exist
    // (post `pnpm mcp:build-viewer`) the download must be complete and
    // correctly headed — otherwise the 503 must say how to build them.
    if (existsSync(join(__dirname, "..", "viewer", "dist", "export-manifest.json"))) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      // Filename derives from the persisted question.
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="what-is-up.html"');
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain('id="hermetic-spec"');
      expect(html).toContain('id="hermetic-manifest"');
    } else {
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("pnpm mcp:build-viewer");
    }
  });

  it("health endpoint responds", async () => {
    const res = await get("/api/health");
    expect((await res.json()).ok).toBe(true);
  });

  it("takes an ephemeral port when the preferred one is busy", async () => {
    const second = await startViewerServer(viewer.port);
    expect(second.port).not.toBe(viewer.port);
    await second.close();
  });
});
