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
  force?: boolean,
  onProgress?: (evt: import("@/lib/manifest/shared").ConnectProgress) => void
): Promise<ManifestView> {
  const res = await fetch("/api/manifest/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, creds, force }),
  });
  const ctype = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || !ctype.includes("ndjson")) {
    // Non-stream path: a 4xx before the stream opened, OR a server that still
    // returns a single JSON ManifestView (e.g. dev server not yet restarted on
    // the streaming route) — parse it directly rather than mis-reading it as
    // NDJSON (which would throw "ended without a result").
    return json<ManifestView>(res);
  }
  // NDJSON stream: {type:"progress",...} lines, then one {type:"result"|"error"}.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let view: ManifestView | null = null;
  let error: string | null = null;
  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(t);
    } catch {
      return; // partial/garbled line — ignore, the buffer keeps the remainder
    }
    if (msg.type === "progress") {
      const { type: _t, ...evt } = msg;
      onProgress?.(evt as import("@/lib/manifest/shared").ConnectProgress);
    } else if (msg.type === "result") {
      view = msg.view as ManifestView;
    } else if (msg.type === "error") {
      error = String(msg.error ?? "Failed to read that manifest");
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  if (buf) handleLine(buf);
  if (error) throw new Error(error);
  if (!view) throw new Error("Connect stream ended without a result");
  return view;
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

/** The selection pre-step (spec §7): which entities does this question need? */
export async function selectManifestEntities(
  manifestId: string,
  question: string
): Promise<{ entities: string[]; usedFallback?: boolean; autoIncluded?: string[] }> {
  const res = await fetch("/api/manifest/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manifestId, question }),
  });
  return json<{ entities: string[]; usedFallback?: boolean }>(res);
}
