//! `egress-fetch` — the host-side remote-read edge for the WASM/desktop runtime
//! (build log D9). It is how the Node sidecar materializes a REMOTE source without
//! the untrusted worker ever touching the network: the sidecar spawns this bin, it
//! runs the §6a-tested `authorize_and_fetch` (allowlist + resolve-and-reject +
//! DNS-rebinding-proof IP pinning + no-follow redirects re-authorized per hop +
//! byte-cap), and streams the vetted object bytes to stdout. The worker then reads
//! the materialized bytes as a LOCAL file — so `codeDoesRemoteIo` stays false and
//! the sandbox boundary is unchanged.
//!
//! Reusing the exact Rust decision core (not a reimplementation) is the whole point:
//! one adversarially-tested egress boundary, invoked from TypeScript by spawning
//! this bin (the @napi-rs/keyring-style native binding is a heavier follow-on; a
//! subprocess is the simplest correct reuse and matches the egress-proxy precedent).
//!
//! CONTRACT (all inputs from the trusted SIDECAR, never the worker):
//!   argv[1]              the request URL (validated by authorize_fetch; never
//!                        worker-supplied — the sidecar passes the STORED source URL)
//!   env HERMETIC_EGRESS_ALLOWLIST   comma-separated vhost allowlist (required)
//!   env HERMETIC_EGRESS_CAP_BYTES   byte-cap (optional; default 2 GiB)
//!   env HERMETIC_EGRESS_BEARER      bearer token (optional; via ENV, never argv —
//!                                   argv is world-readable via `ps`)
//!   env HERMETIC_EGRESS_HEADER_NAME / _VALUE   arbitrary auth header (optional)
//!   stdout   the object bytes on success
//!   stderr   a one-line diagnostic on failure
//!   exit     0 ok · 1 denied · 2 transport · 3 cap-exceeded · 4 redirect-denied ·
//!            5 unparseable-redirect · 64 usage
use std::io::Write;
use std::process::ExitCode;

use hermetic_egress_core::fetch::{authorize_and_fetch, Credentials, FetchError, SystemResolver};

const DEFAULT_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB

fn main() -> ExitCode {
    let url = match std::env::args().nth(1) {
        Some(u) => u,
        None => {
            eprintln!("egress-fetch: usage: egress-fetch <url>  (allowlist via HERMETIC_EGRESS_ALLOWLIST)");
            return ExitCode::from(64);
        }
    };

    let allowlist: Vec<String> = std::env::var("HERMETIC_EGRESS_ALLOWLIST")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if allowlist.is_empty() {
        // Fail closed: no allowlist ⇒ nothing is authorized (never fetch "anything").
        eprintln!("egress-fetch: refusing — empty HERMETIC_EGRESS_ALLOWLIST (fail closed)");
        return ExitCode::from(1);
    }

    let cap = std::env::var("HERMETIC_EGRESS_CAP_BYTES")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_CAP_BYTES);

    // Credentials come from the environment (the sidecar reads them from the OS
    // keychain at the executor boundary), NEVER from argv — argv is visible to any
    // local process via `ps`.
    let creds = if let Ok(token) = std::env::var("HERMETIC_EGRESS_BEARER") {
        Credentials::Bearer(token)
    } else if let (Ok(name), Ok(value)) = (
        std::env::var("HERMETIC_EGRESS_HEADER_NAME"),
        std::env::var("HERMETIC_EGRESS_HEADER_VALUE"),
    ) {
        Credentials::Header { name, value }
    } else {
        Credentials::None
    };

    match authorize_and_fetch(&url, &allowlist, &SystemResolver, &creds, cap) {
        Ok(bytes) => {
            // Bytes → stdout (binary-safe); a broken pipe is a transport failure.
            let mut out = std::io::stdout().lock();
            if let Err(e) = out.write_all(&bytes).and_then(|_| out.flush()) {
                eprintln!("egress-fetch: write failed: {e}");
                return ExitCode::from(2);
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            let (code, msg) = match &err {
                FetchError::Denied(r) => (1, format!("denied: {r:?}")),
                FetchError::Transport(m) => (2, format!("transport: {m}")),
                FetchError::CapExceeded { read } => (3, format!("cap exceeded after {read} bytes")),
                FetchError::RedirectNotAllowed(r) => (4, format!("redirect denied: {r:?}")),
                FetchError::UnparseableRedirect(l) => (5, format!("unparseable redirect: {l}")),
                FetchError::BadRedirectScheme(s) => (5, format!("bad redirect scheme: {s}")),
                FetchError::TooManyRedirects => (4, "too many redirects".to_string()),
            };
            eprintln!("egress-fetch: {msg}");
            ExitCode::from(code)
        }
    }
}
