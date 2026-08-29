//! IP address classification — the desktop §6a variant of `egress-proxy.py`'s
//! `_is_blocked_ip`.
//!
//! # Divergence from the Python reference (deliberate — spec §6a)
//!
//! `docker/sandbox/egress-proxy.py::_is_blocked_ip` blocks loopback,
//! link-local, multicast, reserved, and unspecified, but **ALLOWS** RFC-1918 /
//! CGNAT private ranges at connect time: an on-prem / self-hosted data endpoint
//! and the docker host gateway (`host.docker.internal`) legitimately resolve
//! there, and the Docker gateway is per-run and torn down.
//!
//! This is the **desktop** core. Per spec §6a ("RFC-1918 policy is a DECISION,
//! not an inheritance"), on a user's machine the LAN itself is a threat surface
//! (a public hostname that resolves to `192.168.x.x` is a router/NAS/printer
//! SSRF), so this core is **STRICTER than the Python proxy**: it ALSO rejects
//! resolved RFC-1918 and CGNAT ranges. This deliberately breaks on-prem
//! endpoints on desktop — accepted per spec for the non-technical target.
//!
//! All classification is done from raw octets/segments here rather than via
//! `std`'s partially-unstable `Ipv4Addr`/`Ipv6Addr` helpers (`is_shared`,
//! `is_reserved`, `is_benchmarking` are unstable as of Rust 1.97), so the
//! policy is explicit, stable, and auditable.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// The cloud-metadata service address (link-local; also independently pinned).
pub const IPV4_METADATA: Ipv4Addr = Ipv4Addr::new(169, 254, 169, 254);

/// `true` if the core must REFUSE to connect to this resolved address.
///
/// Fail-closed: any address that falls in loopback, link-local (incl. cloud
/// metadata), multicast, unspecified, broadcast, documentation/benchmarking/
/// reserved, OR — the desktop divergence — an RFC-1918 / CGNAT private range is
/// blocked. Only a genuine, routable, public unicast address is allowed.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

/// IPv4 classification. Blocks everything that is not routable public unicast.
pub fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _d] = ip.octets();

    // 0.0.0.0/8 — "this network"; 0.0.0.0 is also unspecified.
    if a == 0 {
        return true;
    }
    // 127.0.0.0/8 — loopback.
    if a == 127 {
        return true;
    }
    // RFC-1918 private (DESKTOP DIVERGENCE — Python proxy allows these):
    //   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    if a == 10 {
        return true;
    }
    if a == 172 && (16..=31).contains(&b) {
        return true;
    }
    if a == 192 && b == 168 {
        return true;
    }
    // 100.64.0.0/10 — CGNAT / carrier-grade NAT shared address space
    // (DESKTOP DIVERGENCE — treated as private).
    if a == 100 && (64..=127).contains(&b) {
        return true;
    }
    // 169.254.0.0/16 — link-local (includes 169.254.169.254 cloud metadata).
    if a == 169 && b == 254 {
        return true;
    }
    // 192.0.0.0/24 — IETF protocol assignments.
    if a == 192 && b == 0 && c == 0 {
        return true;
    }
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — documentation (TEST-NET).
    if a == 192 && b == 0 && c == 2 {
        return true;
    }
    if a == 198 && b == 51 && c == 100 {
        return true;
    }
    if a == 203 && b == 0 && c == 113 {
        return true;
    }
    // 198.18.0.0/15 — benchmarking.
    if a == 198 && (b == 18 || b == 19) {
        return true;
    }
    // 224.0.0.0/4 — multicast.
    if (224..=239).contains(&a) {
        return true;
    }
    // 240.0.0.0/4 — reserved (future use), which also covers
    // 255.255.255.255 broadcast.
    if a >= 240 {
        return true;
    }
    false
}

/// IPv6 classification. Blocks loopback, unspecified, multicast, link-local,
/// unique-local (the RFC-1918 equivalent), documentation, discard-only, and
/// re-checks any embedded IPv4 (IPv4-mapped / -compatible / NAT64) against the
/// IPv4 policy so `::ffff:192.168.0.1` cannot dodge the private-range block.
pub fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    // Unspecified :: and loopback ::1
    if ip.is_unspecified() || ip.is_loopback() {
        return true;
    }

    let segs = ip.segments();

    // Embedded IPv4 must be re-vetted with the IPv4 policy.
    //   ::ffff:a.b.c.d  (IPv4-mapped, ::ffff:0:0/96)
    //   ::a.b.c.d       (IPv4-compatible, deprecated, ::/96)
    //   64:ff9b::/96    (NAT64 well-known prefix)
    if let Some(v4) = embedded_ipv4(&segs) {
        return is_blocked_ipv4(v4);
    }

    // ff00::/8 — multicast (covers fd00:ec2::254? no; that's ULA, handled below).
    if segs[0] & 0xff00 == 0xff00 {
        return true;
    }
    // fe80::/10 — link-local.
    if segs[0] & 0xffc0 == 0xfe80 {
        return true;
    }
    // fc00::/7 — unique local address (ULA; the RFC-1918 equivalent, includes
    // fd00:ec2::254 cloud metadata). DESKTOP DIVERGENCE: rejected.
    if segs[0] & 0xfe00 == 0xfc00 {
        return true;
    }
    // 2001:db8::/32 — documentation.
    if segs[0] == 0x2001 && segs[1] == 0x0db8 {
        return true;
    }
    // 100::/64 — discard-only.
    if segs[0] == 0x0100 && segs[1] == 0 && segs[2] == 0 && segs[3] == 0 {
        return true;
    }
    false
}

/// Extract an embedded IPv4 address from an IPv4-mapped, IPv4-compatible, or
/// NAT64 IPv6 address. `None` if this is a native IPv6 address.
fn embedded_ipv4(segs: &[u16; 8]) -> Option<Ipv4Addr> {
    let v4 = |segs: &[u16; 8]| {
        Ipv4Addr::new(
            (segs[6] >> 8) as u8,
            (segs[6] & 0xff) as u8,
            (segs[7] >> 8) as u8,
            (segs[7] & 0xff) as u8,
        )
    };
    // ::ffff:0:0/96 — IPv4-mapped.
    if segs[0..5] == [0, 0, 0, 0, 0] && segs[5] == 0xffff {
        return Some(v4(segs));
    }
    // 64:ff9b::/96 — NAT64 well-known prefix.
    if segs[0] == 0x0064 && segs[1] == 0xff9b && segs[2..6] == [0, 0, 0, 0] {
        return Some(v4(segs));
    }
    // ::/96 IPv4-compatible (deprecated) — but exclude :: and ::1 (already
    // handled) and the loopback tail. Require a nonzero embedded v4 that isn't
    // pure loopback marker.
    if segs[0..6] == [0, 0, 0, 0, 0, 0] && !(segs[6] == 0 && segs[7] <= 1) {
        return Some(v4(segs));
    }
    None
}
