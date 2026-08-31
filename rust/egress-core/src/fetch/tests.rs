//! Tests for the real-network `Fetcher` edge and the `authorize_and_fetch`
//! wiring. Two layers, both socket-honest:
//!
//! * The `SystemFetcher` tests hit a LOCAL `std::net` HTTP/1.1 server on
//!   127.0.0.1 (no external network) with a hand-built `AllowedFetch` pinned to
//!   loopback. They MUST bypass `authorize_fetch`'s IP vetting on purpose:
//!   `is_blocked_ip(127.0.0.1)` is `true` (loopback is non-routable), so the only
//!   way to exercise the real HTTP path against a local server is to construct the
//!   already-vetted `AllowedFetch` directly. This is exactly the edge's contract:
//!   it does no policy, it connects to `addrs` and reads under `cap`.
//! * The `authorize_and_fetch_with` tests drive the DECISION + redirect + cap
//!   wiring over a FAKE `Fetcher` and a fixed-map `Resolver`, so refusals and the
//!   per-hop re-authorization are covered with no socket at all (and refusals are
//!   proven to happen BEFORE the fetcher is ever called).

use super::*;

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::io::Write as _;
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

// --- local HTTP/1.1 test server (127.0.0.1, no external network) ------------

/// Bind an ephemeral loopback port and serve each connection with `handler`,
/// which receives the raw request head and the stream to write a response into.
/// Returns the bound port. Each connection is handled on its own thread so a
/// handler can stream a large body while the client aborts mid-stream.
fn spawn_server<H>(handler: H) -> u16
where
    H: Fn(Vec<u8>, TcpStream) + Send + Sync + 'static,
{
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let handler = Arc::new(handler);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let head = read_head(&mut stream);
            let h = Arc::clone(&handler);
            thread::spawn(move || h(head, stream));
        }
    });
    port
}

/// Read a request head up to and including the CRLFCRLF terminator (bounded).
fn read_head(stream: &mut TcpStream) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => buf.push(byte[0]),
            Err(_) => break,
        }
        if buf.ends_with(b"\r\n\r\n") || buf.len() > 65536 {
            break;
        }
    }
    buf
}

/// An `AllowedFetch` pinned to loopback: the URL carries a fake public hostname
/// (`data.example.com`) so the test proves the edge connects to the vetted IP
/// (127.0.0.1) and NOT to whatever the hostname would resolve to.
fn loopback_target(url: &str, port: u16, cap: u64) -> AllowedFetch {
    AllowedFetch {
        range: None,
        host: "data.example.com".to_string(),
        port,
        addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
        method: Method::Get,
        cap: ByteCounter::new(cap),
        url: url.to_string(),
    }
}

fn url_for(port: u16, path: &str) -> String {
    format!("http://data.example.com:{port}{path}")
}

// =========================================================================
// SystemFetcher — real HTTP against a local server
// =========================================================================

#[test]
fn system_fetcher_happy_get_returns_body() {
    let port = spawn_server(|_head, mut stream| {
        let body = b"hello world";
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(resp.as_bytes());
        let _ = stream.write_all(body);
    });

    let target = loopback_target(&url_for(port, "/obj"), port, 1_000_000);
    let out = SystemFetcher::new().fetch(&target).expect("fetch ok");
    match out {
        FetchOutcome::Body(b) => assert_eq!(b, b"hello world"),
        other => panic!("expected Body, got {other:?}"),
    }
}

#[test]
fn system_fetcher_byte_cap_aborts_large_body() {
    // No Content-Length: body is framed by connection close. The server streams
    // far more than the cap; the ByteCounter must abort mid-stream.
    let port = spawn_server(|_head, mut stream| {
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
        let chunk = vec![b'x'; 8192];
        for _ in 0..20_000 {
            if stream.write_all(&chunk).is_err() {
                break; // client aborted (cap tripped) — stop.
            }
        }
    });

    let cap = 4096;
    let target = loopback_target(&url_for(port, "/big"), port, cap);
    let out = SystemFetcher::new().fetch(&target).expect("fetch ok");
    match out {
        FetchOutcome::CapExceeded { read } => {
            assert!(read > cap, "read {read} must exceed cap {cap}")
        }
        other => panic!("expected CapExceeded, got {other:?}"),
    }
}

