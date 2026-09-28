"use client";

import { useCallback, useEffect, useState } from "react";

import { workloadShape } from "../components/cell";
import { AddWorkloadForm } from "../components/add-workload-form";
import { CellLadderForm } from "../components/cell-ladder-form";
import { WorkloadCardFrame } from "../components/workload-card-frame";
import { TrashIcon } from "../components/icons";
import { WorkloadModePanel } from "../components/workload-mode-panel";
import { Button, Empty, ErrorBanner, Field, Modal, SelectInput, Surface, TextInput } from "../components/ui";
import { api, describe, type BenchSuite, type CellMode, type SuiteCell, type SuiteInput, type Workload } from "../lib/api";

type GroupDraft = { key: string; workloadId: number; cells: SuiteCell[] };

let draftId = 0;
function draftKey(): string { return String(++draftId); }

function groupsFrom(suite: BenchSuite | null): GroupDraft[] {
  if (!suite) return [];
  const grouped = new Map<number, GroupDraft>();
  for (const cell of suite.cells) {
    if (!grouped.has(cell.workload_id)) {
      grouped.set(cell.workload_id, { key: draftKey(), workloadId: cell.workload_id, cells: [] });
    }
    grouped.get(cell.workload_id)!.cells.push(cell);
  }
  return Array.from(grouped.values());
}

