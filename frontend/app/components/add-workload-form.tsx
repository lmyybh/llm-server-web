"use client";

import { useEffect, useState } from "react";

import { workloadShape } from "./cell";
import { WorkloadForm } from "./workload-form";
import { Button, ErrorBanner, Field, SelectInput } from "./ui";
import { api, describe, type Workload, type WorkloadInput } from "../lib/api";

/** Choose an existing Workload or create one inline, then add it to a target. */
export function AddWorkloadForm({
  addedIds,
  onAdded,
  onClose,
}: {
  addedIds: Set<number>;
  onAdded: (workload: Workload) => Promise<void>;
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
      const picked = available.find((workload) => workload.id === pickedId);
      if (picked) await onAdded(picked);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  async function createAndAttach(payload: WorkloadInput) {
    const created = await api.createWorkload(payload);
    await onAdded(created);
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
            没有可选的已有负载，可以直接新建一个。
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
      <Field label="负载" hint="添加后，在并发测试或 QPS 测试面板中配置。">
        <SelectInput
          ariaLabel="负载"
          value={pickedId === null ? "" : String(pickedId)}
          onValueChange={(value) => setPickedId(Number(value))}
          options={available.map((workload) => ({ value: String(workload.id), label: `${workload.name}（${workloadShape(workload)}）` }))}
        />
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
