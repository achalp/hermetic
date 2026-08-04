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

## Pruned surface (exit-audit F5, 2026-08-03)

Modules removed from the vendored copy because hermetic has no consumer and
their presence carried maintenance weight (or a naming trap):

- `core/spec-validator.ts` (`validateSpec`/`autoFixSpec`/`formatSpecIssues`) —
  collided with hermetic's own zod-based `validateSpec` in `lib/catalog.ts`,
  which is the one actually enforcing the contract.
- `core/prompt.ts` (`buildUserPrompt`) — hermetic builds user prompts in the
  pipeline, not through the fork.
- `react/hooks.ts#useJsonRenderMessage` and the deprecated
  `elementTreeSchema`/`ElementTreeSchema`/`ElementTreeSpec` aliases.

The default JSONL element-tree prompt branch inside `core/schema.ts` is
RETAINED: it is the in-function fallback of `buildPrompt` and is covered by
the vendored tests. When syncing ideas from upstream, do not re-introduce the
pruned modules without a consumer.
