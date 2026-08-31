/**
 * In-flight manifest sources (spec §4/§5): one record per connected manifest,
 * holding the gated entity list and each entity's introspection state. A
 * "ready" entity has been registered under its own csvId via
 * `storeRemoteParquetRef` — from that moment every existing per-entity
 * mechanism (question pipeline, wasm handoff, refresh) works on it untouched;
 * this store only remembers WHICH csvIds belong to WHICH manifest, and what is
 * still pending.
 *
 * In-memory with the same lifecycle as csv storage (the expensive artifacts —
 * per-entity schemas — persist in schema-cache, keyed per entity URL, so a
 * reconnect after restart is cache-hits, not re-extraction). The singleton is
 * globalThis-pinned like the other cross-route registries: the connect route
 * writes and the browser/attach routes read from separate dev module graphs.
 */
import { stateBox } from "@/lib/state-store";
import type {
  DatasetManifest,
  ExcludedEntry,
  ManifestEntity,
} from "@/lib/contracts/dataset-manifest";
import type { RemoteCreds } from "@/lib/contracts/storage-types";

export type EntityStatus = "pending" | "ready" | "failed";

export interface EntityState {
  entity: ManifestEntity;
  status: EntityStatus;
  /** Set when ready — the id every downstream mechanism keys on. */
  csvId?: string;
  /** Exact count once introspected (rowCountHint until then). */
  rowCount?: number;
  columnCount?: number;
  /** User-facing extraction failure (friendlyParquetError output). */
  error?: string;
}

export interface ManifestRecord {
  manifestId: string;
  manifest: DatasetManifest;
  excluded: ExcludedEntry[];
  entities: Map<string, EntityState>;
  creds?: RemoteCreds;
  /** sha256 of the manifest bytes — the whole-source fingerprint. */
  manifestHash: string;
  connectedAt: number;
}

export interface ManifestStore {
  put(record: ManifestRecord): void;
  get(manifestId: string): ManifestRecord | undefined;
  /** Mark one entity ready (or failed) — returns false when unknown. */
  setEntityState(manifestId: string, name: string, state: Partial<EntityState>): boolean;
  size(): number;
}

export function createManifestStore(): ManifestStore {
  const records = new Map<string, ManifestRecord>();
  return {
    put(record) {
      records.set(record.manifestId, record);
    },
    get(manifestId) {
      return records.get(manifestId);
    },
    setEntityState(manifestId, name, state) {
      const entity = records.get(manifestId)?.entities.get(name);
      if (!entity) return false;
      Object.assign(entity, state);
      return true;
    },
    size() {
      return records.size;
    },
  };
}

const box = stateBox<ManifestStore>("dataset-manifest-store", createManifestStore);

/** The shared store — written by /api/manifest/connect, read by browse/attach. */
export function getManifestStore(): ManifestStore {
  return box.get();
}
