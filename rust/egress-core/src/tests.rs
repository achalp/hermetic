//! Comprehensive unit tests for every §6a decision branch. No network: DNS is a
//! fixed in-memory map (`FakeResolver`).

use super::*;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

// --- Test helpers ----------------------------------------------------------

fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
    IpAddr::V4(Ipv4Addr::new(a, b, c, d))
}

fn v6(s: &str) -> IpAddr {
    IpAddr::V6(s.parse::<Ipv6Addr>().unwrap())
}

fn allowlist(hosts: &[&str]) -> Vec<String> {
    hosts.iter().map(|s| s.to_string()).collect()
}

/// A resolver backed by a fixed `host -> IPs` map. Injects DNS so the decision
/// path is tested WITHOUT a socket. A host mapped to `Err` simulates NXDOMAIN.
struct FakeResolver {
    map: HashMap<String, Result<Vec<IpAddr>, ResolveError>>,
}

impl FakeResolver {
    fn new() -> Self {
        FakeResolver {
            map: HashMap::new(),
        }
    }
    fn with(mut self, host: &str, ips: Vec<IpAddr>) -> Self {
        self.map.insert(host.to_string(), Ok(ips));
        self
    }
    fn failing(mut self, host: &str) -> Self {
        self.map
            .insert(host.to_string(), Err(ResolveError("nxdomain".into())));
        self
    }
}

impl Resolver for FakeResolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, ResolveError> {
        match self.map.get(host) {
            Some(Ok(ips)) => Ok(ips.clone()),
            Some(Err(e)) => Err(e.clone()),
            None => Err(ResolveError("unmapped host".into())),
        }
    }
}

// =========================================================================
// 1. is_blocked_ip — IPv4
// =========================================================================

#[test]
fn ipv4_public_addresses_allowed() {
    for ip in [
        v4(1, 1, 1, 1),
        v4(8, 8, 8, 8),
        v4(52, 216, 1, 1),      // AWS S3-ish public
        v4(140, 82, 121, 3),    // GitHub-ish
        v4(172, 15, 0, 1),      // just BELOW the 172.16/12 private block
        v4(172, 32, 0, 1),      // just ABOVE the 172.16/12 private block
        v4(100, 63, 255, 255),  // just below CGNAT 100.64/10
        v4(100, 128, 0, 1),     // just above CGNAT 100.64/10
        v4(198, 20, 0, 1),      // just above benchmarking 198.18/15
    ] {
        assert!(!is_blocked_ip(ip), "{ip} should be allowed (public)");
    }
}

#[test]
fn ipv4_loopback_blocked() {
    assert!(is_blocked_ip(v4(127, 0, 0, 1)));
    assert!(is_blocked_ip(v4(127, 255, 255, 254)));
}

#[test]
fn ipv4_unspecified_and_this_network_blocked() {
    assert!(is_blocked_ip(v4(0, 0, 0, 0)));
    assert!(is_blocked_ip(v4(0, 1, 2, 3)));
}

#[test]
fn ipv4_link_local_and_metadata_blocked() {
    assert!(is_blocked_ip(v4(169, 254, 0, 1)));
    // The cloud metadata service — instance-credential theft target.
    assert!(is_blocked_ip(IpAddr::V4(ip::IPV4_METADATA)));
    assert!(is_blocked_ip(v4(169, 254, 169, 254)));
}

#[test]
fn ipv4_multicast_and_reserved_blocked() {
    assert!(is_blocked_ip(v4(224, 0, 0, 1)));
    assert!(is_blocked_ip(v4(239, 255, 255, 255)));
    assert!(is_blocked_ip(v4(240, 0, 0, 1))); // reserved future-use
    assert!(is_blocked_ip(v4(255, 255, 255, 255))); // broadcast
}

