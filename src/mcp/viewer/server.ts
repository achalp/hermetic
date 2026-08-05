/**
 * The embedded viewer server (mcp-server spec §4 M3) — a plain node http
 * listener inside the MCP process, so `analyze` links always resolve without
 * a separately running web harness.
 *
 * Surface (loopback-only by construction — binds 127.0.0.1):
 *   GET /?restore=<id>   → viewer.html (the built SpecView bundle shell)
 *   GET /assets/*        → files from src/mcp/viewer/dist (built by
 *                          `pnpm mcp:build-viewer`; 503 with instructions
 *                          when the bundle is missing)
 *   GET /api/spec/<id>   → { spec, question } from the persisted history
 *                          entry — id strictly validated, path never joined
 *                          from raw input beyond that.
 *   GET /api/export/<id> → the entry as ONE self-contained .html download
 *                          (specs/dashboard-distribution-2026-08-05.md §4.2)
 *                          — the viewer entry's Download button targets this.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { hermeticPaths } from "@/lib/paths";
import { RECORD_FILES } from "@/lib/record-store";
// Server-side node code, so the export assembler (a framework-free lib) is
// imported directly — the McpDeps seam covers tool handlers, not this server.
import { exportDashboardHtml, exportFilename } from "@/lib/export/html-export";
import { logger } from "@/lib/logger";

const DIST = resolve(__dirname, "dist");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const BUILD_HELP =
  "The MCP viewer bundle is not built. Run `pnpm mcp:build-viewer` in the hermetic checkout, " +
  "then reload this page.";

const EXPORT_BUILD_HELP =
  "The single-file export bundles are not built. Run `pnpm mcp:build-viewer` in the hermetic " +
  "checkout, then retry the download.";

export interface ViewerServer {
  port: number;
  close(): Promise<void>;
}

export function startViewerServer(preferredPort: number): Promise<ViewerServer> {
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: string | Buffer, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    };
    try {
      // Loopback-only by bind, but a rebinding page could still target us by
      // name; require a loopback Host (review S16).
      const host = (req.headers.host ?? "").split(":")[0];
      if (host && host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
        return send(403, JSON.stringify({ error: "local access only" }));
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/api/health") return send(200, JSON.stringify({ ok: true }));

      if (path.startsWith("/api/spec/")) {
        const id = path.slice("/api/spec/".length);
        if (!UUID_RE.test(id)) return send(400, JSON.stringify({ error: "invalid id" }));
        const entryDir = join(hermeticPaths.historyDir(), id);
        if (!existsSync(join(entryDir, RECORD_FILES.spec))) {
          return send(404, JSON.stringify({ error: `no history entry ${id}` }));
        }
        const spec = JSON.parse(await readFile(join(entryDir, RECORD_FILES.spec), "utf-8"));
        let question: string | null = null;
        try {
          const meta = JSON.parse(await readFile(join(entryDir, RECORD_FILES.meta), "utf-8"));
          question = typeof meta.question === "string" ? meta.question : null;
        } catch {
          // meta is optional for rendering
        }
        return send(200, JSON.stringify({ spec, question }));
      }

      if (path.startsWith("/api/export/")) {
        const id = path.slice("/api/export/".length);
        if (!UUID_RE.test(id)) return send(400, JSON.stringify({ error: "invalid id" }));
        const entryDir = join(hermeticPaths.historyDir(), id);
        if (!existsSync(join(entryDir, RECORD_FILES.spec))) {
          return send(404, JSON.stringify({ error: `no history entry ${id}` }));
        }
        if (!existsSync(join(DIST, "export-manifest.json"))) {
          return send(503, EXPORT_BUILD_HELP, "text/plain; charset=utf-8");
        }
        const spec = JSON.parse(await readFile(join(entryDir, RECORD_FILES.spec), "utf-8"));
        let question: string | null = null;
        let createdAt: string | null = null;
        try {
          const meta = JSON.parse(await readFile(join(entryDir, RECORD_FILES.meta), "utf-8"));
          question = typeof meta.question === "string" ? meta.question : null;
          if (typeof meta.timestamp === "number") {
            createdAt = new Date(meta.timestamp).toISOString();
          }
        } catch {
          // meta is optional for exporting too — the watermark just goes blank
        }
        const { html, report } = await exportDashboardHtml({
          spec,
          question,
          createdAt,
          distDir: DIST,
        });
        res.writeHead(200, {
          "Content-Type": MIME[".html"],
          "Content-Disposition": `attachment; filename="${exportFilename(question)}"`,
          "Cache-Control": "no-store",
          // Same report headers as the web routes — one wire contract.
          "X-Hermetic-Export-Bundle": report.bundle,
          "X-Hermetic-Export-Bytes": String(report.bytes),
        });
        return res.end(html);
      }

      if (path === "/" || path === "/index.html") {
        const shell = join(DIST, "viewer.html");
        if (!existsSync(shell)) return send(503, BUILD_HELP, "text/plain; charset=utf-8");
        return send(200, await readFile(shell), MIME[".html"]);
      }

      if (path.startsWith("/assets/")) {
        // Resolve inside DIST only — traversal collapses out, then must
        // still prefix-match.
        const file = resolve(DIST, "." + path.slice("/assets".length));
        if (!file.startsWith(DIST + "/")) return send(403, "forbidden", "text/plain");
        if (!existsSync(file)) return send(404, "not found", "text/plain");
        const type = MIME[extname(file)] ?? "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": type,
          // Chunks are content-hashed — cache hard; entry files are not.
          "Cache-Control": file.includes("/chunks/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        });
        return res.end(await readFile(file));
      }

      send(404, "not found", "text/plain");
    } catch (err) {
      logger.warn("MCP viewer request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      send(500, JSON.stringify({ error: "internal error" }), "application/json");
    }
  });

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let retriedEphemeral = false;

    const settleListening = () => {
      const addr = server.address();
      if (settled) return;
      if (addr && typeof addr === "object") {
        settled = true;
        resolvePromise({ port: addr.port, close: () => closeServer(server) });
      } else {
        settled = true;
        reject(new Error("viewer server: no address"));
      }
    };

    // ONE error path (review S16): the preferred port being taken triggers a
    // single ephemeral retry; anything else — including a failed retry —
    // rejects. Never leaves the promise pending or throws unhandled.
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (err.code === "EADDRINUSE" && !retriedEphemeral) {
        retriedEphemeral = true;
        server.listen(0, "127.0.0.1");
        return;
      }
      settled = true;
      reject(err);
    });

    server.on("listening", settleListening);
    server.listen(preferredPort, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}
