//! Hermetic desktop shell — Tauri v2 builder (build log D15 / Phase 0c).
//!
//! Three-context model (specs/pyodide-wasm-sandbox-2026-08-26.md §4a):
//!
//! ```text
//! Rust core ── spawns ──▶ Node sidecar (TRUSTED)     Webview (UNTRUSTED content)
//! (this crate)            the Next standalone server   the Next UI + the Pyodide/
//!                         (lib pipeline/orchestrator)   DuckDB-WASM execution worker
//! ```
//!
//! Security posture (§7):
//!   - §7 #1: the IPC surface reachable from webview JS is EMPTY of host-touching
//!     commands. NO custom `invoke` handlers; the capability set grants only
//!     `core:default` + window basics; `withGlobalTauri:false` removes
//!     `window.__TAURI__`. The sidecar is spawned from RUST via `std::process`
//!     (NOT a shell plugin), so no spawn/exec command is ever exposed to the page.
//!   - §7 #2: the execution worker gets its OWN stricter CSP at runtime (D8=self:
//!     `script-src 'self' 'wasm-unsafe-eval' blob:; connect-src 'self'`), served on
//!     the /api/wasm-worker response — NOT the app CSP here.
//!
//! Runtime: in release the sidecar serves the app on a loopback port and the window
//! loads it; in `tauri dev` (debug) the window uses the dev server (devUrl) and no
//! sidecar is spawned. The sidecar's lifecycle is tied to the app — killed on exit.

use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The spawned sidecar, kept so we can kill it when the app exits.
struct Sidecar(Mutex<Option<Child>>);

/// Pick a free loopback TCP port by binding :0 and reading the assigned port.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Block until the sidecar accepts connections on `port` (or time out).
fn wait_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Resolve the bundled sidecar dir (the assembled Next standalone server + node +
/// assets). Bundled under the app resource dir as `sidecar/` (tauri.conf resources).
fn sidecar_dir(app: &tauri::App) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("sidecar");
    if dir.join("server.js").exists() {
        Some(dir)
    } else {
        None
    }
}

/// Spawn `node server.js` from the sidecar dir with the packaged environment, and
/// return the child + the loopback URL it serves.
fn spawn_sidecar(app: &tauri::App, dir: &PathBuf) -> std::io::Result<(Child, String)> {
    let port = free_port()?;
    // Writable roots live in the OS app-data dir (the bundle is read-only); the
    // asset root IS the bundle (docker/sandbox runtime + duckdb-wasm live there).
    let data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| dir.clone());
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let egress = dir
        .join("bin")
        .join(if cfg!(windows) { "egress-fetch.exe" } else { "egress-fetch" });

    let child = Command::new(node)
        .arg("server.js")
        .current_dir(dir)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("HERMETIC_ASSET_ROOT", dir)
        .env("HERMETIC_DATA_ROOT", data.join("data"))
        .env("HERMETIC_USER_ROOT", data.join("user"))
        .env("HERMETIC_SCRATCH_ROOT", data.join("scratch"))
        .env("HERMETIC_PYODIDE_DIR", dir.join("pyodide"))
        .env("HERMETIC_EGRESS_FETCH_BIN", egress)
        // The desktop ships the WASM tier + no Docker — force it, predictably.
        .env("HERMETIC_FORCE_RUNTIME", "wasm")
        .spawn()?;

    Ok((child, format!("http://127.0.0.1:{port}")))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // No `.invoke_handler(...)` on purpose (§7 #1): a custom command would be
        // reachable from untrusted webview JS. The sidecar is spawned from Rust below.
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            // Release: spawn the bundled sidecar and point the window at it. Debug
            // (`tauri dev`): use the dev server (devUrl in tauri.conf) — no sidecar.
            let url = match sidecar_dir(app) {
                Some(dir) => {
                    let (child, base) = spawn_sidecar(app, &dir)?;
                    app.state::<Sidecar>().0.lock().unwrap().replace(child);
                    // 60s: first boot compiles nothing (prebuilt) but loads the JS.
                    if !wait_ready(url_port(&base), Duration::from_secs(60)) {
                        eprintln!("[hermetic] sidecar did not become ready in time");
                    }
                    WebviewUrl::External(base.parse().expect("valid loopback url"))
                }
                // Dev / unbundled: load the Next dev server the developer is running
                // (`pnpm dev`, matching tauri.conf devUrl). No sidecar is spawned.
                None => WebviewUrl::External(
                    "http://localhost:3000".parse().expect("valid dev url"),
                ),
            };

            WebviewWindowBuilder::new(app, "main", url)
                .title("Hermetic")
                .inner_size(1280.0, 832.0)
                .min_inner_size(800.0, 600.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Hermetic desktop application")
        .run(|app, event| {
            // Kill the sidecar when the app exits so no orphan node lingers.
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}

/// Extract the port from a `http://127.0.0.1:PORT` base (built by spawn_sidecar).
fn url_port(base: &str) -> u16 {
    base.rsplit(':').next().and_then(|p| p.parse().ok()).unwrap_or(0)
}