#[test]
fn ipv4_documentation_and_benchmarking_blocked() {
    assert!(is_blocked_ip(v4(192, 0, 2, 5))); // TEST-NET-1
    assert!(is_blocked_ip(v4(198, 51, 100, 5))); // TEST-NET-2
    assert!(is_blocked_ip(v4(203, 0, 113, 5))); // TEST-NET-3
    assert!(is_blocked_ip(v4(198, 18, 0, 1))); // benchmarking
    assert!(is_blocked_ip(v4(198, 19, 255, 1)));
    assert!(is_blocked_ip(v4(192, 0, 0, 1))); // IETF protocol assignments
}

/// THE DESKTOP DIVERGENCE: RFC-1918 / CGNAT private ranges are rejected here,
/// even though egress-proxy.py ALLOWS them. Explicit, load-bearing test.
#[test]
fn ipv4_rfc1918_private_blocked_desktop_divergence() {
    // 10.0.0.0/8
    assert!(is_blocked_ip(v4(10, 0, 0, 1)));
    assert!(is_blocked_ip(v4(10, 255, 255, 255)));
    // 172.16.0.0/12
    assert!(is_blocked_ip(v4(172, 16, 0, 1)));
    assert!(is_blocked_ip(v4(172, 31, 255, 255)));
    // 192.168.0.0/16
    assert!(is_blocked_ip(v4(192, 168, 1, 1)));
    // 100.64.0.0/10 CGNAT
    assert!(is_blocked_ip(v4(100, 64, 0, 1)));
    assert!(is_blocked_ip(v4(100, 127, 255, 255)));
}

// =========================================================================
// 1. is_blocked_ip — IPv6
// =========================================================================

#[test]
fn ipv6_public_allowed() {
    assert!(!is_blocked_ip(v6("2606:4700:4700::1111"))); // Cloudflare DNS
    assert!(!is_blocked_ip(v6("2001:4860:4860::8888"))); // Google DNS
}

#[test]
fn ipv6_loopback_and_unspecified_blocked() {
    assert!(is_blocked_ip(v6("::1")));
    assert!(is_blocked_ip(v6("::")));
}

#[test]
fn ipv6_link_local_multicast_blocked() {
    assert!(is_blocked_ip(v6("fe80::1")));
    assert!(is_blocked_ip(v6("ff02::1")));
}

#[test]
fn ipv6_unique_local_blocked_desktop_divergence() {
    // fc00::/7 ULA is the RFC-1918 equivalent — desktop rejects it.
    assert!(is_blocked_ip(v6("fd00::1")));
    assert!(is_blocked_ip(v6("fc00::1")));
    // fd00:ec2::254 — the IPv6 cloud metadata address (ULA).
    assert!(is_blocked_ip(v6("fd00:ec2::254")));
}

#[test]
fn ipv6_documentation_and_discard_blocked() {
    assert!(is_blocked_ip(v6("2001:db8::1")));
    assert!(is_blocked_ip(v6("100::1"))); // discard-only
}

#[test]
fn ipv6_mapped_ipv4_rechecks_embedded_address() {
    // ::ffff:169.254.169.254 must be blocked via the embedded-v4 recheck.
    assert!(is_blocked_ip(v6("::ffff:169.254.169.254")));
    // ::ffff:192.168.0.1 — mapped RFC-1918.
    assert!(is_blocked_ip(v6("::ffff:192.168.0.1")));
    // ::ffff:8.8.8.8 — mapped PUBLIC address stays allowed.
    assert!(!is_blocked_ip(v6("::ffff:8.8.8.8")));
    // 64:ff9b::/96 NAT64 wrapping an internal v4.
    assert!(is_blocked_ip(v6("64:ff9b::10.0.0.1")));
}

// =========================================================================
// 2. host_allowed — exact, case-insensitive, no widening
// =========================================================================

#[test]
fn host_membership_exact_match() {
    let al = allowlist(&["bucket.s3.amazonaws.com", "data.example.com"]);
    assert!(host_allowed("bucket.s3.amazonaws.com", &al));
    assert!(host_allowed("data.example.com", &al));
}

