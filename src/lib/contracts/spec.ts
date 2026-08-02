/**
 * The ONE sanctioned import point for the spec envelope type (modularization
 * M1/WS2). Everything else imports `Spec` from here, never from
 * `@json-render/*` directly — so when WS2 brings the envelope in-house, the
 * fork swaps in by changing this file alone. The ratchet metric
 * `json-render-imports` counts direct imports and shrinks as consumers
 * migrate to this seam.
 */
export type { Spec } from "@json-render/core";
