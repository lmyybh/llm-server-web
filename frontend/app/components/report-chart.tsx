"use client";

import { useId, useState } from "react";
import type { Cell, CellMode } from "../lib/api";
import { finite, REPORT_PERCENTILES, reportSummaryValue, type ReportMetric } from "../lib/report-metrics";

export const REPORT_CHARTS = [
  { key: "output_token_throughput", title: "输出吞吐", unit: "tok/s" },
  { key: "e2e_ms", title: "E2E · 请求总延迟", unit: "ms" },
  { key: "ttft_ms", title: "TTFT · 首 Token 延迟", unit: "ms" },
  { key: "tpot_ms", title: "TPOT · 每 Token 延迟", unit: "ms" },
] as const;
export type ReportChartMetric = typeof REPORT_CHARTS[number];
const COLORS = ["#64748b", "#3b82f6", "#06b6d4", "#8b5cf6", "#f59e0b"];
const format = (n: number | null) => n === null ? "—" : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const label = (s: string) => s === "mean" ? "Mean" : s.toUpperCase();

export function ReportChart({ metric, mode, cells, onShowData }: {
  metric: ReportChartMetric; mode: CellMode; cells: Cell[]; onShowData: () => void;
}) {
  const tooltipId = useId();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const distribution = metric.key !== "output_token_throughput";
  const series = distribution ? [...REPORT_PERCENTILES] : ["value" as const];
  const getValue = (cell: Cell, s: typeof series[number]) => s === "value"
    ? finite(cell.output_token_throughput)
    : reportSummaryValue(cell, metric.key as ReportMetric, s);
  const visible = series.filter(s => !hidden.has(s));
  const values = cells.flatMap(c => visible.map(s => getValue(c, s))).filter((n): n is number => n !== null);
  const max = Math.max(1, ...values) * 1.12;
  const x = (i: number) => cells.length === 1 ? 290 : 55 + i / Math.max(1, cells.length - 1) * 480;
  const y = (n: number) => 170 - n / max * 152;
  const selectedCell = cells.find(c => c.id === selected);
  const clear = () => setSelected(null);
  const modeLabel = mode === "qps" ? "QPS" : "并发";
  return <article className="report-chart overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-neutral-700 dark:bg-neutral-900" aria-label={metric.title}>
    <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3.5">
      <h4 className="text-xs font-semibold">{metric.title}</h4>
      <div className="flex items-center gap-2"><span className="text-[10px] text-slate-400">{metric.unit}</span><button type="button" onClick={onShowData} className="report-no-print rounded bg-blue-50 px-2 py-1 text-[10px] text-blue-700 dark:bg-blue-950/40 dark:text-blue-300" aria-label={`查看${metric.title}数据表`}>查看数据 ↗</button></div>
    </div>
    <div className="relative px-2 pb-2" onMouseLeave={clear} onKeyDown={e => { if (e.key === "Escape") { clear(); e.stopPropagation(); } }}>
      <svg viewBox="0 0 580 213" className="w-full" role="group" aria-label={`${metric.title} 随${modeLabel}档位变化`}>
        {[0, 1, 2, 3, 4].map(i => {
          const tick = max * i / 4;
          return <g key={i}><line x1="55" x2="535" y1={y(tick)} y2={y(tick)} className="stroke-slate-100 dark:stroke-neutral-800" strokeDasharray="3 4" /><text x="45" y={y(tick) + 3} textAnchor="end" className="fill-slate-400 text-[9px]">{tick >= 1000 ? `${(tick / 1000).toFixed(1)}k` : format(tick)}</text></g>;
        })}
        {cells.map((c, i) => <text key={c.id} x={x(i)} y="187" textAnchor="middle" className="fill-slate-400 text-[9px]">{c.level}</text>)}
        <text x="535" y="207" textAnchor="end" className="fill-slate-400 text-[9px]">{modeLabel}档位 · 分类轴</text>
        {visible.map(s => {
          const color = distribution ? COLORS[REPORT_PERCENTILES.indexOf(s as typeof REPORT_PERCENTILES[number])] : "#2563eb";
          // A missing sample starts a new segment; never interpolate across absent data.
          let connected = false;
          const path = cells.map((cell, i) => {
            const n = getValue(cell, s);
            if (n === null) { connected = false; return ""; }
            const command = connected ? "L" : "M"; connected = true;
            return `${command} ${x(i)} ${y(n)}`;
          }).join(" ");
          return <g key={s}><path data-series={s} d={path} fill="none" stroke={color} strokeWidth="1.8" />{cells.map((cell, i) => {
            const n = getValue(cell, s);
            if (n === null) return null;
            return <circle key={cell.id} cx={x(i)} cy={y(n)} r="4" stroke={color} strokeWidth="1.8" className="cursor-crosshair fill-white outline-none focus:stroke-slate-900 focus:stroke-[3px] dark:fill-neutral-900 dark:focus:stroke-white" tabIndex={0} role="button"
              aria-label={`${modeLabel} ${cell.level}，${s === "value" ? "测量值" : label(s)} ${format(n)} ${metric.unit}`}
              aria-describedby={selected === cell.id ? tooltipId : undefined}
              onMouseEnter={() => setSelected(cell.id)} onFocus={() => setSelected(cell.id)} onBlur={clear} onClick={() => setSelected(cell.id)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(cell.id); } }} />;
          })}</g>;
        })}
        {!values.length ? <text x="290" y="100" textAnchor="middle" className="fill-slate-400 text-xs">{visible.length ? "暂无测量结果" : "已隐藏全部曲线，点击图例恢复"}</text> : null}
      </svg>
      {selectedCell ? <div id={tooltipId} role="tooltip" className="report-no-print pointer-events-none absolute right-3 top-2 max-w-[90%] rounded-lg bg-slate-900/95 px-3 py-2 text-[11px] leading-5 text-white shadow-lg">
        <strong>{modeLabel} {selectedCell.level} · {metric.title}</strong>
        {series.map(s => <div key={s} className="flex justify-between gap-6"><span>{s === "value" ? "测量值" : label(s)}</span><span>{format(getValue(selectedCell, s))} {metric.unit}</span></div>)}
        {selectedCell.last_run_at ? <div className="text-[10px] text-slate-300">测于 {new Date(selectedCell.last_run_at).toLocaleString("zh-CN")}</div> : null}
        {selectedCell.stale ? <div className="text-amber-300">旧配置执行快照</div> : null}
      </div> : null}
    </div>
    {distribution ? <div className="flex flex-wrap justify-center gap-4 px-3 pb-3" aria-label="曲线分位数">
      {REPORT_PERCENTILES.map((s, i) => <button type="button" key={s} aria-pressed={!hidden.has(s)} onClick={() => { clear(); setHidden(previous => { const next = new Set(previous); if (next.has(s)) next.delete(s); else next.add(s); return next; }); }} className={`flex items-center gap-1 text-[10px] text-slate-500 dark:text-neutral-400 ${hidden.has(s) ? "line-through opacity-40" : ""}`}><span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: COLORS[i] }} />{label(s)}</button>)}
    </div> : null}
  </article>;
}