#[test]
fn host_membership_case_insensitive() {
    let al = allowlist(&["Bucket.S3.Amazonaws.Com"]);
    assert!(host_allowed("bucket.s3.amazonaws.com", &al));
    assert!(host_allowed("BUCKET.S3.AMAZONAWS.COM", &al));
}

#[test]
fn host_membership_no_widening() {
    let al = allowlist(&["bucket.s3.amazonaws.com"]);
    // The generic path-style host is NOT a member (vhost-only, §6a vector 8).
    assert!(!host_allowed("s3.amazonaws.com", &al));
    // No suffix widening — a sibling bucket is not a member.
    assert!(!host_allowed("other.s3.amazonaws.com", &al));
    // No prefix/substring widening.
    assert!(!host_allowed("evilbucket.s3.amazonaws.com", &al));
    assert!(!host_allowed("bucket.s3.amazonaws.com.evil.com", &al));
}

#[test]
fn host_membership_empty_allowlist_denies_all() {
    // Local-run parity: empty allowlist ⇒ nothing allowed (§6a vector 2).
    let al: Vec<String> = vec![];
    assert!(!host_allowed("anything.example.com", &al));
}

// =========================================================================
// 3. redirect policy
// =========================================================================

#[test]
fn redirect_same_host_allowed_by_host_check() {
    let al = allowlist(&["data.example.com"]);
    assert!(redirect_allowed("data.example.com", "data.example.com", &al));
}

#[test]
fn redirect_cross_host_to_allowlisted_ok() {
    let al = allowlist(&["a.example.com", "b.example.com"]);
    assert!(redirect_allowed("a.example.com", "b.example.com", &al));
}

#[test]
fn redirect_cross_host_to_non_allowlisted_rejected() {
    let al = allowlist(&["a.example.com"]);
    assert!(!redirect_allowed("a.example.com", "evil.example.com", &al));
    // Classic S3 regional redirect to the generic host — rejected (vhost-only).
    let al2 = allowlist(&["bucket.s3.amazonaws.com"]);
    assert!(!redirect_allowed(
        "bucket.s3.amazonaws.com",
        "s3.amazonaws.com",
        &al2
    ));
}

#[test]
fn redirect_target_authorized_reruns_resolve_and_reject() {
    let al = allowlist(&["a.example.com", "b.example.com"]);
    // Same-host redirect that now rebinds to an internal IP → rejected per hop.
    let rebind = FakeResolver::new().with("a.example.com", vec![v4(192, 168, 0, 5)]);
    let res = redirect_target_authorized("a.example.com", "a.example.com", &al, &rebind);
    assert_eq!(res, Err(DenyReason::ResolvesToInternal(v4(192, 168, 0, 5))));

    // Cross-host redirect to an allowlisted host that resolves public → ok.
    let good = FakeResolver::new().with("b.example.com", vec![v4(93, 184, 216, 34)]);
    let res2 = redirect_target_authorized("a.example.com", "b.example.com", &al, &good);
    assert_eq!(res2, Ok(vec![v4(93, 184, 216, 34)]));

    // Redirect to a non-allowlisted host → rejected before resolving.
    let res3 = redirect_target_authorized("a.example.com", "evil.com", &al, &good);
    assert_eq!(res3, Err(DenyReason::HostNotAllowed("evil.com".into())));
}

// =========================================================================
// 4. streaming byte cap
// =========================================================================

#[test]
fn byte_counter_under_cap_ok() {
    let mut c = ByteCounter::new(1000);
    assert_eq!(c.add(400), CapStatus::Ok);
    assert_eq!(c.add(600), CapStatus::Ok); // exactly at cap is allowed
    assert!(!c.is_aborted());
    assert_eq!(c.count(), 1000);
}

