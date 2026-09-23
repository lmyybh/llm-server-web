"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { MultiLineChart, SERIES_COLOURS, type Point, type Series } from "../../../components/chart";
import { formatMs, format, MODE_LABELS, relativeTime, workloadShape } from "../../../components/cell";
import { Breadcrumb, Empty, ErrorBanner, Surface } from "../../../components/ui";
import {
  api,
  describe,
  type Comparison,
  type ComparisonCell,
  type ComparisonSection,
} from "../../../lib/api";

type Curve = {
  title: string;
  unit: string;
  read: (cell: ComparisonCell) => number | null;
};

const CURVES: Curve[] = [
  { title: "TTFT p99", unit: "ms", read: (cell) => cell.ttft_p99 },
  { title: "TPOT p99", unit: "ms", read: (cell) => cell.tpot_p99 },
  { title: "E2E p99", unit: "ms", read: (cell) => cell.e2e_p99 },
  { title: "输出吞吐", unit: "tok/s", read: (cell) => cell.output_token_throughput },
];

export default function ComparePage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const modelId = Number(params.id);

  // Memoize on the raw string, not the params object: a new identity per
  // render would re-fire the fetch effect in a loop.
  const rawIds = search.get("deployments") ?? "";
  const deploymentIds = useMemo(
    () =>
      rawIds
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value) && value > 0),
    [rawIds],
  );

  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [modelName, setModelName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getModel(modelId)
      .then((model) => setModelName(model.name))
      .catch(() => setModelName(null));
  }, [modelId]);

  useEffect(() => {
    if (deploymentIds.length < 2) return;
    void (async () => {
      try {
        setComparison(await api.compare(modelId, deploymentIds));
        setError(null);
      } catch (caught) {
        setError(describe(caught));
      }
    })();
  }, [modelId, deploymentIds]);

  if (deploymentIds.length < 2) {
    return (
      <Surface>
        <Empty>至少需要勾选两个部署方式才能对比。</Empty>
      </Surface>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb
        items={[
          { label: "模型", href: "/" },
          { label: modelName ?? "…", href: `/models/${modelId}` },
          { label: "对比" },
        ]}
      />

      <div>
        <h1 className="text-lg font-semibold">对比</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          按负载、模式、档位自动配对：同一个 Workload、同一种模式、同一个档位的 Cell 才放在一起比。缺的一方显示「未测」。
        </p>
      </div>

      <ErrorBanner message={error} />

      {comparison === null ? (
        <Surface>
          <Empty>加载中…</Empty>
        </Surface>
      ) : comparison.sections.length === 0 ? (
        <Surface>
          <Empty>
            选中的部署方式还没有可比对的测量——至少两个部署方式在同一个负载、同一种模式下跑完过
            Cell，这里才有内容。
          </Empty>
        </Surface>
      ) : (
        comparison.sections.map((section) => (
          <Section
            key={`${section.workload.id}-${section.mode}`}
            section={section}
            deployments={comparison.deployments}
          />
        ))
      )}
    </div>
  );
}

