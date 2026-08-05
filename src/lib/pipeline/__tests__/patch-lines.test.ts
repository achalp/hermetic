import { describe, it, expect } from "vitest";
import { parsePatchLines, readRunError } from "@/lib/pipeline/patch-lines";

describe("parsePatchLines", () => {
  it("skips keepalives, blanks, and non-JSON noise; splits multi-line chunks", () => {
    const patches = parsePatchLines([
      ": keepalive\n",
      "\n",
      "not-json\n",
      // One chunk carrying two lines — the MCP sink receives whole emit
      // chunks, not pre-split lines.
      '{"op":"add","path":"/root","value":"main"}\n{"op":"add","path":"/state/__cost","value":{}}\n',
    ]);
    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ op: "add", path: "/root", value: "main" });
    expect(patches[1].path).toBe("/state/__cost");
  });
});

describe("readRunError", () => {
  it("returns the /state/__error message", () => {
    const patches = parsePatchLines([
      '{"op":"add","path":"/state/__error","value":"SQL execution failed: boom"}\n',
      '{"op":"add","path":"/root","value":"error"}\n',
    ]);
    expect(readRunError(patches)).toBe("SQL execution failed: boom");
  });

  it('reports a bare root="error" spec as a failure (producer-drift guard)', () => {
    const patches = parsePatchLines(['{"op":"add","path":"/root","value":"error"}\n']);
    expect(readRunError(patches)).toContain("no error detail");
  });

  it("returns null for a clean run", () => {
    const patches = parsePatchLines([
      '{"op":"add","path":"/root","value":"main"}\n',
      '{"op":"add","path":"/state/__cost","value":{"costUsd":0.1}}\n',
    ]);
    expect(readRunError(patches)).toBeNull();
  });
});
