import { NextResponse } from "next/server";
import { resolve } from "node:path";
import { getFileInfo } from "@/lib/local-files/browser";
import { validateLocalOrigin, isAllowedExtension } from "@/lib/local-files/security";

export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  const body = await request.json();
  const { path: rawPath, type } = body as { path: string; type: "file" | "folder" };

  if (!rawPath || !type) {
    return NextResponse.json({ error: "path and type are required" }, { status: 400 });
  }

  const filePath = resolve(rawPath);

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
    const message = err instanceof Error ? err.message : "Failed to access file";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
