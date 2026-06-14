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
]);

export default eslintConfig;
