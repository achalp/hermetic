//! The real-network `Fetcher` edge — spec §6a, build-log D7.
//!
//! The decision half of the guard ([`crate::authorize_fetch`], `ip.rs`, `url.rs`)
//! is pure and socket-free. THIS module is the other half: the actual TLS/HTTP
//! GET that runs *behind* an already-made decision. It is deliberately small and
//! contains no policy of its own — every guarantee below is a §6a requirement
//! that the tunnel-based `egress-proxy.py` got "for free" and a *terminating*
//! fetch (which decrypts TLS and sees the whole response) must re-establish:
//!
//! - **Connect only to the pre-vetted IPs; never re-resolve.** [`SystemFetcher`]
//!   hands ureq a constant [`ureq::Resolver`] closure that returns exactly
//!   `AllowedFetch::addrs` regardless of the netloc, so the client physically
//!   cannot touch system DNS or reach any address other than the ones
//!   `authorize_fetch` already ran through [`crate::is_blocked_ip`]. This is the
//!   check-to-connect DNS-rebinding defense — the Rust analogue of the Python
//!   proxy's "connect to the VETTED sockaddr, not re-resolving" (`_safe_connect`).
//!   TLS SNI and the `Host` header still use the URL's hostname, so certificate
//!   validation remains against the *name*, while the *socket* goes to a vetted IP.
//! - **GET only.** We only ever call `agent.get(url)`. There is no code path that
//!   honors a worker-supplied verb (§6a re-review #3: no attacker-driven writes).
//! - **Standard cert validation.** rustls defaults + Mozilla/webpki roots (ureq's
//!   `tls` feature). No accept-invalid, no custom CA (§6a).
//! - **No auto-redirects.** `.redirects(0)` — ureq returns the 3xx as-is instead
//!   of following it. We surface it as [`FetchOutcome::Redirect`]; the RE-AUTHORIZE
//!   policy (allowlist + resolve-and-reject on the new hop) is applied by
//!   [`authorize_and_fetch_with`], never inside the edge.
//! - **Streaming byte-cap; `Content-Length` untrusted.** We read the body in
//!   fixed chunks off `into_reader()` and feed each chunk length to the run's
//!   [`crate::ByteCounter`], hard-aborting the moment it trips. We never read,
//!   trust, or pre-allocate from `Content-Length`, so a forged length or a
//!   chunked multi-GB body is bounded to `cap` bytes ever held.
//! - **Credentials applied at the edge, never seen by the worker.** A bearer /
//!   header credential is set on the outgoing request here. S3 SigV4 request
//!   signing is a documented follow-on (see [`Credentials`]).

use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use crate::{
    authorize_fetch, parse_url, redirect_target_authorized, AllowedFetch, ByteCounter, CapStatus,
    DenyReason, Fetcher, FetchOutcome, Method, ResolveError, Resolver,
};

/// Read chunk size for streaming the body under the cap. Bounds how many bytes
/// past the cap we can read in the worst case (one chunk) before aborting.
const READ_CHUNK: usize = 64 * 1024;

/// Hard ceiling on redirect hops in [`authorize_and_fetch_with`]. Each hop is
/// fully re-authorized (allowlist + resolve-and-reject); this only bounds loops.
pub const MAX_REDIRECTS: usize = 5;

/// Overall per-request deadline (connect + read). A remote scan is bounded by the
/// byte-cap, not time, but an unbounded hang would strand the run — 60s is well
/// past any healthy first-byte latency while still reaping a dead socket.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// A credential the trusted core applies to the outgoing request. It is set here
/// at the executor boundary and NEVER handed to the untrusted worker (§6a: "the
/// worker never sees credential bytes at all") — stronger than Docker's
/// `applyRemoteAuth`, which splices creds into in-container SQL.
///
/// # Scope (honest)
/// This is a header/bearer pass-through only. **S3 SigV4 (and GCS HMAC) request
/// signing is a documented follow-on** — those require canonical-request signing
/// over method/path/headers/payload-hash, not a static header. A pre-signed URL
/// works today (it needs no credential and passes as [`Credentials::None`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credentials {
    /// No credential (public object or pre-signed URL).
    None,
    /// `Authorization: Bearer <token>`.
    Bearer(String),
    /// An arbitrary single request header (e.g. a provider-specific token header).
    Header { name: String, value: String },
}

impl Default for Credentials {
    fn default() -> Self {
        Credentials::None
    }
}

// ---------------------------------------------------------------------------
// SystemResolver — the production Resolver (std DNS), injected into the decision
// ---------------------------------------------------------------------------

