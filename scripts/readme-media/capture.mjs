#!/usr/bin/env node
// README media capture: regenerates the docs/*.png screenshots the README
// shows and the "flow reel" (docs/flow-reel.gif + .mp4) — upload → ask →
// dashboard → Verify/audit → export — by driving the real UI with Playwright.
//
// Run (from the repo root, after `pnpm build` AND `pnpm mcp:build-viewer` —
// the reel's "Interactive HTML" export needs the viewer bundles; Docker + the
// hermetic-sandbox image must be available, and an LLM provider configured —
// see below):
//
//   node scripts/readme-media/capture.mjs            # stills + reel
//   node scripts/readme-media/capture.mjs stills     # screenshots only
//   node scripts/readme-media/capture.mjs reel       # reel only
//
// What it does:
// - Starts its OWN production server (`pnpm start`, port 3077) with every
//   storage root under data/readme-media/ (gitignored), so captures never show
//   your real history, recents or connections, and never write to them. The
//   state roots are wiped at the start of every run; the LLM fixtures are not.
// - The server runs with HERMETIC_LLM_MODE=record (record-if-miss) and
//   HERMETIC_LLM_FIXTURES=data/readme-media/llm: the first run calls the LLM
//   live and caches every response; later runs replay whatever still hashes
//   the same, so re-captures are fast and cost cents (the narrative and audit
//   prompts are not byte-stable across runs, so those calls usually go live).
// - Provider: README_MEDIA_PROVIDER (default "claude-cli" — your Claude
//   subscription via the `claude` binary; "anthropic" uses ANTHROPIC_API_KEY
//   or the keychain); model README_MEDIA_MODEL (default claude-sonnet-5, for
//   both code generation and composition). Expect ~3–5 minutes per
//   question on a cold cache, a few seconds warm.
// - Dataset: public/sample-data/sales-data.csv (the bundled synthetic demo).
// - Point at an already-running server instead with README_MEDIA_BASE_URL
//   (its own data/roots are then used — not recommended).
//
// Output: docs/{home,ask-suggestions,dashboard,artifacts,data-explorer,
// settings,saved-vizs}.png (1440×900 viewport @2x) and docs/flow-reel.{gif,mp4}
// (1280×800 frames scaled to 880 px wide). Needs ffmpeg on PATH. Frames and
// the exported HTML land in data/readme-media/frames (gitignored).
//
// Look at every output before committing: the dashboard text comes from a
// live model and can change between runs.

import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORK = join(ROOT, "data", "readme-media");
const DOCS = join(ROOT, "docs");
const FRAMES = join(WORK, "frames");
const PORT = 3077;
const BASE = process.env.README_MEDIA_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const CSV = join(ROOT, "public", "sample-data", "sales-data.csv");
const MODE = process.argv[2] ?? "all";
const MODEL = process.env.README_MEDIA_MODEL ?? "claude-sonnet-5";

const Q_MAIN = "Which channels and customer segments bring in the most revenue?";
const Q_EXTRA = [
  "Break down revenue by region.",
  "How is revenue trending by region, and which products drive it?",
];

const log = (...a) => console.log(`[readme-media]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── server ──────────────────────────────────────────────────────────────────

function resetState() {
  for (const d of ["data", "user", "scratch", "frames"]) {
    rmSync(join(WORK, d), { recursive: true, force: true });
    mkdirSync(join(WORK, d), { recursive: true });
  }
  mkdirSync(join(WORK, "llm"), { recursive: true });
  writeFileSync(
    join(WORK, "data", "runtime-config.json"),
    JSON.stringify(
      {
        activeProvider: process.env.README_MEDIA_PROVIDER ?? "claude-cli",
        // Pinned (not the repo default) so the cached fixtures keep hitting.
        models: { codeGen: MODEL, uiCompose: MODEL },
        composer: { mode: "compiled" },
        sandboxRuntime: "docker",
      },
      null,
      2
    )
  );
}

async function startServer() {
  if (process.env.README_MEDIA_BASE_URL) return null;
  if (!existsSync(join(ROOT, ".next", "BUILD_ID"))) {
    throw new Error("no production build — run `pnpm build` first");
  }
  if (!existsSync(join(ROOT, "src", "mcp", "viewer", "dist", "export-manifest.json"))) {
    throw new Error("no viewer export bundles — run `pnpm mcp:build-viewer` first");
  }
  resetState();
  preexisting = warmContainers();
  const logFile = join(WORK, "server.log");
  const out = [];
  const child = spawn("pnpm", ["start"], {
    cwd: ROOT,
    detached: true, // own process group: next start's children die with it
    env: {
      ...process.env,
      PORT: String(PORT),
      HERMETIC_DATA_ROOT: join(WORK, "data"),
      HERMETIC_USER_ROOT: join(WORK, "user"),
      // Under $HOME, not /tmp: snap Docker cannot see /tmp bind mounts.
      HERMETIC_SCRATCH_ROOT: join(WORK, "scratch"),
      HERMETIC_LLM_MODE: "record",
      HERMETIC_LLM_FIXTURES: join(WORK, "llm"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sink = (b) => {
    out.push(b);
    writeFileSync(logFile, Buffer.concat(out));
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/providers`);
      if (r.ok) {
        log(`server up (log: ${logFile})`);
        return child;
      }
    } catch {
      /* not yet */
    }
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  await stopServer(child);
  throw new Error(`server did not start — see ${logFile}`);
}

