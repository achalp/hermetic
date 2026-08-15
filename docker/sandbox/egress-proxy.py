# Allowlist egress proxy for the hermetic sandbox (stdlib only).
#
# Runs in the GATEWAY container of a restricted-egress analysis run
# (lib/sandbox/egress.ts): the analysis container sits on an internal Docker
# network with no outbound route; this proxy is its only door, and the door
# only opens toward the ALLOW_HOSTS list (exact hostname match, both HTTPS
# CONNECT tunnels — TLS passes through untouched, so certificate validation
# stays end-to-end — and plain absolute-URI HTTP requests).
#
# Deny is the default: anything not explicitly allowed gets 403 and a log
# line on stderr.
import os
import socket
import sys
import threading
from urllib.parse import urlsplit

ALLOW_HOSTS = {h.strip().lower() for h in os.environ.get("ALLOW_HOSTS", "").split(",") if h.strip()}
PORT = int(os.environ.get("PROXY_PORT", "3128"))


def log(msg):
    sys.stderr.write(f"[egress-proxy] {msg}\n")
    sys.stderr.flush()


def allowed(host):
    return host.lower() in ALLOW_HOSTS


# A billions-row remote scan can go minutes without a byte on the socket
# (DuckDB planning, server-side work), so a short idle cut would surface as an
# opaque read failure. Only a genuinely dead tunnel is reaped.
IDLE_TIMEOUT_S = int(os.environ.get("PROXY_IDLE_TIMEOUT_S", "1800"))

# Relay buffer: 1 MiB. The original select()-loop pump moved 64 KB per
# syscall round-trip through the GIL and turned a 45-second planet-scale
# scan into 25 minutes (run e1c88a71). Blocking recv/send release the GIL,
# so one thread per direction relays at close to native throughput.
RELAY_BUF = 1 << 20


def _relay(src, dst):
    """One direction of a tunnel. On EOF or error, half-close the write side
    of dst so the peer sees EOF while the reverse direction drains."""
    try:
        while True:
            data = src.recv(RELAY_BUF)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def pump(a, b):
    a.settimeout(IDLE_TIMEOUT_S)
    b.settimeout(IDLE_TIMEOUT_S)
    t = threading.Thread(target=_relay, args=(b, a), daemon=True)
    t.start()
    _relay(a, b)
    t.join()


# A well-formed proxy request line + headers are small; cap the header read so
# a client that never sends the CRLFCRLF terminator can't make us buffer without
# bound. 64 KiB is far past any legitimate CONNECT/GET header block.
MAX_HEADER_BYTES = 65536


def handle(client):
    upstream = None
    try:
        client.settimeout(30)
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = client.recv(65536)
            if not chunk:
                return
            head += chunk
            if len(head) > MAX_HEADER_BYTES:
                log("DENY oversized request header")
                try:
                    client.sendall(b"HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n")
                except OSError:
                    pass
                return
        request_line = head.split(b"\r\n", 1)[0].decode("latin1", "replace")
        parts = request_line.split(" ")
        if len(parts) < 3:
            return
        method, target = parts[0], parts[1]

        if method == "CONNECT":
            host, _, port = target.partition(":")
            if not allowed(host):
                log(f"DENY CONNECT {host}")
                client.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
                return
            upstream = socket.create_connection((host, int(port or 443)), timeout=30)
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            pump(client, upstream)
            return

        # Absolute-URI plain HTTP (GET http://host/path)
        url = urlsplit(target)
        host = url.hostname or ""
        if not allowed(host):
            log(f"DENY {method} {host}")
            client.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            return
        upstream = socket.create_connection((host, url.port or 80), timeout=30)
        # Rewrite to origin-form and forward the rest verbatim.
        origin = (url.path or "/") + (f"?{url.query}" if url.query else "")
        rest = head.split(b"\r\n", 1)[1]
        upstream.sendall(f"{method} {origin} HTTP/1.1\r\n".encode("latin1") + rest)
        pump(client, upstream)
    except OSError as e:
        log(f"error: {e}")
    finally:
        # Close BOTH sockets on every exit path — a connection that failed
        # after create_connection but before/inside pump used to leak the
        # upstream fd until the process died.
        if upstream is not None:
            try:
                upstream.close()
            except OSError:
                pass
        try:
            client.close()
        except OSError:
            pass


def main():
    log(f"listening :{PORT}, allow={sorted(ALLOW_HOSTS)}")
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", PORT))
    srv.listen(64)
    while True:
        # One transient accept() error (EMFILE, an interrupted syscall) must not
        # silently kill the proxy and strand every in-flight analysis with an
        # opaque connection failure — log and keep serving.
        try:
            conn, _ = srv.accept()
        except OSError as e:
            log(f"accept error: {e}")
            continue
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
