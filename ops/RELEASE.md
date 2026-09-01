# Release runbook

How to cut a prerelease and a stable release, what each one publishes, and what
to check before users can get it.

Everything is **tag-driven**: pushing a `v*` tag runs
`.github/workflows/release.yml`. Nothing is published by merging to `main`.

---

## The one rule that matters: prereleases are invisible to installed apps

The desktop app polls exactly one URL for updates:

```
https://github.com/achalp/hermetic/releases/latest/download/latest.json
```

GitHub's `/releases/latest` resolves to **the newest release that is neither a
draft nor a prerelease**. Assets are served relative to _that_ release. So:

- A **prerelease** (`v0.2.0-rc.1`) gets its own release page with its own
  `latest.json` attached — but `/releases/latest/download/...` keeps resolving
  to the last **stable** release. No installed app can see it, even though the
  file exists and is signed.
- A **stable** release (`v0.2.0`) becomes `/releases/latest`, so its
  `latest.json` is what every installed app fetches on next launch.

The workflow keys off the same distinction: **any tag containing `-` is a
prerelease** (`[[ "$TAG" == *-* ]] && FLAGS="--prerelease"`), and the sandbox
image's `:latest` pointer only moves for stable tags.

**The consequence, and why the rc step is worth doing:** a prerelease exercises
the _entire_ pipeline — quality gate, GHCR image, `.mcpb`, desktop build,
signing, `latest.json` generation, upload ordering — while remaining
undiscoverable by every existing install. If something is wrong, you find out
from the workflow log and the release page, not from users stuck in a broken
update. Publishing straight to a stable tag makes the first test of the update
path a live one, on other people's machines.

---

## Before you tag

