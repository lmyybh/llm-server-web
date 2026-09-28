"use client";

import type { CaseVerdict, InspectionCase } from "../lib/api";

/**
 * Unlike the bench charts, colour here *is* a verdict — and that is the point.
 *
 * A performance curve is a measurement the reader interprets; colouring it
 * would answer a question they came to answer themselves. An inspection case
 * is a categorical claim the tool already made, and a red light is how it gets
 * read at a glance. Four states, not two: "could not tell" and "not applicable"
 * are different from both "fine" and "broken", and flattening them is how a
 * tool starts lying by omission.
 */
const VERDICT_STYLES: Record<CaseVerdict, string> = {
  PASS: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  FAIL: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  INCONCLUSIVE: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  SKIPPED: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  ERROR: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

const VERDICT_LABELS: Record<CaseVerdict, string> = {
  PASS: "通过",
  FAIL: "失败",
  INCONCLUSIVE: "无法判定",
  SKIPPED: "跳过",
  ERROR: "执行出错",
};

export function VerdictBadge({ verdict }: { verdict: CaseVerdict }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${VERDICT_STYLES[verdict]}`}>
      {VERDICT_LABELS[verdict]}
    </span>
  );
}

export function CaseList({ cases }: { cases: InspectionCase[] }) {
  if (cases.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-neutral-400">暂无用例结果。</p>;
  }
  return (
    <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {cases.map((entry) => (
        <li key={entry.case_id} className="flex flex-col gap-1 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <VerdictBadge verdict={entry.verdict} />
            <span className="font-mono text-sm">{entry.case_id}</span>
            {entry.required ? null : (
              <span className="text-xs text-neutral-400">非必需</span>
            )}
          </div>
          {entry.message ? (
            <p className="whitespace-pre-wrap font-mono text-xs text-neutral-500 dark:text-neutral-400">
              {entry.message}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
