"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { api, type InspectionProject, type InspectionProjectSettings } from "../lib/api";
import { Button, ErrorBanner, SelectInput } from "../components/ui";
import "./projects.css";

const palettes: Record<string, string> = {
  基础接口: "basic", 异常输入: "invalid", 边界行为: "boundary",
  可选能力: "optional", 扰动恢复: "disruption",
};

function GroupBadge({ group }: { group: string }) {
  const hash = Array.from(group).reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  const palette = palettes[group] ?? Object.values(palettes)[hash % Object.values(palettes).length];
  return <span className={`inspection-group inspection-group-${palette}`}><i aria-hidden />{group}</span>;
}

function DefaultSwitch({ item, disabled, onChange }: { item: InspectionProject; disabled: boolean; onChange: () => void }) {
  return <button type="button" role="switch" aria-label={`${item.title}：新服务默认选中`}
    aria-checked={item.default_enabled} disabled={disabled} onClick={onChange}
    className="project-switch"><span /></button>;
}

export default function InspectionProjectsPage() {
  const [items, setItems] = useState<InspectionProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [scope, setScope] = useState("");
  const [selected, setSelected] = useState<InspectionProject | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try { setItems(await api.listInspectionProjects()); }
    catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function update(item: InspectionProject, changes: Partial<InspectionProjectSettings>) {
    setBusy(true); setError(null); setNotice("");
    try {
      const saved = await api.updateInspectionProject(item.case_id, changes);
      setItems(current => current.map(c => c.case_id === saved.case_id ? saved : c));
      if (group === item.group && saved.group !== item.group) setGroup("");
      setNotice("已保存");
      return saved;
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
      return null;
    } finally { setBusy(false); }
  }
  async function reset() {
    setBusy(true); setError(null); setNotice("");
    try { setItems(await api.resetInspectionProjects()); setGroup(""); setResetOpen(false); setNotice("已恢复初始设置"); }
    catch (e) { setError(e instanceof Error ? e.message : "恢复失败"); }
    finally { setBusy(false); }
  }
  const q = query.trim().toLowerCase();
  const groups = Array.from(new Set([...Object.keys(palettes), ...items.map(c => c.group)]));
  const filtered = items.filter(c =>
    (!q || [c.title, c.case_id, c.description].some(text => text.toLowerCase().includes(q))) &&
    (!group || c.group === group) && (!scope || c.default_enabled === (scope === "on")));

  return <section className="inspection-projects">
    <div className="project-heading">
      <div className="project-heading-info"><h1>巡检项目</h1>
        {!loading && <div className="project-summary"><span><b>{items.length}</b> 个内置项目</span>
          <span><b>{items.filter(c => c.default_enabled).length}</b> 项默认选中</span>
          {items[0] && <span className="project-version">用例集 v{items[0].suite_version}</span>}
        </div>}
      </div>
      <button className="project-control" disabled={busy || loading || !items.length} onClick={() => setResetOpen(true)}>恢复初始设置</button>
    </div>
    <p className="project-hint">默认选择只用于新建服务；超时设置用于后续巡检，正在执行的任务不受影响。</p>
    {!selected && !resetOpen && <ErrorBanner message={error} />}
    <div className="project-toolbar">
      <input className="project-control project-search" type="search" aria-label="搜索巡检项目" placeholder="搜索项目名称或检查内容" value={query} onChange={e => setQuery(e.target.value)} />
      <SelectInput ariaLabel="按分组筛选" value={group ? `group:${group}` : "all"}
        onValueChange={value => setGroup(value === "all" ? "" : value.slice(6))}
        options={[{ value: "all", label: "全部分组" }, ...groups.map(g => ({ value: `group:${g}`, label: g }))]} />
      <SelectInput ariaLabel="按默认选择筛选" value={scope || "all"}
        onValueChange={value => setScope(value === "all" ? "" : value)}
        options={[{ value: "all", label: "全部项目" }, { value: "on", label: "默认选中" }, { value: "off", label: "按需选择" }]} />
      <span className="project-count">{loading ? "加载中…" : `显示 ${filtered.length} / ${items.length} 项`}</span>
    </div>
    <div className="project-table" tabIndex={0} aria-label="巡检项目列表" aria-busy={loading}>
      <table><thead><tr><th>巡检项目</th><th>分组</th><th>超时</th><th>新服务默认选中</th><th><span className="sr-only">操作</span></th></tr></thead>
        <tbody>{filtered.map(item => <tr key={item.case_id}>
          <td><button className="project-name" onClick={() => { setError(null); setSelected(item); }}>{item.title}</button>
            <span className="project-id">{item.case_id}</span><p className="project-description">{item.description}</p></td>
          <td><GroupBadge group={item.group} /></td><td className="whitespace-nowrap">{item.timeout_seconds} 秒</td>
          <td><DefaultSwitch item={item} disabled={busy} onChange={() => void update(item, { default_enabled: !item.default_enabled })} /></td>
          <td><button className="project-details" aria-label={`查看${item.title}详情`} onClick={() => { setError(null); setSelected(item); }}>查看详情 ↗</button></td>
        </tr>)}
        {!filtered.length && <tr><td colSpan={5} className="project-empty">{loading ? "正在加载巡检项目…" : error ? <button onClick={() => void load()}>加载失败，点击重试</button> : "没有匹配的巡检项目，请调整搜索或筛选条件。"}</td></tr>}
        </tbody></table>
    </div>
    <div className="project-foot"><span>请求与判断规则为内置定义。</span><span role="status">{notice}</span></div>
    <Dialog.Root open={!!selected} onOpenChange={open => { if (!open && !busy) { setSelected(null); setError(null); } }}>
      <Dialog.Portal><Dialog.Overlay className="project-overlay" /><Dialog.Content className="project-drawer" aria-describedby={undefined}>
        <div className="project-drawer-bar"><Dialog.Title>巡检项目 / 详情与设置</Dialog.Title><Dialog.Close disabled={busy} aria-label="关闭详情">×</Dialog.Close></div>
        {selected && <ProjectEditor key={selected.case_id} item={selected} groups={groups} busy={busy} error={error}
          onSave={async changes => { const saved = await update(selected, changes); if (saved) setSelected(saved); return !!saved; }} />}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    <Dialog.Root open={resetOpen} onOpenChange={open => { if (!busy) { setResetOpen(open); setError(null); } }}>
      <Dialog.Portal><Dialog.Overlay className="project-overlay" /><Dialog.Content className="project-reset">
        <Dialog.Title className="text-lg font-semibold">恢复初始设置</Dialog.Title>
        <Dialog.Description className="my-4 text-sm text-slate-500">将所有项目的名称、分组标签、超时和默认选择恢复为内置值。已保存的服务选择和正在执行的任务不受影响。</Dialog.Description>
        <ErrorBanner message={error} /><div className="mt-5 flex justify-end gap-2"><Dialog.Close asChild><Button variant="ghost" disabled={busy}>取消</Button></Dialog.Close><Button disabled={busy} onClick={() => void reset()}>{busy ? "恢复中…" : "确认恢复"}</Button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </section>;
}

