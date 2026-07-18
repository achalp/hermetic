import "server-only";
import { homedir } from "node:os";
import { resolve, sep, delimiter } from "node:path";
import { ALLOWED_LOCAL_EXTENSIONS } from "@/lib/constants";

/**
 * Check if a filename is a dotfile / hidden file.
 */
export function isDotfile(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Check if a filename has an allowed data file extension.
 */
export function isAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_LOCAL_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Roots the local-file browser may enter. Home dir by default; extendable via
 * HERMETIC_LOCAL_FILE_ROOTS (path-delimiter-separated, e.g. for data on an
 * external volume). Read lazily so tests can vary the env.
 */
export function allowedLocalRoots(): string[] {
  const extra = (process.env.HERMETIC_LOCAL_FILE_ROOTS ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
  return [resolve(homedir()), ...extra];
}

/**
 * Root-jail for user-supplied filesystem paths. `resolve()` normalizes `..`
 * but does NOT confine — before this check, any absolute path (/etc/passwd,
 * ~/.ssh of another user) was browsable/readable through the local-files
 * routes. The path must sit under an allowed root; the separator guard stops
 * prefix-escapes (/Users/x must not admit /Users/xevil).
 */
export function isPathAllowed(resolvedPath: string): boolean {
  return allowedLocalRoots().some(
    (root) => resolvedPath === root || resolvedPath.startsWith(root + sep)
  );
}

/** The 403 message for a path outside the jail — tells the user the remedy. */
export const PATH_NOT_ALLOWED_ERROR =
  "Path is outside the allowed folders (your home directory by default). " +
  "To browse another location, set HERMETIC_LOCAL_FILE_ROOTS to include it.";

/**
 * Validate that a request originates from localhost.
 * Checks the Origin header to prevent DNS rebinding attacks; when Origin is
 * absent (same-origin GETs, curl) it falls back to the Host header — a DNS-
 * rebinding request necessarily carries the attacker's hostname in Host, so
 * requiring a loopback Host closes that hole without breaking local tools.
 */
export function validateLocalOrigin(request: Request): boolean {
  const isLoopback = (value: string | null, viaUrl: boolean): boolean => {
    if (!value) return false;
    try {
      const hostname = viaUrl ? new URL(value).hostname : new URL(`http://${value}`).hostname;
      return hostname === "localhost" || hostname === "127.0.0.1";
    } catch {
      return false;
    }
  };

  const origin = request.headers.get("origin");
  if (origin) return isLoopback(origin, true);
  // No Origin (same-origin GET / non-browser client): require a loopback Host.
  return isLoopback(request.headers.get("host"), false);
}
