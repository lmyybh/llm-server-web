import type { ReactNode } from "react";

export type SidebarItem = { href: string; label: string; icon: ReactNode; active: boolean };
type LinkProps = { href: string; title: string; className: string; "aria-current"?: "page"; children: ReactNode };

/** Shared sidebar presentation for app routes and report section anchors. */
export function SidebarNav({ sections, renderLink = (props) => <a {...props} /> }: {
  sections: { label: string; items: SidebarItem[] }[];
  renderLink?: (props: LinkProps) => ReactNode;
}) {
  return <nav className="flex h-full flex-col gap-6">
    {sections.map((section, index) => <div key={section.label} className={`flex flex-col gap-1.5 ${index > 0 ? "mt-auto border-t border-slate-200/80 pt-5" : ""}`}>
      <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[.16em] text-slate-400 max-[720px]:hidden">{section.label}</p>
      {section.items.map(item => <div key={item.href}>{renderLink({
        href: item.href, title: item.label, "aria-current": item.active ? "page" : undefined,
        className: "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all max-[720px]:justify-center max-[720px]:px-0 " + (item.active
          ? "bg-blue-50 font-semibold text-blue-700 shadow-sm shadow-blue-900/[.03] ring-1 ring-blue-100"
          : "text-slate-500 hover:bg-slate-100/80 hover:text-slate-900"),
        children: <><span className={"grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base " + (item.active ? "bg-white text-blue-600 shadow-sm" : "text-slate-400 group-hover:text-slate-700")} aria-hidden>{item.icon}</span><span className="max-[720px]:hidden">{item.label}</span></>,
      })}</div>)}
    </div>)}
  </nav>;
}
