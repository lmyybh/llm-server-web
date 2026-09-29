"use client";

import { useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";

import { CheckIcon, CopyIcon } from "./icons";
import { VerdictBadge } from "./inspection";
import { Button, ErrorBanner, IconButton, Surface } from "./ui";
import type {
  InspectionCase,
  InspectionCaseDefinition,
  InspectionExchange,
  InspectionRun,
  Service,
} from "../lib/api";

const statusText: Record<string, string> = {
  PASS: "已完成",
  FAIL: "验证失败",
  ERROR: "执行出错",
  SKIPPED: "已跳过",
  INCONCLUSIVE: "无法判定",
};

const failureBadgeClass = "rounded-md bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-950 dark:text-red-300";
const successBadgeClass = "rounded-md bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";

function caseState(run: InspectionRun, caseId: string) {
  const result = run.cases.find((entry) => entry.case_id === caseId);
  if (result) return { result, label: statusText[result.verdict], state: result.verdict };
  if (run.current_case === caseId && (run.status === "running" || run.status === "queued")) {
    return { result: null, label: "执行中", state: "RUNNING" };
  }
  return { result: null, label: "等待", state: "WAITING" };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function curlCommand(exchange: InspectionExchange, apiKeyEnv: string): string {
  let streaming = false;
  try {
    streaming = Boolean(exchange.request_body && JSON.parse(exchange.request_body).stream === true);
  } catch {
    // Deliberately malformed JSON is itself an inspection case.
  }
  const lines = [`curl -i ${streaming ? "-N " : ""}-X ${exchange.method} ${shellQuote(exchange.url)}`];
  if (exchange.content_type) lines.push(`  -H ${shellQuote(`Content-Type: ${exchange.content_type}`)}`);
  if (exchange.auth_required) lines.push(`  -H "Authorization: Bearer \${${apiKeyEnv}}"`);
  if (exchange.request_body !== null) lines.push(`  --data-raw ${shellQuote(exchange.request_body)}`);
  return lines.join(" \\\n");
}

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatEvidence(value: string): string {
  const formatted = formatJson(value);
  if (formatted !== value) return formatted;
  return value.split(/\r?\n/).map((line) => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice(5).trimStart();
    const event = formatJson(data);
    return event === data ? line : `data: ${event.replaceAll("\n", "\n      ")}`;
  }).join("\n");
}

function displayCurlCommand(exchange: InspectionExchange, apiKeyEnv: string): string {
  return curlCommand(
    exchange.request_body === null ? exchange : { ...exchange, request_body: formatJson(exchange.request_body) },
    apiKeyEnv,
  );
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Could not copy text");
}

function CaseMark({ state }: { state: string }) {
  const color = state === "PASS" ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950" :
    state === "FAIL" || state === "ERROR" ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950" :
    state === "RUNNING" ? "border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950" :
    "border-slate-200 bg-slate-100 text-slate-400 dark:border-neutral-700 dark:bg-neutral-800";
  return (
    <span className={`absolute -left-[14px] top-0 flex h-7 w-7 items-center justify-center rounded-full border text-xs font-bold ${color}`} aria-hidden="true">
      {state === "RUNNING" ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" /> :
        state === "PASS" ? "✓" : state === "FAIL" || state === "ERROR" ? "!" : "○"}
    </span>
  );
}

type CopyAction = {
  label: string;
  tooltip: string;
  copied: boolean;
  onClick: () => void;
  error?: string;
};

function CopyOverlay({ action }: { action: CopyAction }) {
  return (
    <div className="absolute right-2 top-2 z-10 rounded-lg border border-blue-200 bg-white shadow-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 dark:border-blue-800 dark:bg-neutral-900">
      <IconButton label={action.label} tooltip={action.copied ? "已复制" : action.tooltip} tone="blue" onClick={action.onClick}>
        {action.copied ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
    </div>
  );
}

function EvidenceSection({ label, value, error = false, formatted = false, copy }: { label: string; value: string; error?: boolean; formatted?: boolean; copy?: CopyAction }) {
  return (
    <section className="mt-6">
      <h4 className="mb-2 text-sm font-semibold">{label}</h4>
      <div className={`group relative rounded-xl border ${error ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300" : "border-slate-200 bg-slate-50 text-slate-700 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"}`}>
        {copy ? <CopyOverlay action={copy} /> : null}
        <pre className="max-h-80 overflow-auto p-4 font-mono text-xs leading-5 whitespace-pre-wrap break-words">{formatted ? formatEvidence(value) : value}</pre>
      </div>
      {copy?.error ? <p role="alert" className="mt-2 text-xs text-red-600">{copy.error}</p> : null}
    </section>
  );
}

function CaseDetail({
  run, service, definition, result, returnFocusToCase,
}: {
  run: InspectionRun;
  service: Service;
  definition: InspectionCaseDefinition;
  result: InspectionCase | null;
  returnFocusToCase: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<{ key: string; message: string } | null>(null);
  const detail = caseState(run, definition.case_id);

  async function copy(value: string, key: string, errorMessage: string) {
    try {
      await copyText(value);
      setCopied(key);
      setCopyError(null);
    } catch {
      setCopyError({ key, message: errorMessage });
    }
  }

  return (
    <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/45" />
        <Dialog.Content onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusToCase(); }} className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[44rem] flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl focus:outline-none dark:border-neutral-700 dark:bg-neutral-900">
          <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5 sm:p-7 dark:border-neutral-800">
            <div className="min-w-0">
              <p className="text-[10px] font-bold tracking-widest text-slate-400">巡检项详情</p>
              <Dialog.Title className="mt-2 text-lg font-semibold">{definition.title}</Dialog.Title>
              <Dialog.Description className="mt-1 break-all font-mono text-xs text-slate-500">
                巡检 #{run.id} · {definition.case_id} · {detail.label}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild><button type="button" aria-label="关闭详情" className="rounded-lg px-2 py-1 text-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-neutral-800">×</button></Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
            <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs sm:grid-cols-3 dark:border-neutral-700 dark:bg-neutral-800/50">
              <div><p className="text-slate-400">状态</p><p className="mt-1 font-semibold">{detail.label}</p></div>
              <div><p className="text-slate-400">请求数</p><p className="mt-1 font-semibold">{result?.evidence?.length ?? 0}</p></div>
              <div><p className="text-slate-400">判定</p><p className="mt-1 font-semibold">{result?.reason_code ?? "—"}</p></div>
            </div>

            {result?.message ? <EvidenceSection label="完整错误或判定信息" value={result.message} error={result.verdict === "FAIL" || result.verdict === "ERROR"} /> : null}

            {result?.evidence?.length ? result.evidence.map((exchange, index) => (
              <section key={index} className="mt-7 border-t border-slate-200 pt-6 dark:border-neutral-800">
                <h3 className="text-sm font-semibold">请求 {index + 1} · {exchange.method} {new URL(exchange.url).pathname}</h3>
                <p className="mt-1 text-xs text-slate-500">{exchange.response_status ? `HTTP ${exchange.response_status}` : "无 HTTP 响应"} · {exchange.latency_ms.toLocaleString()} ms</p>
                <h4 className="mt-5 text-sm font-semibold">复现请求</h4>
                <div className="group relative mt-2 rounded-xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
                  <CopyOverlay action={{ label: `复制请求 ${index + 1} 的 cURL`, tooltip: "复制 cURL", copied: copied === `curl-${index}`, onClick: () => void copy(curlCommand(exchange, service.api_key_env), `curl-${index}`, "复制失败，请手动复制命令。") }} />
                  <pre className="max-h-80 overflow-auto font-mono text-xs leading-5 text-blue-900 dark:text-blue-200">{displayCurlCommand(exchange, service.api_key_env)}</pre>
                </div>
                {copyError?.key === `curl-${index}` ? <p role="alert" className="mt-2 text-xs text-red-600">{copyError.message}</p> : null}
                {exchange.auth_required ? <p className="mt-2 text-[11px] text-slate-500">执行前请在终端设置 {service.api_key_env} 环境变量；命令不包含密钥明文。</p> : null}
                <EvidenceSection label="请求体 · 完整内容" value={exchange.request_body ?? "（无请求体）"} formatted copy={exchange.request_body === null ? undefined : {
                  label: `复制请求 ${index + 1} 的请求体`, tooltip: "复制请求体原文", copied: copied === `request-${index}`,
                  onClick: () => void copy(exchange.request_body ?? "", `request-${index}`, "复制失败，请手动复制请求体。"),
                  error: copyError?.key === `request-${index}` ? copyError.message : undefined,
                }} />
                <EvidenceSection label="响应内容 · 完整内容" value={exchange.response_body || "（无响应内容）"} formatted copy={!exchange.response_body ? undefined : {
                  label: `复制请求 ${index + 1} 的响应内容`, tooltip: "复制响应原文", copied: copied === `response-${index}`,
                  onClick: () => void copy(exchange.response_body, `response-${index}`, "复制失败，请手动复制响应内容。"),
                  error: copyError?.key === `response-${index}` ? copyError.message : undefined,
                }} />
                {exchange.error ? <EvidenceSection label="请求错误" value={exchange.error} error /> : null}
              </section>
            )) : <p className="mt-6 text-sm text-slate-500">{result ? "这条历史用例没有保存请求与响应证据。" : "该用例尚未完成；完成后可在此查看请求、响应和错误信息。"}</p>}
          </div>
        </Dialog.Content>
    </Dialog.Portal>
  );
}

export function InspectionTimeline({ run, service, catalogue }: {
  run: InspectionRun;
  service: Service;
  catalogue: InspectionCaseDefinition[];
}) {
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const caseTrigger = useRef<HTMLButtonElement | null>(null);
  const definitions = new Map(catalogue.map((entry) => [entry.case_id, entry]));
  const total = run.case_ids.length;
  const done = run.completed_cases ?? run.cases.length;
  const percentage = total ? Math.round(done / total * 100) : 0;
  const selected = selectedCase ? definitions.get(selectedCase) : null;
  const failed = run.status === "failed" || (run.status === "completed" && run.verdict === "FAIL");

  return (
    <Dialog.Root open={selectedCase !== null} onOpenChange={(open) => { if (!open) setSelectedCase(null); }}>
    <Surface className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-neutral-800">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            巡检 #{run.id}
            {run.verdict ? <VerdictBadge verdict={run.verdict} /> : null}
            <span className={failed ? failureBadgeClass : `rounded-md px-2 py-0.5 text-[10px] font-semibold ${run.status === "completed" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}>
              {run.status === "queued" ? "排队中" : run.status === "running" ? "执行中" : run.status === "failed" && run.verdict !== "FAIL" ? "执行未完成" : failed ? "失败" : run.status === "completed" ? "已完成" : "已取消"}
            </span>
          </h2>
          <p className="mt-1 text-xs text-slate-500">{new Date(run.queued_at).toLocaleString()} · {total} 项巡检</p>
        </div>
      </div>
      <div className="px-5 py-4">
        <div className="mb-2 flex justify-between text-xs text-slate-500"><span>用例进度 {done} / {total}</span><span>{percentage}%</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-neutral-800"><div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${percentage}%` }} /></div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {run.error ? <div className="px-5"><ErrorBanner message={run.error} /></div> : null}
      <ol className="px-6 pb-6 pt-2 sm:px-8">
        {run.case_ids.map((caseId) => {
          const definition = definitions.get(caseId) ?? { case_id: caseId, title: caseId, group: "" };
          const detail = caseState(run, caseId);
          return (
            <li key={caseId} className="relative ml-3 border-l-2 border-slate-200 pb-4 pl-8 last:border-transparent last:pb-0 dark:border-neutral-800">
              <CaseMark state={detail.state} />
              <Dialog.Trigger asChild><button type="button" onClick={(event) => { caseTrigger.current = event.currentTarget; setSelectedCase(caseId); }} className="flex w-full items-center justify-between gap-3 rounded-lg px-1 pb-2 text-left hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500">
                <span className="min-w-0"><span className="block text-sm font-medium">{definition.title}</span><span className="block truncate font-mono text-[11px] text-slate-400">{caseId}</span></span>
                <span className="flex shrink-0 items-center gap-2"><span className="text-[10px] text-slate-500">{detail.label}</span><span className="text-lg text-slate-400" aria-hidden="true">›</span></span>
              </button></Dialog.Trigger>
            </li>
          );
        })}
      </ol>
      </div>
      {selected ? <CaseDetail run={run} service={service} definition={selected} result={run.cases.find((entry) => entry.case_id === selected.case_id) ?? null} returnFocusToCase={() => caseTrigger.current?.focus({ preventScroll: true })} /> : null}
    </Surface>
    </Dialog.Root>
  );
}

