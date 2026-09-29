"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, describe, type Cell, type Deployment, type Model, type Workload } from "../../../lib/api";
import { DeploymentReport } from "../../../components/deployment-report";
import { Button, Empty, ErrorBanner } from "../../../components/ui";

type ReportData = { deployment: Deployment; model: Model; workloads: Workload[]; cells: Cell[] };

export default function DeploymentReportPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry(n => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null); setError(null);
    async function load() {
      try {
        const deployment = await api.getDeployment(Number(id));
        const [model, workloads, cells] = await Promise.all([api.getModel(deployment.model_id), api.listDeploymentWorkloads(deployment.id), api.listCells(deployment.id)]);
        if (cancelled) return;
        setData({ deployment, model, workloads, cells }); setError(null);
        if (cells.some(c => c.status === "queued" || c.status === "running")) timer = setTimeout(load, 1500);
      } catch (caught) { if (!cancelled) setError(describe(caught)); }
    }
    if (!Number.isFinite(Number(id)) || Number(id) <= 0) setError("无效的部署 ID");
    else void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [id, retry]);
  return <>
    {error ? <div className="mb-4"><ErrorBanner message={error} /><Button onClick={refresh}>重新加载报告</Button></div> : null}
    {data ? <DeploymentReport key={data.deployment.id} {...data} /> : !error ? <Empty>报告加载中…</Empty> : null}
  </>;
}
