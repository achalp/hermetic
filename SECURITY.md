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

## Scope and trust model

Hermetic assumes a **single trusted local user**. By default it binds to
`127.0.0.1` (override with `HERMETIC_HOST`), every `/api/` route requires a
loopback request, and analyzed data is treated as **untrusted input to the
model** (prompt injection is in scope). The sandbox runs analysis code with
Docker (`--network none` for local data; a deny-by-default egress allowlist for
remote data), and secrets live in the OS keychain, never in repo-written files.

In scope: sandbox escape, egress-allowlist bypass, secret exfiltration, SSRF
through the proxy or remote-source fetching, SQL write-gate bypass, path-jail
escape, and MCP tool-abuse paths.

Out of scope: issues that require the server to be intentionally exposed to an
untrusted network (it is not designed for that), and vulnerabilities in
dependencies without a Hermetic-specific exploit path (report those upstream;
Dependabot tracks advisories here).
