// ESM resolve hook paired with hash-externals-hook.cjs (build log D16).
const HASH = /^(.+)-[0-9a-f]{16}$/;
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const m = HASH.exec(specifier);
    if (m && (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND")) {
      return nextResolve(m[1], context);
    }
    throw err;
  }
}
