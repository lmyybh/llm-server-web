import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Nav } from "../app/components/nav";

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
      React.createElement("a", { href, ...rest }, children),
  };
});

let pathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

afterEach(() => {
  pathname = "/";
});

test("the section owning the current path is the current page", () => {
  pathname = "/deployments/3";
  render(<Nav />);
  expect(screen.getByRole("link", { name: "压测" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "巡检" })).not.toHaveAttribute("aria-current");
});

test("the workload library owns its own path", () => {
  pathname = "/workloads";
  render(<Nav />);
  expect(screen.getByRole("link", { name: "负载库" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "压测" })).not.toHaveAttribute("aria-current");
});

test("an inspection detail belongs to the inspection section", () => {
  pathname = "/inspections/7";
  render(<Nav />);
  expect(screen.getByRole("link", { name: "巡检" })).toHaveAttribute("aria-current", "page");
});
