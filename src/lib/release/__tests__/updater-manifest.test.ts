import { describe, it, expect } from "vitest";
import { buildUpdaterManifest, platformForBundle } from "@/lib/release/updater-manifest";

/**
 * latest.json is the join between a release's assets and every installed app
 * (build log D42). The failure modes are all silent-at-build-time and loud on a
 * user's machine — wrong URL, mismatched signature, a platform pointing at a
 * bundle that cannot self-update — so they are pinned here.
 */

const SIG = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpSV1Er";

describe("platformForBundle", () => {
  it("maps only SELF-UPDATABLE artifacts", () => {
    expect(platformForBundle("Hermetic_0.2.0_amd64.AppImage")).toBe("linux-x86_64");
    expect(platformForBundle("Hermetic.app.tar.gz")).toBe("darwin-x86_64");
    expect(platformForBundle("Hermetic_aarch64.app.tar.gz")).toBe("darwin-aarch64");
    expect(platformForBundle("Hermetic_0.2.0_x64-setup.exe")).toBe("windows-x86_64");
    expect(platformForBundle("Hermetic_0.2.0_x64_en-US.msi")).toBe("windows-x86_64");
  });

  it("REFUSES deb/rpm — those update via the package manager, not the updater", () => {
    // Listing them would hand an installed app a download it cannot apply.
    expect(platformForBundle("Hermetic_0.2.0_amd64.deb")).toBeNull();
    expect(platformForBundle("Hermetic-0.2.0-1.x86_64.rpm")).toBeNull();
    expect(platformForBundle("checksums.txt")).toBeNull();
  });
});

describe("buildUpdaterManifest", () => {
  const base = {
    tag: "v0.2.0",
    repo: "achalp/hermetic",
    pubDate: "2026-09-01T00:00:00Z",
  };

  it("builds version, per-platform URL and signature from the release assets", () => {
    const m = buildUpdaterManifest({
      ...base,
      bundles: [
        { fileName: "Hermetic_0.2.0_amd64.AppImage", signature: SIG },
        { fileName: "Hermetic_0.2.0_amd64.deb", signature: "ignored" },
      ],
    });
    expect(m.version).toBe("0.2.0"); // the leading v is stripped — apps compare semver
    expect(m.pub_date).toBe("2026-09-01T00:00:00Z");
    expect(Object.keys(m.platforms)).toEqual(["linux-x86_64"]);
    expect(m.platforms["linux-x86_64"]).toEqual({
      signature: SIG,
      url: "https://github.com/achalp/hermetic/releases/download/v0.2.0/Hermetic_0.2.0_amd64.AppImage",
    });
  });

  it("percent-encodes a filename with spaces so the download URL resolves", () => {
    const m = buildUpdaterManifest({
      ...base,
      bundles: [{ fileName: "Hermetic Desktop_0.2.0_amd64.AppImage", signature: SIG }],
    });
    expect(m.platforms["linux-x86_64"]!.url).toContain("Hermetic%20Desktop_0.2.0_amd64.AppImage");
  });

  it("trims the signature file's trailing newline", () => {
    const m = buildUpdaterManifest({
      ...base,
      bundles: [{ fileName: "x.AppImage", signature: `${SIG}\n` }],
    });
    expect(m.platforms["linux-x86_64"]!.signature).toBe(SIG);
  });

  it("THROWS on an empty signature rather than publishing an unusable update", () => {
    // An empty .sig means signing silently didn't run (no key in the env) —
    // every installed app would fail verification and stop updating.
    expect(() =>
      buildUpdaterManifest({ ...base, bundles: [{ fileName: "x.AppImage", signature: "  " }] })
    ).toThrow(/Empty signature/);
  });

  it("THROWS when two bundles claim one platform — never pick one at random", () => {
    expect(() =>
      buildUpdaterManifest({
        ...base,
        bundles: [
          { fileName: "a.AppImage", signature: SIG },
          { fileName: "b.AppImage", signature: SIG },
        ],
      })
    ).toThrow(/ambiguous/);
  });

  it("THROWS when nothing is self-updatable — an empty manifest strands installs", () => {
    expect(() =>
      buildUpdaterManifest({
        ...base,
        bundles: [{ fileName: "Hermetic_0.2.0_amd64.deb", signature: SIG }],
      })
    ).toThrow(/strand/);
  });

  it("THROWS when the tag and the BUILT APP version disagree (the update loop)", () => {
    // The app compares the manifest version against its own (from
    // tauri.conf.json5). Tag 0.2.0 + app built as 0.1.0 = the update installs,
    // still reports 0.1.0, and re-downloads itself on every launch forever.
    // Nothing else catches this: build, signature and install all succeed.
    expect(() =>
      buildUpdaterManifest({
        ...base,
        appVersion: "0.1.0",
        bundles: [{ fileName: "x.AppImage", signature: SIG }],
      })
    ).toThrow(/Version mismatch: tag says 0\.2\.0, the app is built as 0\.1\.0/);
  });

  it("accepts a matching app version, and stays optional for callers without one", () => {
    const matched = buildUpdaterManifest({
      ...base,
      appVersion: "0.2.0",
      bundles: [{ fileName: "x.AppImage", signature: SIG }],
    });
    expect(matched.version).toBe("0.2.0");
    // Omitted → no check (the pure builder stays usable without a config read).
    expect(
      buildUpdaterManifest({ ...base, bundles: [{ fileName: "x.AppImage", signature: SIG }] })
        .version
    ).toBe("0.2.0");
  });

  it("accepts an explicit platform for a filename the inference cannot classify", () => {
    const m = buildUpdaterManifest({
      ...base,
      bundles: [{ fileName: "custom-bundle.bin", signature: SIG, platform: "windows-x86_64" }],
    });
    expect(Object.keys(m.platforms)).toEqual(["windows-x86_64"]);
  });
});
