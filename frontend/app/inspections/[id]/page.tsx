"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import Link from "../../components/Link";
import { InspectionHistory, InspectionTimeline } from "../../components/inspection-workspace";
import { Breadcrumb, Button, Empty, ErrorBanner, Surface } from "../../components/ui";
import { api, describe, isTerminal, withGatewayPrefix, type InspectionCaseDefinition, type InspectionRun, type Service } from "../../lib/api";

const POLL_MS = 1500;

export default function InspectionPage() {
  const params = useParams<{ id: string }>();
  const inspectionId = Number(params.id);
  const router = useRouter();
  const [run, setRun] = useState<InspectionRun | null>(null);
  const [activeId, setActiveId] = useState(inspectionId);
  const [runs, setRuns] = useState<InspectionRun[]>([]);
  const [service, setService] = useState<Service | null>(null);
  const [catalogue, setCatalogue] = useState<InspectionCaseDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedId = useRef(inspectionId);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    if (!Number.isFinite(inspectionId)) return;
    if (timer.current) clearTimeout(timer.current);
    const version = ++requestVersion.current;
    try {
      const loaded = await api.getInspection(selectedId.current);
      const [targetService, history, definitions] = await Promise.all([
        api.getService(loaded.service_id),
        api.listInspections(loaded.service_id),
        api.listInspectionCases(),
      ]);
      if (version !== requestVersion.current) return;
      setRun(loaded);
      setActiveId(loaded.id);
      setService(targetService);
      setRuns(history);
      setCatalogue(definitions);
      setError(null);
      if (!isTerminal(loaded.status)) timer.current = setTimeout(() => void load(), POLL_MS);
    } catch (caught) {
      if (version === requestVersion.current) setError(describe(caught));
    }
  }, [inspectionId]);

  useEffect(() => {
    selectedId.current = inspectionId;
    setActiveId(inspectionId);
    void load();
    return () => { ++requestVersion.current; if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  function selectRun(id: number) {
    if (id === activeId) return;
    selectedId.current = id;
    setActiveId(id);
    void load();
  }

  async function cancel() {
    setCancelling(true);
    try {
      await api.cancelInspection(run?.id ?? inspectionId);
      await load();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setCancelling(false);
    }
  }

  async function deleteRun(id: number) {
    await api.deleteInspection(id);
    const remaining = runs.filter((entry) => entry.id !== id);
    setRuns(remaining);
    if (id === inspectionId) {
      router.replace(withGatewayPrefix(`/services/${service?.id ?? run?.service_id}`));
      return;
    }
    if (selectedId.current === id) {
      selectedId.current = remaining[0]?.id ?? inspectionId;
      setActiveId(selectedId.current);
      setRun(null);
    }
    await load();
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden">
      <Breadcrumb items={[{ label: "巡检", href: "/services" }, { label: service?.name ?? "服务", href: run ? `/services/${run.service_id}` : "/services" }, { label: "巡检记录" }]} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{service?.name ?? `巡检 #${inspectionId}`}</h1>
          <p className="mt-1 break-all font-mono text-xs text-slate-500">{service?.router_url}</p>
        </div>
        <div className="flex items-center gap-2">
          {run && !isTerminal(run.status) ? <Button variant="danger" onClick={() => void cancel()} disabled={cancelling}>{cancelling ? "取消中…" : "取消巡检"}</Button> : null}
          {service ? <Link href={`/services/${service.id}`} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800">返回服务</Link> : null}
        </div>
      </div>
      <ErrorBanner message={error} />
      {run && service ? <>
        <div className="grid min-h-0 flex-1 grid-rows-[160px_minmax(0,1fr)] gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
          <InspectionHistory runs={runs} activeId={activeId} onSelect={selectRun} onDelete={deleteRun} />
          <InspectionTimeline key={run.id} run={run} service={service} catalogue={catalogue} />
        </div>
      </> : <Surface><Empty>加载中…</Empty></Surface>}
    </div>
  );
}
