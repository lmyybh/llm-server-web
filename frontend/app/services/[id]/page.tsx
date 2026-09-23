"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import Link from "../../components/Link";
import { Breadcrumb, Button, Empty, ErrorBanner, Surface } from "../../components/ui";
import { CellStatusBadge } from "../../components/cell";
import { VerdictBadge } from "../../components/inspection";
import { api, describe, isTerminal, type InspectionRun, type Service } from "../../lib/api";

export default function ServicePage() {
  const params = useParams<{ id: string }>();
  const serviceId = Number(params.id);

  const [service, setService] = useState<Service | null>(null);
  const [inspections, setInspections] = useState<InspectionRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!Number.isFinite(serviceId)) return;
    try {
      const [loaded, runs] = await Promise.all([
        api.getService(serviceId),
        api.listInspections(serviceId),
      ]);
      setService(loaded);
      setInspections(runs);
      setError(null);

      // Keep refreshing while something is in flight: an inspection is short,
      // and watching it finish is the whole point of the page.
      const running = runs.find((run) => !isTerminal(run.status));
      if (running) {
        timer.current = setTimeout(() => void refresh(), 1500);
      }
    } catch (caught) {
      setError(describe(caught));
    }
  }, [serviceId]);

  useEffect(() => {
    void refresh();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      await api.startInspection(serviceId);
      await refresh();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb items={[{ label: "巡检", href: "/services" }, { label: service?.name ?? "…" }]} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{service?.name ?? "…"}</h1>
          <p className="mt-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">
            {service?.router_url}
          </p>
        </div>
        <Button onClick={start} disabled={starting || service === null}>
          {starting ? "启动中…" : "开始巡检"}
        </Button>
      </div>

      <ErrorBanner message={error} />

      <Surface>
        {inspections === null ? (
          <Empty>加载中…</Empty>
        ) : inspections.length === 0 ? (
          <Empty>还没有巡检过。</Empty>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {inspections.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/inspections/${run.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="font-mono text-xs text-neutral-400">{`#${run.id}`}</span>
                    <CellStatusBadge status={run.status} />
                    {run.verdict ? <VerdictBadge verdict={run.verdict} /> : null}
                    {run.suite_version ? (
                      <span className="text-xs text-neutral-400">用例集 v{run.suite_version}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">
                    {new Date(run.queued_at).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}