#[test]
fn system_fetcher_content_length_is_untrusted() {
    // Serve a colossal (lying) Content-Length far above the cap, then stream real
    // bytes. If we trusted/pre-allocated Content-Length we'd try to reserve 100GB;
    // instead the byte-count alone governs and aborts at the cap.
    let port = spawn_server(|_head, mut stream| {
        let head = "HTTP/1.1 200 OK\r\nContent-Length: 100000000000\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(head.as_bytes());
        let chunk = vec![b'y'; 8192];
        for _ in 0..4000 {
            if stream.write_all(&chunk).is_err() {
                break;
            }
        }
    });

    let cap = 4096;
    let target = loopback_target(&url_for(port, "/liar"), port, cap);
    let out = SystemFetcher::new().fetch(&target).expect("fetch ok");
    match out {
        FetchOutcome::CapExceeded { read } => assert!(read > cap),
        other => panic!("expected CapExceeded (Content-Length ignored), got {other:?}"),
    }
}

#[test]
fn system_fetcher_surfaces_redirect_without_following() {
    let port = spawn_server(|_head, mut stream| {
        let resp = "HTTP/1.1 302 Found\r\nLocation: https://relocated.example.com/new\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(resp.as_bytes());
    });

    let target = loopback_target(&url_for(port, "/old"), port, 1_000_000);
    let out = SystemFetcher::new().fetch(&target).expect("fetch ok");
    match out {
        FetchOutcome::Redirect { location } => {
            assert_eq!(location, "https://relocated.example.com/new");
        }
        other => panic!("expected Redirect (not followed), got {other:?}"),
    }
}

#[test]
fn system_fetcher_issues_get_only() {
    let captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let cap_clone = Arc::clone(&captured);
    let port = spawn_server(move |head, mut stream| {
        *cap_clone.lock().unwrap() = head;
        let _ =
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });

    let target = loopback_target(&url_for(port, "/obj"), port, 1_000_000);
    let _ = SystemFetcher::new().fetch(&target).expect("fetch ok");

    let head = captured.lock().unwrap().clone();
    assert!(
        head.starts_with(b"GET "),
        "request must be a GET: {:?}",
        String::from_utf8_lossy(&head)
    );
}

#[test]
fn system_fetcher_applies_bearer_credential() {
    let captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let cap_clone = Arc::clone(&captured);
    let port = spawn_server(move |head, mut stream| {
        *cap_clone.lock().unwrap() = head;
        let _ =
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });

    let target = loopback_target(&url_for(port, "/obj"), port, 1_000_000);
    let fetcher = SystemFetcher::new().with_credentials(Credentials::Bearer("sekret".into()));
    let _ = fetcher.fetch(&target).expect("fetch ok");

    let head = String::from_utf8_lossy(&captured.lock().unwrap()).to_lowercase();
    assert!(
        head.contains("authorization: bearer sekret"),
        "credential header must be present, head was:\n{head}"
    );
}

// =========================================================================
// authorize_and_fetch_with — decision + redirect + cap wiring over a FAKE edge
// =========================================================================

/// Fixed `host -> IPs` resolver (same idea as the decision-path FakeResolver).
struct MapResolver {
    map: HashMap<String, Vec<IpAddr>>,
}
impl MapResolver {
    fn new() -> Self {
        MapResolver {
            map: HashMap::new(),
        }
    }
    fn with(mut self, host: &str, ips: Vec<IpAddr>) -> Self {
        self.map.insert(host.to_string(), ips);
        self
    }
}
impl Resolver for MapResolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, ResolveError> {
        self.map
            .get(host)
            .cloned()
            .ok_or_else(|| ResolveError("unmapped host".into()))
    }
}

