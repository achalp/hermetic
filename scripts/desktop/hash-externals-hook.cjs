/**
 * Workaround for a Next 16 Turbopack PRODUCTION-build bug (build log D16): external
 * modules are emitted with an unresolvable content-hash suffix, e.g. the server does
 * `require("pg-587764f78a6c7a9c")` / `import("@napi-rs/keyring-77f6e008788a8a96")`
 * instead of the real `pg` / `@napi-rs/keyring`. `next start` installs a resolver that
 * hides this, but the trimmed standalone `server.js` does not — so warehouse (pg),
 * cleanup (rimraf), the OS keychain (@napi-rs/keyring), etc. fail to load in the
 * packaged app. The Tauri sidecar preloads this (`node --require … server.js`).
 *
 * Strategy: try the id verbatim; ONLY on a not-found failure, if it matches
 * `<pkg>-<16 hex>`, retry with the hash stripped. Legit packages are never affected
 * (they resolve on the first try). Patches BOTH the CJS resolver and the ESM resolve
 * hook (Turbopack emits hashed externals for both require and import).
 */
const Module = require("node:module");
const HASH = /^(.+)-[0-9a-f]{16}$/;
const NOTFOUND = new Set(["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"]);

// CJS: require("<pkg>-<hash>")
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  try {
    return origResolve.call(this, request, ...rest);
  } catch (err) {
    const m = HASH.exec(request);
    if (m && NOTFOUND.has(err && err.code)) {
      return origResolve.call(this, m[1], ...rest);
    }
    throw err;
  }
};

// ESM: import("<pkg>-<hash>")
try {
  Module.register("./hash-externals-hook.mjs", require("node:url").pathToFileURL(__filename));
} catch {
  /* older node without module.register — CJS patch above still covers require() */
}
