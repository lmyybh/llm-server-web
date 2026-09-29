"use client";

import { artifactsZipUrl, type Cell } from "../lib/api";
import { format, formatMs, relativeTime } from "./cell";

type SummaryKey = "ttft_ms" | "tpot_ms" | "e2e_ms" | "input_tokens" | "output_tokens";
type PercentileKey = "mean" | "p50" | "p70" | "p95" | "p99";

function tokenCount(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}

function resultValue(cell: Cell, metric: SummaryKey, percentile: PercentileKey): number | null {
  const measured = cell.metric_summaries?.[metric]?.[percentile];
  if (measured !== undefined) return measured;
  if (percentile !== "p50" && percentile !== "p95" && percentile !== "p99") return null;
  if (metric === "ttft_ms") return cell[`ttft_${percentile}`];
  if (metric === "tpot_ms") return cell[`tpot_${percentile}`];
  if (metric === "e2e_ms") return cell[`e2e_${percentile}`];
  return null;
}

function MetricTable({ cell, kind }: { cell: Cell; kind: "latency" | "tokens" }) {
  const rows: { key: SummaryKey; label: string; explanation: string }[] = kind === "latency"
    ? [
        { key: "ttft_ms", label: "TTFT", explanation: "首 token 等待" },
        { key: "tpot_ms", label: "TPOT", explanation: "后续 token 间隔" },
        { key: "e2e_ms", label: "E2E", explanation: "请求完成时间" },
      ]
    : [
        { key: "input_tokens", label: "Input tokens", explanation: "实际输入 token 数" },
        { key: "output_tokens", label: "Output tokens", explanation: "实际输出 token 数" },
      ];
  const columns: PercentileKey[] = ["mean", "p50", "p70", "p95", "p99"];

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-neutral-700">
      <table className="w-full min-w-[650px] table-fixed border-collapse text-right text-xs">
        <thead className="bg-slate-50 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          <tr>
            <th className="w-[116px] px-2.5 py-2 text-left font-medium">指标</th>
            {columns.map((column) => (
              <th key={column} className="px-2.5 py-2 font-medium uppercase">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-slate-100 dark:border-neutral-800">
              <td className="px-2.5 py-2 text-left">
                <strong className="block font-semibold text-slate-800 dark:text-neutral-100">{row.label}</strong>
                <span className="block text-[10px] text-neutral-400">{row.explanation}</span>
              </td>
              {columns.map((column) => {
                const value = resultValue(cell, row.key, column);
                return (
                  <td
                    key={column}
                    className="px-2.5 py-2 tabular-nums text-slate-700 dark:text-neutral-300"
                  >
                    {kind === "latency" ? formatMs(value) : tokenCount(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FinishReasons({ cell }: { cell: Cell }) {
  const reasons = Object.entries(cell.finish_reasons ?? {}).filter(([, count]) => count > 0);
  if ((cell.failed_requests ?? 0) > 0) reasons.push(["error", cell.failed_requests!]);
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reasons.length === 0 ? <span className="text-xs text-neutral-400">—</span> : reasons.map(([reason, count]) => (
        <span key={reason} className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${reason === "error" ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-slate-100 text-slate-600 dark:bg-neutral-800 dark:text-neutral-300"}`}>
          {reason} {count}
        </span>
      ))}
    </div>
  );
}

export function CellReport({ cell }: { cell: Cell }) {
  const total = cell.total_requests ?? cell.num_requests;
  const successful = cell.successful_requests ?? 0;
  const successRate = total > 0 ? `${((successful / total) * 100).toFixed(0)}%` : "—";
  const workload = cell.executed_snapshot?.workload;
  const input = workload?.input_tokens ?? cell.workload_input_tokens;
  const output = workload?.output_tokens ?? cell.workload_output_tokens;

  return (
    <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pr-1">
      <p className="flex flex-wrap gap-x-2 text-xs text-neutral-500 dark:text-neutral-400">
        <span>{workload?.name ?? cell.workload_name}</span>
        {cell.last_run_at ? <span>· 测于 {relativeTime(cell.last_run_at)}</span> : null}
        {input != null && output != null ? <span>· workload 配置：input {tokenCount(input)} / output {tokenCount(output)} tokens</span> : null}
        {cell.stale ? <span className="text-amber-700 dark:text-amber-400">· 结果来自旧配置</span> : null}
      </p>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1.15fr_.85fr_.85fr_1fr_.85fr]">
        <article className="rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 dark:border-blue-900 dark:bg-blue-950/30">
          <p className="text-[11px] text-slate-500 dark:text-neutral-400">请求数</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-blue-700 dark:text-blue-300">
            {successful} / {total}
            <span className="ml-2 rounded-full bg-emerald-50 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{successRate}</span>
          </p>
        </article>
        <article className="rounded-lg border border-slate-200 px-3 py-2 dark:border-neutral-700">
          <p className="text-[11px] text-slate-500 dark:text-neutral-400">{cell.mode === "qps" ? "QPS" : "最大并发"}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{cell.level}</p>
        </article>
        <article className="rounded-lg border border-slate-200 px-3 py-2 dark:border-neutral-700">
          <p className="text-[11px] text-slate-500 dark:text-neutral-400">实际并发</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{format(cell.actual_concurrency, 1)}</p>
        </article>
        <article className="rounded-lg border border-slate-200 px-3 py-2 dark:border-neutral-700">
          <p className="text-[11px] text-slate-500 dark:text-neutral-400">请求吞吐</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{format(cell.achieved_qps)} <small className="text-[10px] font-normal text-neutral-400">req/s</small></p>
        </article>
        <article className="rounded-lg border border-slate-200 px-3 py-2 dark:border-neutral-700">
          <p className="text-[11px] text-slate-500 dark:text-neutral-400">测试耗时</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">{format(cell.duration_seconds, 1)} <small className="text-[10px] font-normal text-neutral-400">s</small></p>
        </article>
      </div>

      <div className="grid overflow-hidden rounded-lg border border-slate-200 bg-slate-50/60 sm:grid-cols-3 dark:border-neutral-700 dark:bg-neutral-800/40">
        <div className="px-3 py-2"><p className="text-[11px] text-neutral-500">输入吞吐</p><p className="mt-1 text-xs font-semibold tabular-nums">{format(cell.input_token_throughput)} <span className="font-normal text-neutral-400">tok/s</span></p></div>
        <div className="border-t border-slate-200 px-3 py-2 sm:border-l sm:border-t-0 dark:border-neutral-700"><p className="text-[11px] text-neutral-500">输出吞吐</p><p className="mt-1 text-xs font-semibold tabular-nums">{format(cell.output_token_throughput)} <span className="font-normal text-neutral-400">tok/s</span></p></div>
        <div className="border-t border-slate-200 px-3 py-2 sm:border-l sm:border-t-0 dark:border-neutral-700"><p className="text-[11px] text-neutral-500">结束原因</p><FinishReasons cell={cell} /></div>
      </div>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold">延迟指标</h3>
          <p className="text-[11px] text-neutral-500 dark:text-neutral-400">TTFT 首 token 等待 · TPOT 后续 token 间隔 · E2E 请求完成时间；不含并发排队</p>
        </div>
        <MetricTable cell={cell} kind="latency" />
      </section>
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold">Token 数量 <span className="text-xs font-normal text-slate-500">· 按请求统计</span></h3>
          {!cell.metric_summaries ? <p className="text-[11px] text-neutral-400">历史结果无实测 token 分布；重跑后可查看</p> : null}
        </div>
        <MetricTable cell={cell} kind="tokens" />
      </section>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        计时从请求真正发出的那一刻起算，排队等待并发许可的时间不计入；这里展示的是服务时间，而不是用户感知的响应时间。
      </p>
      <a href={artifactsZipUrl(cell.id)} className="self-start text-xs text-blue-600 hover:underline dark:text-blue-400">
        下载全部产物
      </a>
      <p className="text-[10px] text-neutral-400">实际并发为同时在途请求数的时间平均值；“—”表示这次测量未记录该指标。</p>
    </div>
  );
}
