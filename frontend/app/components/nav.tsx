"use client";

import { usePathname } from "next/navigation";

import { stripGatewayPrefix } from "../lib/api";
import Link from "./Link";
import { SidebarNav } from "./sidebar-nav";

type NavItem = {
  href: string;
  label: string;
  /** Which paths this item owns, for the active highlight. */
  owns: (path: string) => boolean;
};

const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: "工作台",
    items: [
      {
        href: "/",
        label: "压测",
        owns: (path) =>
          path === "/" || path.startsWith("/models") || path.startsWith("/deployments"),
      },
      {
        href: "/services",
        label: "巡检",
        owns: (path) => path.startsWith("/services") || path.startsWith("/inspections"),
      },
    ],
  },
  {
    label: "配置管理",
    items: [
      { href: "/workloads", label: "负载库", owns: (path) => path.startsWith("/workloads") },
      { href: "/suites", label: "压测组合", owns: (path) => path.startsWith("/suites") },
      { href: "/inspection-projects", label: "巡检项目", owns: (path) => path.startsWith("/inspection-projects") },
    ],
  },
];

const ITEM_ICONS: Record<string, string> = { 压测: "◉", 负载库: "▦", 压测组合: "▤", 巡检: "⌁", 巡检项目: "☷" };

/** The sidebar's section links, with the current section highlighted. */
export function Nav() {
  const path = stripGatewayPrefix(usePathname());
  return <SidebarNav sections={SECTIONS.map(section => ({
    label: section.label,
    items: section.items.map(item => ({ ...item, active: item.owns(path), icon: ITEM_ICONS[item.label] })),
  }))} renderLink={props => <Link {...props} />} />;
}
