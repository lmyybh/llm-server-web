"use client";

import { useParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  CellCurves,
  CellHistograms,
  CellLatencyTable,
  CellProgress,
  CellStatusDot,
  CellSummary,
  MODE_LABELS,
  relativeTime,
  workloadShape,
} from "../../components/cell";
import { Breadcrumb, Button, Empty, ErrorBanner, Field, IconButton, Modal, TextInput } from "../../components/ui";
import { EllipsisIcon, PlayIcon, RotateCcwIcon, StopIcon } from "../../components/icons";
import { WorkloadForm } from "../../components/workload-form";
import { parseLevels } from "../../lib/levels";
import {
  api,
  artifactsZipUrl,
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
        <ul className="grid w-full grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {groups.map((group) => (
            <WorkloadCard
              key={group.workloadId}
              group={group}
              onNewCell={() => setCellForm({ workloadId: group.workloadId })}
              onDetach={() => void act(() => api.detachWorkload(deploymentId, group.workloadId), "已移除负载")}
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
          <li>
            <button
              type="button"
              onClick={() => setAddingWorkload(true)}
              disabled={attached === null}
              className="flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 rounded-[18px] border-2 border-dashed border-neutral-300 text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600 disabled:opacity-50 dark:border-neutral-700 dark:hover:border-neutral-500 dark:hover:text-neutral-300"
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
        <Modal title="添加测试" className="max-w-2xl" onClose={() => setCellForm(null)}>
          <CellLadderForm
            deploymentId={deploymentId}
            workloadId={cellForm.workloadId}
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
      <Field label="负载" hint="压测配置在添加后从卡片上的「新建 Cell」设置。">
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
  initial,
  onCreated,
}: {
  deploymentId: number;
  workloadId: number;
  /** Levels this (workload, mode) already has — excluded from the batch. */
  existingLevels: Record<CellMode, number[]>;
  /** 「复制」预填的来源测试项配置。 */
  initial?: { mode: CellMode; levels: string; requests: string };
  onCreated: (created: number) => Promise<void>;
}) {
  const [mode, setMode] = useState<CellMode>(initial?.mode ?? "concurrency");
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
 * One Workload as a full-width card: header (name, shape, actions), then the
 * mode panels side by side — 并发测试 left, QPS 测试 right, separated by a
 * hairline. A freshly added Workload has no Cells yet — the card is where its
 * first Cell is configured, and where it can be removed again.
 */
function WorkloadCard({
  group,
  onNewCell,
  onDetach,
  onAction,
  onDuplicate,
}: {
  group: WorkloadGroup;
  onNewCell: () => void;
  onDetach: () => void;
  onAction: (action: () => Promise<unknown>, toast?: string) => Promise<void>;
  onDuplicate: (cell: Cell) => void;
}) {
  const panels = (["concurrency", "qps"] as const)
    .map((mode) => ({ mode, cells: group.cells.filter((cell) => cell.mode === mode) }))
    .filter((panel) => panel.cells.length > 0);

  return (
    <li className="flex flex-col gap-4 rounded-[18px] border border-neutral-200 bg-white p-5 shadow-sm [container-type:inline-size] dark:border-neutral-800 dark:bg-neutral-900">
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
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onNewCell}
            className="rounded-md border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
          >
            ＋ 添加测试
          </button>
          {group.cells.length === 0 ? (
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onDetach}>
              移除
            </Button>
          ) : null}
        </div>
      </div>

      {group.cells.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          已添加，还没有测试项——点「添加测试」配置压测。
        </p>
      ) : null}

      <div className="card-panels">
        {panels.map((panel, index) => (
          <Fragment key={panel.mode}>
            {panels.length === 2 && index === 1 ? (
              <div aria-hidden className="card-panel-divider bg-neutral-100 dark:bg-neutral-800" />
            ) : null}
            <ModePanel
              mode={panel.mode}
              cells={panel.cells}
              onAction={onAction}
              onDuplicate={onDuplicate}
            />
          </Fragment>
        ))}
      </div>
    </li>
  );
}

const PANEL_TITLES: Record<CellMode, string> = {
  concurrency: "并发测试",
  qps: "QPS 测试",
};

const PARAM_COLUMN_TITLES: Record<CellMode, string> = {
  concurrency: "并发数",
  qps: "QPS",
};

/**
 * One mode panel: title with a count chip and the batch action, then a fixed
 * four-column table (参数 · 状态 · 进度/请求数 · 操作). Results stay off the
 * card — each completed row opens them in a dialog via 查看结果.
 */
