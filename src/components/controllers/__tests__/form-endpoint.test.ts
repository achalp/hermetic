import { describe, it, expect } from "vitest";
import { safeFormEndpoint } from "../form-controller";

describe("safeFormEndpoint (spec-authored submit target, F3)", () => {
  it("accepts /api/-relative paths and preserves query strings", () => {
    expect(safeFormEndpoint("/api/feedback")).toBe("/api/feedback");
    expect(safeFormEndpoint("/api/saved/vizs?draft=1")).toBe("/api/saved/vizs?draft=1");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(safeFormEndpoint("https://evil.example/api/x")).toBeNull();
    expect(safeFormEndpoint("http://localhost:3000/api/x")).toBeNull();
    expect(safeFormEndpoint("//evil.example/api/x")).toBeNull();
    expect(safeFormEndpoint("ftp://evil.example/api/x")).toBeNull();
  });

  it("rejects non-/api/ paths", () => {
    expect(safeFormEndpoint("/admin/reset")).toBeNull();
    // Bare-relative is normalized to root-relative — the fetch uses the
    // RETURNED path, so page-URL-dependent resolution can't occur.
    expect(safeFormEndpoint("api/feedback")).toBe("/api/feedback");
    expect(safeFormEndpoint("/")).toBeNull();
    expect(safeFormEndpoint("")).toBeNull();
  });

  it("normalizes traversal out of /api/ and rejects it", () => {
    expect(safeFormEndpoint("/api/../admin/reset")).toBeNull();
    expect(safeFormEndpoint("/api/x/../../admin")).toBeNull();
    expect(safeFormEndpoint("/api/%2e%2e/admin")).toBeNull();
  });

  it("keeps traversal that stays under /api/", () => {
    expect(safeFormEndpoint("/api/a/../feedback")).toBe("/api/feedback");
  });
});
