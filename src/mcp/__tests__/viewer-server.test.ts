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

const base = () => `http://127.0.0.1:${viewer.port}`;
// The data endpoints require the capability token (F9); append it so the
// existing id-validation assertions reach their handlers.
const get = (path: string) => {
  const sep = path.includes("?") ? "&" : "?";
  return fetch(`${base()}${path}${sep}t=${viewer.token}`);
};
const getRaw = (path: string, init?: RequestInit) => fetch(`${base()}${path}`, init);

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

  it("rejects data requests with a missing or wrong token (F9)", async () => {
    expect((await getRaw(`/api/spec/${ENTRY_ID}`)).status).toBe(403); // no token
    expect((await getRaw(`/api/spec/${ENTRY_ID}?t=wrong`)).status).toBe(403);
    expect((await getRaw(`/api/export/${ENTRY_ID}`)).status).toBe(403);
    expect((await getRaw("/?restore=" + ENTRY_ID)).status).toBe(403); // page needs it too
  });

  it("the page load sets the token cookie; a same-origin fetch is then accepted", async () => {
    const page = await getRaw(`/?restore=${ENTRY_ID}&t=${viewer.token}`);
    // (200 with the built shell, or 503 if the viewer bundle isn't built here)
    expect([200, 503]).toContain(page.status);
    if (page.status === 200) {
      const cookie = page.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("hermetic_viewer=");
      // The cookie alone (no ?t=) authorizes the spec fetch.
      const specViaCookie = await getRaw(`/api/spec/${ENTRY_ID}`, {
        headers: { cookie: `hermetic_viewer=${viewer.token}` },
      });
      expect(specViaCookie.status).toBe(200);
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
