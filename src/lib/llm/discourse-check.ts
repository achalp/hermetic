/**
 * Post-resolution discourse checker (structural fix 3, 2026-08-07).
 *
 * One home for the whole "values-blind composer makes relational claims"
 * bug class, operating on RESOLVED prose — where interpolated values are
 * visible and empty slots are detectable, which pre-resolution lints
 * cannot do by construction. Ran per finalized line by
 * finalize-spec-stream; issues flow to grounding advisories, egregious
 * sentences (zero-count templates) are dropped like refusals.
 *
 * Encoded relations (add new ones HERE, not as new lints):
 *  - empty interpolation: leftover multi-space gaps ("in both  and  to")
 *    — flagged, whitespace collapsed;
 *  - zero-count template: "The latest 0 trailing month(s) ... are
 *    excluded" — a sentence about zero things asserting a process that
 *    didn't happen; the sentence is dropped;
 *  - temporal incoherence: sequencing words joining out-of-order periods
 *    ("climbed to its peak in 2021-04, then contracted ... in 2020-01")
 *    — flagged (rewriting prose is unsafe).
 */
import type { FindingIssue } from "@/lib/contracts/findings";

export interface DiscourseCheckResult {
  line: string;
  issues: FindingIssue[];
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/** "0 months", "0 trailing month(s)", "0 periods were excluded"… */
const ZERO_COUNT_RE =
  /\b0(?:\.0+)?\s+(?:[a-z]+\s+){0,2}(?:month|day|week|year|period|record|entr|item|point|row)[a-z()]*\b/i;

/** Sequencing markers that assert forward temporal order. */
const SEQUENCE_RE = /\b(?:then|followed by|subsequently|after (?:that|which))\b/i;

/** Period tokens: 2021-04, 2021-04-21, 2021Q2, bare 2021 (years last — only
 *  counted when no finer token is present, to avoid "2021-04" double-hits). */
const PERIOD_RE = /\b(20\d{2})(?:-(\d{2})(?:-(\d{2}))?|[Qq]([1-4]))?\b/g;

function periodOrdinal(m: RegExpMatchArray): number {
  const year = Number(m[1]);
  if (m[4]) return year * 372 + (Number(m[4]) - 1) * 93; // quarter
  const month = m[2] ? Number(m[2]) - 1 : 0;
  const day = m[3] ? Number(m[3]) : 0;
  return year * 372 + month * 31 + day;
}

function checkSentence(sentence: string, issues: FindingIssue[]): "keep" | "drop" {
  if (ZERO_COUNT_RE.test(sentence)) {
    issues.push({
      kind: "zero_count_sentence",
      detail: `dropped a sentence narrating zero things as an event: "${sentence.trim().slice(0, 120)}"`,
    });
    return "drop";
  }
  // Narrated-arithmetic coherence: "A ... B ... a multiplier of C" where C
  // matches neither B/A nor A/B (±5%) mixes values from different windows
  // in one claim — the sentence's own arithmetic must work.
  const mult = /\b(?:multiplier|ratio)\s+of\s+(-?\d[\d,.]*)/i.exec(sentence);
  if (mult) {
    const nums = [...sentence.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
      .map((m) => parseFloat(m[0].replace(/,/g, "")))
      .filter((n) => Number.isFinite(n) && n !== 0);
    const c = parseFloat(mult[1].replace(/,/g, ""));
    const others = nums.filter((n) => n !== c);
    if (others.length >= 2 && Number.isFinite(c)) {
      const coheres = others.some((x) =>
        others.some((y) => y !== x && Math.abs(x / y - c) / Math.abs(c) < 0.05)
      );
      if (!coheres) {
        issues.push({
          kind: "arithmetic_incoherence",
          detail: `sentence claims a multiplier/ratio of ${c} that no pair of its own numbers produces — values from different windows narrated as one claim: "${sentence.trim().slice(0, 120)}"`,
        });
      }
    }
  }
  // Interpreting insignificance: a sentence carrying a visible p-value
  // above 0.05 plus an interpretive verb is manufacturing meaning the
  // statistic declined to provide ("flat at p = 0.129 ... indicating that
  // premium offerings did not move in lockstep" — an insignificant slope
  // cannot be distinguished from no relationship, in EITHER direction).
  const pMatch = /\bp\s*[=<>]\s*(0?\.\d+)/i.exec(sentence);
  if (pMatch && parseFloat(pMatch[1]) > 0.05) {
    if (
      /\b(?:means?|indicat(?:es|ing)|reveal(?:s|ing)|establish(?:es|ing)|demonstrat(?:es|ing)|shows? that|confirm(?:s|ing))\b/i.test(
        sentence
      )
    ) {
      issues.push({
        kind: "interpreting_insignificance",
        detail: `sentence interprets an insignificant result (p = ${pMatch[1]}) as establishing something — it cannot be distinguished from no relationship: "${sentence.trim().slice(0, 130)}"`,
      });
    }
  }
  // Tautological delta narrated as a finding: "sitting 0% below the 2012
  // peak" when the current period IS the peak informs nothing.
  if (/\b0(?:\.0+)?%\s+(?:below|above|from|off)\b[^.]*\bpeak/i.test(sentence)) {
    issues.push({
      kind: "tautological_delta_prose",
      detail: `sentence narrates a zero distance-from-peak as a finding (the current period IS the peak): "${sentence.trim().slice(0, 110)}"`,
    });
  }
  // Joint-motion incoherence: "both/together/likewise" over two direction
  // words that differ ("P25 rising and P75 flat moved together" — they
  // didn't; "rising ... likewise flat" is not likewise).
  if (/\b(?:both|together|likewise|alike|in tandem)\b/i.test(sentence)) {
    const dirs = new Set(
      [
        ...sentence.matchAll(
          /\b(rising|rose|increasing|falling|fell|declining|decreasing|flat)\b/gi
        ),
      ].map((m) => {
        const w = m[1].toLowerCase();
        if (["rising", "rose", "increasing"].includes(w)) return "up";
        if (["falling", "fell", "declining", "decreasing"].includes(w)) return "down";
        return "flat";
      })
    );
    if (dirs.size > 1) {
      issues.push({
        kind: "joint_motion_incoherence",
        detail: `sentence asserts joint motion over differing directions (${[...dirs].join(" vs ")}): "${sentence.trim().slice(0, 120)}"`,
      });
    }
  }
  const seq = SEQUENCE_RE.exec(sentence);
  if (seq) {
    const before: number[] = [];
    const after: number[] = [];
    for (const m of sentence.matchAll(PERIOD_RE)) {
      ((m.index ?? 0) < (seq.index ?? 0) ? before : after).push(periodOrdinal(m));
    }
    if (before.length > 0 && after.length > 0 && Math.max(...after) < Math.min(...before)) {
      issues.push({
        kind: "temporal_incoherence",
        detail: `sequencing word "${seq[0]}" joins out-of-order periods — the narrative runs backwards in time: "${sentence.trim().slice(0, 140)}"`,
      });
    }
  }
  return "keep";
}

/**
 * Check one finalized JSONL line. Only JSON string contents are touched;
 * structure is never modified. Returns the (possibly cleaned) line plus
 * advisory issues.
 */
export function checkDiscourseLine(
  line: string,
  results?: Record<string, unknown>
): DiscourseCheckResult {
  const issues: FindingIssue[] = [];
  // Fast path: nothing prose-like.
  if (!/[a-z]{3}/i.test(line)) return { line, issues };
  // Statistic mislabel (run-38: 'Median YoY growth averaged 37.73%' where
  // median=0 and MEAN=37.73 — the mean quoted under the median's name, on
  // the exact statistic where the distinction matters most). Deterministic:
  // a number near the word median/mean that equals the OTHER statistic's
  // results value while the named one differs.
  if (results) {
    // Metric families: prose naming metric A beside a number that equals a
    // results key of metric B (while A's own sibling key differs) quotes
    // the wrong statistic under A's name. Generalized from mean/median
    // (run-38) to the whole family after run-41 put the IQR slope in the
    // median-price headline with the median's p-value.
    const FAMILIES = [
      "median",
      "mean",
      "average",
      "iqr",
      "p25",
      "p75",
      "max",
      "min",
      "spread",
      "std",
    ];
    const canon = (w: string) => (w === "average" ? "mean" : w);
    const famRe = new RegExp(
      `\\b(${FAMILIES.join("|")})\\b[^".]{0,80}?(-?\\d[\\d,]*\\.?\\d*)`,
      "gi"
    );
    for (const m of line.matchAll(famRe)) {
      const said = canon(m[1].toLowerCase());
      const num = parseFloat(m[2].replace(/,/g, ""));
      if (!Number.isFinite(num) || num === 0) continue;
      for (const [k, v] of Object.entries(results)) {
        if (typeof v !== "number") continue;
        if (Math.abs(v - num) > Math.abs(v) * 0.001) continue;
        // Which other-family token in k, swapped for `said`, names an
        // EXISTING sibling? (Keys can contain both words —
        // median_price_mean_yoy_... — so the swap decides, not inclusion.)
        const other: string | undefined = FAMILIES.map(canon).find((f: string): boolean => {
          if (f === said || !k.includes(f)) return false;
          const cand: string = k.replace(f, said);
          return cand !== k && cand in results;
        });
        if (!other) continue;
        const sibling = k.replace(other, said);
        const sibVal = results[sibling];
        if (typeof sibVal === "number" && Math.abs(sibVal - num) > Math.abs(num) * 0.01) {
          issues.push({
            kind: "statistic_mislabel",
            detail: `prose calls ${num} the ${said}, but it equals results.${k} (the ${other}) while ${sibling} = ${sibVal} — the ${other} quoted under the ${said}'s name`,
          });
          break;
        }
      }
    }
  }
  const cleaned = line.replace(/"((?:[^"\\]|\\.)*)"/g, (whole, inner: string) => {
    if (!/[a-zA-Z]{3}/.test(inner) || inner.length < 40) return whole;
    let text = inner;
    // Counts rendered as list markers — "(8) years where..." reads as
    // enumeration (three runs of prompt rules didn't hold; fixed here).
    if (/[:;]\s*\(\d+\)\s+[a-z]/i.test(text)) {
      issues.push({
        kind: "count_formatting",
        detail: `parenthesized counts rewritten to plain counts: "${text.trim().slice(0, 90)}"`,
      });
      text = text.replace(/([:;]\s*)\((\d+)\)\s+/g, "$1$2 ");
    }
    // Empty interpolation: a multi-space gap mid-prose is the tell of an
    // unfilled slot ("present in both  and  to ensure").
    if (/\S {2,}\S/.test(text)) {
      issues.push({
        kind: "empty_interpolation",
        detail: `prose contains unfilled slots (multi-space gaps): "${text.trim().slice(0, 120)}"`,
      });
      text = text.replace(/(\S) {2,}(\S)/g, "$1 $2");
    }
    const sentences = text.split(SENTENCE_SPLIT);
    const kept = sentences.filter((s) => checkSentence(s, issues) === "keep");
    if (kept.length === sentences.length && text === inner) return whole;
    return `"${kept.join(" ").trim()}"`;
  });
  return { line: cleaned, issues };
}
