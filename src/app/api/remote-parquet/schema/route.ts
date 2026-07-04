import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { extractRemoteParquetSchema } from "@/lib/parquet/schema-extractor";
import { isSafeParquetUrl } from "@/lib/parquet/duckdb-source";
import { normalizeRemoteParquetUrl } from "@/lib/parquet/partition";
import { storeRemoteParquetRef } from "@/lib/csv/storage";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import type { RemoteCreds } from "@/lib/types";
import { logger } from "@/lib/logger";

export const maxDuration = 300; // remote reads over the network can be slow

/** A human filename from a Parquet URL: the last path segment, or the host. */
function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url.replace(/^s3:\/\//i, "https://").replace(/^gs:\/\//i, "https://"));
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || u.hostname;
  } catch {
    return url.split("/").filter(Boolean).pop() || url;
  }
}

export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  try {
    const body = (await request.json()) as { url?: string; creds?: RemoteCreds };
    const url = typeof body.url === "string" ? body.url.trim() : "";

    if (!isSafeParquetUrl(url)) {
      return NextResponse.json(
        { error: "Enter a valid s3:// or https:// Parquet URL (no quotes or special characters)." },
        { status: 400 }
      );
    }

    // Only forward the recognized credential fields (drop anything else).
    const creds: RemoteCreds | undefined = body.creds
      ? {
          s3Region: body.creds.s3Region,
          s3AccessKeyId: body.creds.s3AccessKeyId,
          s3SecretAccessKey: body.creds.s3SecretAccessKey,
          s3Endpoint: body.creds.s3Endpoint,
        }
      : undefined;

    // Apply layout conventions: a bare folder/prefix (e.g. an Overture
    // theme=…/type=… path) becomes a recursive Parquet glob; Hive partitioning
    // is inferred from key=value segments. A single-file URL passes through.
    const { readUrl, isHivePartitioned } = normalizeRemoteParquetUrl(url);

    const runtime = getActiveSandboxRuntime();
    const csvId = uuidv4();
    const filename = filenameFromUrl(url);

    const schema = await extractRemoteParquetSchema(
      readUrl,
      csvId,
      filename,
      runtime,
      isHivePartitioned,
      creds
    );
    storeRemoteParquetRef(csvId, schema, readUrl, creds, isHivePartitioned);

    return NextResponse.json({ csv_id: csvId, schema });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read remote Parquet";
    logger.warn("Remote Parquet schema failed", { error: message.slice(0, 300) });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
