import { describe, it, expect } from "vitest";
import { createInputRegistry } from "@/lib/sandbox/wasm/input-registry";

function seq() {
  let n = 0;
  return () => `tok-${n++}`;
}

describe("createInputRegistry", () => {
  it("register → resolve returns the host path; unknown token → undefined", () => {
    const reg = createInputRegistry(seq());
    const token = reg.register({ hostPath: "/tmp/a.parquet", runId: "r1" });
    expect(token).toBe("tok-0");
    expect(reg.resolve(token)).toBe("/tmp/a.parquet");
    expect(reg.resolve("nope")).toBeUndefined();
    expect(reg.size()).toBe(1);
  });

  it("release removes a single token", () => {
    const reg = createInputRegistry(seq());
    const t = reg.register({ hostPath: "/tmp/a" });
    expect(reg.release(t)).toBe(true);
    expect(reg.resolve(t)).toBeUndefined();
    expect(reg.release(t)).toBe(false); // already gone
  });

  it("releaseRun drops exactly the run's tokens", () => {
    const reg = createInputRegistry(seq());
    reg.register({ hostPath: "/a", runId: "r1" });
    reg.register({ hostPath: "/b", runId: "r1" });
    const keep = reg.register({ hostPath: "/c", runId: "r2" });
    expect(reg.releaseRun("r1")).toBe(2);
    expect(reg.size()).toBe(1);
    expect(reg.resolve(keep)).toBe("/c");
    expect(reg.releaseRun("r-none")).toBe(0);
  });
});
