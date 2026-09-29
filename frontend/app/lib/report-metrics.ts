import type { Cell } from "./api";

export const REPORT_PERCENTILES = ["mean", "p50", "p70", "p95", "p99"] as const;
export type ReportPercentile = typeof REPORT_PERCENTILES[number];
export type ReportMetric = "ttft_ms" | "tpot_ms" | "e2e_ms" | "input_tokens" | "output_tokens";

/** A recorded null stays missing; only absent summary fields fall back to legacy columns. */
export function reportSummaryValue(cell: Cell, metric: ReportMetric, percentile: ReportPercentile): number | null {
  const measured = cell.metric_summaries?.[metric]?.[percentile];
  if (measured !== undefined) return finite(measured);
  if (percentile === "p50" || percentile === "p95" || percentile === "p99") {
    if (metric === "ttft_ms") return finite(cell[`ttft_${percentile}`]);
    if (metric === "tpot_ms") return finite(cell[`tpot_${percentile}`]);
    if (metric === "e2e_ms") return finite(cell[`e2e_${percentile}`]);
  }
  return null;
}

export function finite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

/** Results retain their execution identity even after the current configuration is edited. */
export function reportCell(cell: Cell): Cell {
  return cell.executed_snapshot ? { ...cell, mode: cell.executed_snapshot.mode, level: cell.executed_snapshot.level } : cell;
}
