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
 * Validate that a request originates from localhost.
 * Checks the Origin header to prevent DNS rebinding attacks.
 */
export function validateLocalOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  // No Origin header — allow (same-origin requests from the page itself
  // omit Origin on GET, and server-side fetches have no Origin)
  if (!origin) return true;

  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
