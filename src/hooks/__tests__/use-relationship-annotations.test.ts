// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { SheetInfo, SheetRelationship } from "@/lib/types";

// Test the pure logic extracted from useRelationshipAnnotations.
// Since the hook uses useMemo, we test the underlying logic directly.

function makeSheet(name: string, headers: string[]): SheetInfo {
  return { name, rowCount: 10, columnCount: headers.length, headers, sampleRows: [] };
}

function makeRel(
  src: string,
  srcCol: string,
  tgt: string,
  tgtCol: string,
  opts: Partial<SheetRelationship> = {}
): SheetRelationship {
  return {
    sourceSheet: src,
    sourceColumn: srcCol,
    sourceColumnIndex: 0,
    targetSheet: tgt,
    targetColumn: tgtCol,
    targetColumnIndex: 0,
    matchType: "exact_name",
    confidence: 0.8,
    isPrimaryKeyCandidate: false,
    isForeignKeyCandidate: false,
    ...opts,
  };
}

// Replicate the pure logic from the hook for unit testing
function buildRelationshipMap(relationships: SheetRelationship[]) {
  const map = new Map<string, SheetRelationship[]>();
  for (const rel of relationships) {
    if (rel.confidence < 0.5) continue;
    const srcKey = `${rel.sourceSheet}.${rel.sourceColumn}`;
    const tgtKey = `${rel.targetSheet}.${rel.targetColumn}`;
    if (!map.has(srcKey)) map.set(srcKey, []);
    if (!map.has(tgtKey)) map.set(tgtKey, []);
    map.get(srcKey)!.push(rel);
    map.get(tgtKey)!.push(rel);
  }
  return map;
}

function getActiveRelationships(relationships: SheetRelationship[], activeSheet: SheetInfo) {
  return relationships.filter(
    (r) =>
      r.confidence >= 0.5 &&
      (r.sourceSheet === activeSheet.name || r.targetSheet === activeSheet.name)
  );
}

function getSheetsWithRelationships(relationships: SheetRelationship[]) {
  const names = new Set<string>();
  for (const r of relationships) {
    if (r.confidence >= 0.5) {
      names.add(r.sourceSheet);
      names.add(r.targetSheet);
    }
  }
  return names;
}

function getColumnBadge(
  header: string,
  activeSheet: SheetInfo,
  relationshipMap: Map<string, SheetRelationship[]>
): "pk" | "fk" | "link" | null {
  const key = `${activeSheet.name}.${header}`;
  const rels = relationshipMap.get(key);
  if (!rels || rels.length === 0) return null;

  for (const rel of rels) {
    if (rel.isPrimaryKeyCandidate) {
      const isPKSide =
        (rel.sourceSheet === activeSheet.name && rel.sourceColumn === header) ||
        (rel.targetSheet === activeSheet.name && rel.targetColumn === header);
      if (isPKSide && rel.isForeignKeyCandidate) {
        const isSource = rel.sourceSheet === activeSheet.name && rel.sourceColumn === header;
        if (isSource) return "pk";
        return "fk";
      }
      if (isPKSide) return "pk";
    }
    if (rel.isForeignKeyCandidate) {
      const isFKSide =
        (rel.sourceSheet === activeSheet.name && rel.sourceColumn === header) ||
        (rel.targetSheet === activeSheet.name && rel.targetColumn === header);
      if (isFKSide) return "fk";
    }
  }
  return "link";
}

describe("relationship annotations logic", () => {
  describe("buildRelationshipMap", () => {
    it("builds map from relationships, indexing both source and target", () => {
      const rels = [makeRel("Orders", "dept_id", "Departments", "id")];
      const map = buildRelationshipMap(rels);

      expect(map.has("Orders.dept_id")).toBe(true);
      expect(map.has("Departments.id")).toBe(true);
      expect(map.get("Orders.dept_id")).toHaveLength(1);
      expect(map.get("Departments.id")).toHaveLength(1);
    });

    it("filters out relationships with confidence < 0.5", () => {
      const rels = [makeRel("A", "x", "B", "y", { confidence: 0.3 })];
      const map = buildRelationshipMap(rels);
      expect(map.size).toBe(0);
    });

    it("groups multiple relationships for the same column", () => {
      const rels = [
        makeRel("Orders", "id", "Items", "order_id"),
        makeRel("Orders", "id", "Payments", "order_id"),
      ];
      const map = buildRelationshipMap(rels);
      expect(map.get("Orders.id")).toHaveLength(2);
    });
  });

  describe("getActiveRelationships", () => {
    it("returns only relationships involving the active sheet", () => {
      const sheet = makeSheet("Orders", ["id", "dept_id"]);
      const rels = [
        makeRel("Orders", "dept_id", "Departments", "id"),
        makeRel("Products", "cat_id", "Categories", "id"),
      ];
      const active = getActiveRelationships(rels, sheet);
      expect(active).toHaveLength(1);
      expect(active[0].sourceSheet).toBe("Orders");
    });

    it("includes relationships where active sheet is the target", () => {
      const sheet = makeSheet("Departments", ["id", "name"]);
      const rels = [makeRel("Orders", "dept_id", "Departments", "id")];
      const active = getActiveRelationships(rels, sheet);
      expect(active).toHaveLength(1);
    });

    it("excludes low-confidence relationships", () => {
      const sheet = makeSheet("Orders", ["id"]);
      const rels = [makeRel("Orders", "id", "Items", "order_id", { confidence: 0.4 })];
      expect(getActiveRelationships(rels, sheet)).toHaveLength(0);
    });
  });

  describe("getSheetsWithRelationships", () => {
    it("returns set of sheet names with confidence >= 0.5", () => {
      const rels = [
        makeRel("Orders", "dept_id", "Departments", "id"),
        makeRel("X", "a", "Y", "b", { confidence: 0.3 }),
      ];
      const names = getSheetsWithRelationships(rels);
      expect(names).toContain("Orders");
      expect(names).toContain("Departments");
      expect(names).not.toContain("X");
      expect(names).not.toContain("Y");
    });
  });

  describe("getColumnBadge", () => {
    it("returns 'pk' for primary key candidate on source side", () => {
      const sheet = makeSheet("Departments", ["id", "name"]);
      const rels = [
        makeRel("Departments", "id", "Orders", "dept_id", {
          isPrimaryKeyCandidate: true,
        }),
      ];
      const map = buildRelationshipMap(rels);
      expect(getColumnBadge("id", sheet, map)).toBe("pk");
    });

    it("returns 'fk' for foreign key candidate", () => {
      const sheet = makeSheet("Orders", ["id", "dept_id"]);
      const rels = [
        makeRel("Orders", "dept_id", "Departments", "id", {
          isForeignKeyCandidate: true,
        }),
      ];
      const map = buildRelationshipMap(rels);
      expect(getColumnBadge("dept_id", sheet, map)).toBe("fk");
    });

    it("returns 'link' for columns with relationships but no PK/FK flags", () => {
      const sheet = makeSheet("Orders", ["status"]);
      const rels = [makeRel("Orders", "status", "Statuses", "code")];
      const map = buildRelationshipMap(rels);
      expect(getColumnBadge("status", sheet, map)).toBe("link");
    });

    it("returns null for columns with no relationships", () => {
      const sheet = makeSheet("Orders", ["amount"]);
      const map = buildRelationshipMap([]);
      expect(getColumnBadge("amount", sheet, map)).toBeNull();
    });
  });
});
