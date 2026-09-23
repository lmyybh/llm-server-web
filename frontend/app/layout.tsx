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
        <div className="flex min-h-screen flex-col bg-[#F3F5F8] text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
          <header className="border-b border-neutral-200 bg-white px-6 py-3 dark:border-neutral-800 dark:bg-neutral-900">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              LLM 压测与巡检
            </Link>
          </header>
          <div className="flex flex-1">
            <aside className="w-44 shrink-0 border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
              <Nav />
            </aside>
            <main className="min-w-0 flex-1 px-8 py-8">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
