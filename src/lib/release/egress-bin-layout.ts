/**
 * The vendored `egress-fetch` binary layout inside distributable bundles
 * (.mcpb today; any future archive that carries per-platform bins).
 *
 * One module answers "where does the bin for THIS platform live?" for all
 * three consumers — the bundle builder (scripts/build-mcpb.mjs), the runtime
 * entry that pins HERMETIC_EGRESS_FETCH_BIN (src/mcp/mcpb-main.ts), and the
 * smoke test — so the layout cannot drift between the writer and the readers.
 *
 * Naming uses Node's own platform/arch identifiers (process.platform +
 * process.arch), NOT Rust target triples: every consumer is Node, and each CI
 * leg builds natively so the triple never needs to be spelled out.
 */

/** The platforms a release vendors — mirrors the CI egress-bins matrix. */
export const EGRESS_BIN_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
] as const;

export type EgressBinPlatform = (typeof EGRESS_BIN_PLATFORMS)[number];

/** `linux` + `x64` → `linux-x64`; unknown combinations → null (fail closed). */
export function egressBinPlatform(platform: string, arch: string): EgressBinPlatform | null {
  const id = `${platform}-${arch}`;
  return (EGRESS_BIN_PLATFORMS as readonly string[]).includes(id)
    ? (id as EgressBinPlatform)
    : null;
}

/** The binary's filename for a platform id (`.exe` on Windows). */
export function egressBinFilename(id: EgressBinPlatform): string {
  return id.startsWith("win32") ? "egress-fetch.exe" : "egress-fetch";
}

/**
 * Bundle-relative path of the vendored binary for a platform/arch pair, or
 * null when that pair is not vendored. POSIX separators on purpose — the
 * consumer joins it onto its root with its own path module.
 */
export function bundledEgressBinRelPath(platform: string, arch: string): string | null {
  const id = egressBinPlatform(platform, arch);
  return id ? `bin/${id}/${egressBinFilename(id)}` : null;
}