const warmContainers = () =>
  execFileSync(
    "docker",
    ["ps", "-a", "--filter", "name=hermetic-warm-", "--format", "{{.Names}}"],
    {
      encoding: "utf8",
    }
  )
    .split("\n")
    .filter(Boolean);
let preexisting = [];

async function stopServer(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await sleep(3000);
  // The server leaves its warm sandbox container running on SIGTERM; remove
  // the one(s) this run created (never another server's).
  const ours = warmContainers().filter((n) => !preexisting.includes(n));
  try {
    if (ours.length) execFileSync("docker", ["rm", "-f", ...ours], { stdio: "ignore" });
  } catch {
    /* already removed */
  }
}

// ── UI steps ────────────────────────────────────────────────────────────────

async function uploadSample(page) {
  await page.goto(BASE + "/");
  const upload = page.waitForResponse((r) => r.url().endsWith("/api/upload"));
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({ name: "sales-data.csv", mimeType: "text/csv", buffer: readFileSync(CSV) });
  if (!(await upload).ok()) throw new Error("upload failed");
  await page.locator("#home-question").waitFor();
}

/** Suggestion pills: 3 instant heuristics, upgraded to 5 LLM ones. */
async function waitForLlmSuggestions(page, timeout = 90_000) {
  const pills = page.locator("button").filter({ hasText: /\?\s*$/ });
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await pills.count()) >= 4) return true;
    await sleep(500);
  }
  log("warning: LLM suggestions never arrived (heuristic pills shown)");
  return false;
}

async function waitForDashboard(page) {
  await page.locator("#query-input").waitFor({ timeout: 900_000 });
  const dash = page.locator("[data-slides-root]");
  await dash.waitFor();
  if (await page.getByText("Analysis Error").count()) throw new Error("analysis errored");
  await dash.locator('[role="img"]').first().waitFor();
  await sleep(1500); // chart entry animations
}

async function ask(page, question) {
  await page.locator("#home-question").fill(question);
  await page.getByRole("button", { name: /^Analyze/ }).click();
  const t0 = Date.now();
  await waitForDashboard(page);
  log(`analysis "${question}" ${(Date.now() - t0) / 1000}s`);
}

/** Scroll so `locator`'s top sits `offset` px below the viewport top. */
async function scrollTo(page, locator, offset = 72) {
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate((dy) => window.scrollBy(0, dy), box.y - offset);
  await sleep(400);
}

const kpiRow = (page) =>
  page.locator("[data-slides-root]").getByText("Top Channel By Revenue", { exact: false }).first();

async function openArtifacts(page, tab) {
  await page.locator('button[title="View artifacts (SQL, code, data)"]').click();
  await sleep(800);
  if (tab) {
    await page
      .locator("button", { hasText: new RegExp(`^${tab}$`) })
      .last()
      .click();
    await sleep(800);
  }
}
const closeArtifacts = (page) => page.getByRole("button", { name: "Close" }).last().click();

/** The right-hand data rail has no labelled buttons; its first icon expands it. */
async function openDataExplorer(page) {
  const vp = page.viewportSize();
  await page.mouse.click(vp.width - 24, 88);
  await page.getByText("Data Explorer").first().waitFor();
  await sleep(800);
}

// ── stills ──────────────────────────────────────────────────────────────────

