import type { ReactNode } from "react";

import type { CellMode } from "../lib/api";

export const PANEL_TITLES: Record<CellMode, string> = {
  concurrency: "并发测试",
  qps: "QPS 测试",
};

export const ADD_PANEL_TITLES: Record<CellMode, string> = {
  concurrency: "添加并发测试",
  qps: "添加 QPS 测试",
};

export function WorkloadModePanel({ mode, count, action, onAdd, children }: {
  mode: CellMode;
  count: number;
  action?: ReactNode;
  onAdd: () => void;
  children: ReactNode;
}) {
  return <section aria-label={PANEL_TITLES[mode]} className="card-mode-panel flex min-w-0 flex-col gap-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        {PANEL_TITLES[mode]}
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs tabular-nums text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">{count}</span>
      </h3>
      {action}
    </div>
    {children}
    <button
      type="button"
      aria-label={ADD_PANEL_TITLES[mode]}
      onClick={onAdd}
      className={`w-full rounded-lg border border-dashed border-neutral-300 px-2 text-center text-xs font-medium text-neutral-500 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-neutral-700 dark:hover:border-blue-700 dark:hover:bg-blue-950/30 dark:hover:text-blue-300 ${count === 0 ? "py-5" : "py-1.5"}`}
    >
      {count === 0 ? <span className="mb-1 block font-normal text-neutral-400">暂无测试项</span> : null}
      ＋ {ADD_PANEL_TITLES[mode]}
    </button>
  </section>;
}
