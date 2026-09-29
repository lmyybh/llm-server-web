"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Cell, CellMode } from "../lib/api";
import { reportCell } from "../lib/report-metrics";
import { workloadShape } from "./cell";
import { WorkloadReportTables } from "./workload-report-tables";
import { REPORT_CHARTS, ReportChart, type ReportChartMetric } from "./report-chart";

type SectionView = "charts" | "tables";

/** Shared report card for the deployment page and the standalone Workload dialog. */
export function WorkloadReportCard({ id, name, shape, cells: sourceCells, mode, navigate }: {
  id: string;
  name: string;
  shape: string;
  cells: Cell[];
  mode: CellMode;
  navigate: (element: HTMLElement) => void;
}) {
  const [view, setView] = useState<SectionView>("charts");
  const [target, setTarget] = useState<string | null>(null);
  const tables = useRef<HTMLDivElement>(null);
  const cells = useMemo(() => sourceCells.map(reportCell).filter(c => c.mode === mode).sort((a, b) => a.level - b.level), [sourceCells, mode]);
  const completed = cells.filter(c => c.status === "completed").length;
  const failed = cells.filter(c => (c.failed_requests ?? 0) > 0).length;
  const executionFailed = cells.filter(c => c.status === "failed").length;
  const pending = cells.filter(c => c.status === "idle").length;
  const running = cells.filter(c => c.status === "running" || c.status === "queued").length;
  const cancelled = cells.filter(c => c.status === "cancelled").length;
  const stale = cells.filter(c => c.stale).length;
  const shapes = Array.from(new Set(cells.map(c => c.executed_snapshot?.workload ? workloadShape(c.executed_snapshot.workload) : shape)));
  useLayoutEffect(() => {
    if (view !== "tables" || !target) return;
    const element = tables.current?.querySelector<HTMLElement>(`[data-report-metric="${target}"]`);
    if (element) { navigate(element); element.tabIndex = -1; element.focus({ preventScroll: true }); }
    setTarget(null);
  }, [navigate, target, view]);
  function showData(metric: ReportChartMetric) { setView("tables"); setTarget(metric.key === "output_token_throughput" ? "overview" : metric.key); }
  const badge = "rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] dark:border-neutral-700 dark:bg-neutral-900";
  return <section id={id} aria-labelledby={`${id}-title`} className="deployment-report-section mb-6 overflow-hidden rounded-[17px] border border-slate-200 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
    <div className={`flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-5 dark:border-neutral-800 ${mode === "qps" ? "bg-[#F9F3EC] dark:bg-[#F9F3EC]" : "bg-blue-50 dark:bg-blue-950"}`}>
      <div className="min-w-0 flex-1 basis-64"><h2 id={`${id}-title`} className="break-words text-lg font-semibold tracking-tight">{name}</h2><p className="mt-1 text-[11px] text-slate-500 dark:text-neutral-400">{(shapes.length ? shapes : [shape]).join("；")}</p>
      <div className="mt-2.5 flex flex-wrap gap-1.5 text-slate-500 dark:text-neutral-400">
        <span className={`${badge} ${mode === "qps" ? "text-[#B35F0A] dark:text-[#B35F0A]" : "text-blue-700 dark:text-blue-300"}`}>{mode === "qps" ? "QPS 测试" : "并发测试"}</span>
        <span className={badge}>{completed} / {cells.length} 项已完成</span>
        {failed > 0 ? <span className={`${badge} text-red-700`}>{failed} 档含失败请求</span> : null}
        {executionFailed > 0 ? <span className={`${badge} text-red-600`}>{executionFailed} 项执行失败</span> : null}
        {pending > 0 ? <span className={badge}>{pending} 档未执行</span> : null}
        {running > 0 ? <span className={badge}>{running} 项排队或运行中</span> : null}
        {cancelled > 0 ? <span className={badge}>{cancelled} 项已取消</span> : null}
        {stale > 0 ? <span className={`${badge} text-amber-700`}>{stale} 档旧配置</span> : null}
      </div>
      </div>
      <div role="group" aria-label={`${name}报告视图`} className="report-no-print ml-auto inline-flex shrink-0 gap-0.5 rounded-lg border border-slate-200 bg-slate-100/80 p-0.5 dark:border-neutral-700 dark:bg-neutral-800">
        {(["charts", "tables"] as const).map(v => <button type="button" key={v} aria-pressed={view === v} aria-controls={`${id}-${v}`} onClick={() => setView(v)} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${view === v ? `bg-white shadow-sm dark:bg-neutral-900 ${mode === "qps" ? "text-[#B35F0A] dark:text-[#B35F0A]" : "text-blue-700 dark:text-blue-300"}` : "text-slate-500 hover:text-slate-800 dark:text-neutral-400 dark:hover:text-neutral-200"}`}>{v === "charts" ? "曲线" : "数据表"}</button>)}
      </div>
    </div>
    <div className="p-4 lg:p-5">
      {cells.length === 0 ? <p className="rounded-xl border border-dashed border-slate-200 py-9 text-center text-xs text-slate-400 dark:border-neutral-700">暂无{mode === "qps" ? "QPS" : "并发"}测试</p> : <>
        <div id={`${id}-charts`} hidden={view !== "charts"}>
          <div className="grid grid-cols-1 gap-3.5 min-[1150px]:grid-cols-2">
            {REPORT_CHARTS.map(metric => <ReportChart key={`${mode}-${metric.key}`} metric={metric} mode={mode} cells={cells} onShowData={() => showData(metric)} />)}
          </div>
        </div>
        <div ref={tables} id={`${id}-tables`} hidden={view !== "tables"}><WorkloadReportTables mode={mode} cells={cells} /></div>
      </>}
    </div>
  </section>;
}
