//! # hermetic-egress-core
//!
//! The §6a egress-proxy **DECISION** logic, ported to pure Rust for the Tauri
//! trusted core. This is the fetch-time half of the guard whose pre-flight half
//! lives in `src/lib/sandbox/wasm/egress-guard.ts` (`authorizeEgress`).
//!
//! The untrusted worker (`connect-src 'none'`, DuckDB-WASM httpfs OFF) can only
//! *request* a URL; the trusted core is the egress boundary. This crate encodes
//! everything the core must guarantee **before** it opens a socket, and does so
//! with **NO real network in the decision path** — DNS is injected through the
//! [`Resolver`] trait so every branch is unit-testable without a socket.
//!
//! What lives here (the terminating-fetch guarantees of spec §6a):
//!
//! 1. [`ip::is_blocked_ip`] — resolve-and-reject classification, the **desktop**
//!    variant (stricter than `egress-proxy.py`: also rejects RFC-1918 / CGNAT;
//!    see `ip.rs` for the documented divergence).
//! 2. [`host_allowed`] — exact, case-insensitive vhost membership (never a
//!    generic-host widening — `s3://bucket/…` must not yield `s3.amazonaws.com`).
//! 3. [`redirect_allowed`] — reject a cross-host redirect to a non-allowlisted
//!    host; the caller MUST re-run [`ip::is_blocked_ip`] on **every hop** because
//!    even a same-host redirect can rebind (see the function docs).
//! 4. [`ByteCounter`] — streaming byte-cap: count bytes as they arrive and abort
//!    at N, treating any `Content-Length` as untrusted (never pre-allocate).
//! 5. [`Resolver`] + [`authorize_fetch`] — ties it together into the single
//!    decision the core asks before fetching.
//!
//! What deliberately does **NOT** live here: the actual socket / TLS / HTTP
//! fetch. That thin edge (reqwest/hyper/rustls) is left as the [`Fetcher`] trait
//! with a TODO stub — see its docs — so the decision logic stays pure.

pub mod fetch;
pub mod ip;
pub mod url;

use std::net::IpAddr;

pub use fetch::{
    authorize_and_fetch, authorize_and_fetch_with, Credentials, FetchError, SystemFetcher,
    SystemResolver,
};
pub use ip::is_blocked_ip;
pub use url::{parse_url, ParsedUrl};

// ---------------------------------------------------------------------------
// 2. Host allowlist membership
// ---------------------------------------------------------------------------

/// Exact, case-insensitive membership of `host` in `allowlist`.
///
/// This is intentionally NOT a suffix / wildcard match. The allowlist is
/// derived vhost-scoped (`deriveAllowedEgressHosts`), so `bucket.s3.amazonaws.com`
/// is a member while the generic `s3.amazonaws.com` is not — a suffix match
/// would re-open the every-bucket exfiltration door the allowlist exists to
/// close (spec §6a vector 8; `egress.ts` "vhost-only" rationale).
pub fn host_allowed(host: &str, allowlist: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    allowlist.iter().any(|h| h.to_ascii_lowercase() == host)
}

// ---------------------------------------------------------------------------
// 3. Redirect policy
// ---------------------------------------------------------------------------

/// Whether a redirect from `from_host` to `to_host` may be followed.
///
/// Spec §6a: "No auto-redirects. Reject 3xx, **or** re-run the full allowlist +
/// resolve-and-reject on **every hop** (a same-host redirect can still rebind)."
///
/// This function enforces the **host-allowlist** half of that rule: the redirect
/// target host must itself be an allowlist member. It returns `true` for a
/// same-host redirect and for a cross-host redirect whose target is allowlisted;
/// it returns `false` for a redirect to any non-allowlisted host.
///
/// # The caller MUST still resolve-and-reject every hop
///
/// A `true` here is necessary but **NOT sufficient** to follow the redirect. An
/// allowlisted host — including the SAME host — can re-resolve to a different,
/// now-internal IP between hops (DNS rebinding). The caller must call
/// [`ip::is_blocked_ip`] on the freshly resolved address of **each** hop (that
/// is exactly what [`authorize_fetch`] does for the initial hop; a redirect is
/// just another hop and gets the same treatment). Prefer
/// [`redirect_target_authorized`] which performs both checks.
pub fn redirect_allowed(_from_host: &str, to_host: &str, allowlist: &[String]) -> bool {
    host_allowed(to_host, allowlist)
}

