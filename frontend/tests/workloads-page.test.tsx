import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import WorkloadsPage from "../app/workloads/page";
import { fakeApi, makeCell, makeWorkload } from "./helpers";

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement("a", { href }, children),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("an empty library says so", async () => {
  vi.stubGlobal("fetch", fakeApi());
  render(<WorkloadsPage />);
  expect(
    await screen.findByText("还没有负载。新建一个，部署方式下才能配置压测。"),
  ).toBeInTheDocument();
});

test("existing workloads are listed with their shape", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      workloads: [
        makeWorkload({ id: 1, name: "synthetic-1024-128" }),
        makeWorkload({
          id: 2,
          name: "business-claw",
          kind: "dataset",
          input_tokens: null,
          output_tokens: null,
          dataset: "claw",
        }),
      ],
    }),
  );
  render(<WorkloadsPage />);

  expect(await screen.findByText("synthetic-1024-128")).toBeInTheDocument();
  expect(screen.getByText("合成数据 / 输入 1,024 · 输出 128 tokens")).toBeInTheDocument();
  expect(screen.getByText("business-claw")).toBeInTheDocument();
  expect(screen.getByText("真实数据集 / claw")).toBeInTheDocument();
});

test("a synthetic workload can be created", async () => {
  const fetcher = fakeApi();
  vi.stubGlobal("fetch", fetcher);
  render(<WorkloadsPage />);

  await userEvent.click(await screen.findByRole("button", { name: "新建负载" }));
  await userEvent.type(screen.getByLabelText("名称"), "prefill-4k-128");
  await userEvent.type(screen.getByLabelText("输入 tokens"), "4096");
  await userEvent.type(screen.getByLabelText("输出 tokens"), "128");
  await userEvent.click(screen.getByRole("button", { name: "创建" }));

  expect(await screen.findByText("prefill-4k-128")).toBeInTheDocument();
  const posted = fetcher.mock.calls.find(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/workloads"),
  );
  expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({
    name: "prefill-4k-128",
    kind: "synthetic",
    input_tokens: 4096,
    output_tokens: 128,
  });
});

test("a dataset workload picks from the registered datasets, not free text", async () => {
  const fetcher = fakeApi({
    datasets: [{ name: "claw", path: "/data/claw.jsonl", exists: true }],
  });
  vi.stubGlobal("fetch", fetcher);
  render(<WorkloadsPage />);

  await userEvent.click(await screen.findByRole("button", { name: "新建负载" }));
  await userEvent.type(screen.getByLabelText("名称"), "business-claw");
  await userEvent.click(screen.getByRole("radio", { name: "真实数据集" }));
  await userEvent.click(await screen.findByRole("combobox", { name: "数据集" }));
  await userEvent.click(await screen.findByRole("option", { name: "claw" }));
  await userEvent.click(screen.getByRole("button", { name: "创建" }));

  expect(await screen.findByText("business-claw")).toBeInTheDocument();
  const posted = fetcher.mock.calls.find(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/workloads"),
  );
  expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({
    name: "business-claw",
    kind: "dataset",
    dataset: "claw",
  });
});

test("a duplicate name is reported and the form stays open", async () => {
  vi.stubGlobal("fetch", fakeApi({ workloads: [makeWorkload({ id: 1 })] }));
  render(<WorkloadsPage />);
  await screen.findByText("synthetic-1024-128");

  await userEvent.click(screen.getByRole("button", { name: "新建负载" }));
  await userEvent.type(screen.getByLabelText("名称"), "synthetic-1024-128");
  await userEvent.type(screen.getByLabelText("输入 tokens"), "1024");
  await userEvent.type(screen.getByLabelText("输出 tokens"), "128");
  await userEvent.click(screen.getByRole("button", { name: "创建" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
  expect(screen.getByLabelText("名称")).toHaveValue("synthetic-1024-128");
});

test("a workload referenced by cells cannot be deleted", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      workloads: [makeWorkload({ id: 1 })],
      cells: [makeCell({ id: 1, workload_id: 1 })],
    }),
  );
  render(<WorkloadsPage />);
  await screen.findByText("synthetic-1024-128");

  await userEvent.click(screen.getByRole("button", { name: "删除" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "referenced by 1 cell(s); delete those cells first",
  );
});

test("only the name and note can change after creation", async () => {
  const fetcher = fakeApi({ workloads: [makeWorkload({ id: 1 })] });
  vi.stubGlobal("fetch", fetcher);
  render(<WorkloadsPage />);
  await screen.findByText("synthetic-1024-128");

  await userEvent.click(screen.getByRole("button", { name: "编辑" }));
  const nameField = screen.getByLabelText("名称");
  await userEvent.clear(nameField);
  await userEvent.type(nameField, "prefill-1k-128");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => {
    const patched = fetcher.mock.calls.find((call) => call[1]?.method === "PATCH");
    expect(patched).toBeTruthy();
    expect(JSON.parse(String(patched?.[1]?.body))).toEqual({
      name: "prefill-1k-128",
      note: "",
    });
  });
});
