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
