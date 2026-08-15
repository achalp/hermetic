import { describe, it, expect, beforeEach, vi } from "vitest";
import { logger } from "@/lib/logger";
import { hermeticPaths } from "@/lib/paths";

// In-memory path→content fake FS. Models enough of fs/promises for BOTH
// persist-env (readFile/unlink) AND the atomic writer it now delegates to
// (writeFile → temp path, rename → real path, mkdir noop): a bare writeFile
// mock would miss the rename and the test would never exercise the real path.
const fs = new Map<string, string>();
const CONN = "warehouse-connections.json";
function enoent(): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error("ENOENT");
  e.code = "ENOENT";
  return e;
}
/** Content at the (only) real connections file, ignoring atomic temp files. */
function connFile(): string | null {
  for (const [k, v] of fs) if (k.endsWith(CONN)) return v;
  return null;
}
function seedConn(content: string) {
  fs.set(hermeticPaths.warehouseConnectionsFile(), content);
}
function backupKeys(): string[] {
  return [...fs.keys()].filter((k) => k.includes(`${CONN}.corrupt-`));
}
vi.mock("fs/promises", () => ({
  readFile: vi.fn(async (path: string) => {
    if (!fs.has(path)) throw enoent();
    return fs.get(path)!;
  }),
  writeFile: vi.fn(async (path: string, data: string) => {
    fs.set(path, data);
  }),
  rename: vi.fn(async (from: string, to: string) => {
    if (!fs.has(from)) throw enoent();
    fs.set(to, fs.get(from)!);
    fs.delete(from);
  }),
  mkdir: vi.fn(async () => {}),
  unlink: vi.fn(async (path: string) => {
    fs.delete(path);
  }),
}));

// In-memory keychain fake: `available` toggles the credential-service probe.
const keychainState: { available: boolean; blobs: Map<string, Record<string, string>> } = {
  available: true,
  blobs: new Map(),
};
vi.mock("@/lib/secrets", () => ({
  keychainAvailable: vi.fn(() => keychainState.available),
  getWarehouseSecrets: vi.fn((id: string) => keychainState.blobs.get(id)),
  setWarehouseSecrets: vi.fn((id: string, secrets: Record<string, string>) => {
    if (!keychainState.available) throw new Error("no credential service");
    keychainState.blobs.set(id, secrets);
  }),
  deleteWarehouseSecrets: vi.fn((id: string) => {
    keychainState.blobs.delete(id);
  }),
}));

import {
  saveConnection,
  renameConnection,
  loadConnections,
  removeConnection,
} from "@/lib/warehouse/persist-env";
import type { WarehouseConnectionConfig } from "@/lib/contracts/connection-configs";

const PG: WarehouseConnectionConfig = {
  type: "postgresql",
  host: "db.example.com",
  port: 5432,
  database: "analytics",
  user: "reader",
  password: "secret",
};

beforeEach(() => {
  fs.clear();
  keychainState.available = true;
  keychainState.blobs.clear();
  vi.restoreAllMocks();
});

describe("saveConnection / renameConnection", () => {
  it("saves with no name and derives an auto label", async () => {
    const saved = await saveConnection(PG);
    expect(saved.name).toBeUndefined();
    expect(saved.label).toBe("PostgreSQL: db.example.com/analytics");
  });

  it("accepts a friendly name at save time", async () => {
    const saved = await saveConnection(PG, "Prod analytics");
    expect(saved.name).toBe("Prod analytics");
  });

  it("preserves the friendly name when the same connection is re-saved without one", async () => {
    await saveConnection(PG, "Prod analytics");
    // Reconnect (same target → dedup-update) with a changed password, no name.
    const reSaved = await saveConnection({ ...PG, password: "rotated" });
    expect(reSaved.name).toBe("Prod analytics"); // rename survives reconnect
    expect((reSaved.config as typeof PG).password).toBe("rotated"); // config updated
    const all = await loadConnections();
    expect(all).toHaveLength(1); // deduped, not duplicated
  });

  it("renames an existing connection, and an empty name clears back to the label", async () => {
    const saved = await saveConnection(PG);
    await renameConnection(saved.id, "  My DB  ");
    let all = await loadConnections();
    expect(all[0].name).toBe("My DB"); // trimmed

    await renameConnection(saved.id, "");
    all = await loadConnections();
    expect(all[0].name).toBeUndefined(); // cleared → falls back to label in UI
  });
});

