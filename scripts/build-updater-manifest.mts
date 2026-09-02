/**
 * Emit `latest.json` for a release (build log D42).
 *
 * Two modes:
 *   tsx scripts/build-updater-manifest.mts <tag> [outFile]                — from
 *     the bundles ON DISK, after `scripts/build-desktop.mjs` on a machine whose
 *     Tauri build was signed (TAURI_SIGNING_PRIVATE_KEY set), so each
 *     self-updatable bundle has a sibling `.sig`. Single-platform by nature.
 *   tsx scripts/build-updater-manifest.mts <tag> [outFile] --from-release — from
 *     the RELEASE'S UPLOADED ASSETS (via `gh`; needs GH_TOKEN in CI). This is
 *     what the updater-manifest job runs after every desktop matrix leg: it is
 *     the only way to get ALL platforms into one manifest, and every URL the
 *     manifest names is an asset that provably exists.
 *
 * The mapping/validation rules live in `src/lib/release/updater-manifest.ts` —
 * unit-tested, because every mistake here surfaces on a user's machine rather
 * than in CI.
 *
 * `repo` comes from GITHUB_REPOSITORY (CI) or the `origin` remote (local).
 */
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSON5 from "json5";
import {
  buildUpdaterManifest,
  platformForBundle,
  type UpdaterBundle,
} from "@/lib/release/updater-manifest";

const ROOT = resolve(import.meta.dirname, "..");
const BUNDLE_DIR = join(ROOT, "src-tauri", "target", "release", "bundle");

const fromRelease = process.argv.includes("--from-release");
const args = process.argv.slice(2).filter((a) => a !== "--from-release");
const tag = args[0];
if (!tag) {
  console.error("usage: tsx scripts/build-updater-manifest.mts <tag> [outFile] [--from-release]");
  process.exit(64);
}
const outFile = args[1] ?? join(ROOT, "latest.json");

function repoSlug(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT }).toString().trim();
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`cannot derive owner/repo from origin: ${url}`);
  return m[1]!;
}

/** Every file under the bundle dir, one level into each target subdir. */
async function bundleFiles(): Promise<{ name: string; path: string }[]> {
  const out: { name: string; path: string }[] = [];
  for (const dir of await readdir(BUNDLE_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sub = join(BUNDLE_DIR, dir.name);
    for (const f of await readdir(sub, { withFileTypes: true })) {
      if (f.isFile()) out.push({ name: f.name, path: join(sub, f.name) });
    }
  }
  return out;
}

/** Bundles + signatures from the local bundle dir (single-platform build host). */
async function localBundles(): Promise<UpdaterBundle[]> {
  const files = await bundleFiles();
  const out: UpdaterBundle[] = [];
  for (const f of files) {
    if (f.name.endsWith(".sig")) continue;
    if (!platformForBundle(f.name)) continue;
    const sig = files.find((s) => s.name === `${f.name}.sig`);
    if (!sig) {
      // Loud, not skipped: an unsigned updatable bundle means signing did not run
      // (no key in the env), and a release missing its platform is a silent
      // "no updates available" for everyone on it.
      throw new Error(`No ${f.name}.sig — was TAURI_SIGNING_PRIVATE_KEY set for the build?`);
    }
    out.push({ fileName: f.name, signature: await readFile(sig.path, "utf8") });
  }
  return out;
}

/**
 * Bundles + signatures from the release's UPLOADED assets: the union of what
 * every desktop matrix leg actually published. A leg that failed simply isn't
 * represented (its platform drops from the manifest — visible as a red leg in
 * the run, not a broken updater), but an updatable asset that uploaded WITHOUT
 * its .sig still fails loudly: that means signing didn't run for that build.
 */
async function releaseBundles(): Promise<UpdaterBundle[]> {
  const view = execFileSync("gh", ["release", "view", tag, "--json", "assets"], {
    cwd: ROOT,
  }).toString();
  const names = new Set(
    (JSON.parse(view) as { assets: { name: string }[] }).assets.map((a) => a.name)
  );
  const sigDir = await mkdtemp(join(tmpdir(), "hermetic-sigs-"));
  const out: UpdaterBundle[] = [];
  for (const name of names) {
    if (name.endsWith(".sig")) continue;
    if (!platformForBundle(name)) continue; // .deb/.rpm/.mcpb/.sha256/latest.json…
    if (!names.has(`${name}.sig`)) {
      throw new Error(
        `No ${name}.sig on release ${tag} — was TAURI_SIGNING_PRIVATE_KEY set for that leg's build?`
      );
    }
    execFileSync("gh", ["release", "download", tag, "-p", `${name}.sig`, "-D", sigDir], {
      cwd: ROOT,
      stdio: "inherit",
    });
    out.push({ fileName: name, signature: await readFile(join(sigDir, `${name}.sig`), "utf8") });
  }
  return out;
}

const bundles = fromRelease ? await releaseBundles() : await localBundles();

/** The version the built app reports — Tauri compiles this into the binary. */
async function appVersion(): Promise<string> {
  const conf = JSON5.parse(await readFile(join(ROOT, "src-tauri", "tauri.conf.json5"), "utf8")) as {
    version?: string;
  };
  if (!conf.version) throw new Error("tauri.conf.json5 has no version");
  return conf.version;
}

const manifest = buildUpdaterManifest({
  tag,
  repo: repoSlug(),
  pubDate: new Date().toISOString(),
  bundles,
  // Guards the update loop: a tag that disagrees with the built app's version
  // publishes an update every install re-applies forever. Fails the release
  // job instead.
  appVersion: await appVersion(),
});
await writeFile(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[updater] ${outFile}: ${Object.keys(manifest.platforms).join(", ")}`);
