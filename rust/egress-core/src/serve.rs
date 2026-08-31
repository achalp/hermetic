//! `egress-fetch serve` — the PERSISTENT fetcher framing (build log D41, task #37).
//!
//! Spawning one `egress-fetch` process per ranged read costs ~300–500 ms
//! (process spawn + DNS + TLS handshake) — per FOOTER READ. Serve mode keeps one
//! long-lived child whose pooled HTTP agent reuses TLS connections, so a run of
//! sequential DuckDB range reads pays the handshake once per host, not per read.
//!
//! SECURITY — nothing about the boundary changes:
//! - **No listener sockets.** The transport is stdin/stdout of a child the
//!   trusted sidecar spawned. Nothing else on the machine can reach it.
//! - **Every request re-runs the FULL §6a decision** (`authorize_and_fetch_range_with`:
//!   allowlist + resolve-and-reject + IP pinning + no-follow redirects + cap).
//!   Connection REUSE is safe by construction: a pooled socket was established
//!   to an address that was vetted at connect time, which is exactly the
//!   rebinding defense — reuse never re-resolves.
//! - **Fail closed on framing errors.** A malformed frame terminates the
//!   process (exit 64) instead of attempting a resync; the Node side treats any
//!   death as crash-restart. The only writer is our own client, so a bad frame
//!   is a bug, never traffic to tolerate.
//! - **Serial by contract.** One request is fully answered before the next is
//!   read. The Node client serializes; the loop enforces it structurally.
//!
//! WIRE FORMAT (text header lines; response bodies are raw bytes):
//!
//! ```text
//! → REQ <id>                      id: [A-Za-z0-9_-]{1,64}
//! → URL <url>
//! → ALLOW <host1,host2,...>
//! → RANGE bytes=START[-END]       validated by parse_byte_range (fail closed)
//! → CAP <bytes>                   optional
//! → BEARER <token>                optional (mutually exclusive with HEADERCRED)
//! → HEADERCRED <name>\t<value>    optional
//! → END
//! ← OK <id> <nbytes> <content-range>\n  followed by exactly <nbytes> raw bytes
//! ← ERR <id> <code> <message>\n         codes mirror the bin's exit codes
//! ```
//!
//! Values may not contain control characters (they would break line framing);
//! the one sanctioned exception is the single `\t` separating HEADERCRED's name
//! from its value.

use std::io::{BufRead, Write};

use crate::fetch::{Credentials, FetchError};
use crate::{parse_byte_range, ByteRange};

/// One parsed request frame. All fields come from the TRUSTED sidecar (the only
/// stdin writer); they are still validated because fail-closed framing is what
/// keeps a client bug from becoming a silent policy change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeRequest {
    pub id: String,
    pub url: String,
    pub allowlist: Vec<String>,
    pub range: ByteRange,
    pub cap: Option<u64>,
    pub creds: Credentials,
}

/// True iff `id` is a safe response-correlation token.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// True iff `v` can sit inside a line frame without breaking it.
fn frame_safe(v: &str) -> bool {
    !v.chars().any(|c| c.is_control())
}