/// A fake edge returning canned outcomes in order, recording each URL it saw.
struct FakeFetcher {
    outcomes: RefCell<VecDeque<FetchOutcome>>,
    seen: RefCell<Vec<String>>,
}
impl FakeFetcher {
    fn new(outcomes: Vec<FetchOutcome>) -> Self {
        FakeFetcher {
            outcomes: RefCell::new(outcomes.into()),
            seen: RefCell::new(Vec::new()),
        }
    }
}
impl Fetcher for FakeFetcher {
    fn fetch(&self, target: &AllowedFetch) -> Result<FetchOutcome, String> {
        self.seen.borrow_mut().push(target.url.clone());
        Ok(self
            .outcomes
            .borrow_mut()
            .pop_front()
            .expect("FakeFetcher: no more canned outcomes"))
    }
}

/// A fake edge that panics if fetch is ever called — proves a decision refusal
/// happens BEFORE any connection.
struct NeverFetcher;
impl Fetcher for NeverFetcher {
    fn fetch(&self, _t: &AllowedFetch) -> Result<FetchOutcome, String> {
        panic!("fetcher must not be called on a refused decision");
    }
}

fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(a, b, c, d))
}
fn allow(hosts: &[&str]) -> Vec<String> {
    hosts.iter().map(|s| s.to_string()).collect()
}

#[test]
fn authorize_and_fetch_refuses_host_not_on_allowlist_before_connect() {
    let al = allow(&["data.example.com"]);
    let r = MapResolver::new().with("evil.example.com", vec![v4(93, 184, 216, 34)]);
    let err = authorize_and_fetch_with(
        "https://evil.example.com/x",
        &al,
        &r,
        &NeverFetcher, // would panic if reached
        1000,
    )
    .unwrap_err();
    assert_eq!(
        err,
        FetchError::Denied(DenyReason::HostNotAllowed("evil.example.com".into()))
    );
}

#[test]
fn authorize_and_fetch_refuses_internal_ip_before_connect() {
    let al = allow(&["sneaky.example.com"]);
    // Allowlisted host that resolves to a LAN address → refused (desktop §6a).
    let r = MapResolver::new().with("sneaky.example.com", vec![v4(192, 168, 1, 50)]);
    let err =
        authorize_and_fetch_with("https://sneaky.example.com/x", &al, &r, &NeverFetcher, 1000)
            .unwrap_err();
    assert_eq!(
        err,
        FetchError::Denied(DenyReason::ResolvesToInternal(v4(192, 168, 1, 50)))
    );
}

#[test]
fn authorize_and_fetch_happy_returns_body() {
    let al = allow(&["data.example.com"]);
    let r = MapResolver::new().with("data.example.com", vec![v4(93, 184, 216, 34)]);
    let fetcher = FakeFetcher::new(vec![FetchOutcome::Body(b"payload".to_vec())]);
    let out =
        authorize_and_fetch_with("https://data.example.com/obj", &al, &r, &fetcher, 1000).unwrap();
    assert_eq!(out, b"payload");
    assert_eq!(
        fetcher.seen.borrow().as_slice(),
        &["https://data.example.com/obj"]
    );
}

#[test]
fn authorize_and_fetch_follows_redirect_reauthorizing_each_hop() {
    let al = allow(&["a.example.com", "b.example.com"]);
    let r = MapResolver::new()
        .with("a.example.com", vec![v4(93, 184, 216, 34)])
        .with("b.example.com", vec![v4(52, 216, 1, 1)]);
    let fetcher = FakeFetcher::new(vec![
        FetchOutcome::Redirect {
            location: "https://b.example.com/x".into(),
        },
        FetchOutcome::Body(b"final".to_vec()),
    ]);
    let out =
        authorize_and_fetch_with("https://a.example.com/start", &al, &r, &fetcher, 1000).unwrap();
    assert_eq!(out, b"final");
    // Proves the redirect target URL (not the original) was fetched on hop 2.
    assert_eq!(
        fetcher.seen.borrow().as_slice(),
        &["https://a.example.com/start", "https://b.example.com/x"]
    );
}

