import { describe, it, expect } from "vitest";
import {
  EGRESS_BIN_PLATFORMS,
  egressBinPlatform,
  egressBinFilename,
  bundledEgressBinRelPath,
} from "@/lib/release/egress-bin-layout";

/**
 * The layout is written by build-mcpb and read by mcpb-main + the smoke —
 * these pin the mapping so writer and readers cannot drift.
 */
describe("egress bin layout", () => {
  it("maps every vendored platform to its bundle path", () => {
    expect(bundledEgressBinRelPath("linux", "x64")).toBe("bin/linux-x64/egress-fetch");
    expect(bundledEgressBinRelPath("linux", "arm64")).toBe("bin/linux-arm64/egress-fetch");
    expect(bundledEgressBinRelPath("darwin", "x64")).toBe("bin/darwin-x64/egress-fetch");
    expect(bundledEgressBinRelPath("darwin", "arm64")).toBe("bin/darwin-arm64/egress-fetch");
    // Windows carries the .exe suffix — spawn() needs the real filename.
    expect(bundledEgressBinRelPath("win32", "x64")).toBe("bin/win32-x64/egress-fetch.exe");
  });

  it("returns null for anything not vendored — resolution fails CLOSED", () => {
    expect(bundledEgressBinRelPath("win32", "arm64")).toBeNull();
    expect(bundledEgressBinRelPath("freebsd", "x64")).toBeNull();
    expect(bundledEgressBinRelPath("linux", "ia32")).toBeNull();
    expect(egressBinPlatform("darwin", "ppc64")).toBeNull();
  });

  it("filename and platform list stay consistent", () => {
    for (const id of EGRESS_BIN_PLATFORMS) {
      const name = egressBinFilename(id);
      expect(name.startsWith("egress-fetch")).toBe(true);
      expect(name.endsWith(".exe")).toBe(id.startsWith("win32"));
    }
    // The CI matrix builds exactly these five — a sixth entry here without a
    // matrix leg would vendor nothing and strand that platform.
    expect(EGRESS_BIN_PLATFORMS).toHaveLength(5);
  });
});
