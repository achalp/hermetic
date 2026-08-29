// Prevents an extra console window on Windows in release. No effect on Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Thin shim: all wiring lives in lib.rs::run() (Tauri v2 convention).
fn main() {
    hermetic_desktop_lib::run();
}
