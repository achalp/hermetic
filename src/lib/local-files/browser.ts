import "server-only";
import { readdir, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";
import { isDotfile, isAllowedExtension } from "./security";
import { isHivePartitionSegment } from "@/lib/parquet/partition";

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  /** File size in bytes (files only) */
  size?: number;
  /** Last modification time as epoch ms (files only) */
  mtime?: number;
  /** File extension including dot, e.g. ".parquet" (files only) */
  extension?: string;
  /** True if this directory contains .parquet files (flat or Hive-partitioned) */
  isParquetFolder?: boolean;
  /** True if this is a Hive-partitioned dataset (subdirs like key=value) */
  isHivePartitioned?: boolean;
}

/**
 * Check if a directory contains .parquet files, either directly (flat)
 * or via Hive-style partitioning (subdirs named key=value with .parquet
 * files nested inside). Searches up to 3 levels deep.
 */
async function detectParquetFolder(
  dirPath: string,
  depth = 0
): Promise<{ isParquet: boolean; isHive: boolean }> {
  if (depth > 3) return { isParquet: false, isHive: false };

  try {
    const children = await readdir(dirPath, { withFileTypes: true });

    // Flat: directory directly contains .parquet files
    if (children.some((c) => c.isFile() && c.name.toLowerCase().endsWith(".parquet"))) {
      return { isParquet: true, isHive: false };
    }

    // Hive: subdirectories matching key=value pattern
    const hiveDirs = children.filter((c) => c.isDirectory() && isHivePartitionSegment(c.name));
    if (hiveDirs.length > 0) {
      // Check the first partition dir recursively
      const sub = await detectParquetFolder(join(dirPath, hiveDirs[0].name), depth + 1);
      if (sub.isParquet || sub.isHive) {
        return { isParquet: true, isHive: true };
      }
    }
  } catch {
    // Can't read — not a parquet folder
  }

  return { isParquet: false, isHive: false };
}

/**
 * Return the user's home directory as the default browse location.
 */
export function getHomePath(): string {
  return homedir();
}

/**
 * List a directory's contents, filtering out dotfiles and non-data files.
 * Directories are always included (unless dotfiles). Files are filtered
 * to allowed data extensions.
 *
 * Returns directories first, then files, both sorted alphabetically.
 */
export async function listDirectory(dirPath: string): Promise<FileEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });

  const results: FileEntry[] = [];

  for (const entry of entries) {
    if (isDotfile(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Check if this directory is a Parquet folder (flat or Hive-partitioned)
      const parquetInfo = await detectParquetFolder(fullPath);

      results.push({
        name: entry.name,
        path: fullPath,
        isDirectory: true,
        isParquetFolder: parquetInfo.isParquet,
        isHivePartitioned: parquetInfo.isHive,
      });
    } else if (entry.isFile() && isAllowedExtension(entry.name)) {
      try {
        const info = await stat(fullPath);
        results.push({
          name: entry.name,
          path: fullPath,
          isDirectory: false,
          size: info.size,
          mtime: info.mtimeMs,
          extension: extname(entry.name).toLowerCase(),
        });
      } catch {
        // Can't stat — skip this file
      }
    }
  }

  // Sort: directories first (alphabetical), then files (alphabetical)
  results.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Get detailed info about a single file or folder.
 */
export async function getFileInfo(filePath: string): Promise<{
  path: string;
  name: string;
  size: number;
  mtime: number;
  extension: string;
  isDirectory: boolean;
  isParquetFolder: boolean;
  isHivePartitioned?: boolean;
}> {
  const info = await stat(filePath);
  const name = basename(filePath);
  const extension = extname(filePath).toLowerCase();

  if (info.isDirectory()) {
    const parquetInfo = await detectParquetFolder(filePath);

    return {
      path: filePath,
      name,
      size: 0,
      mtime: info.mtimeMs,
      extension: "",
      isDirectory: true,
      isParquetFolder: parquetInfo.isParquet,
      isHivePartitioned: parquetInfo.isHive,
    };
  }

  return {
    path: filePath,
    name,
    size: info.size,
    mtime: info.mtimeMs,
    extension,
    isDirectory: false,
    isParquetFolder: false,
  };
}

/**
 * Format file size for display.
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
