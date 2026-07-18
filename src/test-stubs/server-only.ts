/**
 * Vitest stand-in for the `server-only` package (ARCH-13).
 *
 * The real package throws at import time under the default resolve condition
 * — that's its whole job: Next resolves the `react-server` condition in the
 * server graph (empty module) and the throwing default in a client bundle,
 * failing the BUILD when server code leaks into a Client Component. Vitest
 * resolves the default condition too, so without this alias every test that
 * imports a poisoned store would explode. Aliased in vitest.config.ts.
 */
export {};
