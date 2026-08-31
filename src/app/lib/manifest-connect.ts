"use client";

/**
 * Client half of the manifest flow (spec §5/§6). Lives beside the typed API
 * client (api.ts stays a per-endpoint client under its size ratchet — same
 * split as remote-parquet-connect.ts).
 *
 * The LAZY path deliberately reuses `extractRemoteParquetSchema`: that client
 * function already drives the per-entity extraction on BOTH runtimes (including
 * the wasm two-hop worker round trip), so a pending entity needs no new
 * machinery — introspect it as if its URL had been pasted directly, then attach
 * the resulting csvId back to the manifest so the store learns it is ready.
 */
import type { ManifestView, ManifestEntityDetail } from "@/lib/manifest/view";

export type { ManifestView, ManifestEntityDetail };
import { extractRemoteParquetSchema, type RemoteParquetCreds } from "@/app/lib/api";

async function json<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export async function connectManifest(
  url: string,
  creds?: RemoteParquetCreds,
  force?: boolean
): Promise<ManifestView> {
  const res = await fetch("/api/manifest/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, creds, force }),
  });
  return json<ManifestView>(res);
}

export async function getManifestEntityDetail(
  manifestId: string,
  name: string
): Promise<ManifestEntityDetail> {
  const res = await fetch(
    `/api/manifest/${encodeURIComponent(manifestId)}?entity=${encodeURIComponent(name)}`
  );
  return json<ManifestEntityDetail>(res);
}

/**
 * Make an entity READY (extracting lazily if needed) and return its detail —
 * the browser's click-to-view and "Analyze this entity" both land here.
 */
export async function ensureManifestEntity(
  view: ManifestView,
  name: string,
  creds?: RemoteParquetCreds
): Promise<ManifestEntityDetail> {
  const entity = view.entities.find((e) => e.name === name);
  if (!entity) throw new Error(`Unknown entity: ${name}`);
  if (entity.status === "ready") return getManifestEntityDetail(view.manifestId, name);

  // Pending (or retrying a failure): the existing per-entity flow does the
  // work — docker server-side, wasm via the two-hop worker round trip.
  const extracted = await extractRemoteParquetSchema(entity.url, creds);
  const res = await fetch("/api/manifest/attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifestId: view.manifestId, name, csvId: extracted.csv_id }),
  });
  return json<ManifestEntityDetail>(res);
}
