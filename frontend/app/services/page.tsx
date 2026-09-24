"use client";

import { useCallback, useEffect, useState } from "react";

import Link from "../components/Link";
import { Button, Empty, ErrorBanner, Field, Surface, TextInput } from "../components/ui";
import { api, describe, type Service } from "../lib/api";

export default function ServicesPage() {
  const [services, setServices] = useState<Service[] | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    try {
      await api.createService({ name, note, router_url: url });
      setName("");
      setUrl("");
      setNote("");
      await refresh();
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">服务巡检</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500 dark:text-neutral-400">
          巡检的对象。与压测的模型 / 部署方式是两套独立的记录——巡检关心的是&quot;这个服务现在还正常吗&quot;，
          与它服务哪个模型无关。
        </p>
      </div>

      <ErrorBanner message={error} />

      <Surface>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-48 flex-1">
            <Field label="名称">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="V4-Flash 灰度" required />
            </Field>
          </div>
          <div className="min-w-64 flex-[2]">
            <Field label="Router 地址">
              <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://host:9000" required />
            </Field>
          </div>
          <div className="min-w-48 flex-1">
            <Field label="备注">
              <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="选填" />
            </Field>
          </div>
          <Button type="submit" disabled={busy || !name.trim() || !url.trim()}>
            新建服务
          </Button>
        </form>
      </Surface>

      <Surface>
        {services === null ? (
          <Empty>加载中…</Empty>
        ) : services.length === 0 ? (
          <Empty>还没有登记服务。在上面建一个才能巡检。</Empty>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {services.map((service) => (
          <li key={service.id} className="border-b border-slate-100 last:border-0">
                <Link
                  href={`/services/${service.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-blue-50/50 dark:hover:bg-neutral-800/50"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">{service.name}</span>
                    <span className="truncate font-mono text-xs text-neutral-500 dark:text-neutral-400">
                      {service.router_url}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">巡检 →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}
