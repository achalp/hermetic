# Hermetic in September: the month it became an app

Hermetic is an open-source, local-first AI data analyst I've been building in public. The founding constraint hasn't moved: the model writes the analysis code, but it never sees your data. August closed on an agent-facing queue — catalog resources, schedule tools, kill-signal telemetry. September went sideways again, because a blunter problem was standing in front of all of it: the only people who could use any of this were people who clone repositories. Fifteen stable releases later, Hermetic is a desktop app you download, and the story of getting there turned out to be the same story as the rest of the project — trust, verified mechanically, with the embarrassing parts written down.

## An installer is a trust artifact

Hermetic now ships as a desktop app for Linux, macOS (both architectures), and Windows, with auto-update built in. I came into this thinking of packaging as chores between features. I no longer do. Every choice in a release pipeline is a trust choice, and the discipline that governs the sandbox turned out to transfer directly.

Updates are minisign-verified against a public key compiled into the app; an unsigned or tampered bundle fails before a byte lands. The update manifest is assembled in its own final CI job, only from artifacts that provably uploaded — so a failed platform build is a visibly missing platform, never a manifest pointing at files that don't exist. macOS builds are Developer-ID signed and notarized, which cost exactly the humility you'd expect: Apple rejects an app if any Mach-O binary anywhere inside is unsigned, and Hermetic's sidecar carries a Node runtime (which needs JIT entitlements or it crashes under the hardened runtime), a Rust binary, and native addons — so the build now sweeps the whole tree by magic bytes, because file extensions lie. Three release candidates to get to "Accepted." Windows remains unsigned for now; SmartScreen will warn, and the README says so rather than hoping you won't notice.

The app's security posture did not bend to make room for convenience. The webview still has zero host-reachable commands — the boundary the desktop shell was designed around. When Settings grew a "Check for updates" button and a "Restart now" banner this month, the wiring went page → local API → a command file in the app's own data directory → a trusted watcher in the shell. Two verbs, file deleted before acting. The empty-IPC invariant survived becoming user-friendly.

And one admission belongs here rather than in a footnote: mid-month I rotated the update-signing key. Not because it leaked — because when I finally tested restoring the private key from my own backup, the saved password didn't work. Every installed copy trusts that key permanently; a backup you've never restored is not a backup. The release runbook now requires proving round-trip custody — paste the key back out of the password manager, sign something with it — before any release depends on it. Zero external installs made the rotation free. It will never be that cheap again, which is exactly why the check is mandatory now.

## Three doors, one refusal policy

The same pipeline is now fully reachable three ways: the web app from a checkout, the desktop app, and `hermetic.mcpb` — the one-file extension that installs into Claude Desktop by double-click and turns Claude into a client of your local Hermetic. Parity took real work: the extension now vendors the Rust egress binary (the L7 allowlist proxy that mediates every remote read) built natively for five platforms, plus the in-process DuckDB engine. One CI job builds each platform's binary once, attests it, and both the extension and all four desktop builds reuse it.

Where a door can't honestly support something, it now refuses by name. A browserless MCP server can't run the wasm tier's sandboxed execution — that isolation boundary is literally a browser's — so it says "use Docker" instead of quietly running your data somewhere weaker. I keep relearning that the refusal message is part of the product.

## Point it at a catalog

The month's biggest analysis-side addition: hand Hermetic a dataset manifest — a datapackage, a croissant file, a plain files array, or a STAC catalog — and it becomes one source with many entities that behave like tables. Ask a question and a small model call picks which entities matter; schemas are introspected on demand; cross-entity joins work; on the wasm tier the workers read remote Parquet through ranged requests, so nothing is downloaded whole. Overture Maps' STAC catalog — the same planetary dataset from July's loneliest-building experiment — now connects with one URL. The MCP tools got full manifest parity too, so an agent can do all of this through the same door.

## My development machine was lying to me

Here is the month's honest section, and it has a single root cause worth naming: a development machine accumulates state that masks packaging gaps, and every test that passes on it is testing the machine as much as the code.

The first real desktop installs failed in ways my machine could not reproduce. The Pyodide wheels that make pandas work offline? The npm package doesn't ship them — they'd been silently CDN-cached into my checkout by months of test runs, so every packaged app went out without them, and Pyodide's loader doesn't even throw when a wheel fails to fetch; it just fails later, at import, on a user's Mac. The DuckDB browser bundle the desktop's whole remote-read path depends on? Built by no build step at all — mine existed because I'd once run the script by hand. The Settings footer said "v1.0" for six releases because a hardcoded string never has to meet reality. And the bug report that surfaced all of this was almost undebuggable, because the packaged app wrote no log file — a Finder-launched process's output went nowhere.

Every one of those fixes shipped with an assert that makes the gap impossible to re-ship: the bundle build fails if a wheel is missing, CI now executes the exact engine the desktop ships, the footer reads the running process's version, and the app writes a real log — which paid for itself within hours by catching the next bug (a click that froze the question page while minutes of manifest preparation ran behind it; the progress view now appears at the click). If you're shipping anything local-first: your first ten users are an audit. Build so their findings become permanent.

## The gates now guard me too

The repo grew a static-analysis suite this month — clippy at deny-warnings on the Rust, cargo-audit across both lockfiles, a dead-code ratchet that found seven dependencies nobody imported (including two sandbox runtimes removed months ago), security linting for the sandbox's Python, and CodeQL's extended queries. I know the suite works because it caught _me_, three times in one week: a time-of-check race in the very script that introduced it, an unformatted file, and a raw fetch the architecture ratchet refused on sight. When a rustls advisory published mid-September against the exact crate that terminates TLS for every sandboxed remote read, the patch was on main the same day — and the reason every branch went red until then is that the audit gate did its job.

Quality work continued underneath: both execution tiers aligned on the same stable DuckDB, the wasm tier gained the spatial extension and a Docker-parity test program, and a brutal inspection of one exported dashboard produced nine integrity findings fixed as classes rather than instances. One engine bug on the wasm tier still blocks a class of planetary geo query — it now fails in seconds with a legible message instead of burning thirty-five minutes on four identical retries, but legible is not fixed, and it's at the top of the pile.

## What comes next

August's agent queue mostly didn't happen — manifests and distribution displaced it, and I think that was the right trade, but it's still owed: the component catalog as a resource, schedule tools, an investigate-mode tool. Windows code signing. The wasm engine bug. And the kill-signal telemetry question from August stands unchanged — the analysis room is only real if the dashboards persist and get revisited.

If you install the app and it does something useful — or something embarrassing — I'd like to hear about it. This month proved the embarrassing reports are the valuable ones.

Open source, local first: github.com/achalp/hermetic
