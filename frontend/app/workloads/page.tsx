"use client";

import { useCallback, useEffect, useState } from "react";

import { workloadShape } from "../components/cell";
import { Button, Empty, ErrorBanner, Surface, TextInput } from "../components/ui";
import { WorkloadForm } from "../components/workload-form";
import {
  api,
  describe,
  type Workload,
} from "../lib/api";

export default function WorkloadsPage() {
  const [workloads, setWorkloads] = useState<Workload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setWorkloads(await api.listWorkloads());
      setError(null);
    } catch (caught) {
      setError(describe(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function remove(workload: Workload) {
    setError(null);
    try {
      await api.deleteWorkload(workload.id);
      await refresh();
    } catch (caught) {
      setError(describe(caught));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">负载库</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          预置的负载形状。压测参数不属于这里——并发、QPS、请求数都在部署方式下按 Cell 配置。
        </p>
      </div>

      <ErrorBanner message={error} />

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">全部负载</h2>
        {creating ? null : <Button onClick={() => setCreating(true)}>新建负载</Button>}
      </div>

      {creating ? (
        <Surface>
          <WorkloadForm
            submitLabel="创建"
            className="p-4"
            onSubmit={async (payload) => {
              await api.createWorkload(payload);
              setCreating(false);
              await refresh();
            }}
            onCancel={() => setCreating(false)}
          />
        </Surface>
      ) : null}

      <Surface>
        {workloads === null ? (
          <Empty>加载中…</Empty>
        ) : workloads.length === 0 ? (
          <Empty>还没有负载。新建一个，部署方式下才能配置压测。</Empty>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {workloads.map((workload) => (
              <li key={workload.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {editingId === workload.id ? (
                    <RenameForm
                      workload={workload}
                      onSaved={async () => {
                        setEditingId(null);
                        await refresh();
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <span className="text-sm font-medium">{workload.name}</span>
                      <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
                        {workloadShape(workload)}
                      </span>
                      {workload.note ? (
                        <span className="text-xs text-neutral-500 dark:text-neutral-400">
                          {workload.note}
                        </span>
                      ) : null}
                      <span className="text-xs text-neutral-400 dark:text-neutral-500">
                        被 {workload.cell_count ?? 0} 个 Cell · {workload.deployment_count ?? 0}{" "}
                        个部署方式引用
                      </span>
                    </>
                  )}
                </div>
                {editingId === workload.id ? null : (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="ghost" onClick={() => setEditingId(workload.id)}>
                      编辑
                    </Button>
                    <Button variant="danger" onClick={() => void remove(workload)}>
                      删除
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}

/** Only the label may change; the shape is frozen at creation. */
function RenameForm({
  workload,
  onSaved,
  onCancel,
}: {
  workload: Workload;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(workload.name);
  const [note, setNote] = useState(workload.note);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateWorkload(workload.id, { name, note });
      await onSaved();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <ErrorBanner message={error} />
      <TextInput aria-label="名称" value={name} onChange={(event) => setName(event.target.value)} />
      <TextInput aria-label="备注" value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || name.trim() === ""}>
          保存
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          取消
        </Button>
      </div>
    </form>
  );
}
