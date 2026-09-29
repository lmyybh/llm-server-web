"use client";

import { useId, useRef, useState } from "react";
import type { Cell, CellMode } from "../lib/api";
import { WorkloadReportCard } from "./workload-report-card";

/** Dialog shell: mode selection and scrolling only; all report content lives in the shared card. */
export function WorkloadReport({ cells, name, shape }: { cells: Cell[]; name: string; shape: string }) {
  const [mode, setMode] = useState<CellMode>("concurrency");
  const id = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabs = useRef<Partial<Record<CellMode, HTMLButtonElement | null>>>({});
  function selectMode(next: CellMode) {
    setMode(next);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }
  function navigate(element: HTMLElement) {
    const root = scrollRef.current;
    if (root) root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - 12;
  }
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div role="tablist" aria-label="报告分区" className="mb-4 inline-flex shrink-0 self-start gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1 text-xs font-semibold dark:border-neutral-700 dark:bg-neutral-800">
      {(["concurrency", "qps"] as const).map(value => <button
        key={value}
        ref={element => { tabs.current[value] = element; }}
        type="button"
        id={`${id}-tab-${value}`}
        role="tab"
        aria-controls={`${id}-panel`}
        aria-selected={mode === value}
        tabIndex={mode === value ? 0 : -1}
        onClick={() => selectMode(value)}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "concurrency" : event.key === "End" ? "qps" : value === "concurrency" ? "qps" : "concurrency";
          selectMode(next);
          tabs.current[next]?.focus();
        }}
        className={`rounded-lg px-4 py-2 transition-colors ${mode === value ? "bg-white text-slate-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100" : "text-slate-500 hover:text-slate-700 dark:text-neutral-400 dark:hover:text-neutral-200"}`}
      >{value === "qps" ? "QPS 测试" : "并发测试"}</button>)}
    </div>
    <div ref={scrollRef} id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${mode}`} className="report-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
      <WorkloadReportCard id={`${id}-card`} name={name} shape={shape} cells={cells} mode={mode} navigate={navigate} />
    </div>
  </div>;
}
