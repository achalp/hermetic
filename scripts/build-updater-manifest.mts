/**
 * Emit `latest.json` for a release from the bundles on disk (build log D42).
 *
 * Run AFTER `scripts/build-desktop.mjs` on a machine whose Tauri build was
 * signed (TAURI_SIGNING_PRIVATE_KEY set), so each self-updatable bundle has a
 * sibling `.sig`. The mapping/validation rules live in
 * `src/lib/release/updater-manifest.ts` — unit-tested, because every mistake
 * here surfaces on a user's machine rather than in CI.
 *
 *   tsx scripts/build-updater-manifest.mts <tag> [outFile]
 *
 * `repo` comes from GITHUB_REPOSITORY (CI) or the `origin` remote (local).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  buildUpdaterManifest,
  platformForBundle,
  type UpdaterBundle,
} from "@/lib/release/updater-manifest";

const ROOT = resolve(import.meta.dirname, "..");
const BUNDLE_DIR = join(ROOT, "src-tauri", "target", "release", "bundle");

const tag = process.argv[2];
if (!tag) {
  console.error("usage: tsx scripts/build-updater-manifest.mts <tag> [outFile]");
  process.exit(64);
}
const outFile = process.argv[3] ?? join(ROOT, "latest.json");

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

const files = await bundleFiles();
const bundles: UpdaterBundle[] = [];
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
  bundles.push({ fileName: f.name, signature: await readFile(sig.path, "utf8") });
}

const manifest = buildUpdaterManifest({
  tag,
  repo: repoSlug(),
  pubDate: new Date().toISOString(),
  bundles,
});
await writeFile(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[updater] ${outFile}: ${Object.keys(manifest.platforms).join(", ")}`);
