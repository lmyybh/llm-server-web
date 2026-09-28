"use client";

import { useEffect, useMemo, useState } from "react";

import { MODE_LABELS } from "./cell";
import { Button, ErrorBanner, Field, TextInput } from "./ui";
import { parseLevels } from "../lib/levels";
import { describe, type CellBatchInput, type CellMode, type Estimate } from "../lib/api";

const DEFAULT_REQUESTS = "64";
const ESTIMATE_DEBOUNCE_MS = 400;

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} 秒`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

/**
 * The ladder form inside the create dialog: one mode (picked by radio), a
 * comma-separated ladder of levels, and request counts. A single count
 * broadcasts across the ladder; several counts must pair with the levels
 * one-to-one.
 */
export function CellLadderForm({
  workloadId,
  existingLevels,
  fixedMode,
  initial,
  onCreate,
  onEstimate,
  onCreated,
  submitLabel = "创建 Cell",
}: {
  workloadId: number;
  /** Levels this (workload, mode) already has — excluded from the batch. */
  existingLevels: Record<CellMode, number[]>;
  /** A panel's add action creates Cells only in that panel's mode. */
  fixedMode?: CellMode;
  /** 「复制」预填的来源测试项配置。 */
  initial?: { mode: CellMode; levels: string; requests: string };
  onCreate: (payload: CellBatchInput) => Promise<number>;
  onEstimate?: (payload: CellBatchInput) => Promise<Estimate>;
  onCreated: (created: number) => Promise<void>;
  submitLabel?: string;
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
    if (!ready || !onEstimate) {
      setEstimate(null);
      return;
    }
    const timer = setTimeout(() => {
      onEstimate({
          workload_id: workloadId,
          mode,
          levels: payloadLevels,
          num_requests: payloadCounts,
        })
        .then(setEstimate)
        .catch(() => setEstimate(null));
    }, ESTIMATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [workloadId, mode, levelsText, requestsText, ready, onEstimate]);

  async function create() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const created = await onCreate({
        workload_id: workloadId,
        mode,
        levels: payloadLevels,
        num_requests: payloadCounts,
      });
      await onCreated(created);
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
            : onEstimate ? "预热固定为 5 个请求，执行前自动清空缓存。" : `${newPairs.length} 个测试项`}
        </p>
        <Button type="button" onClick={() => void create()} disabled={!ready || busy}>
          {submitLabel}
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
