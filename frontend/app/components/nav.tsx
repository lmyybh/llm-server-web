"use client";

import { usePathname } from "next/navigation";

import { stripGatewayPrefix } from "../lib/api";
import Link from "./Link";

type NavItem = {
  href: string;
  label: string;
  /** Which paths this item owns, for the active highlight. */
  owns: (path: string) => boolean;
};

const ITEMS: NavItem[] = [
  {
    href: "/",
    label: "压测",
    owns: (path) =>
      path === "/" || path.startsWith("/models") || path.startsWith("/deployments"),
  },
  { href: "/workloads", label: "负载库", owns: (path) => path.startsWith("/workloads") },
  {
    href: "/services",
    label: "巡检",
    owns: (path) => path.startsWith("/services") || path.startsWith("/inspections"),
  },
];

const ITEM_ICONS: Record<string, string> = { 压测: "◉", 负载库: "▦", 巡检: "⌁" };

/** The sidebar's section links, with the current section highlighted. */
export function Nav() {
  const path = stripGatewayPrefix(usePathname());
  return (
    <nav className="flex flex-col gap-1.5">
      <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-slate-400 max-[720px]:hidden">工作台</p>
      {ITEMS.map((item) => {
        const active = item.owns(path);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all max-[720px]:justify-center max-[720px]:px-0 " +
              (active
                ? "bg-blue-50 font-semibold text-blue-700 shadow-sm shadow-blue-900/[.03] ring-1 ring-blue-100"
                : "text-slate-500 hover:bg-slate-100/80 hover:text-slate-900")
            }
            title={item.label}
          >
            <span className={"grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base " + (active ? "bg-white text-blue-600 shadow-sm" : "text-slate-400 group-hover:text-slate-700")} aria-hidden>
              {ITEM_ICONS[item.label]}
            </span>
            <span className="max-[720px]:hidden">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
