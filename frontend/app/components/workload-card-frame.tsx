import type { ReactNode } from "react";

export function WorkloadCardFrame({ children }: { children: ReactNode }) {
  return <li className="workload-card flex min-w-0 flex-col gap-4 rounded-[18px] border border-neutral-200 bg-white p-4 shadow-sm [container-type:inline-size] dark:border-neutral-800 dark:bg-neutral-900">
    {children}
  </li>;
}