function ModePanel({
  mode,
  cells,
  onAction,
  onDuplicate,
}: {
  mode: CellMode;
  cells: Cell[];
  onAction: (action: () => Promise<unknown>, toast?: string) => Promise<void>;
  onDuplicate: (cell: Cell) => void;
}) {
  // 全部重跑 = 所有不在队列里、也不在执行的。已完成项的旧结果会被覆盖。
  const runnable = cells.filter(
    (cell) => cell.status !== "queued" && cell.status !== "running",
  );
  return (
    <section className="flex min-w-0 flex-col gap-3">
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

      <div
        aria-hidden
        className="grid grid-cols-[48px_72px_minmax(0,1fr)_44px] items-center gap-2 px-2 text-xs text-neutral-400 dark:text-neutral-500"
      >
        <span>{PARAM_COLUMN_TITLES[mode]}</span>
        <span>状态</span>
        <span>进度 / 请求数</span>
        <span className="text-right">操作</span>
      </div>

      <ul className="flex flex-col gap-0.5">
        {cells.map((cell) => (
          <CellRow
            key={cell.id}
            cell={cell}
            siblings={cells}
            onAction={onAction}
            onDuplicate={onDuplicate}
          />
        ))}
      </ul>
    </section>
  );
}

const ROW_GRID = "grid grid-cols-[48px_72px_minmax(0,1fr)_44px] items-center gap-2";

function CellRow({
  cell,
  siblings,
  onAction,
  onDuplicate,
}: {
  cell: Cell;
  siblings: Cell[];
  onAction: (action: () => Promise<unknown>, toast?: string) => Promise<void>;
  onDuplicate: (cell: Cell) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const inFlight = cell.status === "queued" || cell.status === "running";
  const progress = cell.progress;
  const percent =
    cell.status === "running" && progress?.total_requests
      ? Math.min(
          100,
          Math.round(((progress.completed_requests ?? 0) / progress.total_requests) * 100),
        )
      : null;

  return (
    <li>
      <div
        className={`${ROW_GRID} rounded-lg px-2 py-1.5 transition-colors ${
          cell.status === "running"
            ? "bg-blue-50 py-2 dark:bg-blue-950/40"
            : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
        }`}
      >
        <button
          type="button"
          className="col-span-3 grid grid-cols-[48px_72px_minmax(0,1fr)] items-center gap-2 text-left"
          onClick={() =>
            cell.status === "completed" ? setShowResults(true) : setOpen(!open)
          }
          {...(cell.status === "completed"
            ? { "aria-haspopup": "dialog" as const }
            : { "aria-expanded": open })}
        >
          <span className="text-sm tabular-nums text-neutral-800 dark:text-neutral-200">
            {cell.level}
          </span>
          <span className="flex items-center gap-1.5">
            <CellStatusDot status={cell.status} />
            {cell.stale ? (
              <span className="truncate text-xs text-amber-700 dark:text-amber-400">
                · 结果来自旧配置
              </span>
            ) : null}
          </span>
          <span className="min-w-0 truncate text-xs tabular-nums text-neutral-400">
            {cell.status === "running" && percent !== null ? (
              <span className="flex flex-col items-start gap-1">
                <CellProgress cell={cell} />
                <span
                  className="h-1 w-24 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-950"
                  role="progressbar"
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span
                    className="block h-1 rounded-full bg-blue-500 transition-all"
                    style={{ width: `${percent}%` }}
                  />
                </span>
              </span>
            ) : (
              `${cell.num_requests} 请求`
            )}
          </span>
        </button>
        <div className="flex items-center justify-end">
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
                onEdit={() => setOpen(true)}
                onDuplicate={() => onDuplicate(cell)}
                onDelete={() => void onAction(() => api.deleteCell(cell.id), "已删除该测试项")}
              />
            </>
          )}
        </div>
      </div>

      {open ? (
        <div className="mt-2 flex flex-col gap-4 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
          {cell.error ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {cell.error}
            </p>
          ) : null}
          {cell.last_run_at ? (
            <p className="text-xs text-neutral-400">测于 {relativeTime(cell.last_run_at)}</p>
          ) : null}
          {!inFlight ? <NumRequestsEditor cell={cell} onAction={onAction} /> : null}
          {cell.status === "idle" ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">还没有跑过这个测试项。</p>
          ) : null}
        </div>
      ) : null}

      {showResults ? (
        <Modal
          title={`${MODE_LABELS[cell.mode]} ${cell.level} · 压测结果`}
          onClose={() => setShowResults(false)}
          className="max-w-4xl"
        >
          <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto">
            {cell.last_run_at ? (
              <p className="text-xs text-neutral-400">测于 {relativeTime(cell.last_run_at)}</p>
            ) : null}
            {cell.stale ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">结果来自旧配置</p>
            ) : null}
            <CellSummary cell={cell} />
            <CellLatencyTable cell={cell} />
            <CellHistograms cell={cell} />
            <CellCurves cells={siblings} mode={cell.mode} />
            {cell.artifact_dir ? (
              <a
                href={artifactsZipUrl(cell.id)}
                className="text-sm text-neutral-600 underline dark:text-neutral-300"
              >
                下载全部产物（zip）
              </a>
            ) : null}
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
