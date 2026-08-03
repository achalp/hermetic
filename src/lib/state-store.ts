/**
 * THE in-process state store (modularization M2-C2, spec §3.2 StateStore).
 *
 * Before this module, 13 independent `globalThis as unknown as {...}` casts
 * scattered singleton state across lib (csv/warehouse/excel stores, caches,
 * run registries, warm pools, LLM processes). They all existed for the same
 * two reasons — surviving Next dev HMR/module-graph splits, and process-wide
 * sharing — so they get ONE owner: a single internal globalThis slot holding
 * named namespaces.
 *
 * A namespace is a plain Map (full behavior parity with the casts this
 * replaces); a box holds a single mutable value. The single-process model
 * (store-sweeper.ts) is unchanged — a distributed implementation is
 * explicitly out of scope until a harness needs one (spec §6).
 *
 * Do NOT add new `globalThis` casts elsewhere — ratchet-enforced.
 */

interface StateSlot {
  namespaces: Map<string, Map<string, unknown>>;
  boxes: Map<string, { value: unknown }>;
}

const g = globalThis as unknown as { __hermeticState?: StateSlot };

function slot(): StateSlot {
  return (g.__hermeticState ??= { namespaces: new Map(), boxes: new Map() });
}

/**
 * Get (or create) a named Map namespace. The SAME Map instance is returned
 * for the life of the process — callers may hold a reference.
 */
export function stateNamespace<V>(name: string): Map<string, V> {
  const namespaces = slot().namespaces;
  let ns = namespaces.get(name);
  if (!ns) {
    ns = new Map();
    namespaces.set(name, ns);
  }
  return ns as Map<string, V>;
}

/** A single mutable value with process lifetime (for non-Map singletons). */
export function stateBox<V>(name: string, init: () => V): { get(): V; set(v: V): void } {
  const boxes = slot().boxes;
  let box = boxes.get(name);
  if (!box) {
    box = { value: init() };
    boxes.set(name, box);
  }
  const b = box;
  return {
    get: () => b.value as V,
    set: (v: V) => {
      b.value = v;
    },
  };
}
