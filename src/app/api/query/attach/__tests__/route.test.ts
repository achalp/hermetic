import { describe, it, expect, vi, beforeEach } from "vitest";

const validateLocalOrigin = vi.fn(() => true);
vi.mock("@/lib/local-files/security", () => ({
  validateLocalOrigin: () => validateLocalOrigin(),
}));

import { POST } from "@/app/api/query/attach/route";
import { GET } from "@/app/api/query/active/route";
import {
  openRunChannel,
  publishRunLine,
  closeRunChannel,
  setRunChannelMeta,
  __resetRunStreamHubForTests,
} from "@/lib/pipeline/run-stream-hub";

beforeEach(() => {
  __resetRunStreamHubForTests();
  validateLocalOrigin.mockReturnValue(true);
});

function attachReq(body: unknown): Request {
  return new Request("http://localhost/api/query/attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe("/api/query/active (discovery)", () => {
  it("rejects a non-local origin", () => {
    validateLocalOrigin.mockReturnValue(false);
    const res = GET(new Request("http://localhost/api/query/active"));
    expect(res.status).toBe(403);
  });

  it("finds the active run for a source", async () => {
    openRunChannel("r1", { route: "/api/query" });
    setRunChannelMeta("r1", { csvId: "csv-9", question: "which building is farthest" });
    const res = GET(new Request("http://localhost/api/query/active?csvId=csv-9"));
    const json = await res.json();
    expect(json.run.runId).toBe("r1");
    expect(json.run.question).toBe("which building is farthest");
  });

  it("returns null when the source has no active run", async () => {
    const res = GET(new Request("http://localhost/api/query/active?csvId=none"));
    expect((await res.json()).run).toBeNull();
  });

  it("lists all active runs without a csvId filter", async () => {
    openRunChannel("r1", { route: "/api/query" });
    openRunChannel("r2", { route: "/api/query/investigate" });
    const res = GET(new Request("http://localhost/api/query/active"));
    const json = await res.json();
    expect(json.runs.map((r: { runId: string }) => r.runId).sort()).toEqual(["r1", "r2"]);
  });
});

describe("/api/query/attach (reattach stream)", () => {
  it("rejects a non-local origin", async () => {
    validateLocalOrigin.mockReturnValue(false);
    const res = await POST(attachReq({ context: { runId: "r1" } }));
    expect(res.status).toBe(403);
  });

  it("400s without a runId", async () => {
    const res = await POST(attachReq({ context: {} }));
    expect(res.status).toBe(400);
  });

  it("404s for an unknown run (client then falls back to history)", async () => {
    const res = await POST(attachReq({ context: { runId: "ghost" } }));
    expect(res.status).toBe(404);
  });

  it("replays the buffer, streams live lines, then closes when the run ends", async () => {
    openRunChannel("r1", { route: "/api/query" });
    publishRunLine("r1", '{"op":"add","path":"/state"}\n');
    publishRunLine("r1", '{"op":"replace","path":"/state/__progress"}\n');

    const res = await POST(attachReq({ context: { runId: "r1" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("ndjson");

    // Live lines emitted while attached, then the run ends → readAll resolves.
    publishRunLine("r1", '{"op":"add","path":"/root"}\n');
    closeRunChannel("r1");

    const body = await readAll(res);
    expect(body).toContain('"path":"/state"'); // replayed
    expect(body).toContain('"path":"/state/__progress"'); // replayed
    expect(body).toContain('"path":"/root"'); // live
  });

  it("reads the accepts-runId-at-top-level shape too", async () => {
    openRunChannel("r2", { route: "/api/query" });
    publishRunLine("r2", "line\n");
    closeRunChannel("r2");
    const res = await POST(attachReq({ runId: "r2" }));
    expect(res.status).toBe(200);
    expect(await readAll(res)).toContain("line");
  });
});
