"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Breadcrumb, Button, Empty, ErrorBanner, Surface } from "../../components/ui";
import { CellStatusBadge } from "../../components/cell";
import { CaseList, TargetSummary, VerdictBadge } from "../../components/inspection";
import { api, describe, isTerminal, type InspectionRun } from "../../lib/api";

const POLL_MS = 1500;

export default function InspectionPage() {
  const params = useParams<{ id: string }>();
  const inspectionId = Number(params.id);

  const [run, setRun] = useState<InspectionRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!Number.isFinite(inspectionId)) return;
    try {
      const loaded = await api.getInspection(inspectionId);
      setRun(loaded);
      setError(null);
      if (!isTerminal(loaded.status)) {
        timer.current = setTimeout(() => void load(), POLL_MS);
      }
    } catch (caught) {
      setError(describe(caught));
    }
  }, [inspectionId]);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  async function cancel() {
    setCancelling(true);
    try {
      await api.cancelInspection(inspectionId);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setCancelling(false);
      if (timer.current) clearTimeout(timer.current);
      await load();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb
        items={[
          { label: "巡检", href: "/services" },
          { label: "服务", href: run ? `/services/${run.service_id}` : "/services" },
          { label: `巡检 #${inspectionId}` },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-lg font-semibold">{`巡检 #${inspectionId}`}</h1>
        {run ? <CellStatusBadge status={run.status} /> : null}
        {run?.verdict ? <VerdictBadge verdict={run.verdict} /> : null}
        {run?.suite_version ? (
          <span className="text-xs text-neutral-400">用例集 v{run.suite_version}</span>
        ) : null}
        {run && !isTerminal(run.status) ? (
          <Button variant="danger" onClick={cancel} disabled={cancelling}>
            {cancelling ? "取消中…" : "取消"}
          </Button>
        ) : null}
      </div>

      <ErrorBanner message={error} />

      {run === null ? (
        <Surface>
          <Empty>加载中…</Empty>
        </Surface>
      ) : (
        <>
          {run.status === "running" && run.current_case ? (
            <Surface className="p-4">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                正在跑 <span className="font-mono">{run.current_case}</span>
              </p>
            </Surface>
          ) : null}

          {run.error ? (
            <Surface className="border-red-300 p-4 dark:border-red-900">
              <h2 className="text-sm font-semibold text-red-800 dark:text-red-300">巡检未能完成</h2>
              <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-red-700 dark:text-red-400">
                {run.error}
              </p>
            </Surface>
          ) : null}

          <Surface className="p-4">
            <h2 className="mb-3 text-sm font-semibold">目标</h2>
            <TargetSummary target={run.target} />
          </Surface>

          <Surface>
            <h2 className="px-4 pt-4 text-sm font-semibold">用例</h2>
            <p className="px-4 pb-2 text-xs text-neutral-500 dark:text-neutral-400">
              「失败」表示服务违反了契约，「无法判定」表示测不出来。两者不是一回事，所以分开显示。
            </p>
            <CaseList cases={run.cases} />
          </Surface>
        </>
      )}
    </div>
  );
}