- [ ] On `main`, clean tree, `git pull --ff-only` (`release.sh` enforces all three).
- [ ] Decide the version. `scripts/release.sh` bumps **`package.json` and
      `src-tauri/tauri.conf.json5` together** — see [Version
      coupling](#version-coupling-non-negotiable) for why that pairing is not
      optional.

## Cut a prerelease

```bash
scripts/release.sh 0.2.0-rc.1
gh run watch $(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')
```

Publishes, all marked prerelease:

| Artifact                 | Where                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| Sandbox image            | `ghcr.io/achalp/hermetic-sandbox:0.2.0-rc.1` (**`:latest` does not move**) |
| Claude Desktop extension | `hermetic.mcpb` + `.sha256` on the release                                 |
| Desktop bundles          | `.AppImage` (+ `.sig`), `.deb`, `.rpm`                                     |
| Update manifest          | `latest.json`                                                              |

### Verify the prerelease

```bash
gh release view v0.2.0-rc.1 --json assets -q '.assets[].name'
gh release download v0.2.0-rc.1 -p latest.json -O - | jq
```

Check that `latest.json`:

- [ ] **`version` matches the tag** without the `v` (`"0.2.0-rc.1"`).
- [ ] **`platforms` has an entry per shipped OS**, and each `url` is a real
      asset on _this_ release. Paste one into a browser — it should download,
      not 404.
- [ ] **`signature` is non-empty** for every platform.

Then confirm the invisibility property itself — this is the whole point of the
rc, so verify it rather than trusting it:

```bash
# Must show the previous STABLE version (or 404 if none has ever shipped),
# never the rc you just pushed.
curl -sL https://github.com/achalp/hermetic/releases/latest/download/latest.json | jq -r .version
```

Optionally install the rc AppImage and run it — but note it will offer to
"update" itself down to whatever the current stable release is, because that is
what `/releases/latest` serves. That is correct behavior, not a bug.

## Cut the stable release

```bash
scripts/release.sh 0.2.0
gh run watch $(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')
```

Same artifacts, plus: `ghcr.io/achalp/hermetic-sandbox:latest` now points here,
and `/releases/latest/download/latest.json` starts serving this manifest. Every
installed app picks it up **on its next launch**.

### Verify the stable release

```bash
curl -sL https://github.com/achalp/hermetic/releases/latest/download/latest.json | jq -r .version   # → 0.2.0
gh attestation verify hermetic.mcpb --repo achalp/hermetic
gh attestation verify oci://ghcr.io/achalp/hermetic-sandbox:0.2.0 --repo achalp/hermetic
```

Then install the published AppImage on a machine running the **previous**
version and relaunch it — that is the only end-to-end proof that auto-update
works for real users. Hermetic logs to stderr:

```
[hermetic] update 0.2.0 available — downloading
[hermetic] update 0.2.0 installed — restart to apply
```

---

## Version coupling (non-negotiable)

Two files carry a version, and **both must equal the tag**:

| File                         | Consumed by                              |
| ---------------------------- | ---------------------------------------- |
| `package.json`               | the npm/sidecar surface                  |
| `src-tauri/tauri.conf.json5` | Tauri — compiled into the desktop binary |

The updater compares `latest.json`'s `version` (derived from the **tag**)
against the version **compiled into the running app**
(`src-tauri/tauri.conf.json5`). If the tag says `0.2.0` while the config still
says `0.1.0`, the published update installs successfully, still reports
`0.1.0`, sees `0.2.0` on offer again — and re-downloads the identical update
**on every launch, forever**. Nothing upstream catches it: the build succeeds,
the signature verifies, the install works.

Two things prevent it:

1. `scripts/release.sh` bumps both files in one commit.
2. `scripts/build-updater-manifest.mts` compares the tag against
   `tauri.conf.json5` and **fails the release job** on mismatch — the guard for
   a hand-cut tag or a hand-edited config.

Don't tag by hand. If you must, bump both files first.

---

## Signing keys

Desktop updates are minisign-signed; Tauri verifies every download against the
public key compiled into the app before writing anything.

- **Public half** — committed in `src-tauri/tauri.conf.json5`
  (`plugins.updater.pubkey`, key id `413EA66010356217`).
- **Private half** — the maintainer's keychain, plus repo secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

**Losing the private key is unrecoverable for existing installs.** The public
key is baked into every shipped binary, so a new keypair cannot sign anything
those apps will accept — they stop updating permanently and users must
reinstall by hand. Keep the key and its password backed up somewhere durable.

If it leaks, treat it as a code-signing compromise: rotate the keypair, ship a
new stable release, and expect every install on the old key to need a manual
reinstall.

Local builds (`pnpm desktop:build`, `start.sh` option 1) need **no** key —
signing is skipped and the unsigned bundles work fine for local use. They just
can't be published as updates.

---

## If something goes wrong

**The desktop job failed but the release exists.** Expected and safe: desktop
bundles attach _after_ release creation (a packaged build is too slow to hold
it), which is why release notes never mention them. The release is simply
missing bundles. Fix the cause, re-run the job, or delete the release + tag and
re-cut.

**`No <bundle>.sig — was TAURI_SIGNING_PRIVATE_KEY set for the build?`** The
signing secrets are missing or misnamed in repo settings. Nothing partial was
published — the script fails before writing a manifest.

**`Version mismatch: tag says X, the app is built as Y`.** See [Version
coupling](#version-coupling-non-negotiable). Delete the tag, bump
`tauri.conf.json5`, re-cut.

**`No self-updatable bundles found`.** The build produced no `.AppImage` /
`.app.tar.gz` / installer — usually a bundling failure earlier in the job.
`.deb`/`.rpm` alone never satisfy this: they update through the package
manager, so listing them would hand apps a download they cannot apply.

**Users report an update loop.** Almost certainly the version mismatch above,
from a release cut before the guard existed. Ship a stable release whose
`tauri.conf.json5` version matches its tag; installs converge on next launch.

**Need to un-publish.** Deleting a release stops new downloads but does nothing
about copies already fetched. If a bad stable release shipped, the fix is
forward: cut a higher version. Marking the bad one as a prerelease also works —
it drops out of `/releases/latest` immediately — but installs that already took
it stay there until the next stable release.

---

## What auto-update does on a user's machine

- Checks **once per launch**, in the Rust core — never from webview JavaScript
  (the updater plugin is registered with no capability grant, so the page has
  no reachable command).
- Verifies the signature **before** writing anything.
- Applies on the **next** launch; it never restarts a session in progress.
- Fails silently-but-logged when offline or rate-limited; a failed check never
  blocks startup.
- Skipped entirely in debug builds and when `HERMETIC_NO_UPDATE_CHECK=1` is set.
- **Linux: only the AppImage self-updates.** `.deb` / `.rpm` installs update
  through the system package manager.

Design rationale and the security argument: `specs/pyodide-wasm-build-log.md`
§ D42.
