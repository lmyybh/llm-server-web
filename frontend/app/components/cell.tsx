"use client";

import type { Cell, CellMode, CellStatus, WorkloadKind } from "../lib/api";
import { LineChart, type Point } from "./chart";

export const MODE_LABELS: Record<CellMode, string> = {
  concurrency: "并发",
  qps: "QPS",
};

/** Short label for a workload's token shape or dataset. */
export function workloadShape(workload: {
  kind: WorkloadKind;
  input_tokens: number | null;
  output_tokens: number | null;
  dataset: string | null;
}): string {
  if (workload.kind === "dataset") return `真实数据集 / ${workload.dataset}`;
  const input = workload.input_tokens?.toLocaleString("zh-CN");
  const output = workload.output_tokens?.toLocaleString("zh-CN");
  return `合成数据 / 输入 ${input} · 输出 ${output} tokens`;
}

const STATUS_STYLES: Record<CellStatus, string> = {
  idle: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500",
  queued:
    "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  completed:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  cancelled:
    "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

const STATUS_LABELS: Record<CellStatus, string> = {
  idle: "待运行",
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function CellStatusBadge({ status }: { status: CellStatus }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Dot + label colors for the cell table's status column. */
const STATUS_DOT_COLORS: Record<CellStatus, string> = {
  idle: "bg-neutral-400",
  queued: "bg-neutral-400",
  running: "bg-blue-500",
  completed: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-amber-500",
};

/**
 * The status column of a cell row: a small dot plus quiet text. Cheaper to
 * scan than the pill badge, which is reserved for inspection pages.
 */
export function CellStatusDot({ status, phase }: { status: CellStatus; phase?: string }) {
  const label =
    status === "running" && (phase === "预热" || phase === "warmup")
      ? "预热中"
      : STATUS_LABELS[status];
  return (
    <span className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT_COLORS[status]} ${
          status === "running" ? "animate-pulse" : ""
        }`}
      />
      {label}
    </span>
  );
}

export function format(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? "—" : value.toFixed(digits);
}

/** Milliseconds in the unit a person would say them in. */
export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

export function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

const PERCENTILES = [
  ["ttft", "TTFT"],
  ["tpot", "TPOT"],
  ["e2e", "E2E"],
] as const;

/** p50/p95/p99 for the three latency families, as one small table. */
export function CellLatencyTable({ cell }: { cell: Cell }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
          <th className="py-1 font-medium">指标</th>
          <th className="py-1 text-right font-medium">p50</th>
          <th className="py-1 text-right font-medium">p95</th>
          <th className="py-1 text-right font-medium">p99</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {PERCENTILES.map(([key, label]) => (
          <tr key={key} className="border-t border-neutral-100 dark:border-neutral-800">
            <td className="py-1 font-sans text-neutral-600 dark:text-neutral-400">{label}</td>
            <td className="py-1 text-right">{formatMs(cell[`${key}_p50`])}</td>
            <td className="py-1 text-right">{formatMs(cell[`${key}_p95`])}</td>
            <td className="py-1 text-right">{formatMs(cell[`${key}_p99`])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The one-line numbers a Cell result is read by. */
export function CellSummary({ cell }: { cell: Cell }) {
  const total = cell.total_requests ?? 0;
  const succeeded = cell.successful_requests ?? 0;
  const failed = cell.failed_requests ?? 0;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
      <Stat
        label="档位"
        value={cell.mode === "qps" ? `QPS ${cell.level}` : `并发 ${cell.level}`}
      />
      <Stat label="成功请求" value={`${succeeded}/${total}`} />
      <Stat
        label="成功率"
        value={total === 0 ? "—" : `${((succeeded / total) * 100).toFixed(1)}%`}
        alarm={failed > 0}
      />
      <Stat
        label="耗时"
        value={cell.duration_seconds === null ? "—" : `${cell.duration_seconds.toFixed(1)} s`}
      />
      <Stat label="吞吐" value={`${format(cell.achieved_qps)} req/s`} />
      <Stat label="输出吞吐" value={`${format(cell.output_token_throughput)} tok/s`} />
      <Stat label="输入吞吐" value={`${format(cell.input_token_throughput)} tok/s`} />
      <Stat
        label="结束原因"
        value={
          cell.finish_reasons
            ? Object.entries(cell.finish_reasons)
                .map(([reason, count]) => {
                  const label = reason === "length" ? "达到长度上限" : reason === "stop" ? "正常停止" : reason === "tool_calls" ? "工具调用" : reason;
                  return `${label}：${count} 次`;
                })
                .join(" · ")
            : "—"
        }
      />
    </dl>
  );
}

function Stat({ label, value, alarm }: { label: string; value: string; alarm?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className={`font-mono ${alarm ? "text-red-700 dark:text-red-400" : ""}`}>{value}</dd>
    </div>
  );
}

function successRate(cell: Cell): number | null {
  const total = cell.total_requests ?? 0;
  if (total === 0 || cell.successful_requests === null) return null;
  return (cell.successful_requests / total) * 100;
}

const CURVES: { title: string; unit: string; read: (cell: Cell) => number | null }[] = [
  { title: "TTFT p99", unit: "ms", read: (cell) => cell.ttft_p99 },
  { title: "TPOT p99", unit: "ms", read: (cell) => cell.tpot_p99 },
  { title: "E2E p99", unit: "ms", read: (cell) => cell.e2e_p99 },
  { title: "输出吞吐", unit: "tok/s", read: (cell) => cell.output_token_throughput },
  { title: "成功率", unit: "%", read: successRate },
];

/**
 * One small chart per metric rather than several lines on one axis: the
 * metrics do not share a unit, and putting milliseconds and requests per
 * second on one scale means neither is readable.
 *
 * Nothing here is coloured by success or failure. There is no threshold to
 * colour against — deciding where a service stops being good enough is the
 * reader's job, and a green/red chart would quietly make that decision for
 * them.
 *
 * Every point is labelled with when it was measured: a curve assembled from
 * Cells run at different times is read with those times attached (ADR-0001).
 */
export function CellCurves({ cells, mode }: { cells: Cell[]; mode: string }) {
  const measured = cells.filter((cell) => cell.status === "completed" && cell.last_run_at);
  if (measured.length === 0) return null;
  const xLabel = mode === "qps" ? "提供的 QPS" : "并发";
  const rates = measured.map(successRate).filter((rate): rate is number => rate !== null);
  const curves = rates.length > 0 && rates.every((rate) => rate === rates[0])
    ? CURVES.filter((curve) => curve.title !== "成功率")
    : CURVES;

  return (
    <section aria-label="指标曲线" className="flex flex-col gap-2">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {curves.map((curve) => (
          <LineChart
            key={curve.title}
            title={curve.title}
            unit={curve.unit}
            xLabel={xLabel}
            points={measured
              .map((cell) => ({ x: cell.level, y: curve.read(cell) }))
              .filter((point): point is Point => point.y !== null)}
          />
        ))}
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        计时从<strong>请求真正发出的那一刻</strong>起算，排队等待并发许可的时间不计入——所以高并发档位呈现的是
        <strong>服务时间</strong>，而不是用户感知的响应时间。
      </p>
      <p className="text-xs text-neutral-400 dark:text-neutral-500">
        {measured
          .map(
            (cell) =>
              `${cell.mode === "qps" ? "QPS" : "并发"} ${cell.level} 测于 ${cell.last_run_at}`,
          )
          .join(" · ")}
      </p>
    </section>
  );
}

/** A Cell's latency distributions, as kept by the executor. */
export function CellHistograms({ cell }: { cell: Cell }) {
  if (!cell.ttft_histogram && !cell.tpot_histogram && !cell.e2e_histogram) return null;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <HistogramBars title="TTFT 分布" buckets={cell.ttft_histogram} unit="ms" />
      <HistogramBars title="TPOT 分布" buckets={cell.tpot_histogram} unit="ms" />
      <HistogramBars title="E2E 分布" buckets={cell.e2e_histogram} unit="ms" />
    </div>
  );
}

export function HistogramBars({
  title,
  buckets,
  unit,
}: {
  title: string;
  buckets: Record<string, number> | null;
  unit: string;
}) {
  if (!buckets) return null;
  const entries = Object.entries(buckets).filter(([, count]) => count > 0);
  if (entries.length === 0) return null;
  const peak = Math.max(...entries.map(([, count]) => count));

  return (
    <div>
      <h4 className="mb-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
        {title}（{unit}）
      </h4>
      <ul className="flex flex-col gap-0.5">
        {entries.map(([label, count]) => (
          <li key={label} className="grid grid-cols-[minmax(0,5rem)_minmax(0,1fr)_2rem] items-center gap-2 text-xs">
            <span className="min-w-0 truncate font-mono text-neutral-500 dark:text-neutral-400" title={label}>
              {label}
            </span>
            <span className="h-3 min-w-0 overflow-hidden rounded-sm bg-neutral-100 dark:bg-neutral-800">
              <span
                className="block h-full rounded-sm bg-neutral-400 dark:bg-neutral-600"
                style={{ width: `${Math.max(2, (count / peak) * 100)}%` }}
              />
            </span>
            <span className="text-right font-mono tabular-nums text-neutral-500 dark:text-neutral-400">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What is running right now, in the terms someone waiting would use: which
 * phase, and how many requests through.
 */
export function CellProgress({ cell }: { cell: Cell }) {
  const progress = cell.progress;
  const parts: string[] = [];
  if (progress?.phase) parts.push(`${progress.phase.replace(/中$/, "")}中`);
  if (progress?.completed_requests !== undefined && progress?.total_requests !== undefined) {
    parts.push(`${progress.completed_requests}/${progress.total_requests}`);
  }
  if (parts.length === 0) return null;
  return (
    <span className="tabular-nums">{parts.join(" · ")}</span>
  );
}