/// Read one request frame. `Ok(None)` on clean EOF *before* a frame starts —
/// that is the orderly-shutdown signal (the client closed stdin). Any error —
/// EOF mid-frame, unknown key, missing key, malformed value — is fatal to the
/// serve process by design.
pub fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<ServeRequest>, String> {
    let mut line = String::new();

    // First line: REQ <id> (skip blank lines between frames).
    let id = loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Ok(None); // clean EOF between frames
        }
        let t = line.trim_end_matches(['\r', '\n']);
        if t.is_empty() {
            continue;
        }
        let Some(id) = t.strip_prefix("REQ ") else {
            return Err(format!("expected REQ, got {t:?}"));
        };
        if !valid_id(id) {
            return Err(format!("invalid request id {id:?}"));
        }
        break id.to_string();
    };

    let mut url: Option<String> = None;
    let mut allowlist: Option<Vec<String>> = None;
    let mut range: Option<ByteRange> = None;
    let mut cap: Option<u64> = None;
    let mut creds = Credentials::None;

    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err(format!("EOF inside frame {id}"));
        }
        let t = line.trim_end_matches(['\r', '\n']);
        if t == "END" {
            break;
        }
        let (key, value) = t.split_once(' ').ok_or_else(|| format!("bad line {t:?}"))?;
        match key {
            "URL" => {
                if !frame_safe(value) {
                    return Err("control characters in URL".into());
                }
                url = Some(value.to_string());
            }
            "ALLOW" => {
                if !frame_safe(value) {
                    return Err("control characters in ALLOW".into());
                }
                let hosts: Vec<String> = value
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if hosts.is_empty() {
                    return Err("empty allowlist (fail closed)".into());
                }
                allowlist = Some(hosts);
            }
            "RANGE" => {
                range = Some(
                    parse_byte_range(value).ok_or_else(|| format!("malformed range {value:?}"))?,
                );
            }
            "CAP" => {
                let n: u64 = value.parse().map_err(|_| format!("bad cap {value:?}"))?;
                if n == 0 {
                    return Err("zero cap".into());
                }
                cap = Some(n);
            }
            "BEARER" => {
                if !frame_safe(value) {
                    return Err("control characters in BEARER".into());
                }
                creds = Credentials::Bearer(value.to_string());
            }
            "HEADERCRED" => {
                let (name, hval) = value
                    .split_once('\t')
                    .ok_or_else(|| "HEADERCRED needs name\\tvalue".to_string())?;
                if !frame_safe(name) || !frame_safe(hval) || name.is_empty() {
                    return Err("bad HEADERCRED".into());
                }
                creds = Credentials::Header {
                    name: name.to_string(),
                    value: hval.to_string(),
                };
            }
            // Unknown keys fail closed: a newer client speaking a field this
            // build does not understand must not have it silently ignored.
            other => return Err(format!("unknown frame key {other:?}")),
        }
    }

    Ok(Some(ServeRequest {
        id,
        url: url.ok_or("frame missing URL")?,
        allowlist: allowlist.ok_or("frame missing ALLOW")?,
        range: range.ok_or("frame missing RANGE")?,
        cap,
        creds,
    }))
}

/// The bin's documented exit-code mapping, reused as the per-request ERR code so
/// the Node side's `kindForExit` works unchanged for serve-mode errors.
pub fn error_code(err: &FetchError) -> u8 {
    match err {
        FetchError::Denied(_) => 1,
        FetchError::Transport(_) => 2,
        FetchError::CapExceeded { .. } => 3,
        FetchError::RedirectNotAllowed(_) | FetchError::TooManyRedirects => 4,
        FetchError::UnparseableRedirect(_) | FetchError::BadRedirectScheme(_) => 5,
    }
}

/// Write a success response: header line, then exactly `body.len()` raw bytes.
pub fn write_ok<W: Write>(
    w: &mut W,
    id: &str,
    content_range: &str,
    body: &[u8],
) -> std::io::Result<()> {
    // A header from a hostile upstream could contain framing characters; strip
    // control chars so the header line can never be split or spoofed.
    let cr: String = content_range.chars().filter(|c| !c.is_control()).collect();
    write!(w, "OK {id} {} {cr}\n", body.len())?;
    w.write_all(body)?;
    w.flush()
}

/// Write an error response (one line, no body).
pub fn write_err<W: Write>(w: &mut W, id: &str, code: u8, msg: &str) -> std::io::Result<()> {
    let one_line: String = msg
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    write!(w, "ERR {id} {code} {one_line}\n")?;
    w.flush()
}