/// The real [`Resolver`] for production: system DNS via std's [`ToSocketAddrs`].
/// The decision path takes a `&impl Resolver` precisely so this — the only part
/// that touches the network for name lookup — is swapped for a fixed map in tests.
///
/// Resolution here feeds `authorize_fetch`, which then vets every returned IP.
/// The [`SystemFetcher`] does its own connecting from the vetted addrs and does
/// NOT resolve again, so the name is looked up exactly once, then frozen.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, ResolveError> {
        // Port is irrelevant to the IP set; use 0 just to form a lookup tuple.
        (host, 0u16)
            .to_socket_addrs()
            .map(|it| it.map(|sa| sa.ip()).collect())
            .map_err(|e| ResolveError(e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// SystemFetcher — the real GET, ureq + rustls
// ---------------------------------------------------------------------------

/// The real-network implementation of [`Fetcher`]. Holds only the credential to
/// apply; all policy lives in the [`AllowedFetch`] it is handed.
#[derive(Debug, Clone, Default)]
pub struct SystemFetcher {
    creds: Credentials,
}

impl SystemFetcher {
    pub fn new() -> Self {
        SystemFetcher {
            creds: Credentials::None,
        }
    }

    pub fn with_credentials(mut self, creds: Credentials) -> Self {
        self.creds = creds;
        self
    }
}

impl Fetcher for SystemFetcher {
    fn fetch(&self, target: &AllowedFetch) -> Result<FetchOutcome, String> {
        // GET only. The `Method` enum has exactly one variant on purpose; this
        // match makes it a compile error to ever silently issue anything else.
        let Method::Get = target.method;

        // Pin the connection to the pre-vetted addresses. The resolver closure is
        // a CONSTANT function of `target.addrs` — it ignores the netloc ureq
        // derives from the URL host, so ureq cannot re-resolve to a rebind target
        // or touch system DNS. `authorize_fetch` already proved every one of
        // these is public/routable via `is_blocked_ip`.
        let port = target.port;
        let pinned: Vec<SocketAddr> = target
            .addrs
            .iter()
            .map(|ip| SocketAddr::new(*ip, port))
            .collect();
        if pinned.is_empty() {
            // Belt-and-suspenders: authorize_fetch never yields an empty addr set.
            return Err("no vetted address to connect to".to_string());
        }

        let agent = ureq::AgentBuilder::new()
            // No auto-redirects — a 3xx must be re-authorized per hop by the core.
            .redirects(0)
            .timeout(REQUEST_TIMEOUT)
            // Connect ONLY to the vetted IPs; never re-resolve (rebind defense).
            .resolver(move |_netloc: &str| Ok(pinned.clone()))
            .build();

        // The URL supplies the request-target/path, the Host header, and TLS SNI;
        // the socket still goes to the pinned IP via the resolver above.
        let mut req = agent.get(&target.url);
        match &self.creds {
            Credentials::None => {}
            Credentials::Bearer(token) => {
                req = req.set("Authorization", &format!("Bearer {token}"));
            }
            Credentials::Header { name, value } => {
                req = req.set(name, value);
            }
        }

        let resp = match req.call() {
            Ok(resp) => resp,
            // 3xx never lands here: with redirects(0), ureq turns only status >=
            // 400 into Error::Status. A 4xx/5xx is a hard upstream error.
            Err(ureq::Error::Status(code, _resp)) => {
                return Err(format!("upstream returned status {code}"));
            }
            Err(ureq::Error::Transport(t)) => {
                return Err(format!("transport error: {t}"));
            }
        };

        let status = resp.status();
        if (300..400).contains(&status) {
            // Do NOT follow. Surface the Location for per-hop re-authorization.
            let location = resp.header("location").unwrap_or_default().to_string();
            return Ok(FetchOutcome::Redirect { location });
        }
        if !(200..300).contains(&status) {
            return Err(format!("unexpected upstream status {status}"));
        }

        // Stream the body under the cap. `Content-Length` is deliberately never
        // consulted: we neither pre-size `body` from it nor trust it for framing
        // — the ByteCounter alone decides when to stop.
        let mut cap = target.cap.clone();
        let mut reader = resp.into_reader();
        let mut body: Vec<u8> = Vec::new();
        let mut chunk = [0u8; READ_CHUNK];
        loop {
            let n = match reader.read(&mut chunk) {
                Ok(0) => break, // clean EOF
                Ok(n) => n,
                Err(e) => return Err(format!("body read error: {e}")),
            };
            // Count first; if this pushes us over, abort WITHOUT keeping the
            // over-cap bytes and drop the connection (reader/resp go out of scope).
            if let CapStatus::Aborted { read } = cap.add(n as u64) {
                return Ok(FetchOutcome::CapExceeded { read });
            }
            body.extend_from_slice(&chunk[..n]);
        }
        Ok(FetchOutcome::Body(body))
    }
}

// ---------------------------------------------------------------------------
// The typed error surfaced by authorize_and_fetch
// ---------------------------------------------------------------------------

/// Why `authorize_and_fetch[_with]` did not return bytes. Splits cleanly into a
/// DECISION denial ([`FetchError::Denied`] / [`FetchError::RedirectNotAllowed`])
/// vs. a network outcome (transport, non-2xx, cap).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The initial authorize decision refused the fetch (host/scheme/IP).
    Denied(DenyReason),
    /// The [`Fetcher`] edge reported a transport/HTTP-status error.
    Transport(String),
    /// The stream exceeded the byte-cap and was hard-aborted; the run is void.
    CapExceeded { read: u64 },
    /// A redirect target failed per-hop re-authorization (allowlist or
    /// resolve-and-reject). The `DenyReason` says which.
    RedirectNotAllowed(DenyReason),
    /// A redirect whose `Location` was not an absolute http(s) URL. We fail
    /// closed on relative/opaque redirects rather than guess the hop's origin.
    UnparseableRedirect(String),
    /// A redirect to a non-http(s) scheme.
    BadRedirectScheme(String),
    /// More than [`MAX_REDIRECTS`] hops — treated as a redirect loop.
    TooManyRedirects,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Denied(d) => write!(f, "fetch denied: {d}"),
            FetchError::Transport(e) => write!(f, "fetch transport failure: {e}"),
            FetchError::CapExceeded { read } => {
                write!(f, "download exceeded the byte cap after {read} bytes")
            }
            FetchError::RedirectNotAllowed(d) => write!(f, "redirect refused: {d}"),
            FetchError::UnparseableRedirect(loc) => {
                write!(f, "redirect Location was not an absolute URL: {loc}")
            }
            FetchError::BadRedirectScheme(s) => write!(f, "redirect to unsupported scheme: {s}"),
            FetchError::TooManyRedirects => write!(f, "too many redirects"),
        }
    }
}