function ProjectEditor({ item, groups, busy, error, onSave }: {
  item: InspectionProject; groups: string[]; busy: boolean; error: string | null;
  onSave: (changes: InspectionProjectSettings) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(item.title);
  const [timeout, setTimeout] = useState(String(item.timeout_seconds));
  const [enabled, setEnabled] = useState(item.default_enabled);
  const [tag, setTag] = useState(item.group);
  const [creatingTag, setCreatingTag] = useState(false);
  const dirty = title !== item.title || tag.trim() !== item.group || Number(timeout) !== item.timeout_seconds || enabled !== item.default_enabled;
  function discard() { setTitle(item.title); setTag(item.group); setCreatingTag(false); setTimeout(String(item.timeout_seconds)); setEnabled(item.default_enabled); }
  return <form className="project-editor" onSubmit={async e => {
    e.preventDefault();
    const name = title.trim();
    if (!name || !tag.trim()) return;
    if (await onSave({ title: name, group: tag.trim(), timeout_seconds: Number(timeout), default_enabled: enabled })) {
      setTitle(name); setTag(tag.trim()); setCreatingTag(false);
    }
  }}>
    <div className="flex items-start justify-between gap-3"><h2 className="text-xl font-semibold">{item.title}</h2><GroupBadge group={item.group} /></div>
    <span className="project-id">{item.case_id}</span><p className="mt-3 text-xs text-slate-500">{item.description}</p>
    <section><h3>怎么执行</h3><ol className="project-steps">{item.steps.map((step, i) => <li key={step}><span>{i + 1}</span>{step}</li>)}</ol></section>
    <section><h3>怎么判断</h3><dl className="project-rules">
      <dt className="text-emerald-600">通过</dt><dd>{item.pass_rule}</dd>
      <dt className="text-rose-600">失败</dt><dd>{item.fail_rule}</dd>
      <dt className="text-amber-600">其他情况</dt><dd>{item.other_rule}</dd>
    </dl></section>
    <section><h3>执行设置</h3><fieldset disabled={busy} className="space-y-4">
      <div className="project-field"><span>分组标签</span>
        <SelectInput ariaLabel="分组标签" disabled={busy}
          value={creatingTag ? "create" : `group:${tag}`}
          onValueChange={value => { setCreatingTag(value === "create"); setTag(value === "create" ? "" : value.slice(6)); }}
          options={[...groups.map(g => ({ value: `group:${g}`, label: g })), { value: "create", label: "＋ 输入新标签" }]} />
        {creatingTag && <label className="project-field">新标签名称
          <input className="project-control" aria-label="新标签名称" required maxLength={30} value={tag} onChange={e => setTag(e.target.value)} placeholder="输入标签名称" />
          <small>{tag.trim() && groups.includes(tag.trim()) ? "标签已存在，保存时使用已有标签。" : "保存时自动创建标签，并加入筛选列表。"}</small>
        </label>}
      </div>
      <label className="project-field">项目名称<input className="project-control" required maxLength={60} pattern=".*\S.*" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <div className="grid grid-cols-2 gap-5"><label className="project-field">执行超时（秒）<input className="project-control w-28" required type="number" min={1} max={900} step={1} value={timeout} onChange={e => setTimeout(e.target.value)} /><small>用于后续巡检。{item.case_id === "disruption.abort_storm" && "恢复检查另有 30 秒预算。"}</small></label>
        <label className="text-xs"><span className="flex items-center gap-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />新服务默认选中</span><small className="mt-3 block text-slate-400">不改动已有服务的选择。</small></label></div>
    </fieldset></section>
    <section><h3>内置请求入口 <span className="font-normal text-slate-400">只读</span></h3><pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-xs">{item.endpoint}</pre></section>
    <ErrorBanner message={error} />
    <div className="project-editor-actions"><span className="mr-auto text-xs text-slate-400">{dirty ? "有未保存的修改" : "已同步"}</span><Button variant="ghost" type="button" disabled={busy || !dirty} onClick={discard}>撤销修改</Button><Button disabled={busy || !dirty || !title.trim() || !tag.trim()} type="submit">{busy ? "保存中…" : "保存更改"}</Button></div>
  </form>;
}