function Section({
  section,
  deployments,
}: {
  section: ComparisonSection;
  deployments: Comparison["deployments"];
}) {
  // Default to the highest level every deployment reached; fall back to the
  // highest level anyone reached — the axis is the union, and a deployment
  // missing a point shows up as 未测 rather than hiding the level.
  const common = section.levels.filter((level) =>
    deployments.every((deployment) => cellAt(section, deployment.id, level)),
  );
  const [level, setLevel] = useState<number | null>(
    common.length > 0 ? common[common.length - 1] : (section.levels[section.levels.length - 1] ?? null),
  );

  return (
    <Surface className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-sm font-semibold">
          {section.workload.name}
          <span className="ml-2 font-normal text-neutral-500 dark:text-neutral-400">
            {MODE_LABELS[section.mode]}
          </span>
        </h2>
        <p className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
          {workloadShape(section.workload)}
        </p>
      </div>

      {section.notices.map((notice) => (
        <p
          key={notice}
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {notice}
        </p>
      ))}

      {section.no_common_levels ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          这一组没有任何大家都测过的档位——曲线仍按各自测过的点画出，同一档位下缺的一方显示「未测」。
        </p>
      ) : null}

      <LevelPicker levels={section.levels} value={level} onChange={setLevel} />
      <ComparisonTable section={section} deployments={deployments} level={level} />

      <div className="grid gap-4 sm:grid-cols-2">
        {CURVES.map((curve) => (
          <MultiLineChart
            key={curve.title}
            title={curve.title}
            unit={curve.unit}
            xLabel={section.mode === "qps" ? "提供的 QPS" : "并发"}
            showLegend
            series={deployments.map((deployment): Series => {
              return {
                label: deployment.name,
                points: section.rows
                  .map((row): Point | null => {
                    const cell = row.cells[String(deployment.id)];
                    if (!cell) return null;
                    const y = curve.read(cell);
                    return y === null ? null : { x: row.level, y };
                  })
                  .filter((point): point is Point => point !== null),
              };
            })}
          />
        ))}
      </div>
    </Surface>
  );
}

function cellAt(
  section: ComparisonSection,
  deploymentId: number,
  level: number,
): ComparisonCell | null {
  const row = section.rows.find((entry) => entry.level === level);
  return row?.cells[String(deploymentId)] ?? null;
}

function LevelPicker({
  levels,
  value,
  onChange,
}: {
  levels: number[];
  value: number | null;
  onChange: (level: number) => void;
}) {
  if (levels.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-neutral-500 dark:text-neutral-400">档位</span>
      {levels.map((candidate) => (
        <button
          key={candidate}
          type="button"
          onClick={() => onChange(candidate)}
          className={
            "rounded px-2 py-0.5 font-mono text-xs " +
            (value === candidate
              ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : "border border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800")
          }
        >
          {candidate}
        </button>
      ))}
    </div>
  );
}

function ComparisonTable({
  section,
  deployments,
  level,
}: {
  section: ComparisonSection;
  deployments: Comparison["deployments"];
  level: number | null;
}) {
  if (level === null) return null;
  const entries = deployments.map((deployment, index) => ({
    deployment,
    colour: SERIES_COLOURS[index % SERIES_COLOURS.length],
    cell: cellAt(section, deployment.id, level),
  }));

  const rows: { label: string; render: (cell: ComparisonCell) => string }[] = [
    { label: "p99 TTFT", render: (cell) => formatMs(cell.ttft_p99) },
    { label: "p50 TTFT", render: (cell) => formatMs(cell.ttft_p50) },
    { label: "p99 TPOT", render: (cell) => formatMs(cell.tpot_p99) },
    { label: "p99 E2E", render: (cell) => formatMs(cell.e2e_p99) },
    { label: "输出吞吐", render: (cell) => `${format(cell.output_token_throughput, 1)} tok/s` },
    { label: "达到", render: (cell) => `${format(cell.achieved_qps)} req/s` },
    {
      label: "成功",
      render: (cell) => `${cell.successful_requests ?? 0}/${cell.total_requests ?? 0}`,
    },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-neutral-400">
            <th className="py-1 font-medium">指标</th>
            {entries.map(({ deployment, colour, cell }) => (
              <th key={deployment.id} className="py-1 text-right font-medium">
                <span className="flex items-center justify-end gap-1">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: colour }}
                  />
                  {deployment.name}
                </span>
                {cell?.last_run_at ? (
                  <span className="block font-normal text-neutral-400">
                    测于 {relativeTime(cell.last_run_at)}
                  </span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-neutral-100 dark:border-neutral-800">
              <td className="py-1 font-sans text-neutral-600 dark:text-neutral-400">{row.label}</td>
              {entries.map(({ deployment, cell }) => (
                <td key={deployment.id} className="py-1 text-right">
                  {cell ? row.render(cell) : <span className="font-sans text-neutral-400">未测</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
