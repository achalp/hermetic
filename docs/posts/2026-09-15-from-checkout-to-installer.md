# From checkout to installer: three weeks, fifteen releases

_September 15, 2026_

When Hermetic launched last month, "installing" it meant cloning a repo, running
`pnpm install`, and building a Docker image. That was honest for what it was — a
local-first AI analyst you could inspect down to the sandbox flags — but it
gated the whole idea on being the kind of person who clones repos.

Fifteen stable releases later, that gate is gone. Here's what shipped.

## A real desktop app, on every desk

Hermetic now ships as a signed desktop app for **Linux** (AppImage/deb/rpm),
**macOS** (Apple Silicon and Intel), and **Windows** — with auto-update built
in. Every update is minisign-verified against a public key compiled into the
app before a byte is written, and the update manifest is assembled only from
artifacts that provably uploaded, so a partial release can't strand anyone.

macOS builds are Developer-ID signed and notarized — no right-click-to-open
ceremony. Getting there meant deep-signing every Mach-O the app carries (the
bundled Node runtime needs JIT entitlements; Apple rejects a single unsigned
dylib anywhere in the bundle), which took exactly the number of release
candidates you'd expect. Windows code signing is the one gap left, and the
runbook says so plainly rather than pretending otherwise.

The app's security posture didn't move to make room for any of this. The
webview still has **zero** host-reachable commands — even the updater is
driven through files in the app's own data directory, never an IPC surface the
page could touch. Settings now shows the _running_ version and offers "Check
for updates" / "Restart now", and that feature is wired the same way: page →
local API → command file → trusted shell. The empty-IPC invariant survived
becoming convenient.

## One pipeline, three doors

The same analysis pipeline is now fully reachable three ways: the web app, the
desktop app, and **`hermetic.mcpb`** — a one-file extension that installs into
Claude Desktop by double-click and turns Claude into a client of your local
Hermetic. The bundle now carries everything it needs on every platform: the
Rust egress-core binary (the L7 allowlist proxy that mediates every remote
read) built natively for five platforms, and the in-process DuckDB engine.
One CI job builds each platform's binary once; the extension and all four
desktop builds reuse it.

Where a door can't honestly support something, it refuses by name instead of
degrading — a browserless MCP server tells you cloud introspection needs
Docker; it doesn't quietly run your data through a weaker sandbox.

## Catalogs as sources: manifests and STAC

You can now hand Hermetic a **dataset manifest** — a datapackage, croissant,
files-array, or **STAC catalog** URL — and get one source with many entities
that behave like tables. Ask a question and an LLM pre-step picks the relevant
entities; schemas are introspected on demand; cross-entity JOINs work; and on
the wasm tier the workers read remote Parquet through ranged requests, so
nothing is downloaded whole. Overture Maps' STAC catalog — billions of rows of
planetary geodata — connects with one URL, in the app or from Claude via MCP.

## What the first real installs taught us

The most valuable commits this month came from field reports, and they share
one root cause worth naming: **development machines accumulate state that
masks packaging gaps.** The Pyodide wheels that make pandas work offline had
been silently CDN-cached into a dev checkout years of test runs ago — so every
packaged app shipped without them, and nothing noticed until a real Mac ran a
real analysis. Same story for the DuckDB browser bundle, which no build step
produced at all. Same story, in miniature, for a Settings footer that said
"v1.0" for six releases because a hardcoded string never met reality.

Each fix shipped with an assert that makes the gap impossible to re-ship: the
bundle build now _fails_ if a wheel is missing, CI now executes the engine the
desktop actually ships, and the installed app writes a real log file — which
paid for itself within hours by catching the next bug.

## Trust, mechanically

The supply chain got the same treatment as the analysis pipeline: every
artifact — installers, the extension, the sandbox image, each Rust binary —
carries a GitHub build-provenance attestation. The updater keypair was rotated
with verified round-trip custody (the runbook now _requires_ proving you can
restore a key from backup before shipping against it). CI gained clippy at
`-D warnings`, `cargo-audit` over both lockfiles, dead-code ratchets, security
linting for the sandbox's Python, and CodeQL's extended query pack — a suite
that flagged a real TOCTOU in its own introduction PR, which is exactly the
kind of tool you want. When RUSTSEC-2026-0285 landed against rustls, the patch
was on main within a day.

## And the analysis itself

Both execution tiers now run the same stable DuckDB, the wasm tier gained the
spatial extension and a Docker-parity test program, schema profiling got an
on-demand depth setting with footer-exact ranges, and a batch of dashboard
integrity findings — sourced from one brutally-inspected exported dashboard —
were fixed as classes rather than instances.

## What's next

Windows code signing. A DuckDB-WASM engine bug that currently blocks one class
of planetary geo query on the built-in tier (it fails legibly now; we want it
fixed). And the same discipline, applied to whatever the next field report
finds.

_Hermetic is open source: [github.com/achalp/hermetic](https://github.com/achalp/hermetic).
Download the desktop app from the [releases page](https://github.com/achalp/hermetic/releases/latest),
or install `hermetic.mcpb` into Claude Desktop._
