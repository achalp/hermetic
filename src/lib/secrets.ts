/**
 * OS-keychain secret store (secrets-and-settings spec, 2026-08-06):
 * hermetic-written files persist NO secrets.
 *
 * Backend: the platform credential service via @napi-rs/keyring (keyring-rs)
 * — macOS Keychain, Linux Secret Service (GNOME Keyring / KWallet), Windows
 * Credential Manager. Everything is stored under service "hermetic", one
 * entry per secret name.
 *
 * Resolution order for reads: keychain → environment (the headless / CI
 * path — .env.local or real env). Writes REQUIRE the keychain: when the
 * platform has no credential service (headless Linux without DBus), setSecret
 * throws with the env-var alternative named — hermetic never falls back to
 * writing a secret into a file.
 *
 * What lives here:
 *   - LLM / sandbox API keys (named secrets with env fallbacks below)
 *   - warehouse connection credentials, one JSON blob per connection id
 *     (`warehouse/<id>`) — the connections FILE keeps only non-secret
 *     metadata (lib/warehouse/persist-env.ts strips + rejoins).
 *
 * Availability is probed once per process (a read of a probe entry — a
 * missing entry returns null cleanly; a missing BACKEND throws).
 */
import { logger, serializeError } from "@/lib/logger";
import { envConfig } from "@/lib/harness-slot";
import type { EnvConfigKey } from "@/lib/contracts/env-config";

const SERVICE = "hermetic";

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}

type EntryCtor = new (service: string, account: string) => KeyringEntry;

let entryCtor: EntryCtor | null | undefined;

/** Lazy native load — a missing/unbuildable addon means "no keychain", not a crash. */
function loadEntryCtor(): EntryCtor | null {
  if (entryCtor !== undefined) return entryCtor;
  // Tests must NEVER reach the developer's real keychain: under vitest the
  // keychain is unavailable unless a fake is injected (_setEntryCtorForTests).
  if (envConfig().VITEST) {
    entryCtor = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@napi-rs/keyring") as { Entry: EntryCtor };
    entryCtor = mod.Entry;
  } catch (err) {
    logger.warn("secrets: @napi-rs/keyring unavailable — keychain disabled", serializeError(err));
    entryCtor = null;
  }
  return entryCtor;
}

let availability: boolean | undefined;

/**
 * Is a platform credential service actually reachable? Reading a probe entry
 * distinguishes "no such secret" (null — service works) from "no service"
 * (throws — e.g. headless Linux without a Secret Service daemon).
 */
export function keychainAvailable(): boolean {
  if (availability !== undefined) return availability;
  const Entry = loadEntryCtor();
  if (!Entry) return (availability = false);
  try {
    new Entry(SERVICE, "__availability-probe__").getPassword();
    availability = true;
  } catch (err) {
    logger.warn(
      "secrets: platform credential service unreachable — keychain disabled, env fallback only",
      serializeError(err)
    );
    availability = false;
  }
  return availability;
}

/** Test seam: forget the availability probe and constructor cache. */
export function _resetKeychainState(): void {
  availability = undefined;
  entryCtor = undefined;
}

/**
 * Test seam: inject a fake Entry constructor. `require()` of the native
 * addon bypasses vitest's module mocks, so tests hand the fake in directly
 * — which also guarantees tests can never touch the developer's real
 * keychain.
 */
export function _setEntryCtorForTests(ctor: EntryCtor | null): void {
  entryCtor = ctor;
  availability = undefined;
}

function entry(name: string): KeyringEntry | null {
  if (!keychainAvailable()) return null;
  const Entry = loadEntryCtor();
  return Entry ? new Entry(SERVICE, name) : null;
}

// ── Generic named secrets ────────────────────────────────────────────

/** Keychain first, env fallback (when the name maps to an env key). */
export function getSecret(name: string, envKey?: EnvConfigKey): string | undefined {
  try {
    const value = entry(name)?.getPassword();
    if (value) return value;
  } catch (err) {
    logger.warn("secrets: keychain read failed", { name, ...serializeError(err) });
  }
  if (envKey) return envConfig()[envKey];
  return undefined;
}

/** Store (or with an empty value, delete) a secret. Keychain REQUIRED. */
export function setSecret(name: string, value: string): void {
  const e = entry(name);
  if (!e) {
    throw new Error(
      "No OS credential service is available on this system, and hermetic never writes " +
        "secrets to files. Use the environment variable path instead (e.g. .env.local for " +
        "the web app, or the MCP server's env block)."
    );
  }
  if (value === "") {
    e.deleteCredential();
    return;
  }
  e.setPassword(value);
}

export function deleteSecret(name: string): void {
  try {
    entry(name)?.deleteCredential();
  } catch (err) {
    logger.warn("secrets: keychain delete failed", { name, ...serializeError(err) });
  }
}

// ── Named API-key secrets (keychain name ↔ env fallback) ─────────────

export const API_KEY_SECRETS = {
  anthropic: { name: "anthropic-api-key", envKey: "ANTHROPIC_API_KEY" },
  openai: { name: "openai-api-key", envKey: "OPENAI_API_KEY" },
  e2b: { name: "e2b-api-key", envKey: "E2B_API_KEY" },
  microsandbox: { name: "microsandbox-api-key", envKey: "MICROSANDBOX_API_KEY" },
} as const satisfies Record<string, { name: string; envKey: EnvConfigKey }>;

export type ApiKeyId = keyof typeof API_KEY_SECRETS;

export function getApiKey(id: ApiKeyId): string | undefined {
  const { name, envKey } = API_KEY_SECRETS[id];
  return getSecret(name, envKey);
}

// ── Warehouse connection credentials (JSON blob per connection) ──────

const warehouseSecretName = (connectionId: string) => `warehouse/${connectionId}`;

export function getWarehouseSecrets(connectionId: string): Record<string, string> | undefined {
  const raw = getSecret(warehouseSecretName(connectionId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    logger.warn("secrets: warehouse secret blob unparsable", { connectionId });
    return undefined;
  }
}

export function setWarehouseSecrets(connectionId: string, secrets: Record<string, string>): void {
  setSecret(warehouseSecretName(connectionId), JSON.stringify(secrets));
}

export function deleteWarehouseSecrets(connectionId: string): void {
  deleteSecret(warehouseSecretName(connectionId));
}