#[test]
fn byte_counter_aborts_over_cap() {
    let mut c = ByteCounter::new(1000);
    assert_eq!(c.add(600), CapStatus::Ok);
    // Next chunk pushes over → abort with the total read so far.
    assert_eq!(c.add(500), CapStatus::Aborted { read: 1100 });
    assert!(c.is_aborted());
}

#[test]
fn byte_counter_aborts_on_single_huge_chunk_untrusted_content_length() {
    // A forged Content-Length is never consulted; a single oversized chunk
    // trips the cap immediately.
    let mut c = ByteCounter::new(10 * 1024 * 1024);
    assert_eq!(
        c.add(50 * 1024 * 1024),
        CapStatus::Aborted {
            read: 50 * 1024 * 1024
        }
    );
}

#[test]
fn byte_counter_saturates_no_wrap() {
    let mut c = ByteCounter::new(u64::MAX - 1);
    // A hostile size must not wrap the counter back under the cap.
    c.add(u64::MAX);
    assert!(c.is_aborted());
    assert_eq!(c.count(), u64::MAX);
}

// =========================================================================
// 5. authorize_fetch — happy path + every denial
// =========================================================================

fn public_resolver() -> FakeResolver {
    FakeResolver::new()
        .with("bucket.s3.amazonaws.com", vec![v4(52, 216, 1, 1)])
        .with("data.example.com", vec![v4(93, 184, 216, 34)])
}

#[test]
fn authorize_fetch_happy_path() {
    let al = allowlist(&["bucket.s3.amazonaws.com"]);
    let r = public_resolver();
    let out = authorize_fetch(
        "https://bucket.s3.amazonaws.com/path/to/object.parquet?x=1",
        &al,
        &r,
        10_000_000,
    )
    .expect("should be authorized");
    assert_eq!(out.host, "bucket.s3.amazonaws.com");
    assert_eq!(out.port, 443);
    assert_eq!(out.addrs, vec![v4(52, 216, 1, 1)]);
    assert_eq!(out.method, Method::Get);
    assert_eq!(out.cap.limit(), 10_000_000);
}

#[test]
fn authorize_fetch_http_scheme_default_port_80() {
    let al = allowlist(&["data.example.com"]);
    let r = public_resolver();
    let out = authorize_fetch("http://data.example.com/x", &al, &r, 1000).unwrap();
    assert_eq!(out.port, 80);
}

#[test]
fn authorize_fetch_explicit_port_honored() {
    let al = allowlist(&["data.example.com"]);
    let r = public_resolver();
    let out = authorize_fetch("https://data.example.com:8443/x", &al, &r, 1000).unwrap();
    assert_eq!(out.port, 8443);
}

#[test]
fn authorize_fetch_case_insensitive_host() {
    let al = allowlist(&["data.example.com"]);
    let r = public_resolver();
    let out = authorize_fetch("https://DATA.Example.COM/x", &al, &r, 1000).unwrap();
    assert_eq!(out.host, "data.example.com");
}

#[test]
fn authorize_fetch_denies_bad_scheme() {
    let al = allowlist(&["data.example.com"]);
    let r = public_resolver();
    for url in [
        "ftp://data.example.com/x",
        "gopher://data.example.com/x",
        "s3://data.example.com/x",
    ] {
        match authorize_fetch(url, &al, &r, 1000) {
            Err(DenyReason::BadScheme(_)) => {}
            other => panic!("{url}: expected BadScheme, got {other:?}"),
        }
    }
}

#[test]
fn authorize_fetch_denies_unparseable_url() {
    let al = allowlist(&["data.example.com"]);
    let r = public_resolver();
    for url in [
        "not a url",
        "https://",
        "https:///path",
        "://nohost",
        "file:///etc/passwd", // scheme with an empty authority
    ] {
        match authorize_fetch(url, &al, &r, 1000) {
            Err(DenyReason::UnparseableUrl) => {}
            other => panic!("{url}: expected UnparseableUrl, got {other:?}"),
        }
    }
}

