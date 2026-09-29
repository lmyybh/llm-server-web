"use client";

import type { Cell, CellMode } from "../lib/api";
import { formatMs } from "./cell";

import { REPORT_PERCENTILES as columns, reportSummaryValue as summaryValue, type ReportMetric as Metric } from "../lib/report-metrics";
const latency: { key: Metric; label: string; unit: string }[] = [
  { key: "e2e_ms", label: "E2E", unit: "ms" },
  { key: "ttft_ms", label: "TTFT", unit: "ms" },
  { key: "tpot_ms", label: "TPOT", unit: "ms" },
];

function number(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function metricText(value: number | null, metric: Metric): string {
  if (metric.endsWith("_ms")) return formatMs(value);
  if (metric.endsWith("tokens")) return number(value, 0);
  return number(value, 1);
}

function ReportTable({ mode, cells, title, unit, metric }: {
  mode: CellMode;
  cells: Cell[];
  title: string;
  unit: string;
  metric: Metric;
}) {
  return (
    <article data-report-metric={metric} className="min-w-0 overflow-hidden rounded-[13px] border border-slate-200 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2 px-3.5 py-3">
        <h4 className="text-xs font-semibold text-slate-800 dark:text-neutral-100">{title}</h4>
        <span className="text-[10px] text-slate-400">{unit}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] table-fixed border-collapse text-right text-xs tabular-nums">
          <thead className="bg-slate-50 text-slate-400 dark:bg-neutral-800 dark:text-neutral-400">
            <tr>
              <th className="w-[58px] py-2 pl-3 pr-1 text-left font-semibold">{mode === "qps" ? "QPS" : "并发"}</th>
              {columns.map((column) => <th key={column} className="px-1.5 py-2 font-semibold uppercase">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {cells.map((cell) => (
              <tr key={cell.id} className="border-t border-slate-100 dark:border-neutral-800">
                <td className={`py-2.5 pl-3 pr-1 text-left font-semibold ${mode === "qps" ? "text-emerald-700 dark:text-emerald-300" : "text-blue-700 dark:text-blue-300"}`}>{cell.level}</td>
                {columns.map((column) => (
                  <td key={column} className="px-1.5 py-2.5 text-slate-700 dark:text-neutral-300">
                    {metricText(summaryValue(cell, metric, column), metric)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-100 px-3 py-2 text-[10px] text-slate-400 dark:border-neutral-800">
        每个成功请求 · 按档位统计
      </div>
    </article>
  );
}

function OverviewTable({ mode, cells }: { mode: CellMode; cells: Cell[] }) {
  return (
    <article data-report-metric="overview" className="min-w-0 overflow-hidden rounded-[13px] border border-slate-200 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2 px-3.5 py-3">
        <h4 className="text-xs font-semibold text-slate-800 dark:text-neutral-100">运行概览</h4>
        <span className="text-[10px] text-slate-400">按档位汇总</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-right text-xs tabular-nums">
          <thead className="bg-slate-50 text-slate-400 dark:bg-neutral-800 dark:text-neutral-400">
            <tr>
              <th className="w-[58px] py-2 pl-3 text-left font-semibold">{mode === "qps" ? "QPS" : "并发"}</th>
              <th className="px-3 py-2 font-semibold">实际并发</th>
              <th className="px-3 py-2 font-semibold">成功率</th>
              <th className="px-3 py-2 font-semibold">请求吞吐 <span className="font-normal">req/s</span></th>
              <th className="px-3 py-2 font-semibold">输入吞吐 <span className="font-normal">tok/s</span></th>
              <th className="px-3 py-2 font-semibold">输出吞吐 <span className="font-normal">tok/s</span></th>
            </tr>
          </thead>
          <tbody>
            {cells.map((cell) => {
              const successRate = cell.total_requests && cell.successful_requests != null
                ? number(cell.successful_requests / cell.total_requests * 100, 1) + "%"
                : "—";
              return (
                <tr key={cell.id} className="border-t border-slate-100 dark:border-neutral-800">
                  <td className={`py-2.5 pl-3 text-left font-semibold ${mode === "qps" ? "text-emerald-700 dark:text-emerald-300" : "text-blue-700 dark:text-blue-300"}`}>{cell.level}</td>
                  <td className="px-3 py-2.5 text-slate-700 dark:text-neutral-300">{number(cell.actual_concurrency, 1)}</td>
                  <td className="px-3 py-2.5 text-slate-700 dark:text-neutral-300">{successRate}</td>
                  <td className="px-3 py-2.5 text-slate-700 dark:text-neutral-300">{number(cell.achieved_qps, 2)}</td>
                  <td className="px-3 py-2.5 text-slate-700 dark:text-neutral-300">{number(cell.input_token_throughput, 1)}</td>
                  <td className="px-3 py-2.5 text-slate-700 dark:text-neutral-300">{number(cell.output_token_throughput, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-100 px-3 py-2 text-[10px] text-slate-400 dark:border-neutral-800">实际并发为时间平均在途请求数；吞吐量为正式压测阶段的成功请求或 token 总量除以总耗时</div>
    </article>
  );
}

function TokenTable({ mode, cells }: { mode: CellMode; cells: Cell[] }) {
  return (
    <article className="min-w-0 overflow-hidden rounded-[13px] border border-slate-200 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center justify-between gap-2 px-3.5 py-3">
        <h4 className="text-xs font-semibold text-slate-800 dark:text-neutral-100">Token 用量</h4>
        <span className="text-[10px] text-slate-400">输入 / 输出 · tokens</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] table-fixed border-collapse text-right text-xs tabular-nums">
          <thead className="bg-slate-50 text-slate-400 dark:bg-neutral-800 dark:text-neutral-400">
            <tr>
              <th className="w-[58px] py-2 pl-3 pr-1 text-left font-semibold">{mode === "qps" ? "QPS" : "并发"}</th>
              {columns.map((column) => <th key={column} className="px-1.5 py-2 font-semibold uppercase">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {cells.map((cell) => (
              <tr key={cell.id} className="border-t border-slate-100 dark:border-neutral-800">
                <td className={`py-2.5 pl-3 pr-1 text-left font-semibold ${mode === "qps" ? "text-emerald-700 dark:text-emerald-300" : "text-blue-700 dark:text-blue-300"}`}>{cell.level}</td>
                {columns.map((column) => {
                  const input = summaryValue(cell, "input_tokens", column);
                  const output = summaryValue(cell, "output_tokens", column);
                  return <td key={column} className="whitespace-nowrap px-1.5 py-2.5 text-slate-700 dark:text-neutral-300">
                    {input == null && output == null ? "—" : `${number(input, 0)}/${number(output, 0)}`}
                  </td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-slate-100 px-3 py-2 text-[10px] text-slate-400 dark:border-neutral-800">每格以 Input tokens / Output tokens 展示</div>
    </article>
  );
}

export function WorkloadReportTables({ mode, cells }: { mode: CellMode; cells: Cell[] }) {
  const sorted = [...cells].sort((a, b) => a.level - b.level);
  return (
    <div className="space-y-5">
          <div>
            <OverviewTable mode={mode} cells={sorted} />
          </div>
          <div className="border-t border-slate-100 pt-5 dark:border-neutral-800">
            <div className="mb-2.5 flex items-baseline justify-between gap-2"><h4 className="text-xs font-semibold">延迟与 Token</h4><span className="text-[10px] text-slate-400">按成功请求统计</span></div>
            <div className="grid gap-3 lg:grid-cols-2">
              <TokenTable mode={mode} cells={sorted} />
              {latency.map((item) => <ReportTable key={item.key} mode={mode} cells={sorted} title={item.label} unit={item.unit} metric={item.key} />)}
            </div>
          </div>
        </div>
  );
}
