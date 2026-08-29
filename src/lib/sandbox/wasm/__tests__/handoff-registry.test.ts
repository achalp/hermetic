import { describe, it, expect } from "vitest";
import { createHandoffRegistry } from "@/lib/sandbox/wasm/handoff-registry";

// Deterministic ids for the tests.
function seq() {
  let n = 0;
  return () => `id-${n++}`;
}

describe("createHandoffRegistry", () => {
  it("create() yields a unique id + a promise resolved by resolve(id, envelope)", async () => {
    const reg = createHandoffRegistry(seq());
    const h = reg.create();
    expect(h.id).toBe("id-0");
    expect(reg.size()).toBe(1);

    const env = { exitCode: 0, output: { results: { n: 1 } } };
    expect(reg.resolve(h.id, env)).toBe(true);
    await expect(h.promise).resolves.toEqual(env);
    expect(reg.size()).toBe(0); // settled → removed
  });

  it("reject(id, reason) rejects the promise and clears the entry", async () => {
    const reg = createHandoffRegistry(seq());
    const h = reg.create();
    expect(reg.reject(h.id, "webview closed")).toBe(true);
    await expect(h.promise).rejects.toThrow(/webview closed/);
    expect(reg.size()).toBe(0);
  });

  it("resolve/reject on an unknown or already-settled id returns false", async () => {
    const reg = createHandoffRegistry(seq());
    expect(reg.resolve("nope", { exitCode: 0, output: {} })).toBe(false);
    expect(reg.reject("nope", "x")).toBe(false);

    const h = reg.create();
    reg.resolve(h.id, { exitCode: 0, output: {} });
    await h.promise;
    // second settle is a no-op
    expect(reg.resolve(h.id, { exitCode: 1, output: {} })).toBe(false);
    expect(reg.reject(h.id, "late")).toBe(false);
  });

  it("tracks multiple concurrent pending handoffs independently", async () => {
    const reg = createHandoffRegistry(seq());
    const a = reg.create();
    const b = reg.create();
    expect(reg.size()).toBe(2);
    reg.resolve(b.id, { exitCode: 0, output: "B" });
    await expect(b.promise).resolves.toMatchObject({ output: "B" });
    expect(reg.size()).toBe(1); // a still pending
    reg.reject(a.id, "cancel");
    await expect(a.promise).rejects.toThrow(/cancel/);
    expect(reg.size()).toBe(0);
  });
});