describe("credential separation (secrets-and-settings 2026-08-06)", () => {
  it("the connections FILE never contains the password; load merges it back", async () => {
    const saved = await saveConnection(PG, "Prod");
    expect(connFile()).not.toContain("secret"); // the boundary that matters
    expect(keychainState.blobs.get(saved.id)).toEqual({ password: "secret" });

    const loaded = await loadConnections();
    expect(loaded).toHaveLength(1);
    expect((loaded[0].config as { password?: string }).password).toBe("secret");
  });

  it("BigQuery credentialsJson is scrubbed the same way", async () => {
    const bq: WarehouseConnectionConfig = {
      type: "bigquery",
      projectId: "p",
      dataset: "d",
      credentialsJson: '{"private_key":"-----BEGIN-----"}',
    } as unknown as WarehouseConnectionConfig;
    const saved = await saveConnection(bq);
    expect(connFile()).not.toContain("BEGIN");
    expect(keychainState.blobs.get(saved.id)?.credentialsJson).toContain("BEGIN");
  });

  it("removeConnection deletes the keychain blob too", async () => {
    const saved = await saveConnection(PG);
    await removeConnection(saved.id);
    expect(keychainState.blobs.has(saved.id)).toBe(false);
  });

  it("without a credential service, legacy plaintext behavior is preserved", async () => {
    keychainState.available = false;
    await saveConnection(PG);
    expect(connFile()).toContain("secret"); // deliberate: headless keeps working
    const loaded = await loadConnections();
    expect((loaded[0].config as { password?: string }).password).toBe("secret");
  });

  it("migrates a pre-keychain file's embedded credentials on first load", async () => {
    // Seed a legacy-format file (credentials embedded).
    seedConn(
      JSON.stringify([
        {
          id: "legacy-1",
          label: "PostgreSQL: db.example.com/analytics",
          config: PG,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ])
    );
    const loaded = await loadConnections();
    // Returned config is complete...
    expect((loaded[0].config as { password?: string }).password).toBe("secret");
    // ...the rewritten file is scrubbed, and the keychain holds the credential.
    expect(connFile()).not.toContain("secret");
    expect(keychainState.blobs.get("legacy-1")).toEqual({ password: "secret" });
  });

  it("rename does not leak credentials back into the file", async () => {
    const saved = await saveConnection(PG);
    await renameConnection(saved.id, "renamed");
    expect(connFile()).toContain("renamed");
    expect(connFile()).not.toContain("secret");
  });
});

describe("crash safety (finding 07): a corrupt file is backed up, never silently emptied", () => {
  it("round-trips a persisted connection through the atomic writer", async () => {
    const saved = await saveConnection(PG, "Prod");
    // A whole, valid JSON array landed at the real path (temp renamed away).
    const raw = connFile();
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toHaveLength(1);
    expect(backupKeys()).toHaveLength(0);
    // Re-load sees exactly the one saved connection.
    expect(await loadConnections()).toHaveLength(1);
  });

  it("backs up a truncated connections file instead of reading it as [] and wiping it", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    // A crash left a half-written file on disk.
    seedConn('[{"id":"a","label":"PostgreSQL: h/d","config":{"type":"postgre');

    // The salvageable bytes are preserved before any write can clobber them...
    const loaded = await loadConnections();
    expect(loaded).toEqual([]);
    const backups = backupKeys();
    expect(backups).toHaveLength(1);
    expect(fs.get(backups[0])).toContain('"id":"a"');
    // ...and the corrupt bytes did NOT survive as the live connections file.
    expect(connFile()).toBeNull();

    // A subsequent save starts a fresh, valid file — the backup is untouched.
    await saveConnection(PG);
    expect(JSON.parse(connFile()!)).toHaveLength(1);
    expect(backupKeys()).toHaveLength(1);
  });

  it("a non-array (wrong-shape) connections file is treated as corrupt", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    seedConn(JSON.stringify({ not: "an array" }));
    expect(await loadConnections()).toEqual([]);
    expect(backupKeys()).toHaveLength(1);
  });
});
