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

import { saveConnection, renameConnection, loadConnections } from "@/lib/warehouse/persist-env";
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
