import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory backing store for the connections file.
let fileContent: string | null = null;
vi.mock("fs/promises", () => ({
  readFile: vi.fn(async () => {
    if (fileContent === null) throw new Error("ENOENT");
    return fileContent;
  }),
  writeFile: vi.fn(async (_path: string, data: string) => {
    fileContent = data;
  }),
  unlink: vi.fn(async () => {
    fileContent = null;
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
  fileContent = null;
  keychainState.available = true;
  keychainState.blobs.clear();
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
    expect(fileContent).not.toContain("secret"); // the boundary that matters
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
    expect(fileContent).not.toContain("BEGIN");
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
    expect(fileContent).toContain("secret"); // deliberate: headless keeps working
    const loaded = await loadConnections();
    expect((loaded[0].config as { password?: string }).password).toBe("secret");
  });

  it("migrates a pre-keychain file's embedded credentials on first load", async () => {
    // Seed a legacy-format file (credentials embedded).
    fileContent = JSON.stringify([
      {
        id: "legacy-1",
        label: "PostgreSQL: db.example.com/analytics",
        config: PG,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    const loaded = await loadConnections();
    // Returned config is complete...
    expect((loaded[0].config as { password?: string }).password).toBe("secret");
    // ...the rewritten file is scrubbed, and the keychain holds the credential.
    expect(fileContent).not.toContain("secret");
    expect(keychainState.blobs.get("legacy-1")).toEqual({ password: "secret" });
  });

  it("rename does not leak credentials back into the file", async () => {
    const saved = await saveConnection(PG);
    await renameConnection(saved.id, "renamed");
    expect(fileContent).toContain("renamed");
    expect(fileContent).not.toContain("secret");
  });
});
