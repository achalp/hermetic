/**
 * Orphan sweeper (finding M7): reapOrphanContainers now also reaps leaked
 * egress gateways (hermetic-egress-gw-*) by the same age rule and removes
 * orphaned egress networks (hermetic-egress-*) — correlating both to live runs
 * by the analysis-container id suffix so a long remote scan keeps its egress.
 *
 * execFile is stubbed so the docker command sequences are asserted directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rms: string[] = [];
const networkRms: string[] = [];

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, args: string[], cb: (err: unknown, stdout: string) => void) => {
    const a = args.join(" ");
    if (a.includes("ps") && a.includes("name=hermetic-egress-gw-")) {
      return cb(null, "hermetic-egress-gw-aaaaaaaaaaaa\nhermetic-egress-gw-bbbbbbbbbbbb\n");
    }
    if (a.includes("ps") && a.includes("name=hermetic-sandbox-")) {
      return cb(null, "hermetic-sandbox-aaaaaaaaaaaa\nhermetic-sandbox-orphan999\n");
    }
    if (a.includes("inspect")) return cb(null, "2000-01-01T00:00:00Z\n"); // old → reapable
    if (a.startsWith("network ls")) {
      return cb(null, "hermetic-egress-aaaaaaaaaaaa\nhermetic-egress-cccccccccccc\n");
    }
    if (a.startsWith("network rm")) {
      networkRms.push(args[2]);
      return cb(null, "");
    }
    if (a.startsWith("rm -f")) {
      rms.push(args[2]);
      return cb(null, "");
    }
    return cb(null, "");
  }),
}));

import { reapOrphanContainers } from "@/lib/sandbox/lifecycle";

beforeEach(() => {
  rms.length = 0;
  networkRms.length = 0;
});

describe("reapOrphanContainers — egress infra sweep", () => {
  it("reaps orphan gateways + networks by suffix, sparing live runs", async () => {
    // The live run's analysis container id ends in "aaaaaaaaaaaa"; its gateway
    // and network share that suffix and must be SPARED.
    const active = new Set(["hermetic-sandbox-aaaaaaaaaaaa"]);
    const reaped = await reapOrphanContainers(active);

    // Orphan sandbox container + orphan gateway both removed.
    expect(rms).toContain("hermetic-sandbox-orphan999");
    expect(rms).toContain("hermetic-egress-gw-bbbbbbbbbbbb");
    // Live run's own container + gateway spared.
    expect(rms).not.toContain("hermetic-sandbox-aaaaaaaaaaaa");
    expect(rms).not.toContain("hermetic-egress-gw-aaaaaaaaaaaa");

    // Orphan network removed, live-suffix network spared.
    expect(networkRms).toContain("hermetic-egress-cccccccccccc");
    expect(networkRms).not.toContain("hermetic-egress-aaaaaaaaaaaa");

    // Count = orphan sandbox + orphan gateway.
    expect(reaped).toBe(2);
  });
});
