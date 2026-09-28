"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Breadcrumb, Button, Empty, ErrorBanner, Surface } from "../../components/ui";
import { InspectionCaseConfig, InspectionHistory, InspectionTimeline } from "../../components/inspection-workspace";
import { api, describe, isTerminal, type InspectionCaseDefinition, type InspectionRun, type Service } from "../../lib/api";

export default function ServicePage() {
  const params = useParams<{ id: string }>();
  const serviceId = Number(params.id);
  const [service, setService] = useState<Service | null>(null);
  const [catalogue, setCatalogue] = useState<InspectionCaseDefinition[]>([]);
  const [runs, setRuns] = useState<InspectionRun[] | null>(null);
  const [selectedRun, setSelectedRun] = useState<InspectionRun | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedId = useRef<number | null>(null);
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    if (!Number.isFinite(serviceId)) return;
    if (timer.current) clearTimeout(timer.current);
    const version = ++requestVersion.current;
    try {
      const [loaded, listed, cases] = await Promise.all([
        api.getService(serviceId), api.listInspections(serviceId), api.listInspectionCases(),
      ]);
      const runId = listed.some((run) => run.id === selectedId.current)
        ? selectedId.current : listed[0]?.id ?? null;
      const detail = runId === null ? null : await api.getInspection(runId);
      if (version !== requestVersion.current) return;
      setService(loaded);
      setRuns(listed);
      setSelectedRun(detail);
      setActiveId(runId);
      setCatalogue(cases);
      setError(null);
      if (listed.some((run) => !isTerminal(run.status))) {
        timer.current = setTimeout(() => void refresh(), 1500);
      }
    } catch (caught) {
      if (version === requestVersion.current) setError(describe(caught));
    }
  }, [serviceId]);

  useEffect(() => {
    selectedId.current = null;
    void refresh();
    return () => { ++requestVersion.current; if (timer.current) clearTimeout(timer.current); };
  }, [refresh]);

  function selectRun(id: number) {
    if (id === activeId) return;
    selectedId.current = id;
    setActiveId(id);
    setSelectedRun(null);
    void refresh();
  }

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const created = await api.startInspection(serviceId);
      selectedId.current = created.id;
      setActiveId(created.id);
      setSelectedRun(created);
      await refresh();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setStarting(false);
    }
  }

  async function saveCases(caseIds: string[]) {
    const updated = await api.configureInspectionCases(serviceId, caseIds);
    setService(updated);
  }

  async function deleteRun(id: number) {
    await api.deleteInspection(id);
    const remaining = (runs ?? []).filter((run) => run.id !== id);
    setRuns(remaining);
    if (selectedId.current === id) {
      selectedId.current = remaining[0]?.id ?? null;
      setActiveId(selectedId.current);
      setSelectedRun(null);
    }
    await refresh();
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-hidden">
      <Breadcrumb items={[{ label: "巡检", href: "/services" }, { label: service?.name ?? "…" }]} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{service?.name ?? "…"}</h1>
          <p className="mt-1 break-all font-mono text-xs text-slate-500">{service?.router_url}</p>
          {service ? <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-600 dark:text-neutral-400"><span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950">服务已登记</span><span className="rounded-full border border-slate-200 px-2.5 py-1 dark:border-neutral-700">已启用 {service.enabled_case_ids.length} / {catalogue.length} 项</span></div> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {service && catalogue.length ? <InspectionCaseConfig service={service} catalogue={catalogue} onSave={saveCases} /> : null}
          <Button onClick={() => void start()} disabled={starting || service === null}>{starting ? "启动中…" : "开始巡检"}</Button>
        </div>
      </div>

      <ErrorBanner message={error} />
      {runs === null ? <Surface><Empty>加载中…</Empty></Surface> :
        <div className="grid min-h-0 flex-1 grid-rows-[160px_minmax(0,1fr)] gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
          <InspectionHistory runs={runs} activeId={activeId} onSelect={selectRun} onDelete={deleteRun} />
          {selectedRun && service ? <InspectionTimeline key={selectedRun.id} run={selectedRun} service={service} catalogue={catalogue} /> : <Surface><Empty>{activeId === null ? "选择巡检项后点击“开始巡检”，这里会显示逐项执行进度。" : "加载巡检记录…"}</Empty></Surface>}
        </div>}
    </div>
  );
}