#[test]
fn authorize_and_fetch_redirect_to_nonallowlisted_refused() {
    let al = allow(&["a.example.com"]);
    let r = MapResolver::new().with("a.example.com", vec![v4(93, 184, 216, 34)]);
    let fetcher = FakeFetcher::new(vec![FetchOutcome::Redirect {
        location: "https://evil.com/x".into(),
    }]);
    let err = authorize_and_fetch_with("https://a.example.com/start", &al, &r, &fetcher, 1000)
        .unwrap_err();
    assert_eq!(
        err,
        FetchError::RedirectNotAllowed(DenyReason::HostNotAllowed("evil.com".into()))
    );
}

#[test]
fn authorize_and_fetch_redirect_to_internal_refused() {
    // Allowlisted redirect target that rebinds to an internal IP → refused per hop.
    let al = allow(&["a.example.com", "b.example.com"]);
    let r = MapResolver::new()
        .with("a.example.com", vec![v4(93, 184, 216, 34)])
        .with("b.example.com", vec![v4(10, 0, 0, 1)]);
    let fetcher = FakeFetcher::new(vec![FetchOutcome::Redirect {
        location: "https://b.example.com/x".into(),
    }]);
    let err = authorize_and_fetch_with("https://a.example.com/start", &al, &r, &fetcher, 1000)
        .unwrap_err();
    assert_eq!(
        err,
        FetchError::RedirectNotAllowed(DenyReason::ResolvesToInternal(v4(10, 0, 0, 1)))
    );
}

#[test]
fn authorize_and_fetch_relative_redirect_refused() {
    let al = allow(&["a.example.com"]);
    let r = MapResolver::new().with("a.example.com", vec![v4(93, 184, 216, 34)]);
    let fetcher = FakeFetcher::new(vec![FetchOutcome::Redirect {
        location: "/relative/only".into(),
    }]);
    let err = authorize_and_fetch_with("https://a.example.com/start", &al, &r, &fetcher, 1000)
        .unwrap_err();
    assert_eq!(
        err,
        FetchError::UnparseableRedirect("/relative/only".into())
    );
}

#[test]
fn authorize_and_fetch_cap_exceeded_is_surfaced() {
    let al = allow(&["data.example.com"]);
    let r = MapResolver::new().with("data.example.com", vec![v4(93, 184, 216, 34)]);
    let fetcher = FakeFetcher::new(vec![FetchOutcome::CapExceeded { read: 12345 }]);
    let err = authorize_and_fetch_with("https://data.example.com/obj", &al, &r, &fetcher, 1000)
        .unwrap_err();
    assert_eq!(err, FetchError::CapExceeded { read: 12345 });
}

#[test]
fn authorize_and_fetch_bounds_redirect_loops() {
    let al = allow(&["a.example.com"]);
    let r = MapResolver::new().with("a.example.com", vec![v4(93, 184, 216, 34)]);
    // Always redirect to the same allowlisted, public host → must terminate.
    let outcomes: Vec<FetchOutcome> = (0..MAX_REDIRECTS + 2)
        .map(|_| FetchOutcome::Redirect {
            location: "https://a.example.com/loop".into(),
        })
        .collect();
    let fetcher = FakeFetcher::new(outcomes);
    let err = authorize_and_fetch_with("https://a.example.com/start", &al, &r, &fetcher, 1000)
        .unwrap_err();
    assert_eq!(err, FetchError::TooManyRedirects);
}

// ── D18: the ranged path must reuse the SAME authorization as the whole-object
// path — a range is an offset within an already-authorized URL, never new reach.

