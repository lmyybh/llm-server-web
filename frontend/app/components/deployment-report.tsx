"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Cell, CellMode, Deployment, Model, Workload } from "../lib/api";
import { reportCell } from "../lib/report-metrics";
import { deploymentReportCsv } from "../lib/report-csv";
import Link from "./Link";
import { SidebarNav } from "./sidebar-nav";
import { mergeGroups } from "./workload-groups";
import { WorkloadReportCard } from "./workload-report-card";

export function DeploymentReport({ deployment, model, workloads, cells }: { deployment: Deployment; model: Model; workloads: Workload[]; cells: Cell[] }) {
  const [mode, setMode] = useState<CellMode>("concurrency");
  const groups = useMemo(() => mergeGroups(cells.map(reportCell), workloads), [cells, workloads]);
  const [active, setActive] = useState<number | null>(groups[0]?.workloadId ?? null);
  const selected = groups.some(g => g.workloadId === active) ? active : groups[0]?.workloadId;
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pendingPosition = useRef<{ id: number; offset: number } | null>(null);
  function navigate(element: HTMLElement) {
    const root = viewport.current;
    if (root) root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - 12;
  }
  function selectMode(next: CellMode) {
    if (mode === next) return;
    const section = content.current?.querySelector<HTMLElement>(`#deployment-workload-${selected}`);
    if (section && viewport.current && selected != null) pendingPosition.current = { id: selected, offset: section.getBoundingClientRect().top - viewport.current.getBoundingClientRect().top };
    setMode(next);
  }
  useLayoutEffect(() => {
    const position = pendingPosition.current;
    const root = viewport.current;
    if (!position || !root) return;
    const element = content.current?.querySelector<HTMLElement>(`#deployment-workload-${position.id}`);
    if (element) root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - position.offset;
    pendingPosition.current = null;
  }, [mode]);
  function exportCsv() {
    const url = URL.createObjectURL(new Blob([deploymentReportCsv(deployment, cells)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `${deployment.name.replace(/[\\/:*?"<>|]/g, "-")}-report.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="deployment-report mx-auto flex h-[calc(100dvh-145px)] min-h-[420px] w-full max-w-[1440px] flex-col">
    <div className="mb-5 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-5 dark:border-neutral-700">
      <div><h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><Link href={`/deployments/${deployment.id}`} className="report-no-print mr-1 text-3xl leading-none text-slate-400" aria-label="返回部署">‹</Link>{deployment.name} · 压测报告<span tabIndex={0} title="报告范围：各 Cell 最新执行快照" aria-label="报告范围：各 Cell 最新执行快照" className="text-xs font-normal text-slate-400">ⓘ</span></h1><p className="mt-2 text-xs text-slate-500 dark:text-neutral-400">{model.name}</p></div>
      <div className="report-no-print flex items-center gap-2"><button type="button" onClick={() => window.print()} className="rounded-lg px-3 py-2 text-xs text-slate-500" title="打印当前模式和视图">打印</button><button type="button" onClick={exportCsv} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700" title="导出全部 Workload、全部模式">导出 CSV</button></div>
    </div>
    <div className="deployment-report-body flex min-h-0 flex-1 gap-4 lg:gap-5">
      <aside className="report-no-print flex w-48 shrink-0 flex-col max-[720px]:w-12">
        <div role="tablist" aria-label="压测模式" className="mb-5 flex shrink-0 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 max-[720px]:flex-col dark:border-neutral-700 dark:bg-neutral-800">
          {(["concurrency", "qps"] as const).map(m => <button type="button" key={m} id={`deployment-report-tab-${m}`} role="tab" aria-selected={mode === m} aria-controls="deployment-report-panel" tabIndex={mode === m ? 0 : -1} onClick={() => selectMode(m)}
            onKeyDown={e => { if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return; e.preventDefault(); const next = e.key === "Home" ? "concurrency" : e.key === "End" ? "qps" : mode === "qps" ? "concurrency" : "qps"; selectMode(next); document.getElementById(`deployment-report-tab-${next}`)?.focus(); }}
            className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold ${mode === m ? `bg-white shadow-sm dark:bg-neutral-900 ${m === "qps" ? "text-[#75658D] dark:text-[#C6B8DD]" : "text-blue-700 dark:text-blue-300"}` : "text-slate-500"}`}>{m === "qps" ? "QPS" : "并发"}</button>)}
        </div>
        <div className="report-scrollbar min-h-0 overflow-y-auto px-1 pb-2">
          <SidebarNav sections={[{ label: `Workload · ${groups.length}`, items: groups.map((g, i) => ({ href: `#deployment-workload-${g.workloadId}`, label: g.workloadName, icon: String(i + 1).padStart(2, "0"), active: selected === g.workloadId })) }]} renderLink={props => <a {...props} aria-current={props["aria-current"] ? "location" : undefined} onClick={e => { e.preventDefault(); const id = Number(props.href.split("-").at(-1)); setActive(id); const section = content.current?.querySelector<HTMLElement>(props.href); if (section) navigate(section); }} />} />
        </div>
      </aside>
      <div ref={viewport} id="deployment-report-panel" role="tabpanel" aria-labelledby={`deployment-report-tab-${mode}`} className="deployment-report-scroll report-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pr-1" onScroll={() => {
        const root = viewport.current; if (!root) return;
        const sections = Array.from(root.querySelectorAll<HTMLElement>(".deployment-report-section"));
        // The final section may never reach the top when it is shorter than the viewport.
        // Allow one pixel for fractional scroll offsets, but keep non-scrollable reports on the first item.
        const atBottom = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 1;
        const current = atBottom ? sections.at(-1) : sections.filter(s => s.getBoundingClientRect().top <= root.getBoundingClientRect().top + 32).at(-1) ?? sections[0];
        if (current) setActive(Number(current.id.split("-").at(-1)));
      }}>
        <div ref={content}>
          {groups.length ? groups.map(group => <WorkloadReportCard key={group.workloadId} id={`deployment-workload-${group.workloadId}`} name={group.workloadName} shape={group.shapeText} cells={group.cells} mode={mode} navigate={navigate} />) : <p className="py-16 text-center text-sm text-slate-400">此部署尚未添加 Workload</p>}
        </div>
      </div>
    </div>
  </div>;
}