/// Full per-hop redirect authorization: host must be allowlisted AND every
/// freshly resolved IP for the target host must be non-internal. This is the
/// "re-run the full allowlist + resolve-and-reject on every hop" of §6a applied
/// to a redirect target.
pub fn redirect_target_authorized<R: Resolver>(
    from_host: &str,
    to_host: &str,
    allowlist: &[String],
    resolver: &R,
) -> Result<Vec<IpAddr>, DenyReason> {
    if !redirect_allowed(from_host, to_host, allowlist) {
        return Err(DenyReason::HostNotAllowed(to_host.to_string()));
    }
    resolve_and_vet(to_host, resolver)
}

// ---------------------------------------------------------------------------
// 4. Streaming byte cap
// ---------------------------------------------------------------------------

/// Streaming download cap. Count bytes as they arrive and abort at `limit`.
///
/// Spec §6a: "count bytes as they stream and hard-abort the connection at N …
/// treat `Content-Length` as untrusted (never pre-allocate/trust it), and bound
/// bytes before they reach MEMFS." This struct holds NO buffer and never sees a
/// `Content-Length`: the caller feeds it chunk sizes off the wire and stops the
/// moment [`CapStatus::Aborted`] comes back. A malicious source serving a
/// chunked multi-GB (or forged-`Content-Length`) body is bounded to `limit`
/// bytes ever read.
#[derive(Debug, Clone)]
pub struct ByteCounter {
    limit: u64,
    count: u64,
}

/// Result of feeding bytes to a [`ByteCounter`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapStatus {
    /// Under the cap; keep reading.
    Ok,
    /// Cap reached or exceeded — the caller MUST abort the connection now and
    /// discard the run. `read` is how many bytes had been counted at abort.
    Aborted { read: u64 },
}

impl ByteCounter {
    /// A counter that aborts once more than `limit` bytes have been seen.
    /// `limit` should be ≈ the §5 memory cap (an object that won't fit the WASM
    /// heap aborts at the core, not after transfer).
    pub fn new(limit: u64) -> Self {
        ByteCounter { limit, count: 0 }
    }

    /// Bytes counted so far.
    pub fn count(&self) -> u64 {
        self.count
    }

    /// The configured cap.
    pub fn limit(&self) -> u64 {
        self.limit
    }

    /// Account for a chunk of `n` bytes just read off the wire. Returns
    /// [`CapStatus::Aborted`] the first time the running total exceeds `limit`
    /// (strictly greater — a body exactly equal to the cap is allowed). Uses
    /// saturating arithmetic so a hostile size can't wrap the counter.
    pub fn add(&mut self, n: u64) -> CapStatus {
        self.count = self.count.saturating_add(n);
        if self.count > self.limit {
            CapStatus::Aborted { read: self.count }
        } else {
            CapStatus::Ok
        }
    }

    /// Whether the cap has already been tripped.
    pub fn is_aborted(&self) -> bool {
        self.count > self.limit
    }
}

// ---------------------------------------------------------------------------
// 5. Resolver trait + authorize_fetch
// ---------------------------------------------------------------------------

/// DNS abstraction so the decision path never touches the network. The real
/// core injects a system-resolver impl; tests inject a fixed `host -> IPs` map.
pub trait Resolver {
    /// Resolve `host` to its addresses. `Err` for a lookup failure; an empty
    /// `Ok(vec![])` means "no address" and is treated as a denial by
    /// [`authorize_fetch`] (fail-closed).
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, ResolveError>;
}