/// The serve loop: strictly serial — read a frame, answer it, read the next.
/// `handle` performs the actual authorized ranged fetch; it is injected so the
/// framing is unit-testable without a socket (the same seam as `Fetcher`).
pub fn serve_loop<R, W, F>(reader: &mut R, writer: &mut W, mut handle: F) -> Result<(), String>
where
    R: BufRead,
    W: Write,
    F: FnMut(&ServeRequest) -> Result<(Vec<u8>, String), (u8, String)>,
{
    while let Some(req) = read_frame(reader)? {
        match handle(&req) {
            Ok((body, content_range)) => write_ok(writer, &req.id, &content_range, &body)
                .map_err(|e| format!("stdout write failed: {e}"))?,
            Err((code, msg)) => write_err(writer, &req.id, code, &msg)
                .map_err(|e| format!("stdout write failed: {e}"))?,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DenyReason;
    use std::io::Cursor;

    fn frame(lines: &[&str]) -> Vec<u8> {
        let mut s = String::new();
        for l in lines {
            s.push_str(l);
            s.push('\n');
        }
        s.into_bytes()
    }

    const GOOD: &[&str] = &[
        "REQ r1",
        "URL https://data.example.com/x.parquet",
        "ALLOW data.example.com,cdn.example.com",
        "RANGE bytes=0-99",
        "END",
    ];

    #[test]
    fn parses_a_full_frame() {
        let mut r = Cursor::new(frame(GOOD));
        let req = read_frame(&mut r).unwrap().unwrap();
        assert_eq!(req.id, "r1");
        assert_eq!(req.url, "https://data.example.com/x.parquet");
        assert_eq!(req.allowlist, vec!["data.example.com", "cdn.example.com"]);
        assert_eq!(req.range.to_header_value(), "bytes=0-99");
        assert_eq!(req.cap, None);
        assert_eq!(req.creds, Credentials::None);
    }

    #[test]
    fn clean_eof_before_a_frame_is_orderly_shutdown() {
        let mut r = Cursor::new(Vec::<u8>::new());
        assert_eq!(read_frame(&mut r).unwrap(), None);
        // Blank lines alone are also a clean EOF, not an error.
        let mut r = Cursor::new(b"\n\n".to_vec());
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn eof_mid_frame_is_fatal() {
        let mut r = Cursor::new(frame(&["REQ r1", "URL https://h/x"]));
        assert!(read_frame(&mut r).unwrap_err().contains("EOF inside frame"));
    }

    #[test]
    fn missing_required_keys_fail_closed() {
        for missing in ["URL", "ALLOW", "RANGE"] {
            let lines: Vec<&str> = GOOD
                .iter()
                .copied()
                .filter(|l| !l.starts_with(missing))
                .collect();
            let mut r = Cursor::new(frame(&lines));
            let err = read_frame(&mut r).unwrap_err();
            assert!(
                err.contains(missing),
                "expected missing-{missing} error, got {err}"
            );
        }
    }

    #[test]
    fn unknown_key_fails_closed() {
        let mut r = Cursor::new(frame(&["REQ r1", "VERB POST", "END"]));
        assert!(read_frame(&mut r)
            .unwrap_err()
            .contains("unknown frame key"));
    }

    #[test]
    fn malformed_range_and_cap_fail_closed() {
        let mut r = Cursor::new(frame(&["REQ r1", "RANGE bytes=5-2", "END"]));
        assert!(read_frame(&mut r).unwrap_err().contains("malformed range"));
        let mut r = Cursor::new(frame(&["REQ r1", "CAP -3", "END"]));
        assert!(read_frame(&mut r).unwrap_err().contains("bad cap"));
        let mut r = Cursor::new(frame(&["REQ r1", "CAP 0", "END"]));
        assert!(read_frame(&mut r).unwrap_err().contains("zero cap"));
    }

    #[test]
    fn empty_allowlist_fails_closed() {
        let mut r = Cursor::new(frame(&["REQ r1", "ALLOW  , ,", "END"]));
        assert!(read_frame(&mut r).unwrap_err().contains("fail closed"));
    }

    #[test]
    fn control_characters_in_values_fail_closed() {
        let mut r = Cursor::new(frame(&["REQ r1", "URL https://h/\u{7}x", "END"]));
        assert!(read_frame(&mut r)
            .unwrap_err()
            .contains("control characters"));
        let mut r = Cursor::new(frame(&["REQ r1", "BEARER tok\u{1b}en", "END"]));
        assert!(read_frame(&mut r)
            .unwrap_err()
            .contains("control characters"));
    }

    #[test]
    fn hostile_request_ids_are_refused() {
        for id in ["", "a b", "x\u{7}", "../../x", &"a".repeat(65)] {
            let mut r = Cursor::new(frame(&[&format!("REQ {id}"), "END"]));
            assert!(read_frame(&mut r).is_err(), "id {id:?} must be refused");
        }
    }

    #[test]
    fn credentials_parse_bearer_and_header_forms() {
        let mut lines: Vec<String> = GOOD.iter().map(|s| s.to_string()).collect();
        lines.insert(4, "BEARER sekret".to_string());
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        let mut r = Cursor::new(frame(&refs));
        assert_eq!(
            read_frame(&mut r).unwrap().unwrap().creds,
            Credentials::Bearer("sekret".into())
        );

        let mut lines: Vec<String> = GOOD.iter().map(|s| s.to_string()).collect();
        lines.insert(4, "HEADERCRED x-api-key\tv123".to_string());
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        let mut r = Cursor::new(frame(&refs));
        assert_eq!(
            read_frame(&mut r).unwrap().unwrap().creds,
            Credentials::Header {
                name: "x-api-key".into(),
                value: "v123".into()
            }
        );

        let mut r = Cursor::new(frame(&["REQ r1", "HEADERCRED no-tab-here", "END"]));
        assert!(read_frame(&mut r).unwrap_err().contains("HEADERCRED"));
    }

    #[test]
    fn serve_loop_answers_frames_in_order_with_exact_bodies() {
        let mut input = frame(GOOD);
        let mut second: Vec<&str> = GOOD.to_vec();
        second[0] = "REQ r2";
        input.extend(frame(&second));
        let mut out = Vec::new();
        let mut n = 0;
        serve_loop(&mut Cursor::new(input), &mut out, |req| {
            n += 1;
            Ok((
                format!("body-for-{}", req.id).into_bytes(),
                format!("bytes 0-99/1000"),
            ))
        })
        .unwrap();
        assert_eq!(n, 2);
        let expect = b"OK r1 11 bytes 0-99/1000\nbody-for-r1OK r2 11 bytes 0-99/1000\nbody-for-r2";
        assert_eq!(out, expect.to_vec());
    }

    #[test]
    fn serve_loop_maps_fetch_errors_to_err_lines_and_continues() {
        let mut input = frame(GOOD);
        let mut second: Vec<&str> = GOOD.to_vec();
        second[0] = "REQ r2";
        input.extend(frame(&second));
        let mut out = Vec::new();
        serve_loop(&mut Cursor::new(input), &mut out, |req| {
            if req.id == "r1" {
                Err((
                    error_code(&FetchError::Denied(DenyReason::UnparseableUrl)),
                    "denied: unparseable URL".to_string(),
                ))
            } else {
                Ok((b"ok".to_vec(), String::new()))
            }
        })
        .unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("ERR r1 1 denied: unparseable URL\n"));
        assert!(s.contains("OK r2 2 \n"));
    }

    #[test]
    fn ok_header_strips_control_chars_from_a_hostile_content_range() {
        // A hostile upstream's Content-Range must never inject a fake frame line.
        let mut out = Vec::new();
        write_ok(&mut out, "r1", "bytes 0-1/9\nOK evil 0 ", b"xy").unwrap();
        let s = String::from_utf8(out).unwrap();
        assert_eq!(s, "OK r1 2 bytes 0-1/9OK evil 0 \nxy");
        assert_eq!(s.matches('\n').count(), 1);
    }

    #[test]
    fn error_codes_mirror_the_bin_exit_codes() {
        assert_eq!(
            error_code(&FetchError::Denied(DenyReason::UnparseableUrl)),
            1
        );
        assert_eq!(error_code(&FetchError::Transport("x".into())), 2);
        assert_eq!(error_code(&FetchError::CapExceeded { read: 9 }), 3);
        assert_eq!(
            error_code(&FetchError::RedirectNotAllowed(DenyReason::UnparseableUrl)),
            4
        );
        assert_eq!(error_code(&FetchError::TooManyRedirects), 4);
        assert_eq!(error_code(&FetchError::UnparseableRedirect("l".into())), 5);
        assert_eq!(error_code(&FetchError::BadRedirectScheme("ftp".into())), 5);
    }

    #[test]
    fn multiple_frames_separated_by_blank_lines_parse() {
        let mut input = frame(GOOD);
        input.extend(b"\n\n");
        let mut second: Vec<&str> = GOOD.to_vec();
        second[0] = "REQ r2";
        input.extend(frame(&second));
        let mut r = Cursor::new(input);
        assert_eq!(read_frame(&mut r).unwrap().unwrap().id, "r1");
        assert_eq!(read_frame(&mut r).unwrap().unwrap().id, "r2");
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }
}
