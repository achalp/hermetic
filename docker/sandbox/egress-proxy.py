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
import select
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


def pump(a, b):
    try:
        while True:
            r, _, _ = select.select([a, b], [], [], IDLE_TIMEOUT_S)
            if not r:
                break
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass


def handle(client):
    try:
        client.settimeout(30)
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = client.recv(65536)
            if not chunk:
                return
            head += chunk
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
            client.settimeout(None)
            upstream.settimeout(None)
            pump(client, upstream)
            upstream.close()
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
        client.settimeout(None)
        upstream.settimeout(None)
        pump(client, upstream)
        upstream.close()
    except OSError as e:
        log(f"error: {e}")
    finally:
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
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
