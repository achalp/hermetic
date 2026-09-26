# Security Policy

Hermetic is a local-first tool that executes LLM-generated code in a sandbox and
connects to your data sources. We take its security boundary seriously and
welcome reports.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's [private vulnerability
reporting](https://github.com/achalp/hermetic/security/advisories/new) (Security
→ Advisories → _Report a vulnerability_). Include:

- what the issue is and the component (web API, MCP server, egress proxy,
  warehouse connector, secret storage, …),
- a proof-of-concept or reproduction steps,
- the impact you believe it has.

We aim to acknowledge a report within a few days and to keep you updated as we
investigate and fix. Please give us reasonable time to release a fix before any
public disclosure. There is no bug-bounty program.

Hermetic currently has a single maintainer, so response times are best-effort
and there is no on-call rotation. Release artifacts are built and provenance-attested
in CI (see [`ops/RELEASE.md`](ops/RELEASE.md)), so verifying an artifact
does not depend on trusting the maintainer's machine.

## Scope and trust model

Hermetic assumes a **single trusted local user**. By default it binds to
`127.0.0.1` (override with `HERMETIC_HOST`), every `/api/` route requires a
loopback request, and analyzed data is treated as **untrusted input to the
model** (prompt injection is in scope). Analysis code runs in one of two
sandboxes: Docker (`--network none` for local data; a deny-by-default egress
allowlist for remote data) or the WebAssembly tier (a CSP-locked browser worker
with no off-machine reach; remote data is fetched host-side against the same
allowlist). Their differences, including the WebAssembly tier's known gap, are
in the README's "Sandbox runtimes" section. Secrets live in the OS keychain,
never in repo-written files.

In scope: sandbox escape (either runtime), egress-allowlist bypass, secret exfiltration, SSRF
through the proxy or remote-source fetching, SQL write-gate bypass, path-jail
escape, and MCP tool-abuse paths.

Out of scope: issues that require the server to be intentionally exposed to an
untrusted network (it is not designed for that), and vulnerabilities in
dependencies without a Hermetic-specific exploit path (report those upstream;
Dependabot tracks advisories here).
