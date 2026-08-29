//! Minimal, std-only URL parsing — enough for the egress decision path.
//!
//! We deliberately avoid the `url` crate: this keeps the crate buildable
//! OFFLINE and keeps the security-critical decision path free of third-party
//! parsing surface. We only need scheme + host + port, and we reject anything
//! that is not a clean absolute `http(s)://` URL rather than trying to be
//! lenient (lenience is how SSRF parsers get bypassed).

/// The parts of a URL the egress decision cares about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedUrl {
    /// Lowercased scheme, without `://` (e.g. `"https"`).
    pub scheme: String,
    /// Lowercased host. For an IPv6 literal, the surrounding brackets are
    /// stripped (e.g. `"::1"`, not `"[::1]"`).
    pub host: String,
    /// Effective port (explicit, else the scheme default).
    pub port: u16,
}

/// Parse an absolute URL into scheme/host/port. Returns `None` for anything
/// that is not a well-formed absolute URL with a nonempty host.
///
/// This does NOT restrict the scheme to http(s) — that policy lives in
/// `authorize_fetch` so the reason is reported explicitly.
pub fn parse_url(raw: &str) -> Option<ParsedUrl> {
    // scheme://
    let (scheme, rest) = raw.split_once("://")?;
    if scheme.is_empty() || !scheme.chars().all(is_scheme_char) {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();

    // Strip anything after the authority: path '/', query '?', or fragment '#'.
    let authority_end = rest
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() {
        return None;
    }

    // Strip userinfo (`user:pass@host`). Use the LAST '@' so an '@' inside
    // userinfo cannot smuggle a fake host — the real host is after the final
    // '@'. (An '@' cannot legally appear in the host itself.)
    let hostport = match authority.rsplit_once('@') {
        Some((_userinfo, hp)) => hp,
        None => authority,
    };
    if hostport.is_empty() {
        return None;
    }

    let (host, port_opt) = split_host_port(hostport)?;
    if host.is_empty() {
        return None;
    }

    // Unknown scheme with no explicit port → port 0 sentinel. The scheme is
    // still rejected downstream (authorize_fetch checks the scheme before the
    // port), but we parse rather than fail so the caller can report the precise
    // "unsupported scheme" reason instead of a generic "unparseable".
    let port = match port_opt {
        Some(p) => p,
        None => default_port(&scheme).unwrap_or(0),
    };

    Some(ParsedUrl {
        scheme,
        host: host.to_ascii_lowercase(),
        port,
    })
}

fn is_scheme_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.'
}

fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    }
}

/// Split `host:port` (or bracketed `[ipv6]:port`) into host and optional port.
fn split_host_port(hp: &str) -> Option<(&str, Option<u16>)> {
    if let Some(stripped) = hp.strip_prefix('[') {
        // IPv6 literal: `[..]` then optional `:port`.
        let close = stripped.find(']')?;
        let host = &stripped[..close];
        let after = &stripped[close + 1..];
        if after.is_empty() {
            return Some((host, None));
        }
        let port_str = after.strip_prefix(':')?;
        return Some((host, Some(parse_port(port_str)?)));
    }
    // Regular host. A port is present only if there's exactly one ':' .
    match hp.rsplit_once(':') {
        Some((host, port_str)) => {
            // Guard against a bare IPv6 with multiple ':' that wasn't bracketed —
            // reject rather than misparse.
            if host.contains(':') {
                return None;
            }
            Some((host, Some(parse_port(port_str)?)))
        }
        None => Some((hp, None)),
    }
}

fn parse_port(s: &str) -> Option<u16> {
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    s.parse::<u16>().ok()
}
