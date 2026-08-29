// Tauri build script: runs `tauri-build` codegen, which reads tauri.conf.json,
// validates it, and embeds the capability set (src-tauri/capabilities/*.json)
// into the compiled ACL. If a capability references a permission the enabled
// plugins do not provide, THIS build fails — that is the compile-time backstop
// for the §7 #1 "empty host-touching IPC surface" invariant.
fn main() {
    tauri_build::build();
}