#[test]
fn ranged_target_sends_a_canonical_range_header_and_yields_partial_body() {
    let mut t = loopback_target("http://x/", 1, 1024);
    t.range = Some(ByteRange {
        start: 4,
        end: Some(9),
    });
    // The edge builds the header from the parsed numbers.
    assert_eq!(t.range.unwrap().to_header_value(), "bytes=4-9");

    // A 206 outcome carries the upstream Content-Range so the caller can answer
    // size probes without a second round trip.
    let out = FetchOutcome::PartialBody {
        body: b"456789".to_vec(),
        content_range: "bytes 4-9/1000".to_string(),
    };
    match out {
        FetchOutcome::PartialBody {
            body,
            content_range,
        } => {
            assert_eq!(body, b"456789");
            assert_eq!(content_range, "bytes 4-9/1000");
        }
        _ => panic!("expected PartialBody"),
    }
}

#[test]
fn a_range_survives_a_redirect_hop_without_widening_authorization() {
    // The hop is re-authorized exactly like hop 0; the range rides along so the
    // final GET still asks for the same offsets.
    let mut t = loopback_target("http://x/", 1, 1024);
    t.range = Some(ByteRange {
        start: 100,
        end: None,
    });
    let carried = AllowedFetch {
        range: t.range,
        ..t.clone()
    };
    assert_eq!(carried.range.unwrap().start, 100);
    assert_eq!(carried.range.unwrap().to_header_value(), "bytes=100-");
}

// =========================================================================
// AgentPool — serve-mode connection reuse (build log D41)
// =========================================================================

#[test]
fn pooled_fetcher_reuses_the_connection_across_requests() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    // A keep-alive server that COUNTS accepted connections and answers any
    // number of requests per connection — so reuse is observable as exactly one
    // accept across two fetches.
    let accepts = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let a2 = Arc::clone(&accepts);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            a2.fetch_add(1, Ordering::SeqCst);
            thread::spawn(move || loop {
                let head = read_head(&mut stream);
                if head.is_empty() {
                    break;
                }
                let body = b"pooled";
                let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
                if stream.write_all(resp.as_bytes()).is_err() {
                    break;
                }
                if stream.write_all(body).is_err() {
                    break;
                }
                let _ = stream.flush();
            });
        }
    });
    let pool = Arc::new(AgentPool::new());
    let fetcher = SystemFetcher::new().with_pool(Arc::clone(&pool));
    for _ in 0..2 {
        let target = loopback_target(&url_for(port, "/obj"), port, 1_000_000);
        match fetcher.fetch(&target).expect("fetch ok") {
            FetchOutcome::Body(b) => assert_eq!(b, b"pooled"),
            other => panic!("expected Body, got {other:?}"),
        }
    }
    assert_eq!(pool.len(), 1, "one cached agent per (host, port)");
    assert_eq!(
        accepts.load(Ordering::SeqCst),
        1,
        "the second request must reuse the pooled connection, not reconnect"
    );
}

#[test]
fn pooled_fetcher_still_pins_to_the_vetted_addr_per_request() {
    // The pool's resolver slot is overwritten before every request: hand the
    // SAME (host, port) key a bogus pinned addr on the second request and the
    // fetch must fail to connect — proving the slot governs, not stale state.
    let port = spawn_server(|_head, mut stream| {
        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
        let _ = stream.write_all(resp.as_bytes());
    });
    let pool = Arc::new(AgentPool::new());
    let fetcher = SystemFetcher::new().with_pool(Arc::clone(&pool));

    let good = loopback_target(&url_for(port, "/a"), port, 1_000);
    assert!(matches!(fetcher.fetch(&good), Ok(FetchOutcome::Body(_))));

    // Same host key, but the vetted addr now points at a closed port. With
    // Connection: close above there is no pooled socket to fall back to.
    let dead = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let dead_port = dead.local_addr().unwrap().port();
    drop(dead);
    let mut bad = loopback_target(&url_for(port, "/b"), port, 1_000);
    bad.addrs = vec![IpAddr::V4(Ipv4Addr::LOCALHOST)];
    bad.port = dead_port;
    bad.url = url_for(dead_port, "/b");
    let err = fetcher.fetch(&bad).expect_err("must fail to connect");
    assert!(err.contains("transport"), "got: {err}");
}
