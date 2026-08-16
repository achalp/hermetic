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
import fcntl
import os
import socket
import struct
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

# Max bytes moved per splice/recv call.
RELAY_BUF = 1 << 20

# Zero-copy relay via splice(2): bytes move socket -> kernel pipe -> socket
# without ever being copied into userspace. The old recv()/sendall() relay
# copied every byte through a Python bytes object twice (kernel->user->kernel)
# and turned a 45-second planet-scale scan into 25 minutes (run e1c88a71);
# widening the buffer to 1 MiB only softened it. splice keeps the data in the
# kernel, so the proxy is no longer the throughput bottleneck and a
# hostname-allowlisted (secure) tunnel runs at close to direct-egress speed.
# splice is Linux + Py3.10; fall back to the copy relay where it's absent.
HAVE_SPLICE = hasattr(os, "splice")
_SPLICE_FLAGS = (os.SPLICE_F_MOVE | os.SPLICE_F_MORE) if HAVE_SPLICE else 0


def _set_idle_timeout(sock):
    """Blocking socket with a kernel recv/send timeout. splice() then blocks for
    a live-but-quiet tunnel (a billions-row scan can go minutes without a byte)
    yet a genuinely dead one is reaped after IDLE_TIMEOUT_S. Uses setsockopt, NOT
    settimeout — settimeout sets O_NONBLOCK, which would make splice return EAGAIN
    immediately and busy-loop. (Verified: blocking splice honors SO_RCVTIMEO.)"""
    sock.setblocking(True)
    tv = struct.pack("@ll", IDLE_TIMEOUT_S, 0)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVTIMEO, tv)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDTIMEO, tv)


def _relay_splice(src, dst):
    """One direction, zero-copy: src socket -> kernel pipe -> dst socket. On EOF,
    idle-timeout, or a dead peer, half-close dst so the other side sees EOF."""
    src_fd, dst_fd = src.fileno(), dst.fileno()
    r, w = os.pipe()
    try:
        fcntl.fcntl(w, fcntl.F_SETPIPE_SZ, RELAY_BUF)  # fewer syscalls per MiB
    except OSError:
        pass
    try:
        while True:
            try:
                n = os.splice(src_fd, w, RELAY_BUF, flags=_SPLICE_FLAGS)
            except OSError:
                break  # idle timeout (EAGAIN) or read error
            if n == 0:
                break  # EOF
            dead = False
            while n > 0:
                try:
                    m = os.splice(r, dst_fd, n, flags=_SPLICE_FLAGS)
                except OSError:
                    dead = True
                    break
                if m == 0:
                    dead = True
                    break
                n -= m
            if dead:
                break  # dst gone — drop any residual, stop
    finally:
        os.close(r)
        os.close(w)
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def _relay_copy(src, dst):
    """Fallback one-direction relay: copy through a userspace buffer. Used only
    where splice(2) is unavailable."""
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


_relay = _relay_splice if HAVE_SPLICE else _relay_copy


def pump(a, b):
    """Relay both directions until EOF — one thread per direction (each releases
    the GIL inside splice/recv). See _relay_splice for the zero-copy path."""
    _set_idle_timeout(a)
    _set_idle_timeout(b)
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
