import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "./components/Link";
import { Nav } from "./components/nav";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "LLM 压测与巡检",
  description: "对 LLM 推理服务做性能压测与接口巡检",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <div className="flex h-[100dvh] flex-col overflow-hidden text-slate-900">
          <header className="z-30 flex h-[68px] shrink-0 items-center justify-between border-b border-slate-200/80 bg-white/90 px-5 backdrop-blur-xl sm:px-8">
            <Link href="/" className="group flex items-center gap-3 text-sm font-semibold tracking-tight text-slate-900">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-blue-600 to-cyan-500 text-white shadow-md shadow-blue-600/20" aria-hidden>
                <span className="text-base">✳</span>
              </span>
              <span>LLM 压测与巡检<span className="ml-2 hidden rounded-md bg-slate-100 px-1.5 py-0.5 align-middle text-[10px] font-medium tracking-wide text-slate-500 sm:inline">控制台</span></span>
            </Link>
            <div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex">
              <span className="h-2 w-2 rounded-full bg-emerald-500 ring-4 ring-emerald-50" />
              推理服务工作台
            </div>
          </header>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <aside className="w-56 shrink-0 border-r border-slate-200/80 bg-white/75 px-3 py-6 backdrop-blur-sm max-[720px]:w-16 max-[720px]:px-2">
              <Nav />
            </aside>
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-8 py-9 lg:px-12">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
