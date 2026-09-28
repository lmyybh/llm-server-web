"use client";

import { useCallback, useEffect, useState } from "react";

import Link from "./components/Link";
import { relativeTime } from "./components/cell";
import { PencilIcon, TrashIcon } from "./components/icons";
import {
  Button,
  Empty,
  ErrorBanner,
  IconButton,
  Modal,
  TextInput,
} from "./components/ui";
import { api, describe, type Model } from "./lib/api";

export default function ModelsPage() {
  const [models, setModels] = useState<Model[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [deleting, setDeleting] = useState<Model | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setModels(await api.listModels());
      setError(null);
    } catch (caught) {
      setError(describe(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.createModel({ name, note });
      setName("");
      setNote("");
      setCreating(false);
      await refresh();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    try {
      await api.updateModel(editing.id, { name, note });
      setEditing(null);
      await refresh();
    } catch (caught) {
      setDialogError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteModel(deleting.id);
      setDeleting(null);
      setDialogError(null);
      await refresh();
    } catch (caught) {
      setDialogError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">模型压测</h1>
            <p className="mt-1 text-sm text-slate-500">管理模型与部署方式，快速查看推理性能表现。</p>
          </div>
          <span className="rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">性能工作区</span>
        </div>
      </div>

      <ErrorBanner message={error} />

      {models === null ? (
        <Empty>加载中…</Empty>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5">
          {models.map((model) => (
            <li key={model.id}>
              <ModelCard
                model={model}
                onEdit={() => {
                  setDialogError(null);
                  setName(model.name);
                  setNote(model.note);
                  setEditing(model);
                }}
                onDelete={() => {
                  setDialogError(null);
                  setDeleting(model);
                }}
              />
            </li>
          ))}
          <li>
            {creating ? (
              <form
                onSubmit={submit}
                className="flex h-full min-h-40 flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <TextInput
                  aria-label="模型名称"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="模型名称，如 DeepSeek-V4-Flash"
                  required
                  autoFocus
                />
                <TextInput
                  aria-label="备注"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="备注（选填）"
                />
                <div className="mt-auto flex gap-2">
                  <Button type="submit" disabled={busy || name.trim() === ""}>
                    新建模型
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                    取消
                  </Button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-neutral-300 text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600 dark:border-neutral-700 dark:hover:border-neutral-500 dark:hover:text-neutral-300"
              >
                <span aria-hidden className="text-2xl leading-none">＋</span>
                <span className="text-sm font-medium">新建模型</span>
                {models.length === 0 ? (
                  <span className="text-xs">还没有模型，点这里建第一个</span>
                ) : null}
              </button>
            )}
          </li>
        </ul>
      )}

      {editing ? (
        <Modal title={`编辑 ${editing.name}`} className="max-w-md" onClose={() => setEditing(null)}>
          <form onSubmit={submitEdit} className="flex flex-col gap-3">
            <TextInput
              aria-label="模型名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="模型名称"
              required
              autoFocus
            />
            <TextInput
              aria-label="备注"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="备注（选填）"
            />
            <ErrorBanner message={dialogError} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button type="submit" disabled={busy || name.trim() === ""}>
                保存
              </Button>
            </div>
          </form>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          title={`删除 ${deleting.name}`}
          className="max-w-md"
          onClose={() => {
            setDeleting(null);
            setDialogError(null);
          }}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-300">
              删除后，它下面的所有部署方式、Cell 和测量结果会一起删除，不可恢复。
            </p>
            <ErrorBanner message={dialogError} />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setDeleting(null);
                  setDialogError(null);
                }}
              >
                取消
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void confirmDelete()}>
                确认删除
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * One Model as a card: identity up top, signs of life at the bottom.
 * The name's link stretches over the whole card; the corner buttons sit
 * above it and stay independent.
 */
function ModelCard({
  model,
  onEdit,
  onDelete,
}: {
  model: Model;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative flex h-full flex-col gap-3 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm shadow-slate-900/[.035] transition-all hover:-translate-y-1 hover:border-blue-200 hover:shadow-xl hover:shadow-blue-900/[.08] dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600 dark:hover:shadow-black/40">
      <div className="flex items-start justify-between gap-2">
        <h2 className="truncate text-sm font-semibold">
          <Link
            href={`/models/${model.id}`}
            className="after:absolute after:inset-0 after:rounded-xl hover:underline"
          >
            {model.name}
          </Link>
        </h2>
        <div className="relative z-10 -mr-1.5 -mt-1.5 flex shrink-0 items-center gap-1">
          <IconButton label={`编辑 ${model.name}`} onClick={onEdit}>
            <PencilIcon />
          </IconButton>
          <IconButton label={`删除 ${model.name}`} danger onClick={onDelete}>
            <TrashIcon />
          </IconButton>
        </div>
      </div>
      <p className="min-h-10 line-clamp-2 text-sm text-neutral-500 dark:text-neutral-400">
        {model.note}
      </p>
      <div className="mt-auto flex items-center gap-1.5 border-t border-neutral-100 pt-3 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <span>{model.deployment_count} 种部署方式</span>
        {model.latest_run_at ? <span>· 最近测量 {relativeTime(model.latest_run_at)}</span> : null}
        {model.active_cells > 0 ? (
          <span className="ml-auto flex items-center gap-1.5 font-medium text-blue-600 dark:text-blue-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
            {model.active_cells} 进行中
          </span>
        ) : null}
      </div>
    </div>
  );
}
