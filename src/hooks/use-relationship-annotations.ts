"use client";

import { useMemo } from "react";
import type { SheetInfo, SheetRelationship } from "@/lib/types";

export const MATCH_TYPE_LABELS: Record<string, string> = {
  exact_name: "exact match",
  fuzzy_name: "similar name",
  value_overlap: "value overlap",
};

export type ColumnBadge = "pk" | "fk" | "link" | null;

export interface RelationshipAnnotations {
  /** Map from "SheetName.ColumnName" → relationships touching that column */
  relationshipMap: Map<string, SheetRelationship[]>;
  /** Relationships (confidence >= 0.5) involving the active sheet */
  activeRelationships: SheetRelationship[];
  /** Set of sheet names that participate in at least one relationship */
  sheetsWithRelationships: Set<string>;
  /** Get the badge type for a column header in the active sheet */
  getColumnBadge: (header: string) => ColumnBadge;
}

export function useRelationshipAnnotations(
  relationships: SheetRelationship[],
  activeSheet: SheetInfo | undefined
): RelationshipAnnotations {
  const relationshipMap = useMemo(() => {
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
  }, [relationships]);

  const activeRelationships = useMemo(() => {
    if (!activeSheet) return [];
    return relationships.filter(
      (r) =>
        r.confidence >= 0.5 &&
        (r.sourceSheet === activeSheet.name || r.targetSheet === activeSheet.name)
    );
  }, [relationships, activeSheet]);

  const sheetsWithRelationships = useMemo(() => {
    const names = new Set<string>();
    for (const r of relationships) {
      if (r.confidence >= 0.5) {
        names.add(r.sourceSheet);
        names.add(r.targetSheet);
      }
    }
    return names;
  }, [relationships]);

  const getColumnBadge = useMemo(() => {
    return (header: string): ColumnBadge => {
      if (!activeSheet) return null;
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
    };
  }, [activeSheet, relationshipMap]);

  return { relationshipMap, activeRelationships, sheetsWithRelationships, getColumnBadge };
}
