/**
 * executeSandbox dispatch: the network="deny" policy (MCP M4).
 * Deny is only enforceable on Docker (--network none); other runtimes are
 * REJECTED rather than silently degraded, and the ephemeral-with-network
 * branch must never fire under deny.
 */
import { describe, it, expect } from "vitest";
import { executeSandbox } from "@/lib/sandbox";

describe("executeSandbox network policy", () => {
  it("rejects deny on non-docker runtimes without executing", async () => {
    const result = await executeSandbox("a\n1\n", "results['x']=1", {
      runtime: "microsandbox",
      network: "deny",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("network='deny'");
      expect(result.error).toContain("Docker");
    }
  });
});
