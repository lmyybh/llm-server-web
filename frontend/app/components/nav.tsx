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

/** The sidebar's section links, with the current section highlighted. */
export function Nav() {
  const path = stripGatewayPrefix(usePathname());
  return (
    <nav className="flex flex-col gap-1 p-3">
      {ITEMS.map((item) => {
        const active = item.owns(path);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              "rounded-md px-3 py-2 text-sm " +
              (active
                ? "bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                : "text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100")
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