async function stills(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const shot = async (name, opts = {}) => {
    await page.screenshot({ path: join(DOCS, `${name}.png`), ...opts });
    log(`wrote docs/${name}.png`);
  };

  await page.goto(BASE + "/");
  await page.getByText("No data handy?").waitFor();
  await sleep(800);
  await shot("home", { clip: { x: 0, y: 0, width: 1440, height: 740 } });

  await uploadSample(page);
  await waitForLlmSuggestions(page);
  // The composer is vertically centred: a shorter viewport frames it tightly.
  await page.setViewportSize({ width: 1440, height: 680 });
  await sleep(700);
  await shot("ask-suggestions");
  await page.setViewportSize({ width: 1440, height: 900 });

  await ask(page, Q_MAIN);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await sleep(1500);
  await scrollTo(page, kpiRow(page), 100);
  await shot("dashboard");

  await page.evaluate(() => window.scrollTo(0, 0));
  await openArtifacts(page);
  await shot("artifacts");
  await closeArtifacts(page);
  await sleep(600);

  await openDataExplorer(page);
  const sample = page.getByText("SAMPLE", { exact: true }).last();
  if (await sample.count()) {
    await sample.click();
    await sleep(800);
  }
  await shot("data-explorer");
  await page.reload();
  await waitForDashboard(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await sleep(600);
  for (const s of ["Appearance", "Connected Sources", "Analysis Defaults"]) {
    await page
      .locator("button", { hasText: new RegExp(`^\\s*${s}`) })
      .first()
      .click();
    await sleep(300);
  }
  await sleep(600);
  await shot("settings");

  // Two more saved analyses for the saved-visualizations list.
  for (const q of Q_EXTRA) {
    const p2 = await ctx.newPage();
    await uploadSample(p2);
    await ask(p2, q);
    await p2.getByRole("button", { name: "Save", exact: true }).click();
    await sleep(1500);
    await p2.close();
  }
  await page.goto(BASE + "/");
  await uploadSample(page);
  await page.getByRole("button", { name: "Saved visualizations" }).click();
  await page.getByRole("button", { name: "Load" }).first().waitFor();
  await sleep(800);
  await shot("saved-vizs", { clip: { x: 0, y: 0, width: 1440, height: 500 } });
  await ctx.close();
}

// ── reel ────────────────────────────────────────────────────────────────────

class Reel {
  constructor(page) {
    this.page = page;
    this.frames = [];
  }
  async caption(text) {
    await this.page.evaluate((t) => {
      let el = document.getElementById("__reel_caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "__reel_caption";
        Object.assign(el.style, {
          position: "fixed",
          left: "50%",
          bottom: "28px",
          transform: "translateX(-50%)",
          zIndex: "2147483647",
          background: "rgba(17,24,39,.92)",
          color: "#fff",
          font: "600 22px/1.3 system-ui, sans-serif",
          padding: "10px 22px",
          borderRadius: "999px",
          boxShadow: "0 6px 24px rgba(0,0,0,.25)",
          pointerEvents: "none",
          whiteSpace: "nowrap",
        });
        document.body.appendChild(el);
      }
      el.textContent = t;
      el.style.display = t ? "block" : "none";
    }, text);
  }
  async hold(ms) {
    const file = join(FRAMES, `f${String(this.frames.length).padStart(4, "0")}.png`);
    await this.page.screenshot({ path: file });
    this.frames.push({ file, ms });
  }
  async type(locator, text, perChars = 3) {
    await locator.click();
    for (let i = 0; i < text.length; i += perChars) {
      await locator.pressSequentially(text.slice(i, i + perChars), { delay: 0 });
      await this.hold(70);
    }
  }
  async scroll(dy, steps, msPerStep = 90) {
    for (let i = 0; i < steps; i++) {
      await this.page.evaluate((d) => window.scrollBy(0, d), dy / steps);
      await sleep(60);
      await this.hold(msPerStep);
    }
  }
  build() {
    const list = join(FRAMES, "list.txt");
    const lines = [];
    for (const f of this.frames)
      lines.push(`file '${f.file}'`, `duration ${(f.ms / 1000).toFixed(3)}`);
    lines.push(`file '${this.frames.at(-1).file}'`); // concat demuxer: last frame needs repeating
    writeFileSync(list, lines.join("\n") + "\n");
    const total = this.frames.reduce((s, f) => s + f.ms, 0) / 1000;
    const mp4 = join(DOCS, "flow-reel.mp4");
    const gif = join(DOCS, "flow-reel.gif");
    const scale = "scale=880:-2:flags=lanczos";
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-vf",
      `fps=25,${scale},format=yuv420p`,
      "-c:v",
      "libx264",
      "-crf",
      "26",
      "-preset",
      "slow",
      "-movflags",
      "+faststart",
      mp4,
    ]);
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-vf",
      `fps=12,${scale},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      gif,
    ]);
    log(`reel: ${this.frames.length} frames, ${total.toFixed(1)}s → docs/flow-reel.{gif,mp4}`);
  }
}

async function reel(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const page = await ctx.newPage();
  const r = new Reel(page);

  // 1. Load a dataset.
  await page.goto(BASE + "/");
  await page.getByText("No data handy?").waitFor();
  await sleep(600);
  await r.caption("1 · Drop in a dataset — it stays on your machine");
  await r.hold(1800);
  const upload = page.waitForResponse((res) => res.url().endsWith("/api/upload"));
  await page
    .locator('input[type="file"]')
    .nth(1)
    .setInputFiles({ name: "sales-data.csv", mimeType: "text/csv", buffer: readFileSync(CSV) });
  await upload;
  await page.locator("#home-question").waitFor();
  await waitForLlmSuggestions(page);
  await sleep(400);
  await r.caption("1 · Drop in a dataset — it stays on your machine");
  await r.hold(1800);

  // 2. Ask.
  await r.caption("2 · Ask in plain English");
  await r.type(page.locator("#home-question"), Q_MAIN);
  await r.hold(700);
  await page.getByRole("button", { name: /^Analyze/ }).click();
  await sleep(1200);
  await r.caption("2 · Ask in plain English  (analysis sped up)");
  await r.hold(1600);
  await waitForDashboard(page);

  // 3. Dashboard.
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await r.caption("3 · Get a live dashboard");
  await r.hold(1800);
  await r.scroll(700, 14);
  await r.hold(1400);
  await r.scroll(700, 14);
  await r.hold(1600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);

  // 4. Verify.
  await r.caption("4 · Check the numbers — every figure traces to the analysis");
  await openArtifacts(page, "Findings");
  // Full-height panel, so the audit verdict has room above the caption.
  await page.getByRole("button", { name: "Toggle fullscreen" }).last().click();
  await sleep(500);
  await r.hold(2000);
  await page
    .locator("button", { hasText: /^Verify$/ })
    .last()
    .click();
  await sleep(600);
  await r.hold(2200);
  await page.getByRole("button", { name: "Run audit" }).click();
  await sleep(500);
  const auditDone = page.getByText(/^Verdict/);
  const auditFail = page.getByText(/Audit failed/);
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000 && !(await auditDone.count()) && !(await auditFail.count()))
    await sleep(1000);
  if (await auditDone.count()) {
    await r.caption("4 · …and have a second model audit them on demand");
    await sleep(500);
    await r.hold(3200);
  } else {
    log(
      `warning: audit did not produce a verdict (${(await auditFail.count()) ? "failed" : "timed out"}) — reel skips it`
    );
  }
  await closeArtifacts(page);
  await sleep(600);

  // 5. Export / share.
  await r.caption("5 · Export one self-contained HTML file to share");
  await page.getByRole("button", { name: "Export ▾" }).click();
  await sleep(400);
  const item = page.getByRole("button", { name: "Interactive HTML" });
  await item.hover();
  await r.hold(1600);
  const dl = page.waitForEvent("download", { timeout: 120_000 });
  await item.click();
  const download = await dl;
  const html = join(FRAMES, "exported-dashboard.html");
  await download.saveAs(html);
  const view = await ctx.newPage();
  await view.goto("file://" + html);
  await sleep(2500);
  r.page = view;
  await r.caption("5 · Export one self-contained HTML file to share");
  await r.hold(2200);
  await r.scroll(600, 10);
  await r.hold(1800);
  await r.caption("");
  await ctx.close();
  r.build();
}

// ── main ────────────────────────────────────────────────────────────────────

const server = await startServer();
const browser = await chromium.launch();
let failed = false;
try {
  if (MODE === "all" || MODE === "stills") await stills(browser);
  if (MODE === "all" || MODE === "reel") await reel(browser);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await stopServer(server);
  if (existsSync(FRAMES)) log(`frames kept in ${FRAMES} (${readdirSync(FRAMES).length} files)`);
}
process.exit(failed ? 1 : 0);
