"use client";

import { useRef, useState } from "react";

import type { Cell, CellMode } from "../lib/api";
import { formatMs, relativeTime } from "./cell";

type Percentile = "mean" | "p50" | "p70" | "p95" | "p99";
type Metric = "ttft_ms" | "tpot_ms" | "e2e_ms" | "input_tokens" | "output_tokens";

const columns: Percentile[] = ["mean", "p50", "p70", "p95", "p99"];
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

function summaryValue(cell: Cell, metric: Metric, percentile: Percentile): number | null {
  const measured = cell.metric_summaries?.[metric]?.[percentile];
  if (measured !== undefined) return measured;
  if (percentile === "p50" || percentile === "p95" || percentile === "p99") {
    if (metric === "ttft_ms") return cell[`ttft_${percentile}`];
    if (metric === "tpot_ms") return cell[`tpot_${percentile}`];
    if (metric === "e2e_ms") return cell[`e2e_${percentile}`];
  }
  return null;
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
    <article className="min-w-0 overflow-hidden rounded-[13px] border border-slate-200 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
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
    <article className="min-w-0 overflow-hidden rounded-[13px] border border-slate-200 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
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

function ModeSection({ mode, cells }: { mode: CellMode; cells: Cell[] }) {
  const sorted = [...cells].sort((a, b) => a.level - b.level);
  const completed = sorted.filter((cell) => cell.status === "completed").length;
  const title = mode === "qps" ? "QPS 测试" : "并发测试";
  return (
    <section id={`report-panel-${mode}`} role="tabpanel" aria-labelledby={`report-tab-${mode}`} className="rounded-[18px] border border-slate-200 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-t-[17px] border-b border-slate-100 px-5 py-4 dark:border-neutral-800 ${mode === "qps" ? "bg-gradient-to-r from-emerald-50 to-white dark:from-emerald-950/20 dark:to-neutral-900" : "bg-gradient-to-r from-blue-50 to-white dark:from-blue-950/20 dark:to-neutral-900"}`}>
        <div>
          <h3 className="text-base font-semibold text-slate-900 dark:text-neutral-100">{title}</h3>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-neutral-400">{mode === "qps" ? "档位为发送端提供的 QPS" : "档位为发送端最大并发"}</p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px] text-slate-500 dark:text-neutral-400">
          <span className="rounded-md border border-slate-200 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">{sorted.length} 个档位</span>
          <span className="rounded-md border border-slate-200 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">{completed} 项已完成</span>
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="m-5 rounded-xl border border-dashed border-slate-200 px-4 py-7 text-center text-xs text-slate-400 dark:border-neutral-700">暂无测试项</p>
      ) : (
        <div className="space-y-5 p-5">
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
      )}
    </section>
  );
}

export function WorkloadReport({ cells, name, shape }: { cells: Cell[]; name: string; shape: string }) {
  const [selectedMode, setSelectedMode] = useState<CellMode>("concurrency");
  const scrollRef = useRef<HTMLDivElement>(null);
  const concurrencyTab = useRef<HTMLButtonElement>(null);
  const qpsTab = useRef<HTMLButtonElement>(null);
  function selectMode(mode: CellMode) {
    setSelectedMode(mode);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }
  const latest = cells.reduce<string | null>((value, cell) =>
    cell.last_run_at && (!value || cell.last_run_at > value) ? cell.last_run_at : value, null);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold tracking-[0.17em] text-slate-400">WORKLOAD REPORT</p>
          <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-900 dark:text-neutral-100">{name} · 总报告</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-neutral-400">{shape}{latest ? ` · 最近测于 ${relativeTime(latest)}` : ""}</p>
        </div>
        <span className="rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[10px] font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">{cells.length} 项测试</span>
      </div>
      <div role="tablist" aria-label="报告分区" className="my-4 inline-flex shrink-0 self-start rounded-xl border border-slate-200 bg-slate-100 p-1 text-xs font-semibold dark:border-neutral-700 dark:bg-neutral-800">
        {(["concurrency", "qps"] as const).map((mode) => (
          <button
            key={mode}
            ref={mode === "concurrency" ? concurrencyTab : qpsTab}
            type="button"
            id={`report-tab-${mode}`}
            role="tab"
            aria-controls={`report-panel-${mode}`}
            aria-selected={selectedMode === mode}
            tabIndex={selectedMode === mode ? 0 : -1}
            onClick={() => selectMode(mode)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = mode === "concurrency" ? "qps" : "concurrency";
              selectMode(next);
              (next === "concurrency" ? concurrencyTab : qpsTab).current?.focus();
            }}
            className={`rounded-lg px-4 py-2 transition-colors ${selectedMode === mode
              ? `bg-white shadow-sm dark:bg-neutral-900 ${mode === "qps" ? "text-emerald-700 dark:text-emerald-300" : "text-blue-700 dark:text-blue-300"}`
              : "text-slate-500 hover:text-slate-700 dark:text-neutral-400 dark:hover:text-neutral-200"}`}
          >
            {mode === "qps" ? "QPS 测试" : "并发测试"}
          </button>
        ))}
      </div>
      <div ref={scrollRef} className="report-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
        {(["concurrency", "qps"] as const).map((mode) => (
          <div key={mode} hidden={selectedMode !== mode}>
            <ModeSection mode={mode} cells={cells.filter((cell) => cell.mode === mode)} />
          </div>
        ))}
        <p className="pb-1 text-[10px] leading-relaxed text-slate-400">延迟和 Token 用量中的 Mean 为单个成功请求的平均值；P50、P70、P95、P99 为对应分位数。— 表示该次测试没有记录对应指标。</p>
      </div>
    </div>
  );
}
