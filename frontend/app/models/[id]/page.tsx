"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import Link from "../../components/Link";

import {
  DeploymentForm,
  blankDeployment,
  copyFrom,
  toPayload,
  valuesFrom,
  type FormValues,
} from "../../components/DeploymentForm";
import { PencilIcon, TrashIcon } from "../../components/icons";
import { Breadcrumb, Button, Empty, ErrorBanner, IconButton, Modal } from "../../components/ui";
import { relativeTime } from "../../components/cell";
import { api, describe, type Deployment, type Model } from "../../lib/api";

export default function ModelPage() {
  const params = useParams<{ id: string }>();
  const modelId = Number(params.id);

  const [model, setModel] = useState<Model | null>(null);
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The one deployment form dialog: either blank for a create, or editing an existing one. */
  const [formState, setFormState] = useState<
    { mode: "create" } | { mode: "edit"; deployment: Deployment } | null
  >(null);
  const [deleting, setDeleting] = useState<Deployment | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);

  function toggleSelected(id: number) {
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
    );
  }

  const refresh = useCallback(async () => {
    if (!Number.isFinite(modelId)) return;
    try {
      const [loadedModel, loadedDeployments] = await Promise.all([
        api.getModel(modelId),
        api.listDeployments(modelId),
      ]);
      setModel(loadedModel);
      setDeployments(loadedDeployments);
      setError(null);
    } catch (caught) {
      setError(describe(caught));
    }
  }, [modelId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submitForm(values: FormValues) {
    if (formState?.mode === "edit") {
      await api.updateDeployment(formState.deployment.id, toPayload(values));
    } else {
      await api.createDeployment(modelId, toPayload(values));
    }
    setFormState(null);
    await refresh();
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api.deleteDeployment(deleting.id);
      setDeleting(null);
      setDeleteError(null);
      await refresh();
    } catch (caught) {
      setDeleteError(describe(caught));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb items={[{ label: "模型", href: "/" }, { label: model?.name ?? "…" }]} />

      <ErrorBanner message={error} />

      {deployments === null ? (
        <Empty>加载中…</Empty>
      ) : (
        <ul className="catalog-grid">
          {deployments.map((deployment) => (
            <DeploymentCard
              key={deployment.id}
              deployment={deployment}
              selected={selected.includes(deployment.id)}
              onToggleSelected={() => toggleSelected(deployment.id)}
              onEdit={() => setFormState({ mode: "edit", deployment })}
              onDelete={() => {
                setDeleteError(null);
                setDeleting(deployment);
              }}
            />
          ))}
          <li>
            <button
              type="button"
              onClick={() => setFormState({ mode: "create" })}
              disabled={model === null}
              className="catalog-card flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-neutral-300 text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600 disabled:opacity-50 dark:border-neutral-700 dark:hover:border-neutral-500 dark:hover:text-neutral-300"
            >
              <span aria-hidden className="text-2xl leading-none">＋</span>
              <span className="text-sm font-medium">新建部署方式</span>
              {deployments.length === 0 ? (
                <span className="text-xs">还没有部署方式，点这里建一个</span>
              ) : null}
            </button>
          </li>
        </ul>
      )}

      {formState ? (
        <Modal
          title={formState.mode === "create" ? "新建部署方式" : `编辑 ${formState.deployment.name}`}
          className="max-w-3xl"
          onClose={() => setFormState(null)}
        >
          <DeploymentForm
            key={formState.mode === "edit" ? formState.deployment.id : "create"}
            initial={
              formState.mode === "edit"
                ? valuesFrom(formState.deployment)
                : // Deployments list oldest-first, so the last one is the most
                  // recent — a new Deployment is usually a copy of it with a
                  // different name.
                  deployments && deployments.length > 0
                  ? copyFrom(deployments[deployments.length - 1])
                  : blankDeployment()
            }
            submitLabel={formState.mode === "create" ? "创建" : "保存"}
            onSubmit={submitForm}
            onCancel={() => setFormState(null)}
          />
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          title={`删除 ${deleting.name}`}
          className="max-w-md"
          onClose={() => {
            setDeleting(null);
            setDeleteError(null);
          }}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              删除后，它下面的所有 Cell 和测量结果会一起删除，不可恢复。
            </p>
            <ErrorBanner message={deleteError} />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setDeleting(null);
                  setDeleteError(null);
                }}
              >
                取消
              </Button>
              <Button variant="danger" onClick={() => void confirmDelete()}>
                确认删除
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {selected.length > 0 ? (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <span className="text-neutral-600 dark:text-neutral-300">
            已选 {selected.length} 个
          </span>
          {selected.length >= 2 ? (
            <Link
              href={`/models/${modelId}/compare?deployments=${selected.join(",")}`}
              className="rounded-full bg-neutral-900 px-3 py-1 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              去对比 →
            </Link>
          ) : (
            <span className="text-xs text-neutral-400">再勾选一个即可对比</span>
          )}
          <button
            type="button"
            onClick={() => setSelected([])}
            className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            清除
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One Deployment as a card. The name's link stretches over the whole card
 * (``after:inset-0``), so the card reads as one thing to click; the compare
 * checkbox and the edit button sit above it (``z-10``) and stay independent.
 */
function DeploymentCard({
  deployment,
  selected,
  onToggleSelected,
  onEdit,
  onDelete,
}: {
  deployment: Deployment;
  selected: boolean;
  onToggleSelected: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={
        "catalog-card relative flex flex-col gap-3 rounded-2xl border bg-white p-5 transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-neutral-200/60 dark:bg-neutral-900 dark:hover:shadow-black/40 " +
        (selected
          ? "border-neutral-400 dark:border-neutral-500"
          : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-600")
      }
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="relative z-10 mt-0.5 h-4 w-4 shrink-0"
          aria-label={`对比 ${deployment.name}`}
          checked={selected}
          onChange={onToggleSelected}
        />
        <div className="min-w-0 flex-1">
          <Link
            href={`/deployments/${deployment.id}`}
            className="text-sm font-medium after:absolute after:inset-0 after:rounded-xl hover:underline"
          >
            {deployment.name}
          </Link>
          {deployment.topology ? (
            <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-normal text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              {deployment.topology}
            </span>
          ) : null}
          <p className="mt-1 truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
            {deployment.router_url} · {deployment.model_name}
          </p>
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          <IconButton label={`编辑 ${deployment.name}`} tooltip="编辑" onClick={onEdit}>
            <PencilIcon />
          </IconButton>
          <IconButton label={`删除 ${deployment.name}`} tooltip="删除" danger onClick={onDelete}>
            <TrashIcon />
          </IconButton>
        </div>
      </div>
      <div className="mt-auto border-t border-neutral-100 pt-3 dark:border-neutral-800">
        <CellsSummary deployment={deployment} />
      </div>
    </li>
  );
}

/**
 * A one-line summary of the Deployment's Cells, so the list itself says
 * whether a Deployment has been measured.
 */
function CellsSummary({ deployment }: { deployment: Deployment }) {
  const cells = deployment.cells;
  if (!cells || cells.total === 0) {
    return <span className="text-xs text-neutral-400 dark:text-neutral-500">还没配置压测</span>;
  }
  const completed = cells.by_status.completed ?? 0;
  return (
    <span className="text-xs text-neutral-500 dark:text-neutral-400">
      {cells.total} 个 Cell · {completed} 已完成
      {cells.latest_run_at ? ` · 最近测量 ${relativeTime(cells.latest_run_at)}` : ""}
    </span>
  );
}