/// Opaque DNS-resolution failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveError(pub String);

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "resolve failed: {}", self.0)
    }
}

/// Why the core refused a fetch. Every variant is a distinct §6a guard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenyReason {
    /// URL did not parse as an absolute URL with a host.
    UnparseableUrl,
    /// Scheme was not `http`/`https` (the only schemes the core will issue).
    BadScheme(String),
    /// Host is not a member of the stored-source-derived allowlist.
    HostNotAllowed(String),
    /// DNS lookup failed.
    ResolveFailed(String),
    /// Host resolved to zero addresses (fail-closed).
    EmptyResolution(String),
    /// Host resolved to (at least) one internal/non-routable address — the
    /// resolve-and-reject guard, incl. the desktop RFC-1918 rejection.
    ResolvesToInternal(IpAddr),
}

impl std::fmt::Display for DenyReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DenyReason::UnparseableUrl => write!(f, "unparseable URL"),
            DenyReason::BadScheme(s) => write!(f, "unsupported scheme: {s}"),
            DenyReason::HostNotAllowed(h) => write!(f, "host not in the source allowlist: {h}"),
            DenyReason::ResolveFailed(h) => write!(f, "DNS resolution failed for {h}"),
            DenyReason::EmptyResolution(h) => write!(f, "host resolved to no addresses: {h}"),
            DenyReason::ResolvesToInternal(ip) => {
                write!(f, "host resolves to a non-routable address: {ip}")
            }
        }
    }
}

/// The HTTP method the core is willing to issue. The core NEVER honors a
/// worker-supplied verb (spec §6a re-review #3: read-only GET only, no
/// attacker-driven PUT/write). This is a zero-variant-of-choice enum on
/// purpose: there is only `Get`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
}

/// A fully vetted fetch target. Holding one is proof that the URL parsed, the
/// scheme is http(s), the host is allowlisted, and EVERY resolved address is
/// public/routable. The thin network edge ([`Fetcher`]) consumes this — it does
/// no policy of its own; it connects to `addrs` and reads bounded by `cap`.
#[derive(Debug, Clone)]
pub struct AllowedFetch {
    pub host: String,
    pub port: u16,
    /// The vetted addresses to connect to. The edge connects to THESE (does not
    /// re-resolve), defeating a rebind between check and connect — mirroring the
    /// Python proxy's "connect to the VETTED sockaddr" comment.
    pub addrs: Vec<IpAddr>,
    /// The core only ever issues this method.
    pub method: Method,
    /// The streaming download cap to enforce while reading the response body.
    pub cap: ByteCounter,
    /// The full, already-validated request URL (scheme://host[:port]/path?query).
    /// The [`Fetcher`] edge needs the path/query and the scheme, which the
    /// host/port/addrs fields above do not carry. This is the URL that PARSED to
    /// the vetted host — the edge uses it for the request-target, the `Host`
    /// header, and TLS SNI, while physically connecting only to `addrs`.
    pub url: String,
}

/// Resolve `host` and reject if ANY resolved address is internal/non-routable.
/// Shared by [`authorize_fetch`] and [`redirect_target_authorized`] so the
/// per-hop guarantee is literally the same code on every hop.
fn resolve_and_vet<R: Resolver>(host: &str, resolver: &R) -> Result<Vec<IpAddr>, DenyReason> {
    let addrs = resolver
        .resolve(host)
        .map_err(|e| DenyReason::ResolveFailed(format!("{host}: {}", e.0)))?;
    if addrs.is_empty() {
        return Err(DenyReason::EmptyResolution(host.to_string()));
    }
    // Reject if ANY address is blocked — a resolver returning one public and one
    // internal address must not be trusted (rebind / round-robin SSRF).
    for &ip in &addrs {
        if is_blocked_ip(ip) {
            return Err(DenyReason::ResolvesToInternal(ip));
        }
    }
    Ok(addrs)
}

