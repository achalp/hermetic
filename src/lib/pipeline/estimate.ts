import { reportProgress } from "@/lib/pipeline/run-control";

export type RunBucket = "quick" | "medium" | "long" | "very_long";

export interface RunEstimate {
  bucket: RunBucket;
  /** Human-readable message shown up front. */
  label: string;
}

function fmtRows(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/**
 * Rough pre-flight duration estimate from cheap signals (row count, remote vs
 * local). Deliberately a bucketed RANGE with its basis — never a false-precise
 * ETA, since real durations vary wildly (measured: the same California
 * question ranged 12–56 min). It sets expectations and reassures the user that
 * a long run is expected, not stuck; Stop is always available.
 */
export function estimateRun(args: {
  rowCount: number;
  /** Reads over the network (s3:// / https:// via httpfs). */
  isRemote: boolean;
  /** Large local Parquet or any remote read. */
  isLargeData: boolean;
}): RunEstimate {
  const { rowCount, isRemote, isLargeData } = args;

  if (!isLargeData && rowCount < 500_000) {
    return { bucket: "quick", label: "Quick analysis — this should be fast." };
  }
  if (isRemote && rowCount >= 500_000_000) {
    return {
      bucket: "very_long",
      label: `Very large remote scan (~${fmtRows(rowCount)} rows). This can take many minutes — that's expected, not stuck. You can stop it anytime.`,
    };
  }
  if (isRemote && rowCount >= 10_000_000) {
    return {
      bucket: "long",
      label: `Large remote scan (~${fmtRows(rowCount)} rows). Expect several minutes; you can stop it anytime.`,
    };
  }
  if (rowCount >= 10_000_000 || isLargeData) {
    return {
      bucket: "medium",
      label: `Large dataset (~${fmtRows(rowCount)} rows) — this may take a minute or two.`,
    };
  }
  return { bucket: "medium", label: "This may take a moment." };
}

/** Emit the estimate as an early progress event (phase "estimate"). */
export function reportEstimate(e: RunEstimate): void {
  reportProgress({ phase: "estimate", detail: e.label, bucket: e.bucket });
}
