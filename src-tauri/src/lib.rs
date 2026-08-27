//! Hermetic desktop shell — Tauri v2 builder.
//!
//! This crate is the **trusted Rust core** in the §4a three-context model:
//!
//! ```text
//! Rust core ── spawns ──▶ Node sidecar (TRUSTED)     Webview (UNTRUSTED content)
//! (this crate)            the whole lib pipeline      the Next UI + the Pyodide/
//!                         orchestrator/LLM/storage     DuckDB-WASM execution worker
//! ```
//!
//! Security posture (specs/pyodide-wasm-sandbox-2026-08-26.md §7):
//!   - §7 #1: the IPC surface reachable from webview JS must be EMPTY of
//!     host-touching commands. So this builder registers NO custom `invoke`
//!     handlers that touch fs/shell/network, and the capability set
//!     (capabilities/default.json) grants only `core:default` + window basics.
//!     `withGlobalTauri:false` (tauri.conf.json) removes `window.__TAURI__`.
//!   - The execution worker gets its OWN stricter blob-document CSP at runtime
//!     (§7 #2: `connect-src 'none'; script-src blob: 'wasm-unsafe-eval'; …`),
//!     NOT the app CSP in tauri.conf.json.

// NOTE (§4a follow-on, Phase 0c): the Node standalone-server sidecar (bundled
// Next server + native `@napi-rs/keyring` addon) will be spawned here as a
// Tauri `externalBin` sidecar, and the main window URL will point at the
// sidecar's localhost origin instead of the dev server. The spawn belongs in a
// `.setup()` closure below (using tauri_plugin_shell::process::CommandExt /
// the sidecar API) so its lifecycle is tied to the app. It is deliberately NOT
// wired yet — this scaffold only proves the shell compiles against webkit.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // No `.invoke_handler(...)` on purpose: registering a custom command
        // here would expose it to untrusted webview JS via `invoke` (§7 #1).
        // Any future command MUST be gated behind an explicit capability and
        // must never be reachable from the execution-worker origin.
        //
        // No `.setup(...)` sidecar spawn yet — see the Phase 0c note above.
        .run(tauri::generate_context!())
        .expect("error while running the Hermetic desktop application");
}
