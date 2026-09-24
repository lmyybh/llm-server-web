"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CellStatusDot,
  MODE_LABELS,
  format,
  relativeTime,
  workloadShape,
} from "../../components/cell";
import { CellReport } from "../../components/cell-report";
import { WorkloadReport } from "../../components/workload-report";
import { Breadcrumb, Button, Empty, ErrorBanner, Field, IconButton, Modal, TextInput } from "../../components/ui";
import { EllipsisIcon, PlayIcon, ReportIcon, RotateCcwIcon, StopIcon, TrashIcon } from "../../components/icons";
import { WorkloadForm } from "../../components/workload-form";
import { parseLevels } from "../../lib/levels";
import {
  api,
  describe,
  type Cell,
  type CellMode,
  type Deployment,
  type Estimate,
  type Model,
  type Workload,
  type WorkloadInput,
} from "../../lib/api";

const DEFAULT_REQUESTS = "64";
const ESTIMATE_DEBOUNCE_MS = 400;
const POLL_INTERVAL_MS = 1500;

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} 秒`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

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

      <div>
        <h1 className="text-lg font-semibold">{deployment?.name ?? "…"}</h1>
        {deployment ? (
          <p className="mt-1 font-mono text-sm text-neutral-500 dark:text-neutral-400">
            {deployment.router_url} · {deployment.model_name}
          </p>
        ) : null}
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
            deploymentId={deploymentId}
            addedIds={new Set(attached.map((workload) => workload.id))}
            onAttached={async () => {
              setAddingWorkload(false);
              await refresh();
            }}
            onClose={() => setAddingWorkload(false)}
          />
        </Modal>
      ) : null}

      {cellForm !== null && cells !== null ? (
        <Modal
          title={cellForm.mode ? ADD_PANEL_TITLES[cellForm.mode] : "添加测试"}
          className="max-w-md"
          onClose={() => setCellForm(null)}
        >
          <CellLadderForm
            deploymentId={deploymentId}
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
 * Adding a Workload to a Deployment is just picking it from the library — the
 * bench configuration (mode, levels, request count) belongs to the Cell and
 * happens per card afterwards. A shape the library does not have yet can be
 * created inline, without leaving the dialog.
 */
function AddWorkloadForm({
  deploymentId,
  addedIds,
  onAttached,
  onClose,
}: {
  deploymentId: number;
  addedIds: Set<number>;
  onAttached: () => Promise<void>;
  onClose: () => void;
}) {
  const [library, setLibrary] = useState<Workload[] | null>(null);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .listWorkloads()
      .then(setLibrary)
      .catch((caught) => setError(describe(caught)));
  }, []);

  const available = (library ?? []).filter((workload) => !addedIds.has(workload.id));

  useEffect(() => {
    if (pickedId === null && available.length > 0) {
      setPickedId(available[0].id);
    }
  }, [available, pickedId]);

  async function attach() {
    if (pickedId === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.attachWorkload(deploymentId, pickedId);
      await onAttached();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createAndAttach(payload: WorkloadInput) {
    const created = await api.createWorkload(payload);
    await api.attachWorkload(deploymentId, created.id);
    await onAttached();
  }

  if (library === null) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">加载中…</p>;
  }

  if (creating || available.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {available.length > 0 ? (
          <button
            type="button"
            className="self-start text-sm text-neutral-500 underline dark:text-neutral-400"
            onClick={() => setCreating(false)}
          >
            从负载库选择
          </button>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            负载库里还没有任何负载，先新建一个。
          </p>
        )}
        <WorkloadForm
          submitLabel="创建并添加"
          onSubmit={createAndAttach}
          onCancel={available.length > 0 ? () => setCreating(false) : onClose}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ErrorBanner message={error} />
      <Field label="负载" hint="添加后，在并发测试或 QPS 测试面板中配置。">
        <select
          aria-label="负载"
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          value={pickedId ?? ""}
          onChange={(event) => setPickedId(Number(event.target.value))}
        >
          {available.map((workload) => (
            <option key={workload.id} value={workload.id}>
              {workload.name}（{workloadShape(workload)}）
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="text-sm text-neutral-500 underline dark:text-neutral-400"
          onClick={() => setCreating(true)}
        >
          库里没有？新建一个
        </button>
        <Button onClick={() => void attach()} disabled={pickedId === null || busy}>
          添加
        </Button>
      </div>
    </div>
  );
}

/**
 * The ladder form inside the create dialog: one mode (picked by radio), a
 * comma-separated ladder of levels, and request counts. A single count
 * broadcasts across the ladder; several counts must pair with the levels
 * one-to-one.
 */
function CellLadderForm({
  deploymentId,
  workloadId,
  existingLevels,
  fixedMode,
  initial,
  onCreated,
}: {
  deploymentId: number;
  workloadId: number;
  /** Levels this (workload, mode) already has — excluded from the batch. */
  existingLevels: Record<CellMode, number[]>;
  /** A panel's add action creates Cells only in that panel's mode. */
  fixedMode?: CellMode;
  /** 「复制」预填的来源测试项配置。 */
  initial?: { mode: CellMode; levels: string; requests: string };
  onCreated: (created: number) => Promise<void>;
}) {
  const [mode, setMode] = useState<CellMode>(fixedMode ?? initial?.mode ?? "concurrency");
  const [levelsText, setLevelsText] = useState(initial?.levels ?? "");
  const [requestsText, setRequestsText] = useState(initial?.requests ?? DEFAULT_REQUESTS);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsedLevels = useMemo(() => parseLevels(levelsText), [levelsText]);
  const parsedRequests = useMemo(() => parseLevels(requestsText), [requestsText]);

  // Concurrency is a count of permits; fractional levels or counts are
  // rejected here and by the server, never silently truncated.
  const fractionalLevels = parsedLevels.levels.filter((level) => !Number.isInteger(level));
  const fractionalCounts = parsedRequests.levels.filter((count) => !Number.isInteger(count));
  const usableLevels =
    mode === "concurrency"
      ? parsedLevels.levels.filter((level) => Number.isInteger(level))
      : parsedLevels.levels;
  const counts = parsedRequests.levels.filter((count) => Number.isInteger(count));

  const levelProblems = [
    ...parsedLevels.invalid.map((token) => `无法识别的档位：${token}`),
    ...(mode === "concurrency"
      ? fractionalLevels.map((level) => `并发档位必须是整数：${level}`)
      : []),
  ];
  const requestProblems = [
    ...parsedRequests.invalid.map((token) => `无法识别的数量：${token}`),
    ...fractionalCounts.map((count) => `请求数量必须是整数：${count}`),
  ];
  if (counts.length > 1 && counts.length !== usableLevels.length) {
    requestProblems.push(
      `请求数量与档位数量不一致：${counts.length} 个数量 vs ${usableLevels.length} 个档位——填一个表示所有档位共用，或与档位一一对应`,
    );
  }

  // Pair levels with counts first, then drop the pairs whose level already
  // exists — pairing is positional, so filtering must not shift it.
  const broadcast = counts.length === 1 ? usableLevels.map(() => counts[0]) : counts;
  const pairs = usableLevels.map((level, index) => ({ level, requests: broadcast[index] }));
  const newPairs = pairs.filter((pair) => !existingLevels[mode].includes(pair.level));
  const dupeLevels = pairs
    .map((pair) => pair.level)
    .filter((level) => existingLevels[mode].includes(level));
  // A single count stays single on the wire — broadcasting is the server's
  // documented semantics, not something the form should pre-expand.
  const payloadCounts =
    counts.length === 1 ? counts : newPairs.map((pair) => pair.requests);
  const payloadLevels = newPairs.map((pair) => pair.level);

  const ready =
    newPairs.length > 0 && levelProblems.length === 0 && requestProblems.length === 0;

  // A live estimate, debounced: the number should move as the ladder is typed,
  // without one request per keystroke.
  useEffect(() => {
    if (!ready) {
      setEstimate(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .estimateCells(deploymentId, {
          workload_id: workloadId,
          mode,
          levels: payloadLevels,
          num_requests: payloadCounts,
        })
        .then(setEstimate)
        .catch(() => setEstimate(null));
    }, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [deploymentId, workloadId, mode, payloadLevels, payloadCounts, ready]);

  async function create() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createCells(deploymentId, {
        workload_id: workloadId,
        mode,
        levels: payloadLevels,
        num_requests: payloadCounts,
      });
      await onCreated(created.length);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ErrorBanner message={error} />
      <div className="flex flex-col gap-3">
        {fixedMode === undefined ? (
          <Field label="模式">
            <div className="flex gap-3" role="radiogroup" aria-label="模式">
              {(Object.keys(MODE_LABELS) as CellMode[]).map((value) => (
                <label key={value} className="flex items-center gap-1 text-sm">
                  <input
                    type="radio"
                    name="cell-mode"
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  {MODE_LABELS[value]}
                </label>
              ))}
            </div>
          </Field>
        ) : null}
        <LadderField
          label={mode === "qps" ? "QPS 档位（逗号分隔）" : "并发档位（逗号分隔）"}
          ariaLabel="档位"
          hint="每个档位展开成一个 Cell。"
          value={levelsText}
          onChange={setLevelsText}
          placeholder={mode === "qps" ? "例如 0.5, 1, 2, 4" : "例如 1, 4, 16, 64"}
          problems={levelProblems}
          duplicates={dupeLevels}
        />
        <LadderField
          label="请求数量（逗号分隔）"
          ariaLabel="请求数量"
          hint="填一个表示所有档位共用；填多个则与档位一一对应。"
          value={requestsText}
          onChange={setRequestsText}
          placeholder="例如 64，或 32, 64, 128"
          problems={requestProblems}
          duplicates={[]}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {estimate
            ? `预计 ${formatDuration(estimate.estimated_seconds)}（${estimate.cell_count} 个 Cell · 共 ${estimate.request_count} 个请求${
                estimate.latency_is_estimated ? "，时延为估计值" : ""
              }）`
            : "预热固定为 5 个请求，执行前自动清空缓存。"}
        </p>
        <Button onClick={() => void create()} disabled={!ready || busy}>
          创建 Cell
        </Button>
      </div>
    </div>
  );
}

/**
 * One list input with its diagnostics: unusable input blocks submission
 * (silently dropping it is how a ladder loses a point nobody noticed), while
 * levels the workload already has are skipped with a note instead of failing
 * the whole batch with a 409.
 */
function LadderField({
  label,
  ariaLabel,
  hint,
  value,
  onChange,
  placeholder,
  problems,
  duplicates,
}: {
  label: string;
  ariaLabel: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  problems: string[];
  duplicates: number[];
}) {
  return (
    <Field label={label} hint={hint}>
      <TextInput
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {problems.map((problem) => (
        <span key={problem} role="alert" className="text-xs text-red-700 dark:text-red-400">
          {problem}
        </span>
      ))}
      {duplicates.length > 0 ? (
        <span className="text-xs text-neutral-400 dark:text-neutral-500">
          已存在：{duplicates.join(", ")}（不会重复创建）
        </span>
      ) : null}
    </Field>
  );
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
    <li
      className="workload-card flex min-w-0 flex-col gap-4 rounded-[18px] border border-neutral-200 bg-white p-4 shadow-sm [container-type:inline-size] dark:border-neutral-800 dark:bg-neutral-900"
    >
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
    </li>
  );
}

const PANEL_TITLES: Record<CellMode, string> = {
  concurrency: "并发测试",
  qps: "QPS 测试",
};

const ADD_PANEL_TITLES: Record<CellMode, string> = {
  concurrency: "添加并发测试",
  qps: "添加 QPS 测试",
};

/**
 * One mode panel: title, batch action, compact Cell rows, and an add action
 * bound to this mode. Results open in a dialog via 查看结果.
 */
function ModePanel({
  mode,
  cells,
  onAdd,
  onAction,
  onDuplicate,
}: {
  mode: CellMode;
  cells: Cell[];
  onAdd: () => void;
  onAction: (action: () => Promise<unknown>, toast?: string) => Promise<void>;
  onDuplicate: (cell: Cell) => void;
}) {
  // 全部重跑 = 所有不在队列里、也不在执行的。已完成项的旧结果会被覆盖。
  const runnable = cells.filter(
    (cell) => cell.status !== "queued" && cell.status !== "running",
  );
  return (
    <section className="card-mode-panel flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          {PANEL_TITLES[mode]}
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs tabular-nums text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {cells.length}
          </span>
        </h3>
        <button
          type="button"
          className={
            "flex items-center gap-1 rounded-md bg-green-600 px-2 py-1 " +
            "text-xs font-medium text-white shadow-sm transition-colors hover:bg-green-700 " +
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 " +
            "disabled:cursor-not-allowed disabled:opacity-50 " +
            "dark:bg-green-600 dark:hover:bg-green-500"
          }
          disabled={runnable.length === 0}
          onClick={() =>
            void onAction(
              () => api.runCells(runnable.map((cell) => cell.id)),
              `已将 ${runnable.length} 项加入队列`,
            )
          }
        >
          <PlayIcon />
          Run All
        </button>
      </div>

      {cells.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {cells.map((cell) => (
            <CellRow
              key={cell.id}
              cell={cell}
              onAction={onAction}
              onDuplicate={onDuplicate}
            />
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        aria-label={ADD_PANEL_TITLES[mode]}
        onClick={onAdd}
        className={`w-full rounded-lg border border-dashed border-neutral-300 px-2 text-center text-xs font-medium text-neutral-500 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 dark:border-neutral-700 dark:hover:border-blue-700 dark:hover:bg-blue-950/30 dark:hover:text-blue-300 ${
          cells.length === 0 ? "py-5" : "py-1.5"
        }`}
      >
        {cells.length === 0 ? (
          <span className="mb-1 block font-normal text-neutral-400">暂无测试项</span>
        ) : null}
        ＋ {ADD_PANEL_TITLES[mode]}
      </button>
    </section>
  );
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
        <div className="cell-row-actions flex items-center justify-end">
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
