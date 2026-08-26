import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * The egress proxy's tunnel relay was converted from a userspace recv()/sendall()
 * copy to zero-copy splice(2) (bytes stay in the kernel: socket -> pipe -> socket)
 * so the secure hostname-allowlisted L7 tier runs near direct-egress speed. This
 * exercises the real pump() over socketpairs: a large payload (chunking +
 * backpressure past the pipe/socket buffers), the reverse direction, and EOF
 * propagation. Skipped when python3 is unavailable (the proxy runs in-image).
 */
const havePython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const PROXY = resolve(process.cwd(), "docker/sandbox/egress-proxy.py");

const SCRIPT = `
import importlib.util, os, socket, threading
spec = importlib.util.spec_from_file_location("egp", ${JSON.stringify(PROXY)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

a, ap = socket.socketpair(); b, bp = socket.socketpair()
th = threading.Thread(target=m.pump, args=(a, b), daemon=True); th.start()

# a->b: 5 MB (exceeds the 1 MiB pipe + socket buffers -> chunked splice + backpressure)
payload = os.urandom(5_000_000)
def writer(): ap.sendall(payload); ap.shutdown(socket.SHUT_WR)
threading.Thread(target=writer, daemon=True).start()
got = bytearray(); bp.settimeout(20)
while len(got) < len(payload):
    c = bp.recv(1 << 20)
    if not c: break
    got += c
assert bytes(got) == payload, "a->b integrity"

# b->a reverse direction, integrity
bp.sendall(b"reverse-channel-check"); ap.settimeout(5)
assert ap.recv(64) == b"reverse-channel-check", "b->a integrity"

# EOF: closing bp ends the reverse direction and pump() joins
bp.shutdown(socket.SHUT_WR); th.join(timeout=5)
assert not th.is_alive(), "pump did not terminate"
print("RELAY_OK")
`;

describe("egress proxy relay (splice zero-copy)", () => {
  it.skipIf(!havePython)("relays both directions with integrity, backpressure, and EOF", () => {
    const out = execFileSync("python3", ["-c", SCRIPT], { encoding: "utf8", timeout: 60_000 });
    expect(out).toContain("RELAY_OK");
  });
});

// SSRF + allowlist-parsing hardening. Loads the proxy module and asserts the
// IP-vetting classifier and newline-delimited ALLOW_HOSTS parsing directly.
const SSRF_SCRIPT = `
import importlib.util, os
os.environ["ALLOW_HOSTS"] = "a.example.com\\nb.example.com\\n  c.example.com  "
spec = importlib.util.spec_from_file_location("egp2", ${JSON.stringify(PROXY)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

# newline-delimited allowlist (a comma-bearing value can no longer inject a host)
assert m.ALLOW_HOSTS == {"a.example.com", "b.example.com", "c.example.com"}, m.ALLOW_HOSTS
assert m.allowed("a.example.com") and not m.allowed("evil.com")

# metadata + loopback + unparseable are blocked; public + private LAN are allowed
assert m._is_blocked_ip("169.254.169.254") is True   # cloud metadata (link-local)
assert m._is_blocked_ip("127.0.0.1") is True          # loopback
assert m._is_blocked_ip("::1") is True                # loopback v6
assert m._is_blocked_ip("not-an-ip") is True          # unparseable
assert m._is_blocked_ip("93.184.216.34") is False     # public
assert m._is_blocked_ip("172.17.0.1") is False        # docker gateway (private, allowed)
assert m._is_blocked_ip("10.0.0.5") is False          # private LAN (on-prem endpoint)
print("SSRF_OK")
`;

describe("egress proxy SSRF guard + allowlist parsing", () => {
  it.skipIf(!havePython)(
    "blocks metadata/loopback, allows public+private, parses newline allowlist",
    () => {
      const out = execFileSync("python3", ["-c", SSRF_SCRIPT], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(out).toContain("SSRF_OK");
    }
  );
});
