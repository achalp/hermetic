import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build artifacts (gitignored): the MCP embedded-viewer bundle.
    "src/mcp/viewer/dist/**",
  ]),
  {
    // React Compiler / strict-React rules added in eslint-plugin-react-hooks
    // v5+. These flag patterns the React Compiler cannot optimize but aren't
    // bugs — code works correctly without these refactors. We're not adopting
    // the React Compiler in scope, so turn them off to keep CI green. The
    // classic exhaustive-deps rule stays on.
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/use-memo": "off",
      // The React Compiler reports "Compilation Skipped: Existing memoization
      // could not be preserved" when a manual useCallback/useMemo dep array
      // omits a stable value it infers (e.g. a useState setter). That's not a
      // bug — stable setters don't need listing — and the diagnostic can fire
      // non-deterministically across Node versions, so CI and local disagree.
      // Off for the same reason as its siblings: not adopting the compiler.
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/static-components": "off",
      "react-hooks/memoized-effect-dependencies": "off",
      "react-hooks/no-deriving-state-in-effects": "off",
      "react/use": "off",
    },
  },
  // ── Modularization layer boundaries (ERROR severity — Phase 1 complete) ───
  // Target layering: specs/modularization-2026-08-01.md §3.3. All groups run
  // at "error"; suppressions are counted by the ratchet (scripts/ratchet.mjs)
  // and must stay at zero.
  {
    files: ["src/lib/**/*.{ts,tsx}"],
    ignores: ["src/lib/**/__tests__/**", "src/lib/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app/*", "@/components/*", "@/hooks/*"],
              message:
                "lib is below the app layer and must not import from it (modularization WS1).",
            },
            {
              group: ["next", "next/*"],
              message:
                "lib must stay framework-free; Next belongs to the harness (modularization WS1).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/sandbox/**/*.ts"],
    ignores: ["src/lib/sandbox/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app/*", "@/components/*", "@/hooks/*"],
              message:
                "lib is below the app layer and must not import from it (modularization WS1).",
            },
            {
              group: ["next", "next/*"],
              message:
                "lib must stay framework-free; Next belongs to the harness (modularization WS1).",
            },
            {
              group: ["@/lib/pipeline/*"],
              message:
                "sandbox sits below orchestration; take AbortSignal/onProgress as inputs instead (modularization WS6).",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/components/charts/**/*.{ts,tsx}",
      "src/components/controllers/**/*.{ts,tsx}",
      "src/components/inputs/**/*.{ts,tsx}",
      "src/components/registry.tsx",
      "src/components/registry-primitives.tsx",
      "src/components/spec-view.tsx",
      "src/components/lazy-client.tsx",
      "src/components/data-table.tsx",
      "src/components/definition-list.tsx",
      "src/components/pivot-table.tsx",
      "src/components/renderer-error-boundary.tsx",
    ],
    ignores: ["src/components/charts/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/hooks/*", "@/app/lib/api", "@/components/app/*"],
              message:
                "the renderer closure must stay free of app state and transport (modularization WS7).",
            },
            {
              group: ["next", "next/*"],
              message:
                "the renderer must be framework-free; use React.lazy instead of next/dynamic (modularization WS7).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/spec/**/*.{ts,tsx}"],
    ignores: ["src/spec/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/app/*",
                "@/components/*",
                "@/hooks/*",
                "@/lib/*",
                "@/harness/*",
                "@/cli/*",
              ],
              message:
                "the vendored spec fork is the bottom of the stack — it imports nothing of hermetic's (exit audit F4; Phase 2 ships it as @hermetic/spec).",
            },
            {
              group: ["next", "next/*"],
              message: "the spec fork must be framework-free (exit audit F4).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/mcp/**/*.ts"],
    ignores: ["src/mcp/**/__tests__/**", "src/mcp/viewer/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app/*", "@/components/*", "@/hooks/*"],
              message:
                "the MCP harness composes lib functions only — UI layers stay out (mcp-server spec §4).",
            },
            {
              group: ["next", "next/*"],
              message: "harnesses must stay framework-free (mcp-server spec §4).",
            },
          ],
        },
      ],
    },
  },
  {
    // The viewer ENTRY is a browser bundle of the renderer closure — it may
    // use React + the renderer, never Next or app state/transport.
    files: ["src/mcp/viewer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/app/*", "@/hooks/*", "@/app/lib/api", "@/components/app/*"],
              message: "the MCP viewer mounts the renderer closure only (mcp-server spec §4 M3).",
            },
            {
              group: ["next", "next/*"],
              message: "the MCP viewer is framework-free (mcp-server spec §4 M3).",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