export function InspectionHistory({ runs, activeId, onSelect, onDelete }: {
  runs: InspectionRun[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onDelete: (id: number) => Promise<void>;
}) {
  const [pendingDelete, setPendingDelete] = useState<InspectionRun | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(pendingDelete.id);
      setPendingDelete(null);
    } catch (caught) {
      setDeleteError(caught instanceof Error ? caught.message : "删除巡检记录失败。");
    } finally {
      setDeleting(false);
    }
  }

  const resultStyle = (run: InspectionRun) => {
    if (run.status === "queued") return { label: "排队中", color: "text-slate-500" };
    if (run.status === "running") return { label: "执行中", color: "text-blue-600 dark:text-blue-400" };
    if (run.status === "cancelled") return { label: "已取消", color: "text-slate-500" };
    if (run.verdict === "ERROR") return { label: "执行出错", color: "text-amber-600 dark:text-amber-400" };
    if (run.verdict === "INCONCLUSIVE") return { label: "无法判定", color: "text-amber-600 dark:text-amber-400" };
    if (run.status === "failed" || run.verdict === "FAIL") return { label: "失败", color: failureBadgeClass };
    if (run.verdict === "PASS") return { label: "通过", color: successBadgeClass };
    return { label: "已完成", color: "text-slate-500" };
  };

  return <>
    <Surface className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-slate-200 px-5 py-4 dark:border-neutral-800"><h2 className="text-sm font-semibold">历史巡检</h2><p className="mt-1 text-xs text-slate-500">选择一条记录查看执行过程</p></div>
      {runs.length === 0 ? <p className="px-5 py-8 text-center text-sm text-slate-400">暂无巡检记录。</p> :
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2.5">{runs.map((run) => {
          const row = <li key={run.id} className={`relative rounded-xl border transition-colors ${activeId === run.id ? "border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30" : "border-slate-200/80 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:bg-neutral-800"}`}>
            <button type="button" onClick={() => onSelect(run.id)} aria-current={activeId === run.id ? "true" : undefined} className="block w-full rounded-xl px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-blue-500">
              <span className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-semibold">巡检 #{run.id}</span>
                <span className={`shrink-0 text-[10px] font-semibold ${resultStyle(run).color}`}>{resultStyle(run).label}</span>
              </span>
              <span className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <span className="min-w-0 truncate">{new Date(run.queued_at).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                <span className="shrink-0">{run.completed_cases ?? run.cases?.length ?? 0}/{run.case_ids.length} 完成</span>
              </span>
            </button>
          </li>;
          if (run.status === "queued" || run.status === "running") return row;
          return <ContextMenu.Root key={run.id}>
            <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className="z-50 min-w-36 rounded-xl border border-slate-200 bg-white p-1 shadow-xl shadow-slate-900/10 dark:border-neutral-700 dark:bg-neutral-900">
                <ContextMenu.Item onSelect={() => { setPendingDelete(run); setDeleteError(null); }} className="cursor-pointer select-none rounded-lg px-3 py-2 text-sm text-red-600 outline-none data-[highlighted]:bg-red-50 dark:text-red-400 dark:data-[highlighted]:bg-red-950">
                  删除记录
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>;
        })}</ul>}
    </Surface>
    <Dialog.Root open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !deleting) { setPendingDelete(null); setDeleteError(null); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
          <Dialog.Title className="text-base font-semibold">删除巡检 #{pendingDelete?.id}？</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-6 text-slate-600 dark:text-neutral-400">
            {pendingDelete ? new Date(pendingDelete.queued_at).toLocaleString() : ""} 的巡检记录及其请求、响应和错误详情将被永久删除，无法恢复。
          </Dialog.Description>
          {deleteError ? <div className="mt-4"><ErrorBanner message={deleteError} /></div> : null}
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild><Button variant="ghost" disabled={deleting}>取消</Button></Dialog.Close>
            <Button variant="danger" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "删除中…" : "删除记录"}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}