#[test]
fn authorize_fetch_denies_host_not_allowed() {
    let al = allowlist(&["data.example.com"]);
    let r = public_resolver();
    let err = authorize_fetch("https://evil.example.com/x", &al, &r, 1000).unwrap_err();
    assert_eq!(err, DenyReason::HostNotAllowed("evil.example.com".into()));
}

#[test]
fn authorize_fetch_local_run_empty_allowlist_denies_all() {
    // §6a vector 2: a local-CSV run has an empty allowlist ⇒ every fetch refused.
    let al: Vec<String> = vec![];
    let r = public_resolver();
    let err = authorize_fetch("https://data.example.com/x", &al, &r, 1000).unwrap_err();
    assert!(matches!(err, DenyReason::HostNotAllowed(_)));
}

#[test]
fn authorize_fetch_s3_vhost_only_generic_host_denied() {
    // §6a vector 8: stored s3://bucket never yields s3.amazonaws.com reachability.
    let al = allowlist(&["bucket.s3.amazonaws.com"]);
    let r = FakeResolver::new().with("s3.amazonaws.com", vec![v4(52, 216, 1, 1)]);
    let err = authorize_fetch("https://s3.amazonaws.com/bucket/obj", &al, &r, 1000).unwrap_err();
    assert_eq!(err, DenyReason::HostNotAllowed("s3.amazonaws.com".into()));
}

#[test]
fn authorize_fetch_denies_resolves_to_internal() {
    // §6a vector 9: an allowlisted PUBLIC host that resolves to a LAN address.
    let al = allowlist(&["sneaky.example.com"]);
    let r = FakeResolver::new().with("sneaky.example.com", vec![v4(192, 168, 1, 50)]);
    let err = authorize_fetch("https://sneaky.example.com/x", &al, &r, 1000).unwrap_err();
    assert_eq!(err, DenyReason::ResolvesToInternal(v4(192, 168, 1, 50)));
}

#[test]
fn authorize_fetch_denies_resolves_to_metadata() {
    let al = allowlist(&["metadata-trap.example.com"]);
    let r = FakeResolver::new().with("metadata-trap.example.com", vec![v4(169, 254, 169, 254)]);
    let err = authorize_fetch("https://metadata-trap.example.com/x", &al, &r, 1000).unwrap_err();
    assert_eq!(err, DenyReason::ResolvesToInternal(v4(169, 254, 169, 254)));
}

#[test]
fn authorize_fetch_rejects_if_any_resolved_ip_internal() {
    // A resolver returning one public AND one internal address must be rejected
    // (round-robin / rebind SSRF): ANY blocked IP denies.
    let al = allowlist(&["mixed.example.com"]);
    let r = FakeResolver::new().with(
        "mixed.example.com",
        vec![v4(93, 184, 216, 34), v4(10, 0, 0, 1)],
    );
    let err = authorize_fetch("https://mixed.example.com/x", &al, &r, 1000).unwrap_err();
    assert_eq!(err, DenyReason::ResolvesToInternal(v4(10, 0, 0, 1)));
}

#[test]
fn authorize_fetch_denies_resolve_failure() {
    let al = allowlist(&["dead.example.com"]);
    let r = FakeResolver::new().failing("dead.example.com");
    let err = authorize_fetch("https://dead.example.com/x", &al, &r, 1000).unwrap_err();
    assert!(matches!(err, DenyReason::ResolveFailed(_)));
}

#[test]
fn authorize_fetch_denies_empty_resolution() {
    let al = allowlist(&["empty.example.com"]);
    let r = FakeResolver::new().with("empty.example.com", vec![]);
    let err = authorize_fetch("https://empty.example.com/x", &al, &r, 1000).unwrap_err();
    assert_eq!(err, DenyReason::EmptyResolution("empty.example.com".into()));
}

