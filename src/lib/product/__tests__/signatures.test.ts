/**
 * Licensing-registry closure (compiled-view-parity spec §3/§6): every
 * catalog component is signed, every signature names a catalog component,
 * and everything the P1 compilers claim to build is licensed. The same
 * trick as the field contract — component #85 cannot ship unlicensed.
 */
import { describe, it, expect } from "vitest";
import { catalogComponents } from "@/lib/catalog";
import { COMPONENT_ROLE_SIGNATURES, seriesKindOf } from "@/lib/product/signatures";
import { P1_COMPILABLE } from "@/lib/compose/view-compilers";

describe("component signature closure", () => {
  const catalog = Object.keys(catalogComponents);
  const signed = Object.keys(COMPONENT_ROLE_SIGNATURES);

  it("every catalog component has a signature", () => {
    const missing = catalog.filter((c) => !signed.includes(c));
    expect(missing, `unsigned components: ${missing.join(", ")}`).toEqual([]);
  });

  it("every signature names a catalog component (no dead entries)", () => {
    const dead = signed.filter((c) => !catalog.includes(c));
    expect(dead, `dead signatures: ${dead.join(", ")}`).toEqual([]);
  });

  it("everything compilable is licensed and view-feedable", () => {
    for (const c of P1_COMPILABLE) {
      const sig = COMPONENT_ROLE_SIGNATURES[c];
      expect(sig, `${c} compilable but unsigned`).toBeTruthy();
      expect(sig.feeds, `${c} compilable but feeds none`).not.toBe("none");
    }
  });

  it("view-feedable signatures carry a when-clause for the planner catalog", () => {
    for (const [name, sig] of Object.entries(COMPONENT_ROLE_SIGNATURES)) {
      if (sig.feeds === "none" || !P1_COMPILABLE.has(name)) continue;
      expect(sig.when, `${name} has no when-clause`).toBeTruthy();
    }
  });
});

describe("seriesKindOf", () => {
  it("declared kind wins; geo is inferred from lat/lng morphology; default axis", () => {
    expect(seriesKindOf({ kind: "flow" })).toBe("flow");
    expect(seriesKindOf({ rows: [{ lat: 47.6, lng: -122.3, v: 1 }] })).toBe("geo");
    expect(seriesKindOf({ rows: [{ latitude: 47.6, lon: -122.3 }] })).toBe("geo");
    expect(seriesKindOf({ rows: [{ year: 2020, spend: 10 }] })).toBe("axis");
    expect(seriesKindOf({ rows: [] })).toBe("axis");
    // lat alone is not geo (a "latency" column must not trigger a map).
    expect(seriesKindOf({ rows: [{ lat: 1, value: 2 }] })).toBe("axis");
  });
});
