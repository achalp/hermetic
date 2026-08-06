# Settings in runtime-config, secrets in the OS keychain

**Date:** 2026-08-06 · **Status:** v1 shipped (§4) · **Owner seams:**
`lib/settings.ts` (resolution), `lib/secrets.ts` (keychain),
`lib/warehouse/persist-env.ts` (credential separation).

## 1. The problems

**Settings parity.** `.env.local` is loaded by Next for the WEB harness only.
The MCP server (spawned by Claude Desktop) and the CLI see the bare process
env — so env-only settings silently diverge between harnesses (observed: the
Desktop-spawned server auto-detected claude-cli while the web app used an API
key). `data/runtime-config.json` is shared by every harness in the checkout.

**Secrets on disk.** Warehouse connection credentials (passwords, BigQuery
service-account JSON, Databricks tokens) persisted in plaintext inside
`data/warehouse-connections`. API keys lived in `.env.local` — user-managed,
but still plaintext on disk, and invisible to non-web harnesses.

## 2. The taxonomy (what lives where)

| Class                    | Home                                                       | Examples                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Process facts            | env only                                                   | `NODE_ENV`, `TMPDIR`, `LOG_LEVEL`, `VITEST`                                                                                                            |
| Security boundaries      | env only (deliberate)                                      | `HERMETIC_LOCAL_FILE_ROOTS` — a boundary the Settings UI can widen is a weaker boundary                                                                |
| Harness deployment knobs | env only                                                   | `HERMETIC_MCP_VIEWER_PORT`, `HERMETIC_LLM_MODE`, `HERMETIC_CLAUDE_CLI_EFFORT`                                                                          |
| Product settings         | **runtime-config, env fallback** (`lib/settings.ts`)       | provider endpoints (`openaiBaseUrl/Model`, `vertexProject/Location`, `awsRegion`), sandbox (`microsandboxUrl/Image`, `memoryFraction`), retention caps |
| Secrets                  | **OS keychain, env fallback for reads** (`lib/secrets.ts`) | API keys (Anthropic/OpenAI/E2B/Microsandbox), warehouse credentials                                                                                    |
| Seeding conveniences     | env (unchanged)                                            | `WAREHOUSE_*` presets — migrate into saved connections on first load                                                                                   |

Deliberately NOT migrated: `AWS_PROFILE` — the Bedrock SDK resolves it through
its own credential chain, so a runtime-config value would be silently ignored.
A setting that lies is worse than an env var.

## 3. Design

**Settings (`lib/settings.ts`):** typed getters, `runtime-config → env`
resolution, following the precedent of `rc.activeProvider`/`rc.sandboxRuntime`.
RuntimeConfig gained `providers`, `sandbox`, `retention` blocks — with the
comment-level rule that secrets NEVER go there.

**Secrets (`lib/secrets.ts`):** `@napi-rs/keyring` (keyring-rs) over the
platform credential service — macOS Keychain, Linux Secret Service, Windows
Credential Manager. Service `"hermetic"`, one entry per secret name.

- Reads: keychain → env (`.env.local` for the web harness; real env or the
  host's `env` block for MCP/CLI). Headless systems keep working via env.
- Writes: keychain REQUIRED. `setSecret` throws a message naming the env
  alternative when no credential service exists — hermetic never writes a
  secret into a file it owns.
- Availability probed once per process (a read distinguishes "no entry" from
  "no service"); native-addon load failures degrade to unavailable, never
  crash.
- Next: `@napi-rs/keyring` added to `serverExternalPackages` (native addon).

**Warehouse credential separation (`persist-env.ts`):** one write path
(`persistConnections`) scrubs `password` / `credentialsJson` / `token` /
`privateKey` into a per-connection keychain blob (`warehouse/<id>`) and writes
only non-secret metadata to the file; loads merge the blob back. A
pre-keychain file's embedded credentials migrate out on first load. Removal
deletes the blob. If a keychain write fails, the credential stays in the file
(losing it would be worse) with a warning. No credential service at all →
legacy plaintext behavior, warned once — headless deployments must not break.

**API-key entry:** `PUT /api/providers` accepts `api_key` (keychain-stored;
empty string deletes); `GET /api/providers` reports `keychain_available` so
the UI knows whether to offer the field.

## 4. Shipped in v1 (2026-08-06)

- `lib/settings.ts` + RuntimeConfig blocks; consumers migrated: llm/client,
  config validation, microsandbox executor, e2b executor, memory-budget,
  history retention, run-recorder, providers route.
- `lib/secrets.ts` with keychain backend, env fallbacks, warehouse blob API.
- Warehouse credential separation with on-load migration.
- Providers route: key-aware detection + keychain-backed `api_key` writes.

## 5. Roadmap

- ~~Settings UI fields~~ — DONE (same day): `/api/settings` (GET/PUT) +
  the Advanced Configuration drawer section (`settings/config-section.tsx`):
  keychain API-key inputs (status badges, no material echo, disabled with
  env guidance when no credential service), provider endpoints, sandbox
  tuning, retention — env fallbacks shown as placeholders. E2E-verified
  against a live server incl. a real keychain write and cross-process
  (MCP-style) resolution of a UI-saved value.
- **Scrub-on-migrate hygiene:** after the warehouse migration rewrites the
  file, the old bytes may survive in the filesystem's free list; consider a
  one-time note in docs (local threat model makes this low-stakes).
- **`.env.local` guidance:** README should steer new users to Settings-first
  (keys land in the keychain), with env as the headless/CI path.
- **MCP parity for the remaining env knobs** is complete for settings/secrets;
  harness env-file loading (option "a") intentionally NOT done — the
  keychain + runtime-config path supersedes it for everything that matters.
