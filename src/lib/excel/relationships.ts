import type { SheetInfo, SheetRelationship, RelationshipMatchType } from "@/lib/types";

// Generic column names that produce false positives — halve their confidence
const GENERIC_NAMES = new Set([
  "name",
  "date",
  "type",
  "status",
  "description",
  "notes",
  "created_at",
  "updated_at",
  "count",
  "total",
  "amount",
  "value",
  "price",
  "quantity",
  "active",
  "enabled",
  "deleted",
  "comment",
]);

// Patterns that indicate a PK/FK column
const ID_SUFFIXES = ["_id", "id", "_key", "_code", "_no", "_num"];

/**
 * Detect likely join relationships across sheets by comparing column names and sample values.
 * Pure function — no I/O, no side effects.
 */
export function detectRelationships(sheets: SheetInfo[]): SheetRelationship[] {
  if (sheets.length < 2) return [];

  // Build column info for each sheet
  const sheetCols = sheets.map((sheet) => {
    const headers = sheet.headers ?? [];
    return headers.map((header, colIdx) => {
      const values = extractColumnValues(sheet.sampleRows, colIdx);
      return {
        sheetName: sheet.name,
        header,
        colIdx,
        tokens: tokenize(header),
        normalizedName: header.toLowerCase().trim(),
        values,
        uniqueValues: new Set(values),
        isIdLike: isIdColumn(header),
        isPKCandidate:
          isIdColumn(header) && values.length > 0 && new Set(values).size === values.length,
        avgValueLength:
          values.length > 0 ? values.reduce((sum, v) => sum + v.length, 0) / values.length : 0,
      };
    });
  });

  // Collect candidate pairs from name matching + ID-like columns
  type CandidatePair = {
    sourceSheetIdx: number;
    sourceColIdx: number;
    targetSheetIdx: number;
    targetColIdx: number;
    matchType: RelationshipMatchType;
    confidence: number;
    nameMatched: boolean;
  };

  const candidates: CandidatePair[] = [];

  // Step 1: Column name matching — compare all pairs of sheets
  for (let a = 0; a < sheets.length; a++) {
    for (let b = a + 1; b < sheets.length; b++) {
      for (const colA of sheetCols[a]) {
        for (const colB of sheetCols[b]) {
          // Exact match (case-insensitive)
          if (colA.normalizedName === colB.normalizedName && colA.normalizedName !== "") {
            let confidence = 0.9;
            if (GENERIC_NAMES.has(colA.normalizedName)) confidence *= 0.5;
            candidates.push({
              sourceSheetIdx: a,
              sourceColIdx: colA.colIdx,
              targetSheetIdx: b,
              targetColIdx: colB.colIdx,
              matchType: "exact_name",
              confidence,
              nameMatched: true,
            });
            continue;
          }

          // Fuzzy/token match
          const jaccard = tokenJaccard(colA.tokens, colB.tokens);
          if (jaccard >= 0.5) {
            let confidence = 0.5 + jaccard * 0.3;
            const combined = colA.normalizedName + colB.normalizedName;
            if (GENERIC_NAMES.has(colA.normalizedName) || GENERIC_NAMES.has(colB.normalizedName)) {
              confidence *= 0.5;
            }
            // Suppress empty/trivial token matches
            if (colA.tokens.length === 0 || colB.tokens.length === 0) continue;
            candidates.push({
              sourceSheetIdx: a,
              sourceColIdx: colA.colIdx,
              targetSheetIdx: b,
              targetColIdx: colB.colIdx,
              matchType: "fuzzy_name",
              confidence: Math.min(confidence, 0.95),
              nameMatched: true,
            });
          }
        }
      }

      // Also check ID-like columns across sheets for value overlap even without name match
      for (const colA of sheetCols[a]) {
        if (!colA.isIdLike) continue;
        for (const colB of sheetCols[b]) {
          if (!colB.isIdLike) continue;
          // Skip if already matched by name
          const alreadyMatched = candidates.some(
            (c) =>
              c.sourceSheetIdx === a &&
              c.sourceColIdx === colA.colIdx &&
              c.targetSheetIdx === b &&
              c.targetColIdx === colB.colIdx
          );
          if (!alreadyMatched) {
            candidates.push({
              sourceSheetIdx: a,
              sourceColIdx: colA.colIdx,
              targetSheetIdx: b,
              targetColIdx: colB.colIdx,
              matchType: "value_overlap",
              confidence: 0, // will be computed in step 2
              nameMatched: false,
            });
          }
        }
      }
    }
  }

  // Step 2: Value containment for name-matched pairs and ID-like cross-sheet pairs
  for (const cand of candidates) {
    const colA = sheetCols[cand.sourceSheetIdx][cand.sourceColIdx];
    const colB = sheetCols[cand.targetSheetIdx][cand.targetColIdx];

    // Skip long text fields
    if (colA.avgValueLength > 50 || colB.avgValueLength > 50) continue;
    if (colA.values.length === 0 || colB.values.length === 0) continue;

    const intersection = colA.values.filter((v) => colB.uniqueValues.has(v));
    const containment = intersection.length / Math.min(colA.values.length, colB.values.length);

    if (containment >= 0.4) {
      const valueConfidence = Math.min(containment * 0.7, 0.95);
      if (cand.nameMatched) {
        // Boost name-based confidence with value evidence
        cand.confidence = Math.min(Math.max(cand.confidence, valueConfidence), 0.95);
      } else {
        // Pure value overlap match
        cand.confidence = valueConfidence;
        cand.matchType = "value_overlap";
      }
    }
  }

  // Remove candidates with no confidence (value-only pairs that didn't pass containment)
  const validCandidates = candidates.filter((c) => c.confidence > 0);

  // Deduplicate: same column pair → keep highest confidence
  const dedupKey = (c: CandidatePair) =>
    `${c.sourceSheetIdx}:${c.sourceColIdx}:${c.targetSheetIdx}:${c.targetColIdx}`;
  const bestByPair = new Map<string, CandidatePair>();
  for (const c of validCandidates) {
    const key = dedupKey(c);
    const existing = bestByPair.get(key);
    if (!existing || c.confidence > existing.confidence) {
      bestByPair.set(key, c);
    }
  }

  // Step 3: PK/FK heuristics + build final results
  const results: SheetRelationship[] = [];
  for (const cand of bestByPair.values()) {
    if (cand.confidence < 0.5) continue;

    const colA = sheetCols[cand.sourceSheetIdx][cand.sourceColIdx];
    const colB = sheetCols[cand.targetSheetIdx][cand.targetColIdx];

    const aPK = colA.isPKCandidate;
    const bPK = colB.isPKCandidate;

    results.push({
      sourceSheet: colA.sheetName,
      sourceColumn: colA.header,
      sourceColumnIndex: colA.colIdx,
      targetSheet: colB.sheetName,
      targetColumn: colB.header,
      targetColumnIndex: colB.colIdx,
      matchType: cand.matchType,
      confidence: Math.round(cand.confidence * 1000) / 1000,
      isPrimaryKeyCandidate: aPK || bPK,
      isForeignKeyCandidate: (aPK && !bPK) || (!aPK && bPK),
    });
  }

  // Sort by confidence descending
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractColumnValues(sampleRows: string[][] | undefined, colIdx: number): string[] {
  if (!sampleRows) return [];
  const values: string[] = [];
  for (const row of sampleRows.slice(0, 5)) {
    const val = row[colIdx];
    if (val !== undefined && val !== null && val.trim() !== "") {
      values.push(val.trim());
    }
  }
  return values;
}

/** Tokenize a column name by _, -, spaces, and camelCase boundaries */
function tokenize(name: string): string[] {
  // Split camelCase then split by separators
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter((t) => t.length > 0);
  return parts;
}

/** Token-set Jaccard with prefix-substring boost */
function tokenJaccard(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let matches = 0;

  const allTokens = new Set([...setA, ...setB]);

  for (const t of setA) {
    if (setB.has(t)) {
      matches++;
    } else {
      // Prefix-substring boost: if a token 3+ chars is a prefix of another
      for (const u of setB) {
        if (t.length >= 3 && u.startsWith(t)) {
          matches += 0.8;
          break;
        }
        if (u.length >= 3 && t.startsWith(u)) {
          matches += 0.8;
          break;
        }
      }
    }
  }

  return matches / allTokens.size;
}

function isIdColumn(header: string): boolean {
  const lower = header.toLowerCase().trim();
  return ID_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
