/**
 * `latest.json` — the update manifest installed apps poll (build log D42).
 *
 * Tauri's updater fetches this from the GitHub *latest* release, picks the entry
 * matching its own platform key, downloads that URL, and verifies the signature
 * against the pubkey compiled into the app. So this file is the join between a
 * release's assets and every installed copy: a wrong URL is a dead update, and a
 * signature copied from the WRONG bundle is a verification failure on the user's
 * machine. Both are cheap to get wrong by hand, which is why this is code with
 * tests rather than a shell heredoc in the workflow.
 *
 * PURE on purpose (no fs, no network): the workflow reads the bundle dir and
 * hands the filenames + signature blobs in, so every mapping decision below is
 * unit-testable.
 */

/** Tauri's platform keys. Only the targets we actually publish are listed. */
export type UpdaterPlatform =
  "linux-x86_64" | "darwin-x86_64" | "darwin-aarch64" | "windows-x86_64";

export interface UpdaterBundle {
  /** Release asset filename, e.g. `Hermetic_0.2.0_amd64.AppImage`. */
  fileName: string;
  /** Contents of the sibling `.sig` file (minisign, base64). */
  signature: string;
  /** Explicit platform; inferred from the filename when omitted. */
  platform?: UpdaterPlatform;
}

export interface UpdaterManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
}

/**
 * Infer the platform key from a bundle filename.
 *
 * Only formats Tauri can actually SELF-UPDATE are recognized: the Linux
 * AppImage (a .deb/.rpm install updates through the package manager, so
 * offering it here would hand users a download that cannot apply), macOS
 * `.app.tar.gz`, and the Windows NSIS/MSI installers. Anything else returns
 * null and the caller skips it.
 */
export function platformForBundle(fileName: string): UpdaterPlatform | null {
  const f = fileName.toLowerCase();
  if (f.endsWith(".appimage")) return "linux-x86_64";
  if (f.endsWith(".app.tar.gz")) {
    return f.includes("aarch64") || f.includes("arm64") ? "darwin-aarch64" : "darwin-x86_64";
  }
  if (f.endsWith("-setup.exe") || f.endsWith(".msi")) return "windows-x86_64";
  return null;
}

export interface BuildManifestArgs {
  /** Release tag, e.g. `v0.2.0` (the asset URLs are built from it). */
  tag: string;
  /** `owner/repo`. */
  repo: string;
  /** ISO-8601 publication timestamp. */
  pubDate: string;
  bundles: UpdaterBundle[];
  notes?: string;
}

/**
 * Build the manifest. Throws when it would produce something an installed app
 * cannot use — an empty platform set, a blank signature, or two bundles
 * claiming the same platform (which would silently pick one at random).
 */
export function buildUpdaterManifest(args: BuildManifestArgs): UpdaterManifest {
  const version = args.tag.replace(/^v/, "");
  const platforms: UpdaterManifest["platforms"] = {};

  for (const b of args.bundles) {
    const platform = b.platform ?? platformForBundle(b.fileName);
    if (!platform) continue; // not a self-updatable artifact (.deb/.rpm/…)
    const signature = b.signature.trim();
    if (!signature) {
      throw new Error(`Empty signature for ${b.fileName} — refusing to publish an unusable update`);
    }
    if (platforms[platform]) {
      throw new Error(
        `Two bundles claim platform ${platform} (${b.fileName}) — the manifest would be ambiguous`
      );
    }
    platforms[platform] = {
      signature,
      // GitHub serves release assets under /releases/download/<tag>/<name>.
      url: `https://github.com/${args.repo}/releases/download/${args.tag}/${encodeURIComponent(
        b.fileName
      )}`,
    };
  }

  if (Object.keys(platforms).length === 0) {
    throw new Error(
      "No self-updatable bundles found — latest.json would strand every installed app"
    );
  }
  return {
    version,
    notes: args.notes ?? `Hermetic ${version}`,
    pub_date: args.pubDate,
    platforms,
  };
}