/// The single decision the core asks before fetching. NO real network here — DNS
/// comes from `resolver`; the socket is the caller's ([`Fetcher`]) job.
///
/// Guards, in order (each maps to a §6a T6 vector):
/// 1. URL parses → else [`DenyReason::UnparseableUrl`].
/// 2. Scheme is http(s) → else [`DenyReason::BadScheme`].
/// 3. Host ∈ `allowlist` (exact, case-insensitive; no widening) → else
///    [`DenyReason::HostNotAllowed`] (vectors 1/2/3/8: cross-source, local-run
///    empty allowlist, worker-host-not-derived, s3 vhost-only all collapse to
///    "host not a member" because the allowlist is derived from the STORED
///    source out-of-band and passed in here).
/// 4. Host resolves, and NO resolved IP is internal → else
///    [`DenyReason::ResolvesToInternal`] (vector 9: public host → LAN).
///
/// The returned [`AllowedFetch`] carries the vetted addresses and a fresh
/// [`ByteCounter`] set to `cap`.
pub fn authorize_fetch<R: Resolver>(
    raw_url: &str,
    allowlist: &[String],
    resolver: &R,
    cap: u64,
) -> Result<AllowedFetch, DenyReason> {
    let parsed = parse_url(raw_url).ok_or(DenyReason::UnparseableUrl)?;

    if parsed.scheme != "http" && parsed.scheme != "https" {
        return Err(DenyReason::BadScheme(parsed.scheme));
    }

    if !host_allowed(&parsed.host, allowlist) {
        return Err(DenyReason::HostNotAllowed(parsed.host));
    }

    let addrs = resolve_and_vet(&parsed.host, resolver)?;

    Ok(AllowedFetch {
        host: parsed.host,
        port: parsed.port,
        addrs,
        method: Method::Get,
        cap: ByteCounter::new(cap),
        url: raw_url.to_string(),
    })
}

// ---------------------------------------------------------------------------
// The real-network edge — deliberately OUT of the decision path (TODO stub).
// ---------------------------------------------------------------------------

/// The thin network edge. Everything above is pure and unit tested; the actual
/// TLS/HTTP fetch is a trait here so the DECISION path (ip/url/authorize_fetch)
/// never depends on it and its tests never hit a socket. The real implementation
/// is [`SystemFetcher`] (ureq + rustls) in [`fetch`]; tests inject a fake so the
/// redirect/cap wiring is exercised offline.
///
/// # Contract the implementation MUST honor (all enforced by the types above)
/// - Connect to `target.addrs` directly; do **not** re-resolve `target.host`
///   (defeats a check-to-connect rebind — the Python proxy connects to the
///   vetted sockaddr for the same reason).
/// - Issue `target.method` only (always `GET`); never a worker-supplied verb.
/// - Standard cert validation; no accept-invalid, no custom CA (§6a).
/// - Do NOT auto-follow redirects. On a 3xx, surface the `Location` to the
///   caller, which re-runs [`redirect_target_authorized`] (allowlist +
///   resolve-and-reject) for that hop before continuing.
/// - Feed every body chunk's length to `target.cap` and abort the moment it
///   returns [`CapStatus::Aborted`]; never pre-allocate from `Content-Length`.
pub trait Fetcher {
    /// Perform the vetted GET, streaming the body under the cap, and return the
    /// bytes (or the intercepted redirect / an error) to the caller.
    fn fetch(&self, target: &AllowedFetch) -> Result<FetchOutcome, String>;
}

/// The outcome the [`Fetcher`] edge reports back to the core.
#[derive(Debug, Clone)]
pub enum FetchOutcome {
    /// A complete body that stayed under the cap.
    Body(Vec<u8>),
    /// A 3xx with its `Location` — the core re-authorizes this hop before
    /// following (never auto-followed inside the edge).
    Redirect { location: String },
    /// The byte cap tripped mid-stream; the connection was hard-aborted.
    CapExceeded { read: u64 },
}

#[cfg(test)]
mod tests;
