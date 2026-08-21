/**
 * Structural equality with JSON.stringify semantics — the lazyChart memo
 * comparator's replacement (perf P8).
 *
 * The old comparator did `JSON.stringify(prev.props) !== JSON.stringify(next.props)`
 * per chart per parent render: for a 5000-row `data` prop that materializes
 * ~2×250KB of string per compare, on every stream patch and filter click. A
 * SHALLOW compare is NOT an option: the spec resolver rebuilds array/object
 * literal props (data, y_keys, label_map) with fresh identities every render,
 * so identity-based memoization would never hold and nivo would rebuild per
 * tick — worse than the stringify. This compare keeps the stringify's VALUE
 * semantics (so the memo holds exactly as often) at a fraction of the cost:
 * no string building, early exit on the first difference.
 *
 * JSON semantics preserved deliberately, so the memo behaves byte-identically
 * to the stringify comparator:
 *  - undefined object values are ignored (stringify drops those keys);
 *  - NaN/Infinity compare equal to null (stringify emits "null" for both);
 *  - key ORDER matters (stringify is order-sensitive) — spec objects come from
 *    parsed JSON, so equal objects have equal order.
 */
export function jsonValueEqual(a: unknown, b: unknown): boolean {
  // JSON scalar view: functions serialize like undefined; NaN/±Inf → null.
  const norm = (v: unknown): unknown => {
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    if (typeof v === "function") return undefined;
    return v;
  };
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (na === null || nb === null) return false;
  if (typeof na !== typeof nb) return false;
  if (typeof na !== "object") return false;

  const aArr = Array.isArray(na);
  if (aArr !== Array.isArray(nb)) return false;
  if (aArr) {
    const arrA = na as unknown[];
    const arrB = nb as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!jsonValueEqual(arrA[i], arrB[i])) return false;
    }
    return true;
  }

  // Objects: compare in key order, skipping undefined-valued keys (JSON drops
  // them, so {a:1, b:undefined} must equal {a:1}).
  const objA = na as Record<string, unknown>;
  const objB = nb as Record<string, unknown>;
  const keysA = Object.keys(objA).filter(
    (k) => objA[k] !== undefined && typeof objA[k] !== "function"
  );
  const keysB = Object.keys(objB).filter(
    (k) => objB[k] !== undefined && typeof objB[k] !== "function"
  );
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!jsonValueEqual(objA[keysA[i]], objB[keysB[i]])) return false;
  }
  return true;
}
