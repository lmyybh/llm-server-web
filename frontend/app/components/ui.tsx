"use client";

import { useEffect } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

import Link from "./Link";

/** A quiet icon-only button for card corners; the label is for assistive tech. */
export function IconButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={
        "rounded-md p-1 transition-colors " +
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 " +
        (danger
          ? "text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-red-950 dark:hover:text-red-400"
          : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200")
      }
    >
      {children}
    </button>
  );
}

const INPUT =
  "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none " +
  "placeholder:text-neutral-400 focus:border-neutral-900 disabled:opacity-50 " +
  "dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-100";

const SURFACE =
  "rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint ? <span className="text-xs text-neutral-400 dark:text-neutral-500">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${INPUT} ${className}`} />;
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const palette = {
    primary:
      "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300",
    ghost:
      "border border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800",
    danger:
      "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
  }[variant];
  return (
    <button
      {...props}
      className={
        "rounded-md px-3 py-2 text-sm font-medium transition-colors " +
        "disabled:cursor-not-allowed disabled:opacity-50 " +
        `${palette} ${className}`
      }
    />
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
    >
      {message}
    </div>
  );
}

export function Surface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${SURFACE} ${className}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">{children}</p>
  );
}

/** Where this page sits, as links. The last item is the page itself. */
export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav
      aria-label="面包屑"
      className="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500"
    >
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="flex items-center gap-1.5">
          {index > 0 ? (
            <span aria-hidden className="text-neutral-300 dark:text-neutral-600">
              /
            </span>
          ) : null}
          {item.href ? (
            <Link
              href={item.href}
              className="hover:text-neutral-700 hover:underline dark:hover:text-neutral-200"
            >
              {item.label}
            </Link>
          ) : (
            <span aria-current="page" className="text-neutral-600 dark:text-neutral-300">
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * A centered dialog over a dimmed backdrop. Escape and backdrop clicks both
 * close it — a modal that can only be closed one way is a trap.
 */
export function Modal({
  title,
  onClose,
  className = "",
  children,
}: {
  title: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden
        className="absolute inset-0 bg-black/40 dark:bg-black/60"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full max-w-2xl rounded-xl border border-neutral-200 bg-white p-5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 ${className}`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