#[test]
fn authorize_fetch_ipv6_literal_host() {
    // A bracketed IPv6 literal that is allowlisted and public.
    let al = allowlist(&["2606:4700:4700::1111"]);
    let r = FakeResolver::new().with("2606:4700:4700::1111", vec![v6("2606:4700:4700::1111")]);
    let out = authorize_fetch("https://[2606:4700:4700::1111]/x", &al, &r, 1000).unwrap();
    assert_eq!(out.host, "2606:4700:4700::1111");
    assert_eq!(out.port, 443);
}

// =========================================================================
// URL parser edge cases
// =========================================================================

#[test]
fn parse_url_strips_userinfo_uses_last_at() {
    // An '@' in userinfo must not smuggle a fake host: real host is after the
    // final '@'.
    let p = parse_url("https://user:p@ss@real.example.com/x").unwrap();
    assert_eq!(p.host, "real.example.com");
}

#[test]
fn parse_url_lowercases_scheme_and_host() {
    let p = parse_url("HTTPS://Host.Example.COM/x").unwrap();
    assert_eq!(p.scheme, "https");
    assert_eq!(p.host, "host.example.com");
}

#[test]
fn parse_url_rejects_malformed() {
    assert!(parse_url("https://").is_none());
    assert!(parse_url("noscheme.com/path").is_none());
    assert!(parse_url("https://host:notaport/x").is_none());
    assert!(parse_url("https://host:99999/x").is_none()); // port out of u16 range
}

#[test]
fn parse_url_default_ports() {
    assert_eq!(parse_url("http://h.com").unwrap().port, 80);
    assert_eq!(parse_url("https://h.com").unwrap().port, 443);
}

// ── D18: byte-range parsing (the worker picks OFFSETS; it must never be able to
// smuggle a header value through, nor request a form we can't frame safely) ──

#[test]
fn parse_byte_range_accepts_the_two_supported_forms() {
    assert_eq!(
        parse_byte_range("bytes=0-3"),
        Some(ByteRange { start: 0, end: Some(3) })
    );
    assert_eq!(
        parse_byte_range("bytes=525066711-"),
        Some(ByteRange { start: 525066711, end: None })
    );
    // surrounding whitespace is tolerated, the value is still canonicalized
    assert_eq!(
        parse_byte_range("  bytes=10-20  "),
        Some(ByteRange { start: 10, end: Some(20) })
    );
    // single byte (used to probe total size for a HEAD)
    assert_eq!(
        parse_byte_range("bytes=0-0"),
        Some(ByteRange { start: 0, end: Some(0) })
    );
}

#[test]
fn parse_byte_range_fails_closed_on_everything_else() {
    // multi-range would make the response multipart — we cannot frame it
    assert_eq!(parse_byte_range("bytes=0-1,5-6"), None);
    // suffix form needs the total length to interpret
    assert_eq!(parse_byte_range("bytes=-500"), None);
    // inverted
    assert_eq!(parse_byte_range("bytes=9-2"), None);
    // wrong/absent unit, junk, and header-injection attempts
    assert_eq!(parse_byte_range("0-3"), None);
    assert_eq!(parse_byte_range("items=0-3"), None);
    assert_eq!(parse_byte_range("bytes=abc"), None);
    assert_eq!(parse_byte_range(""), None);
    assert_eq!(parse_byte_range("bytes=0-3\r\nX-Evil: 1"), None);
}

#[test]
fn byte_range_header_value_is_reserialized_not_echoed() {
    // The header the edge sends is built from the PARSED numbers, so no caller
    // string ever reaches the wire verbatim.
    let r = parse_byte_range("  bytes=10-20  ").unwrap();
    assert_eq!(r.to_header_value(), "bytes=10-20");
    assert_eq!(
        ByteRange { start: 7, end: None }.to_header_value(),
        "bytes=7-"
    );
}
