"use client";

import { useEffect } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";

import Link from "./Link";

/** A quiet icon-only button for card corners; the label is for assistive tech. */
export function IconButton({
  label,
  danger = false,
  tone,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  tone?: "blue" | "red";
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
        "rounded-lg p-1.5 transition-colors " +
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 " +
        (tone === "blue"
          ? "text-blue-600 hover:bg-blue-50 hover:text-blue-700 dark:text-blue-400 dark:hover:bg-blue-950"
          : tone === "red"
          ? "text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950"
          : danger
          ? "text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-red-950 dark:hover:text-red-400"
          : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200")
      }
    >
      {children}
    </button>
  );
}

const INPUT =
  "rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 shadow-sm shadow-slate-900/[.025] outline-none " +
  "placeholder:text-slate-400 focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50 " +
  "dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-blue-400";

const SURFACE =
  "rounded-2xl border border-slate-200/90 bg-white shadow-sm shadow-slate-900/[.035] dark:border-neutral-800 dark:bg-neutral-900";

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

export function SelectInput({
  value,
  onValueChange,
  options,
  placeholder = "请选择…",
  ariaLabel,
  disabled = false,
  compact = false,
  title,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  compact?: boolean;
  title?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled || options.length === 0}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        title={title}
        className={
          "inline-flex max-w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white text-left text-slate-800 shadow-sm shadow-slate-900/[.025] outline-none " +
          "focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50 " +
          "dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-blue-400 " +
          (compact ? "py-1.5 pl-3 pr-2.5 text-base font-semibold tracking-tight" : "w-full px-3.5 py-2.5 text-sm")
        }
      >
        <span className="min-w-0 truncate"><SelectPrimitive.Value placeholder={placeholder} /></span>
        <SelectPrimitive.Icon className="shrink-0 text-slate-400">
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4">
            <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={6} className="z-[60] min-w-[var(--radix-select-trigger-width)] max-w-[min(90vw,28rem)] overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-xl shadow-slate-900/10 dark:border-neutral-700 dark:bg-neutral-900">
          <SelectPrimitive.Viewport className="max-h-[min(18rem,var(--radix-select-content-available-height))]">
            {options.map((option) => (
              <SelectPrimitive.Item key={option.value} value={option.value} className="relative flex cursor-pointer select-none items-center rounded-lg py-2 pl-3 pr-9 text-sm text-slate-700 outline-none data-[highlighted]:bg-blue-50 data-[highlighted]:text-blue-700 dark:text-neutral-200 dark:data-[highlighted]:bg-blue-950 dark:data-[highlighted]:text-blue-300">
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-3 text-blue-600">✓</SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const palette = {
    primary:
      "bg-blue-600 text-white shadow-sm shadow-blue-700/20 hover:bg-blue-700 active:bg-blue-800 dark:bg-blue-500 dark:text-white dark:hover:bg-blue-400",
    ghost:
      "border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50 hover:text-slate-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800",
    danger:
      "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
  }[variant];
  return (
    <button
      {...props}
      className={
        "rounded-xl px-4 py-2.5 text-sm font-semibold transition-all " +
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
      className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
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
              className="font-medium text-slate-500 hover:text-blue-700 hover:underline dark:hover:text-neutral-200"
            >
              {item.label}
            </Link>
          ) : (
            <span aria-current="page" className="font-medium text-slate-700 dark:text-neutral-300">
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
        className={`relative w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl shadow-slate-900/15 dark:border-neutral-700 dark:bg-neutral-900 ${className}`}
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