export default function SuitesPage() {
  const [suites, setSuites] = useState<BenchSuite[] | null>(null);
  const [workloads, setWorkloads] = useState<Workload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<BenchSuite | "new" | null>(null);
  const [deleting, setDeleting] = useState<BenchSuite | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [loadedSuites, loadedWorkloads] = await Promise.all([api.listSuites(), api.listWorkloads()]);
      setSuites(loadedSuites);
      setWorkloads(loadedWorkloads);
      setError(null);
    } catch (caught) {
      setError(describe(caught));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function save(payload: SuiteInput) {
    if (editing === null) return;
    if (editing === "new") await api.createSuite(payload);
    else await api.updateSuite(editing.id, payload);
    setEditing(null);
    await refresh();
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteSuite(deleting.id);
      setDeleting(null);
      await refresh();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">压测组合</h1>
          <p className="mt-1 text-sm text-slate-500">把多个负载及其测试档位保存为模板，在部署方式中一键导入。</p>
        </div>
        <Button onClick={() => setEditing("new")}>新建组合</Button>
      </div>
      <ErrorBanner message={error} />
      {editing ? null : suites === null ? <Empty>加载中…</Empty> : suites.length === 0 ? (
        <Surface><Empty>还没有压测组合。创建后即可在部署方式中导入。</Empty></Surface>
      ) : (
        <ul className="grid gap-4 xl:grid-cols-2">
          {suites.map((suite) => {
            const workloadIds = Array.from(new Set(suite.cells.map((cell) => cell.workload_id)));
            return (
              <li key={suite.id}>
                <Surface className="h-full p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900">{suite.name}</h2>
                      {suite.note ? <p className="mt-1 text-sm text-slate-500">{suite.note}</p> : null}
                      <p className="mt-2 text-xs text-slate-400">{workloadIds.length} 个负载 · {suite.cells.length} 个测试项</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="ghost" onClick={() => setEditing(suite)}>编辑</Button>
                      <Button variant="danger" onClick={() => setDeleting(suite)}>删除</Button>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4">
                    {workloadIds.map((workloadId) => {
                      const workload = workloads?.find((item) => item.id === workloadId);
                      const cells = suite.cells.filter((cell) => cell.workload_id === workloadId);
                      return <div key={workloadId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="font-medium">{workload?.name ?? `负载 #${workloadId}`}</span>
                        <span className="text-xs text-slate-500">{workload ? `${workloadShape(workload)} · ` : ""}{cells.filter((cell) => cell.mode === "concurrency").length} 并发 / {cells.filter((cell) => cell.mode === "qps").length} QPS</span>
                      </div>;
                    })}
                  </div>
                </Surface>
              </li>
            );
          })}
        </ul>
      )}
      {editing && workloads ? (
        <Surface className="p-5">
          <SuiteEditor key={editing === "new" ? "new" : editing.id} suite={editing === "new" ? null : editing} workloads={workloads} onWorkloadAdded={(workload) => setWorkloads((current) => current?.some((item) => item.id === workload.id) ? current : [...(current ?? []), workload])} onSave={save} onCancel={() => setEditing(null)} />
        </Surface>
      ) : null}
      {deleting ? (
        <Modal title={`删除 ${deleting.name}`} className="max-w-md" onClose={() => { if (!busy) setDeleting(null); }}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-slate-600">确定删除这个压测组合？已导入部署方式的负载、Cell 和测量结果不会被删除。</p>
            <ErrorBanner message={error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>取消</Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>确认删除</Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function SuiteEditor({ suite, workloads, onWorkloadAdded, onSave, onCancel }: {
  suite: BenchSuite | null;
  workloads: Workload[];
  onWorkloadAdded: (workload: Workload) => void;
  onSave: (payload: SuiteInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(suite?.name ?? "");
  const [note, setNote] = useState(suite?.note ?? "");
  const [groups, setGroups] = useState<GroupDraft[]>(() => groupsFrom(suite));
  const [adding, setAdding] = useState<{ groupKey: string; mode: CellMode } | null>(null);
  const [choosingWorkload, setChoosingWorkload] = useState(false);
  const [removing, setRemoving] = useState<{ groupKey: string; cell?: SuiteCell } | null>(null);
  const [editingCell, setEditingCell] = useState<{ groupKey: string; cell: SuiteCell } | null>(null);
  const [requestCount, setRequestCount] = useState("64");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function changeGroup(groupKey: string, update: (group: GroupDraft) => GroupDraft) {
    setGroups((current) => current.map((group) => group.key === groupKey ? update(group) : group));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (groups.length === 0 || groups.some((group) => group.cells.length === 0)) {
      setError("每个负载至少需要一个测试项。");
      return;
    }
    const cells = groups.flatMap((group) => group.cells);
    setBusy(true);
    try {
      await onSave({ name: name.trim(), note: note.trim(), cells });
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  const addingGroup = groups.find((group) => group.key === adding?.groupKey);

  return <>
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{suite ? `编辑 ${suite.name}` : "新建压测组合"}</h2>
        <button type="button" className="text-xs text-slate-500 hover:underline" onClick={onCancel}>取消编辑</button>
      </div>
      <ErrorBanner message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="组合名称"><TextInput value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} placeholder="例如：标准并发与 QPS" /></Field>
        <Field label="备注"><TextInput value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="适用场景（选填）" /></Field>
      </div>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">负载与测试项</h3>
      </div>
      <ul className="workload-grid">
        {groups.map((group) => {
          const workload = workloads.find((item) => item.id === group.workloadId);
          return <WorkloadCardFrame key={group.key}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <SelectInput
                  ariaLabel="负载"
                  compact
                  value={String(group.workloadId)}
                  disabled={group.cells.length > 0}
                  title={group.cells.length > 0 ? "已有测试项的负载不可直接替换；可先移除负载再添加" : "选择负载"}
                  onValueChange={(value) => changeGroup(group.key, (old) => ({ ...old, workloadId: Number(value) }))}
                  options={workloads.filter((item) => item.id === group.workloadId || !groups.some((other) => other.workloadId === item.id)).map((item) => ({ value: String(item.id), label: item.name }))}
                />
                <p className="text-xs tabular-nums text-neutral-500">{workload ? workloadShape(workload) : null}</p>
              </div>
              <button type="button" aria-label="移除负载" title="移除负载" className="rounded-lg p-1.5 text-red-600 hover:bg-red-50" onClick={() => setRemoving({ groupKey: group.key })}><TrashIcon /></button>
            </div>
            <div className="card-panels">
              {(["concurrency", "qps"] as const).map((mode) => {
                const cells = group.cells.filter((cell) => cell.mode === mode).sort((a, b) => a.level - b.level);
                return <WorkloadModePanel key={mode} mode={mode} count={cells.length} onAdd={() => setAdding({ groupKey: group.key, mode })}>
                  {cells.length > 0 ? <ul className="flex flex-col gap-0.5">
                    {cells.map((cell) => <li key={`${mode}-${cell.level}`} className="cell-row-grid rounded-lg px-2 py-1.5 hover:bg-neutral-50">
                      <span className="cell-row-level text-sm font-medium tabular-nums">{cell.level}</span>
                      <span className="cell-row-requests whitespace-nowrap text-[9px] tabular-nums text-neutral-400">{cell.num_requests} 请求</span>
                      <span className="cell-row-status text-xs text-neutral-400">待导入</span>
                      <span className="cell-row-actions flex justify-end gap-0.5">
                        <button type="button" aria-label="编辑参数" title="编辑参数" className="text-neutral-500 hover:text-blue-600" onClick={() => { setRequestCount(String(cell.num_requests)); setEditingCell({ groupKey: group.key, cell }); }}>✎</button>
                        <button type="button" aria-label="移除测试项" title="移除测试项" className="text-neutral-500 hover:text-red-600" onClick={() => setRemoving({ groupKey: group.key, cell })}>×</button>
                      </span>
                    </li>)}
                  </ul> : null}
                </WorkloadModePanel>;
              })}
            </div>
          </WorkloadCardFrame>;
        })}
        <li className="workload-add-item"><button type="button" className="workload-add-button flex w-full flex-col items-center justify-center gap-2 rounded-[18px] border-2 border-dashed border-neutral-300 px-4 text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600" onClick={() => setChoosingWorkload(true)}><span className="text-2xl">＋</span><span className="text-sm font-medium">添加负载</span></button></li>
      </ul>
      <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>取消</Button>
        <Button type="submit" disabled={busy || !name.trim() || groups.length === 0}>保存组合</Button>
      </div>
    </form>
    {choosingWorkload ? <Modal title="添加负载" onClose={() => setChoosingWorkload(false)}>
      <AddWorkloadForm
        addedIds={new Set(groups.map((group) => group.workloadId))}
        onAdded={async (workload) => {
          onWorkloadAdded(workload);
          setGroups((current) => [...current, { key: draftKey(), workloadId: workload.id, cells: [] }]);
          setChoosingWorkload(false);
        }}
        onClose={() => setChoosingWorkload(false)}
      />
    </Modal> : null}
    {adding && addingGroup ? <Modal title={adding.mode === "qps" ? "添加 QPS 测试" : "添加并发测试"} className="max-w-md" onClose={() => setAdding(null)}>
      <CellLadderForm
        workloadId={addingGroup.workloadId}
        fixedMode={adding.mode}
        existingLevels={{
          concurrency: addingGroup.cells.filter((cell) => cell.mode === "concurrency").map((cell) => cell.level),
          qps: addingGroup.cells.filter((cell) => cell.mode === "qps").map((cell) => cell.level),
        }}
        onCreate={async (payload) => {
          const requests = payload.num_requests.length === 1 ? payload.levels.map(() => payload.num_requests[0]) : payload.num_requests;
          changeGroup(adding.groupKey, (old) => ({ ...old, cells: [...old.cells, ...payload.levels.map((level, index) => ({ workload_id: old.workloadId, mode: payload.mode, level, num_requests: requests[index] }))] }));
          return payload.levels.length;
        }}
        onCreated={async () => setAdding(null)}
        submitLabel="添加测试项"
      />
    </Modal> : null}
    {editingCell ? <Modal title={`编辑参数 · ${editingCell.cell.mode === "qps" ? "QPS" : "并发"} ${editingCell.cell.level}`} className="max-w-sm" onClose={() => setEditingCell(null)}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const value = Number(requestCount);
        if (!Number.isInteger(value) || value < 1 || value > 100000) return;
        changeGroup(editingCell.groupKey, (old) => ({ ...old, cells: old.cells.map((cell) => cell === editingCell.cell ? { ...cell, num_requests: value } : cell) }));
        setEditingCell(null);
      }} className="flex flex-col gap-4">
        <Field label="请求数量"><TextInput type="number" min="1" max="100000" step="1" value={requestCount} onChange={(event) => setRequestCount(event.target.value)} required /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEditingCell(null)}>取消</Button><Button type="submit">保存</Button></div>
      </form>
    </Modal> : null}
    {removing ? <Modal title={removing.cell ? "移除测试项" : "移除负载"} className="max-w-sm" onClose={() => setRemoving(null)}>
      <div className="flex flex-col gap-4"><p className="text-sm text-slate-600">确认从当前组合中移除{removing.cell ? "这个测试项" : "这个负载及其所有测试项"}？已导入部署方式的数据不会受到影响。</p><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setRemoving(null)}>取消</Button><Button type="button" variant="danger" onClick={() => {
        if (removing.cell) changeGroup(removing.groupKey, (old) => ({ ...old, cells: old.cells.filter((cell) => cell !== removing.cell) }));
        else setGroups((current) => current.filter((group) => group.key !== removing.groupKey));
        setRemoving(null);
      }}>确认移除</Button></div></div>
    </Modal> : null}
  </>;
}
