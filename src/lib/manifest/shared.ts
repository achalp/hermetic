/**
 * Shared limits + helpers for the manifest adapters (spec §4, §8).
 *
 * Everything here treats the manifest as UNTRUSTED remote content: names and
 * descriptions are clamped and stripped of control characters because they flow
 * into LLM prompts (a prompt-injection surface the spec names explicitly), and
 * the entity count fails LOUDLY over the cap rather than truncating silently —
 * the same posture as the S3 enumeration ceiling (s3-list.ts).
 */
import type { ManifestEntity } from "@/lib/contracts/dataset-manifest";

/** Hard ceiling on entities per manifest — over it, the connect fails loudly. */
export const MAX_MANIFEST_ENTITIES = 200;
/** Byte cap the P1 fetch enforces on the manifest document itself. */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
/** Wall-clock budget for eager introspection (spec §5.5). Lives here (pure)
 *  because BOTH sides consume it: the server's docker batch and — D40 item 3 —
 *  the client's background loop on runtimes where the server can't be eager. */
export const MANIFEST_EAGER_BUDGET_MS = 60_000;
export const MAX_NAME_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_COLUMN_DOC_CHARS = 300;

/** A manifest that was recognized but cannot be used — message is user-facing. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** C0 controls (minus tab/newline, which trim handles) + DEL. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Strip control characters and clamp — applied to EVERY string that leaves an adapter. */
export function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_CHARS, "").trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Finite non-negative integer, or undefined — hints must never carry NaN into a schema. */
export function toCountHint(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return Math.trunc(n);
}

/**
 * Resolve a manifest entry's path against the manifest URL. Absolute URLs
 * (any scheme — s3://, gs://, https://) pass through; relative paths resolve
 * against the manifest's own location, which makes them same-host by construction.
 */
export function resolveEntryUrl(path: string, manifestUrl: string): string | null {
  try {
    return new URL(path).href;
  } catch {
    try {
      return new URL(path, manifestUrl).href;
    } catch {
      return null;
    }
  }
}

/** Does this path name parquet data we can read — a .parquet file or a glob? */
export function isParquetish(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0]!;
  return /\.parquet$/i.test(path) || path.includes("*");
}

/** Entity display name: basename without extension, slugified. */
export function entityNameFrom(raw: string | undefined, url: string): string {
  const base = raw?.trim() || (url.split(/[?#]/, 1)[0]!.split("/").filter(Boolean).pop() ?? "");
  const slug = base
    .replace(/\.parquet$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return (slug || "entity").slice(0, MAX_NAME_CHARS);
}

/**
 * Enforce unique entity names by suffixing -2, -3, … A collision must not merge
 * two entities silently — selection is BY NAME, and a merged name would let a
 * question read the wrong data.
 */
export function dedupeNames(entities: ManifestEntity[]): ManifestEntity[] {
  const seen = new Map<string, number>();
  return entities.map((e) => {
    const n = seen.get(e.name) ?? 0;
    seen.set(e.name, n + 1);
    return n === 0 ? e : { ...e, name: `${e.name}-${n + 1}` };
  });
}

/** Shared post-processing every adapter output passes through. */
export function finalizeEntities(entities: ManifestEntity[]): ManifestEntity[] {
  if (entities.length > MAX_MANIFEST_ENTITIES) {
    throw new ManifestError(
      `This manifest lists ${entities.length} parquet entities — more than the ` +
        `${MAX_MANIFEST_ENTITIES} Hermetic supports. Narrow the source, or connect a ` +
        `single entity's URL directly.`
    );
  }
  return dedupeNames(entities);
}

/** A sha256 from common manifest spellings ("<hex>" or "sha256:<hex>"). */
export function sha256From(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : undefined;
}

/** Is this URL manifest-shaped (vs a parquet file/prefix)? Detection per §5.1. */
export function isManifestUrl(url: string): boolean {
  const path = url.trim().split(/[?#]/, 1)[0]!;
  return /\.(json|jsonld)$/i.test(path);
}
