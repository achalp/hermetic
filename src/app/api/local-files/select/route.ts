import { NextResponse } from "next/server";
import { resolve } from "node:path";
import { apiError } from "@/app/lib/api-error";
import { getFileInfo } from "@/lib/local-files/browser";
import {
  validateLocalOrigin,
  isAllowedExtension,
  isPathAllowed,
  PATH_NOT_ALLOWED_ERROR,
} from "@/lib/local-files/security";
import { parseBody, LocalFileSelectSchema } from "@/lib/api-schemas";

export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  const parsed = parseBody(LocalFileSelectSchema, await request.json());
  if (!parsed.ok) return parsed.response;
  const { path: rawPath, type } = parsed.data;

  const filePath = resolve(rawPath);

  // Root-jail — see lib/local-files/security.ts isPathAllowed.
  if (!isPathAllowed(filePath)) {
    return NextResponse.json({ error: PATH_NOT_ALLOWED_ERROR }, { status: 403 });
  }

  try {
    const info = await getFileInfo(filePath);

    if (type === "file") {
      if (info.isDirectory) {
        return NextResponse.json({ error: "Expected a file, got a directory" }, { status: 400 });
      }
      if (!isAllowedExtension(info.name)) {
        return NextResponse.json(
          { error: `File type not supported: ${info.extension}` },
          { status: 400 }
        );
      }
    } else if (type === "folder") {
      if (!info.isDirectory) {
        return NextResponse.json({ error: "Expected a directory, got a file" }, { status: 400 });
      }
      if (!info.isParquetFolder) {
        return NextResponse.json(
          { error: "Folder does not contain Parquet files" },
          { status: 400 }
        );
      }
    }

    // Include an informational note for large files (> 1 GB)
    const ONE_GB = 1024 * 1024 * 1024;
    const infoMessage =
      !info.isDirectory && info.size > ONE_GB
        ? `File is ${(info.size / ONE_GB).toFixed(1)} GB. DuckDB will stream it efficiently.`
        : undefined;

    return NextResponse.json({
      path: info.path,
      name: info.name,
      size: info.size,
      mtime: info.mtime,
      extension: info.extension,
      isDirectory: info.isDirectory,
      isParquetFolder: info.isParquetFolder,
      isHivePartitioned: info.isHivePartitioned,
      info: infoMessage,
    });
  } catch (err) {
    return apiError("/api/local-files/select", err, "Failed to access file", 400);
  }
}
