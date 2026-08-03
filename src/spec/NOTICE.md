# Vendored: json-render (spec envelope + React renderer runtime)

This directory contains the vendored source of `@json-render/core` and
`@json-render/react` at version **0.8.0** (upstream commit `0a40430`,
https://github.com/vercel-labs/json-render, Apache-2.0), brought in-house
under the hermetic modularization plan (WS2 — "no hard version dependencies
on code we don't own"; specs/modularization-2026-08-01.md, Principle 2).

Why: hermetic's catalog DSL, LLM prompt generation (`catalog.prompt()`),
patch/stream utilities, and renderer runtime were all built on a floating
0.x dependency whose contract drift had already caused CI breakage and a
silently-diverging hand-mirror (assemble-spec). The spec contract is
hermetic's core product surface; it is now owned, tested, and versioned
here. Upstream remains a source of ideas, not a dependency.

Changes from upstream are tracked in git history from the vendoring commit
onward. Original license: Apache-2.0 (see LICENSE in this directory).
