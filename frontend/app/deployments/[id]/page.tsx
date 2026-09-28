"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import Link from "../../components/Link";
import {
  CellStatusDot,
  MODE_LABELS,
  format,
  relativeTime,
  workloadShape,
} from "../../components/cell";
import { CellReport } from "../../components/cell-report";
import { CellLadderForm } from "../../components/cell-ladder-form";
import { WorkloadCardFrame } from "../../components/workload-card-frame";
import { AddWorkloadForm } from "../../components/add-workload-form";
import { ADD_PANEL_TITLES, WorkloadModePanel } from "../../components/workload-mode-panel";
import { WorkloadReport } from "../../components/workload-report";
import { Breadcrumb, Button, Empty, ErrorBanner, Field, IconButton, Modal, SelectInput, TextInput } from "../../components/ui";
import { EllipsisIcon, PlayIcon, ReportIcon, RotateCcwIcon, StopIcon, TrashIcon } from "../../components/icons";
import {
  api,
  describe,
  type Cell,
  type CellMode,
  type BenchSuite,
  type Deployment,
  type Model,
  type Workload,
} from "../../lib/api";

const POLL_INTERVAL_MS = 1500;

export default function DeploymentPage() {
  const params = useParams<{ id: string }>();
  const deploymentId = Number(params.id);

  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [attached, setAttached] = useState<Workload[] | null>(null);
  const [cells, setCells] = useState<Cell[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** null = closed. Cells are only ever configured against an added workload. */
  const [cellForm, setCellForm] = useState<{
    workloadId: number;
    mode?: CellMode;
    initial?: { mode: CellMode; levels: string; requests: string };
  } | null>(null);
  const [addingWorkload, setAddingWorkload] = useState(false);
  const [importingSuite, setImportingSuite] = useState(false);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  const refresh = useCallback(async () => {
    if (!Number.isFinite(deploymentId)) return;
    try {
      const loadedDeployment = await api.getDeployment(deploymentId);
      const [loadedModel, loadedCells, loadedAttached] = await Promise.all([
        api.getModel(loadedDeployment.model_id),
        api.listCells(deploymentId),
        api.listDeploymentWorkloads(deploymentId),
      ]);
      setDeployment(loadedDeployment);
      setModel(loadedModel);
      setCells(loadedCells);
      setAttached(loadedAttached);
      setError(null);
    } catch (caught) {
      setError(describe(caught));
    }
  }, [deploymentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // While anything is in flight, poll: the queue runs one Cell at a time and
  // the page should show it moving without a manual refresh.
  useEffect(() => {
    if (!cells?.some((cell) => cell.status === "queued" || cell.status === "running")) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [cells, refresh]);

  const groups = useMemo(() => mergeGroups(cells ?? [], attached ?? []), [cells, attached]);

  async function act(action: () => Promise<unknown>, toastMessage?: string) {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(describe(caught));
    }
    await refresh();
    if (toastMessage) setToast(toastMessage);
  }

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb
        items={[
          { label: "模型", href: "/" },
          { label: model?.name ?? "…", href: model ? `/models/${model.id}` : "/" },
          { label: deployment?.name ?? "…" },
        ]}
      />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{deployment?.name ?? "…"}</h1>
          {deployment ? (
            <p className="mt-1 font-mono text-sm text-neutral-500 dark:text-neutral-400">
              {deployment.router_url} · {deployment.model_name}
            </p>
          ) : null}
        </div>
        <Button disabled={!deployment} onClick={() => setImportingSuite(true)}>导入压测组合</Button>
      </div>

      <ErrorBanner message={error} />

      {cells !== null && cells.length > 0 ? <RunSummary cells={cells} /> : null}

      {cells === null ? (
        <Empty>加载中…</Empty>
      ) : (
        <ul className="workload-grid">
          {groups.map((group) => (
            <WorkloadCard
              key={group.workloadId}
              group={group}
              onNewCell={(mode) => setCellForm({ workloadId: group.workloadId, mode })}
              onDetach={async () => {
                try {
                  for (const cell of group.cells) {
                    if (cell.status === "queued" || cell.status === "running") {
                      try {
                        await api.cancelCell(cell.id);
                      } catch {
                        // The run may have finished between refresh and confirmation.
                      }
                    }
                    await api.deleteCell(cell.id);
                  }
                  await api.detachWorkload(deploymentId, group.workloadId);
                } finally {
                  await refresh();
                }
                setToast("已从当前部署删除负载及其测试项");
              }}
              onAction={act}
              onDuplicate={(cell) =>
                setCellForm({
                  workloadId: cell.workload_id,
                  initial: {
                    mode: cell.mode,
                    levels: String(cell.level),
                    requests: String(cell.num_requests),
                  },
                })
              }
            />
          ))}
          <li className="workload-add-item">
            <button
              type="button"
              onClick={() => setAddingWorkload(true)}
              disabled={attached === null}
              className="workload-add-button flex w-full flex-col items-center justify-center gap-2 rounded-[18px] border-2 border-dashed border-neutral-300 px-4 text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600 disabled:opacity-50 dark:border-neutral-700 dark:hover:border-neutral-500 dark:hover:text-neutral-300"
            >
              <span aria-hidden className="text-2xl leading-none">＋</span>
              <span className="text-sm font-medium">添加负载</span>
              {groups.length === 0 ? (
                <span className="text-xs">还没有配置压测，点这里开始</span>
              ) : null}
            </button>
          </li>
        </ul>
      )}

      {addingWorkload && attached !== null ? (
        <Modal title="添加负载" onClose={() => setAddingWorkload(false)}>
          <AddWorkloadForm
            addedIds={new Set(attached.map((workload) => workload.id))}
            onAdded={async (workload) => {
              await api.attachWorkload(deploymentId, workload.id);
              setAddingWorkload(false);
              await refresh();
            }}
            onClose={() => setAddingWorkload(false)}
          />
        </Modal>
      ) : null}

      {importingSuite ? (
        <Modal title="导入压测组合" className="max-w-lg" onClose={() => setImportingSuite(false)}>
          <ImportSuiteForm deploymentId={deploymentId} onClose={() => setImportingSuite(false)} onImported={async (created, skipped) => {
            setImportingSuite(false);
            setToast(`已导入 ${created} 个测试项${skipped ? `，跳过 ${skipped} 个已有项` : ""}`);
            await refresh();
          }} />
        </Modal>
      ) : null}

      {cellForm !== null && cells !== null ? (
        <Modal
          title={cellForm.mode ? ADD_PANEL_TITLES[cellForm.mode] : "添加测试"}
          className="max-w-md"
          onClose={() => setCellForm(null)}
        >
          <CellLadderForm
            workloadId={cellForm.workloadId}
            fixedMode={cellForm.mode}
            initial={cellForm.initial}
            existingLevels={{
              concurrency: cells
                .filter(
                  (cell) => cell.workload_id === cellForm.workloadId && cell.mode === "concurrency",
                )
                .map((cell) => cell.level),
              qps: cells
                .filter((cell) => cell.workload_id === cellForm.workloadId && cell.mode === "qps")
                .map((cell) => cell.level),
            }}
            onCreate={async (payload) => (await api.createCells(deploymentId, payload)).length}
            onEstimate={(payload) => api.estimateCells(deploymentId, payload)}
            onCreated={async (created) => {
              setCellForm(null);
              setToast(`已添加 ${created} 个测试`);
              await refresh();
            }}
          />
        </Modal>
      ) : null}

      {toast ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-neutral-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function ImportSuiteForm({ deploymentId, onClose, onImported }: {
  deploymentId: number;
  onClose: () => void;
  onImported: (created: number, skipped: number) => Promise<void>;
}) {
  const [suites, setSuites] = useState<BenchSuite[] | null>(null);
  const [workloads, setWorkloads] = useState<Workload[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.listSuites(), api.listWorkloads()]).then(([loadedSuites, loadedWorkloads]) => {
      setSuites(loadedSuites);
      setWorkloads(loadedWorkloads);
      setSelectedId(loadedSuites[0]?.id ?? null);
    }).catch((caught) => setError(describe(caught)));
  }, []);

  const selected = suites?.find((suite) => suite.id === selectedId);

  async function importSelected() {
    if (selectedId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.importSuite(deploymentId, selectedId);
      await onImported(result.created_cells, result.skipped_cells);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-col gap-4">
    <ErrorBanner message={error} />
    {suites === null ? <p className="text-sm text-slate-500">加载中…</p> : suites.length === 0 ? (
      <p className="text-sm text-slate-500">还没有压测组合。前往 <Link href="/suites" className="font-medium text-blue-600 hover:underline">配置管理</Link> 创建。</p>
    ) : <>
      <Field label="选择组合">
        <SelectInput ariaLabel="选择组合" value={selectedId === null ? "" : String(selectedId)} onValueChange={(value) => setSelectedId(Number(value))} options={suites.map((suite) => ({ value: String(suite.id), label: suite.name }))} />
      </Field>
      {selected ? <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
        <p className="font-medium">{selected.cells.length} 个测试项 · {new Set(selected.cells.map((cell) => cell.workload_id)).size} 个负载</p>
        {selected.note ? <p className="mt-1 text-slate-500">{selected.note}</p> : null}
        <div className="mt-3 max-h-40 space-y-1 overflow-y-auto border-t border-slate-200 pt-3 text-xs">
          {Array.from(new Set(selected.cells.map((cell) => cell.workload_id))).map((workloadId) => {
            const name = workloads.find((workload) => workload.id === workloadId)?.name ?? `负载 #${workloadId}`;
            const cells = selected.cells.filter((cell) => cell.workload_id === workloadId);
            return <p key={workloadId} className="flex justify-between gap-2"><span className="font-medium">{name}</span><span className="text-slate-500">{cells.map((cell) => `${cell.mode === "qps" ? "QPS" : "并发"} ${cell.level}`).join(" · ")}</span></p>;
          })}
        </div>
        <p className="mt-2 text-xs text-slate-500">已有相同负载、模式和档位的测试项会跳过，原配置与结果保持不变。</p>
      </div> : null}
    </>}
    <div className="flex justify-end gap-2">
      <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
      <Button disabled={busy || selectedId === null} onClick={() => void importSelected()}>导入组合</Button>
    </div>
  </div>;
}

/**
 * The page-level run summary: one line above the cards. The blue dot carries
 * a soft glow so "something is in flight" reads at a glance.
 */
function RunSummary({ cells }: { cells: Cell[] }) {
  const running = cells.filter((cell) => cell.status === "running").length;
  const pending = cells.filter((cell) => cell.status === "idle").length;
  return (
    <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${
          running > 0 ? "bg-blue-500 shadow-[0_0_8px_2px_rgba(59,130,246,0.5)]" : "bg-neutral-300 dark:bg-neutral-600"
        }`}
      />
      <span className="tabular-nums">{running} 项运行中</span>
      <span aria-hidden className="text-neutral-300 dark:text-neutral-600">
        ·
      </span>
      <span className="tabular-nums">{pending} 项待运行</span>
    </div>
  );
}

type WorkloadGroup = {
  workloadId: number;
  workloadName: string;
  shapeText: string;
  /** When the Workload was added to *this* Deployment — cards sort oldest
      first, newest last (bottom right of the grid). */
  addedAt: string;
  cells: Cell[];
};

/**
 * Cards come from two sources: Workloads added to the Deployment (possibly
 * with no Cells yet) and the Cells themselves. The union is what renders.
 */
function mergeGroups(cells: Cell[], attached: Workload[]): WorkloadGroup[] {
  const groups = new Map<number, WorkloadGroup>();
  for (const workload of attached) {
    groups.set(workload.id, {
      workloadId: workload.id,
      workloadName: workload.name,
      shapeText: workloadShape(workload),
      addedAt: workload.added_at ?? workload.created_at,
      cells: [],
    });
  }
  for (const cell of cells) {
    let group = groups.get(cell.workload_id);
    if (!group) {
      group = {
        workloadId: cell.workload_id,
        workloadName: cell.workload_name ?? `workload ${cell.workload_id}`,
        shapeText: cell.workload_kind
          ? workloadShape({
              kind: cell.workload_kind,
              input_tokens: cell.workload_input_tokens ?? null,
              output_tokens: cell.workload_output_tokens ?? null,
              dataset: cell.workload_dataset ?? null,
            })
          : "",
        // Cell rows don't carry the attachment's added_at; a cell-derived
        // group without an attachment sorts as oldest.
        addedAt: "",
        cells: [],
      };
      groups.set(cell.workload_id, group);
    }
    group.cells.push(cell);
  }
  const out = Array.from(groups.values());
  out.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.workloadId - b.workloadId);
  for (const group of out) {
    group.cells.sort((a, b) => a.mode.localeCompare(b.mode) || a.level - b.level);
  }
  return out;
}

/**
 * One Workload as a responsive card: header (name, shape, actions), then
 * side-by-side concurrency and QPS panels. Empty modes keep their panel and
 * show a placeholder so the layout stays predictable while configuring.
 */
function WorkloadCard({
  group,
  onNewCell,
  onDetach,
  onAction,
  onDuplicate,
}: {
  group: WorkloadGroup;
  onNewCell: (mode: CellMode) => void;
  onDetach: () => Promise<void>;
  onAction: (action: () => Promise<unknown>, toast?: string) => Promise<void>;
  onDuplicate: (cell: Cell) => void;
}) {
  const [showReport, setShowReport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const panels = (["concurrency", "qps"] as const).map((mode) => ({
    mode,
    cells: group.cells.filter((cell) => cell.mode === mode),
  }));

  return (
    <WorkloadCardFrame>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2
            title={group.workloadName}
            className="truncate text-lg font-semibold tracking-tight"
          >
            {group.workloadName}
          </h2>
          <p className="text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
            {group.shapeText}
          </p>
        </div>
        <div role="toolbar" aria-label="负载操作" className="flex shrink-0 items-center gap-1">
          <IconButton label="查看报告" tone="blue" onClick={() => setShowReport(true)}>
            <ReportIcon />
          </IconButton>
          <IconButton label="删除" tone="red" onClick={() => setConfirmDelete(true)}>
            <TrashIcon />
          </IconButton>
        </div>
      </div>

      <div className="card-panels">
        {panels.map((panel) => (
          <ModePanel
            key={panel.mode}
            mode={panel.mode}
            cells={panel.cells}
            onAdd={() => onNewCell(panel.mode)}
            onAction={onAction}
            onDuplicate={onDuplicate}
          />
        ))}
      </div>
      {showReport ? (
        <Modal
          title={`${group.workloadName} · 压测报告`}
          onClose={() => setShowReport(false)}
          className="flex h-[88vh] max-h-[95vh] max-w-[1240px] flex-col"
        >
          <WorkloadReport cells={group.cells} name={group.workloadName} shape={group.shapeText} />
        </Modal>
      ) : null}
      {confirmDelete ? (
        <Modal
          title={`删除 ${group.workloadName}`}
          onClose={() => { if (!deleting) setConfirmDelete(false); }}
          className="max-w-md"
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              {group.cells.length > 0
                ? `将从当前部署删除此负载及其 ${group.cells.length} 个测试项和测量结果，不可恢复。运行中的测试会先停止。`
                : "将从当前部署删除此负载，不可恢复。"}
            </p>
            <ErrorBanner message={deleteError} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={deleting} onClick={() => setConfirmDelete(false)}>取消</Button>
              <Button
                variant="danger"
                disabled={deleting}
                onClick={() => {
                  setDeleting(true);
                  setDeleteError(null);
                  void onDetach()
                    .then(() => setConfirmDelete(false))
                    .catch((caught) => setDeleteError(describe(caught)))
                    .finally(() => setDeleting(false));
                }}
              >
                确认删除
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </WorkloadCardFrame>
  );
}

/** One mode panel: shared card shell with live Cell actions. */
function ModePanel({
  mode, cells, onAdd, onAction, onDuplicate,
}: {
  mode: CellMode;
  cells: Cell[];
  onAdd: () => void;
  onAction: (action: () => Promise<unknown>, toast?: string) => Promise<void>;
  onDuplicate: (cell: Cell) => void;
}) {
  const runnable = cells.filter((cell) => cell.status !== "queued" && cell.status !== "running");
  return <WorkloadModePanel
    mode={mode}
    count={cells.length}
    onAdd={onAdd}
    action={<button
      type="button"
      className="flex items-center gap-1 rounded-md bg-green-600 px-2 py-1 text-xs font-medium text-white shadow-sm transition-colors hover:bg-green-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-green-600 dark:hover:bg-green-500"
      disabled={runnable.length === 0}
      onClick={() => void onAction(() => api.runCells(runnable.map((cell) => cell.id)), `已将 ${runnable.length} 项加入队列`)}
    ><PlayIcon />Run All</button>}
  >
    {cells.length > 0 ? <ul className="flex flex-col gap-0.5">
      {cells.map((cell) => <CellRow key={cell.id} cell={cell} onAction={onAction} onDuplicate={onDuplicate} />)}
    </ul> : null}
  </WorkloadModePanel>;
}

const ROW_GRID = "cell-row-grid";

function CellRow({
  cell,
  onAction,
  onDuplicate,
}: {
  cell: Cell;
  onAction: (action: () => Promise<unknown>, toast?: string) => Promise<void>;
  onDuplicate: (cell: Cell) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [confirmCellDelete, setConfirmCellDelete] = useState(false);
  const inFlight = cell.status === "queued" || cell.status === "running";
  const progress = cell.progress;
  const percent =
    cell.status === "running" && progress?.total_requests
      ? Math.min(
          100,
          Math.round(((progress.completed_requests ?? 0) / progress.total_requests) * 100),
        )
      : null;
  const progressDescription =
    percent !== null
      ? `${progress?.phase ? `${progress.phase} · ` : ""}${progress?.completed_requests ?? 0}/${progress?.total_requests} 请求`
      : undefined;

  return (
    <li>
      <div
        className={`${ROW_GRID} relative rounded-lg px-2 py-1.5 transition-colors ${
          cell.status === "running"
            ? "bg-blue-50 dark:bg-blue-950/40"
            : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
        }`}
      >
        <button
          type="button"
          className="cell-row-content col-span-3 text-left"
          onClick={() => {
            if (cell.status === "completed") setShowResults(true);
          }}
          {...(cell.status === "completed" ? { "aria-haspopup": "dialog" as const } : {})}
        >
          <span className="cell-row-level text-sm font-medium tabular-nums text-neutral-800 dark:text-neutral-200">
            {cell.level}
          </span>
          <span className="cell-row-requests whitespace-nowrap text-[9px] tabular-nums text-neutral-400">
            {cell.num_requests} 请求
          </span>
          <span className="cell-row-status">
            <CellStatusDot status={cell.status} phase={progress?.phase} />
            <span
              className={`cell-row-progress-label text-[9px] tabular-nums ${
                percent !== null
                  ? "text-blue-600 dark:text-blue-300"
                  : "text-amber-700 dark:text-amber-400"
              }`}
              title={progressDescription ?? (cell.stale ? "结果来自旧配置" : undefined)}
              aria-hidden={percent === null && !cell.stale}
            >
              {percent !== null ? `${percent}%` : cell.stale ? "旧" : null}
            </span>
          </span>
        </button>
        <div className="cell-row-actions cell-run-actions">
          {inFlight ? (
            <IconButton
              label="停止"
              onClick={() => void onAction(() => api.cancelCell(cell.id), "已取消该测试项")}
            >
              <StopIcon />
            </IconButton>
          ) : (
            <>
              <IconButton
                label={cell.status === "completed" ? "重跑" : "运行"}
                onClick={() => void onAction(() => api.runCell(cell.id), "已加入队列")}
              >
                {cell.status === "completed" ? <RotateCcwIcon /> : <PlayIcon />}
              </IconButton>
              <CellRowMenu
                onShowResults={
                  cell.status === "completed" ? () => setShowResults(true) : undefined
                }
                onEdit={() => setEditing(true)}
                onDuplicate={() => onDuplicate(cell)}
                onDelete={() => setConfirmCellDelete(true)}
              />
            </>
          )}
        </div>
        {percent !== null ? (
          <span
            className="cell-row-progress-track absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950"
            role="progressbar"
            aria-label={`运行进度 ${percent}%`}
            aria-valuetext={progressDescription}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className="block h-full rounded-full bg-blue-500 transition-all"
              style={{ width: `${percent}%` }}
            />
          </span>
        ) : null}
      </div>

      {editing ? (
        <Modal
          title={`编辑参数 · ${MODE_LABELS[cell.mode]} ${cell.level}`}
          onClose={() => setEditing(false)}
          className="max-w-md"
        >
          <div className="flex flex-col gap-4">
            {cell.error ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                {cell.error}
              </p>
            ) : null}
            {cell.last_run_at ? (
              <p className="text-xs text-neutral-400">测于 {relativeTime(cell.last_run_at)}</p>
            ) : null}
            {!inFlight ? <NumRequestsEditor cell={cell} onAction={onAction} /> : null}
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => setEditing(false)}>
                关闭
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {showResults ? (
        <Modal
          title={`${MODE_LABELS[cell.mode]} ${cell.level} · 压测结果`}
          onClose={() => setShowResults(false)}
          className="max-w-[800px]"
        >
          <CellReport cell={cell} />
        </Modal>
      ) : null}
      {confirmCellDelete ? (
        <Modal
          title={`删除${MODE_LABELS[cell.mode]} ${cell.level} 测试`}
          onClose={() => setConfirmCellDelete(false)}
          className="max-w-md"
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              删除后，此测试项及其测量结果不可恢复。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmCellDelete(false)}>取消</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmCellDelete(false);
                  void onAction(() => api.deleteCell(cell.id), "已删除该测试项");
                }}
              >
                确认删除
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </li>
  );
}

/** The ⋯ menu: low-frequency actions off the row's icon strip. */
function CellRowMenu({
  onShowResults,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  onShowResults?: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const item =
    "block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800";
  return (
    <div className="relative">
      <IconButton label="更多操作" onClick={() => setOpen(!open)}>
        <EllipsisIcon />
      </IconButton>
      {open ? (
        <>
          <div aria-hidden className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute right-0 z-20 mt-1 w-32 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          >
            {onShowResults ? (
              <button
                type="button"
                role="menuitem"
                className={item}
                onClick={() => {
                  setOpen(false);
                  onShowResults();
                }}
              >
                查看结果
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
            >
              编辑参数
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onDuplicate();
              }}
            >
              复制
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${item} text-red-600 dark:text-red-400`}
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
            >
              删除
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
/**
 * The one adjustable parameter. Mode and level are identity — they sit in the
 * uniqueness key, so changing them is delete-and-recreate, not an edit.
 */
function NumRequestsEditor({
  cell,
  onAction,
}: {
  cell: Cell;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [value, setValue] = useState(String(cell.num_requests));

  useEffect(() => {
    setValue(String(cell.num_requests));
  }, [cell.num_requests]);

  const parsed = Number(value);
  const changed = Number.isFinite(parsed) && parsed > 0 && parsed !== cell.num_requests;

  return (
    <div className="flex items-end gap-2">
      <Field label="每档请求数" hint="改动后需重跑；旧结果会标记为来自旧配置。">
        <TextInput
          aria-label="新的每档请求数"
          type="number"
          min={1}
          className="w-32"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <Button
        variant="ghost"
        disabled={!changed}
        onClick={() => void onAction(() => api.updateCell(cell.id, { num_requests: parsed }))}
      >
        保存
      </Button>
    </div>
  );
}
