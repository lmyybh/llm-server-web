"use client";

import { useCallback, useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import Link from "../components/Link";
import { Button, Empty, ErrorBanner, TextInput } from "../components/ui";
import { api, describe, type Service } from "../lib/api";

export default function ServicesPage() {
  const [services, setServices] = useState<Service[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setServices(await api.listServices());
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
    setFormError(null);
    try {
      await api.createService({ name, note, router_url: url });
      setName("");
      setUrl("");
      setNote("");
      setCreating(false);
      await refresh();
    } catch (caught) {
      setFormError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">服务巡检</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500 dark:text-neutral-400">
          验证推理服务的接口、响应格式和异常负载下的功能正确性
        </p>
      </div>

      <ErrorBanner message={error} />

      {services === null ? (
        <Empty>加载中…</Empty>
      ) : (
        <ul className="catalog-grid">
          {services.map((service) => (
            <li key={service.id}>
              <Link
                href={`/services/${service.id}`}
                className="catalog-card flex h-full flex-col gap-2 rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm shadow-slate-900/[.035] transition-all hover:-translate-y-1 hover:border-blue-200 hover:shadow-xl hover:shadow-blue-900/[.08] dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-600 dark:hover:shadow-black/40"
              >
                <span className="truncate text-sm font-semibold">{service.name}</span>
                <span className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400" title={service.router_url}>
                  {service.router_url}
                </span>
                <span className="line-clamp-2 min-h-10 text-sm text-neutral-500 dark:text-neutral-400">{service.note}</span>
                <span className="mt-auto border-t border-neutral-100 pt-3 text-xs text-blue-600 dark:border-neutral-800 dark:text-blue-400">查看巡检 →</span>
              </Link>
            </li>
          ))}
          <li>
            <DialogPrimitive.Root open={creating} onOpenChange={(open) => {
              setCreating(open);
              if (open) setFormError(null);
            }}>
              <DialogPrimitive.Trigger asChild>
                <button
                  type="button"
                  className="catalog-card flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-neutral-300 text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600 dark:border-neutral-700 dark:hover:border-neutral-500 dark:hover:text-neutral-300"
                >
                  <span aria-hidden className="text-2xl leading-none">＋</span>
                  <span className="text-sm font-medium">新建服务</span>
                  {services.length === 0 ? <span className="text-xs">暂无已登记服务，点击创建</span> : null}
                </button>
              </DialogPrimitive.Trigger>
              <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 dark:bg-black/60" />
                <DialogPrimitive.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl shadow-slate-900/15 dark:border-neutral-700 dark:bg-neutral-900">
                  <DialogPrimitive.Title className="mb-4 text-base font-semibold">新建服务</DialogPrimitive.Title>
                  <form onSubmit={submit} className="flex flex-col gap-3">
                    <ErrorBanner message={formError} />
                    <TextInput
                      aria-label="服务名称"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="服务名称，如 V4-Flash 灰度"
                      required
                      autoFocus
                    />
                    <TextInput
                      aria-label="Router 地址"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="Router 地址，如 http://host:9000"
                      required
                    />
                    <TextInput
                      aria-label="备注"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="备注（选填）"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <Button type="button" variant="ghost" disabled={busy} onClick={() => setCreating(false)}>取消</Button>
                      <Button type="submit" disabled={busy || !name.trim() || !url.trim()}>新建服务</Button>
                    </div>
                  </form>
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            </DialogPrimitive.Root>
          </li>
        </ul>
      )}
    </div>
  );
}