export function InspectionCaseConfig({ service, catalogue, onSave }: {
  service: Service;
  catalogue: InspectionCaseDefinition[];
  onSave: (caseIds: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(service.enabled_case_ids);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = Array.from(new Set(catalogue.map((entry) => entry.group)));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) { setDraft(service.enabled_case_ids); setError(null); } }}>
      <Dialog.Trigger className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800">配置巡检项</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%_-_2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
          <div className="border-b border-slate-200 p-5 dark:border-neutral-800"><Dialog.Title className="text-base font-semibold">配置巡检项</Dialog.Title><Dialog.Description className="mt-1 text-xs text-slate-500">基础巡检默认不含中断扰动。勾选专项扰动后，新建记录会执行该测试；历史记录保持原样。</Dialog.Description></div>
          <div className="min-h-0 overflow-y-auto px-5 py-3">{groups.map((group) => (
            <section key={group} className="py-2"><h3 className="mb-2 text-xs font-semibold text-slate-500">{group}</h3>{catalogue.filter((entry) => entry.group === group).map((entry) => (
              <label key={entry.case_id} className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-slate-50 dark:hover:bg-neutral-800">
                <input type="checkbox" checked={draft.includes(entry.case_id)} onChange={(event) => setDraft((old) => event.target.checked ? [...old, entry.case_id] : old.filter((id) => id !== entry.case_id))} className="mt-0.5 h-4 w-4 accent-blue-600" />
                <span><span className="block text-sm font-medium">{entry.title}</span><span className="block font-mono text-[11px] text-slate-400">{entry.case_id}</span>{entry.case_id === "disruption.abort_storm" ? <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">专项扰动测试：最多同时发起 36 个请求并主动中断部分连接，完成后检查恢复。</span> : null}</span>
              </label>
            ))}</section>
          ))}</div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-200 p-5 dark:border-neutral-800"><span className="text-xs text-slate-500">已选择 {draft.length} / {catalogue.length} 项</span><div className="flex gap-2"><Dialog.Close className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 dark:border-neutral-700 dark:text-neutral-300">取消</Dialog.Close><Button onClick={() => void save()} disabled={!draft.length || saving}>{saving ? "保存中…" : "保存配置"}</Button></div></div>
          {error ? <div className="px-5 pb-4"><ErrorBanner message={error} /></div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