impl std::error::Error for FetchError {}

// ---------------------------------------------------------------------------
// authorize_and_fetch — ties the DECISION to the FETCH
// ---------------------------------------------------------------------------

/// The public entry point: run the §6a decision on `url` against `allowlist`,
/// then perform the real vetted GET, returning the body bytes.
///
/// Redirect policy: **no auto-follow; re-authorize every hop.** A 3xx is not
/// followed by the edge; instead its `Location` is put back through the full
/// allowlist + resolve-and-reject ([`redirect_target_authorized`]) before the
/// next GET — the §6a rule "a same-host redirect can still rebind". Bounded to
/// [`MAX_REDIRECTS`] hops.
pub fn authorize_and_fetch<R: Resolver>(
    url: &str,
    allowlist: &[String],
    resolver: &R,
    creds: &Credentials,
    cap: u64,
) -> Result<Vec<u8>, FetchError> {
    let fetcher = SystemFetcher::new().with_credentials(creds.clone());
    authorize_and_fetch_with(url, allowlist, resolver, &fetcher, cap)
}

/// The same wiring as [`authorize_and_fetch`] but over an injected [`Fetcher`],
/// so the redirect / cap / re-authorization logic is testable with a fake edge
/// (no socket). Production calls the wrapper above with a [`SystemFetcher`].
pub fn authorize_and_fetch_with<F: Fetcher, R: Resolver>(
    url: &str,
    allowlist: &[String],
    resolver: &R,
    fetcher: &F,
    cap: u64,
) -> Result<Vec<u8>, FetchError> {
    // Hop 0: the full initial decision (parse + scheme + allowlist + resolve-and-
    // reject). Produces the vetted AllowedFetch the edge consumes.
    let mut target = authorize_fetch(url, allowlist, resolver, cap).map_err(FetchError::Denied)?;

    // <= MAX_REDIRECTS follows; the extra iteration lets the final hop return a
    // body before we declare a loop.
    for _ in 0..=MAX_REDIRECTS {
        match fetcher.fetch(&target).map_err(FetchError::Transport)? {
            FetchOutcome::Body(bytes) => return Ok(bytes),
            FetchOutcome::CapExceeded { read } => return Err(FetchError::CapExceeded { read }),
            FetchOutcome::Redirect { location } => {
                // Re-authorize THIS hop exactly like the initial one. We require
                // an absolute http(s) URL and fail closed otherwise.
                let parsed = parse_url(&location)
                    .ok_or_else(|| FetchError::UnparseableRedirect(location.clone()))?;
                if parsed.scheme != "http" && parsed.scheme != "https" {
                    return Err(FetchError::BadRedirectScheme(parsed.scheme));
                }
                // allowlist membership + resolve-and-reject on the fresh host.
                let addrs =
                    redirect_target_authorized(&target.host, &parsed.host, allowlist, resolver)
                        .map_err(FetchError::RedirectNotAllowed)?;
                target = AllowedFetch {
                    host: parsed.host,
                    port: parsed.port,
                    addrs,
                    method: Method::Get,
                    // Fresh cap per hop: only the terminal 2xx body is retained,
                    // and each response is independently bounded.
                    cap: ByteCounter::new(cap),
                    url: location,
                };
            }
        }
    }
    Err(FetchError::TooManyRedirects)
}

#[cfg(test)]
mod tests;
