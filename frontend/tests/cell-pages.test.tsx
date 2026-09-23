import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import DeploymentPage from "../app/deployments/[id]/page";
import { fakeApi, makeCell, makeDeployment, makeModel, makeWorkload } from "./helpers";

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement("a", { href }, children),
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "1" }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const SEED = {
  models: [makeModel({ id: 1 })],
  deployments: [makeDeployment({ id: 1, model_id: 1 })],
};

const WORKLOADS = [
  makeWorkload({ id: 1, name: "synthetic-1024-128" }),
  makeWorkload({
    id: 2,
    name: "business-claw",
    kind: "dataset",
    input_tokens: null,
    output_tokens: null,
    dataset: "claw",
  }),
];

// --- configuring ------------------------------------------------------------

test("a deployment with no cells says how to start", async () => {
  vi.stubGlobal("fetch", fakeApi({ ...SEED, workloads: WORKLOADS }));
  render(<DeploymentPage />);
  expect(await screen.findByText("还没有配置压测，点这里开始")).toBeInTheDocument();
});

test("an empty workload library offers to create one inline", async () => {
  vi.stubGlobal("fetch", fakeApi({ ...SEED, workloads: [] }));
  render(<DeploymentPage />);
  await userEvent.click(await screen.findByRole("button", { name: /添加负载/ }));
  expect(await screen.findByText(/负载库里还没有任何负载/)).toBeInTheDocument();
  expect(screen.getByLabelText("名称")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建并添加" })).toBeInTheDocument();
});

test("adding a workload needs no bench configuration", async () => {
  const fetcher = fakeApi({ ...SEED, workloads: WORKLOADS });
  vi.stubGlobal("fetch", fetcher);
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: /添加负载/ }));
  // The dialog is a workload picker: no mode, no levels, no request count.
  const dialog = await screen.findByRole("dialog", { name: "添加负载" });
  expect(within(dialog).getByLabelText("负载")).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("档位")).not.toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "添加" }));

  expect(await screen.findByText(/已添加，还没有测试项/)).toBeInTheDocument();
  expect(screen.getByText("synthetic-1024-128")).toBeInTheDocument();
  const cellPosts = fetcher.mock.calls.filter(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/cells"),
  );
  expect(cellPosts).toHaveLength(0);
});

test("a workload the library lacks is created inline while adding", async () => {
  const fetcher = fakeApi({ ...SEED, workloads: [] });
  vi.stubGlobal("fetch", fetcher);
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: /添加负载/ }));
  const dialog = await screen.findByRole("dialog", { name: "添加负载" });
  await userEvent.type(within(dialog).getByLabelText("名称"), "prefill-256-64");
  await userEvent.type(within(dialog).getByLabelText("输入 tokens"), "256");
  await userEvent.type(within(dialog).getByLabelText("输出 tokens"), "64");
  await userEvent.click(within(dialog).getByRole("button", { name: "创建并添加" }));

  expect(await screen.findByText("prefill-256-64")).toBeInTheDocument();
  const created = fetcher.mock.calls.find(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/workloads"),
  );
  expect(created).toBeTruthy();
  expect(JSON.parse(String(created?.[1]?.body))).toMatchObject({
    name: "prefill-256-64",
    kind: "synthetic",
    input_tokens: 256,
    output_tokens: 64,
  });
});

test("an added workload with no cells can be removed again", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: WORKLOADS,
      attachments: [{ deployment_id: 1, workload_id: 1 }],
    }),
  );
  render(<DeploymentPage />);

  await screen.findByText(/已添加，还没有测试项/);
  await userEvent.click(screen.getByRole("button", { name: "移除" }));
  await waitFor(() =>
    expect(screen.queryByText("synthetic-1024-128")).not.toBeInTheDocument(),
  );
});

test("workload cards sort by when they joined this deployment, newest last", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: [
        // The library creation order is the *reverse* of the attachment order:
        // sorting must follow added_at, not created_at.
        makeWorkload({ id: 1, name: "added-second", created_at: "2026-09-01T00:00:00+00:00" }),
        makeWorkload({
          id: 2,
          name: "added-first",
          kind: "dataset",
          input_tokens: null,
          output_tokens: null,
          dataset: "claw",
          created_at: "2026-09-10T00:00:00+00:00",
        }),
      ],
      attachments: [
        { deployment_id: 1, workload_id: 2, added_at: "2026-09-18T09:00:00+00:00" },
        { deployment_id: 1, workload_id: 1, added_at: "2026-09-18T10:00:00+00:00" },
      ],
    }),
  );
  render(<DeploymentPage />);

  await screen.findByText("added-first");
  const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
  expect(headings).toEqual(["added-first", "added-second"]);
});

test("a ladder expands into one cell per level", async () => {
  const fetcher = fakeApi({ ...SEED, workloads: WORKLOADS });
  vi.stubGlobal("fetch", fetcher);
  render(<DeploymentPage />);

  await screen.findByText("还没有配置压测，点这里开始");
  await userEvent.click(screen.getByRole("button", { name: /添加负载/ }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "添加负载" })).getByRole("button", {
      name: "添加",
    }),
  );
  await userEvent.click(await screen.findByRole("button", { name: /添加测试/ }));
  await userEvent.type(screen.getByLabelText("档位"), "1, 4, 16");
  await userEvent.click(screen.getByRole("button", { name: "创建 Cell" }));

  expect(await screen.findByRole("button", { name: /^1\s*待运行/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^4\s*待运行/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^16\s*待运行/ })).toBeInTheDocument();

  const posted = fetcher.mock.calls.find(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/cells"),
  );
  expect(posted).toBeTruthy();
  const body = JSON.parse(String(posted?.[1]?.body));
  expect(body).toMatchObject({
    workload_id: 1,
    mode: "concurrency",
    levels: [1, 4, 16],
    num_requests: [64],
  });
});

test("a single request count broadcasts; several pair with the levels", async () => {
  const fetcher = fakeApi({
    ...SEED,
    workloads: WORKLOADS,
    attachments: [{ deployment_id: 1, workload_id: 1 }],
  });
  vi.stubGlobal("fetch", fetcher);
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: /添加测试/ }));
  await userEvent.type(screen.getByLabelText("档位"), "1, 4");
  const requestsField = screen.getByLabelText("请求数量");
  await userEvent.clear(requestsField);
  await userEvent.type(requestsField, "32, 128");
  await userEvent.click(screen.getByRole("button", { name: "创建 Cell" }));

  expect(await screen.findByRole("button", { name: /^1\s*待运行/ })).toBeInTheDocument();
  const posted = fetcher.mock.calls.find(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/cells"),
  );
  expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({
    levels: [1, 4],
    num_requests: [32, 128],
  });
});

test("several request counts must match the ladder's length", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ ...SEED, workloads: WORKLOADS, attachments: [{ deployment_id: 1, workload_id: 1 }] }),
  );
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: /添加测试/ }));
  await userEvent.type(screen.getByLabelText("档位"), "1, 4");
  const requestsField = screen.getByLabelText("请求数量");
  await userEvent.clear(requestsField);
  await userEvent.type(requestsField, "32, 64, 128");

  expect(await screen.findByText(/请求数量与档位数量不一致/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建 Cell" })).toBeDisabled();
});

test("ladders are sets: out-of-order and repeated input is normalised", async () => {
  const fetcher = fakeApi({
    ...SEED,
    workloads: WORKLOADS,
    attachments: [{ deployment_id: 1, workload_id: 1 }],
  });
  vi.stubGlobal("fetch", fetcher);
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: /添加测试/ }));
  await userEvent.type(screen.getByLabelText("档位"), "16, 1, 1");
  await userEvent.click(screen.getByRole("button", { name: "创建 Cell" }));

  expect(await screen.findByRole("button", { name: /^1\s*待运行/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^16\s*待运行/ })).toBeInTheDocument();
  const posted = fetcher.mock.calls.find(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/cells"),
  );
  expect(JSON.parse(String(posted?.[1]?.body)).levels).toEqual([1, 16]);
});

test("a level the workload already has is marked and skipped, not a 409", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: WORKLOADS,
      cells: [makeCell({ id: 1, level: 8, status: "idle" })],
    }),
  );
  render(<DeploymentPage />);
  await screen.findByRole("button", { name: /^8\s*待运行/ });

  await userEvent.click(screen.getByRole("button", { name: /添加测试/ }));
  await userEvent.type(screen.getByLabelText("档位"), "8");

  expect(await screen.findByText(/已存在：8/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建 Cell" })).toBeDisabled();
});

test("an unusable token is called out and blocks submission", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ ...SEED, workloads: WORKLOADS, attachments: [{ deployment_id: 1, workload_id: 1 }] }),
  );
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: /添加测试/ }));
  await userEvent.type(screen.getByLabelText("档位"), "abc");

  expect(await screen.findByText("无法识别的档位：abc")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建 Cell" })).toBeDisabled();
});

test("concurrency levels must be whole numbers; qps levels may be fractional", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ ...SEED, workloads: WORKLOADS, attachments: [{ deployment_id: 1, workload_id: 1 }] }),
  );
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: /添加测试/ }));
  await userEvent.type(screen.getByLabelText("档位"), "1.5");
  expect(await screen.findByText("并发档位必须是整数：1.5")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "创建 Cell" })).toBeDisabled();

  await userEvent.click(screen.getByRole("radio", { name: "QPS" }));
  await userEvent.clear(screen.getByLabelText("档位"));
  await userEvent.type(screen.getByLabelText("档位"), "0.5");
  await userEvent.click(screen.getByRole("button", { name: "创建 Cell" }));
  expect(await screen.findByText("0.5")).toBeInTheDocument();
});

test("the estimate is shown before creating anything", async () => {
  vi.stubGlobal("fetch", fakeApi({ ...SEED, workloads: WORKLOADS }));
  render(<DeploymentPage />);

  await screen.findByText(/还没有配置压测/);
  await userEvent.click(screen.getByRole("button", { name: /添加负载/ }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "添加负载" })).getByRole("button", {
      name: "添加",
    }),
  );
  await userEvent.click(await screen.findByRole("button", { name: /添加测试/ }));
  await userEvent.type(screen.getByLabelText("档位"), "8");
  // The fake prices a cell at 30 seconds; the typed ladder has one level.
  expect(
    await screen.findByText(/预计 30 秒（1 个 Cell · 共 64 个请求/, {}, { timeout: 3000 }),
  ).toBeInTheDocument();
});

// --- running ----------------------------------------------------------------

test("running a cell walks it through queued and running to its metrics", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: WORKLOADS,
      cells: [makeCell({ id: 1, level: 8, status: "idle" })],
    }),
  );
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: "运行" }));
  expect(await screen.findByText("排队中")).toBeInTheDocument();
  // The fake advances one step per poll; completed is where it settles.
  expect(await screen.findByText("已完成", {}, { timeout: 5000 })).toBeInTheDocument();
});

test("a running cell can be cancelled", async () => {
  const fetcher = fakeApi({
    ...SEED,
    workloads: WORKLOADS,
    cells: [makeCell({ id: 1, level: 8, status: "running", started_at: "2026-09-17T00:00:01+00:00" })],
  });
  vi.stubGlobal("fetch", fetcher);
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: "停止" }));
  expect(await screen.findByText("已取消")).toBeInTheDocument();
  const cancelled = fetcher.mock.calls.filter(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/cancel"),
  );
  expect(cancelled).toHaveLength(1);
});

test("a running cell shows which phase it is in and how far through", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: WORKLOADS,
      cells: [
        makeCell({
          id: 1,
          level: 8,
          status: "running",
          started_at: "2026-09-17T00:00:01+00:00",
          progress: { phase: "测量", completed_requests: 12, total_requests: 64 },
        }),
      ],
    }),
  );
  render(<DeploymentPage />);

  expect(await screen.findByText("测量中 · 12/64")).toBeInTheDocument();
});

test("Run All queues every cell in the panel, finished or not", async () => {
  const fetcher = fakeApi({
    ...SEED,
    workloads: WORKLOADS,
    cells: [
      makeCell({ id: 1, level: 1, status: "idle" }),
      makeCell({ id: 2, level: 4, status: "failed", error: "executor exited with code 1" }),
      makeCell({ id: 3, level: 8 }),
    ],
  });
  vi.stubGlobal("fetch", fetcher);
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: "Run All" }));

  const posted = fetcher.mock.calls.find(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/cells/run"),
  );
  expect(posted).toBeTruthy();
  expect(JSON.parse(String(posted?.[1]?.body)).cell_ids).toEqual([1, 2, 3]);
});

test("Run All leaves in-flight cells alone", async () => {
  const fetcher = fakeApi({
    ...SEED,
    workloads: WORKLOADS,
    cells: [
      makeCell({
        id: 1,
        level: 1,
        status: "running",
        started_at: "2026-09-17T00:00:01+00:00",
        progress: { phase: "测量", completed_requests: 3, total_requests: 64 },
      }),
      makeCell({ id: 2, level: 4, status: "idle" }),
    ],
  });
  vi.stubGlobal("fetch", fetcher);
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: "Run All" }));

  const posted = fetcher.mock.calls.find(
    (call) => call[1]?.method === "POST" && String(call[0]).endsWith("/cells/run"),
  );
  expect(JSON.parse(String(posted?.[1]?.body)).cell_ids).toEqual([2]);
});

test("the ⋯ menu holds edit, duplicate and delete", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ ...SEED, workloads: WORKLOADS, cells: [makeCell({ id: 1, level: 8, status: "idle" })] }),
  );
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
  const menu = screen.getByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "编辑参数" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "复制" })).toBeInTheDocument();

  await userEvent.click(within(menu).getByRole("menuitem", { name: "删除" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已删除该测试项");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /^8\s*待运行/ })).not.toBeInTheDocument(),
  );
});

test("duplicating a cell prefills the add-test dialog", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ ...SEED, workloads: WORKLOADS, cells: [makeCell({ id: 1, level: 8, status: "idle" })] }),
  );
  render(<DeploymentPage />);

  await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "复制" }));

  const dialog = await screen.findByRole("dialog", { name: "添加测试" });
  expect(within(dialog).getByLabelText("档位")).toHaveValue("8");
  expect(within(dialog).getByLabelText("请求数量")).toHaveValue("64");
  expect(await within(dialog).findByText(/已存在：8/)).toBeInTheDocument();
});

test("the header summarizes running and pending cells", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: WORKLOADS,
      cells: [
        makeCell({ id: 1, level: 1, status: "running", started_at: "2026-09-17T00:00:01+00:00" }),
        makeCell({ id: 2, level: 4, status: "idle" }),
        makeCell({ id: 3, level: 16, status: "idle" }),
      ],
    }),
  );
  render(<DeploymentPage />);

  expect(await screen.findByText("1 项运行中")).toBeInTheDocument();
  expect(screen.getByText("2 项待运行")).toBeInTheDocument();
});

test("a running cell shows a thin progress bar", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: WORKLOADS,
      cells: [
        makeCell({
          id: 1,
          level: 8,
          status: "running",
          started_at: "2026-09-17T00:00:01+00:00",
          progress: { phase: "测量", completed_requests: 12, total_requests: 64 },
        }),
      ],
    }),
  );
  render(<DeploymentPage />);

  const bar = await screen.findByRole("progressbar");
  expect(bar).toHaveAttribute("aria-valuenow", "19");
});

// --- results ----------------------------------------------------------------

test("a completed cell opens its results — metrics, curves, histograms — in a dialog", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: WORKLOADS,
      cells: [makeCell({ id: 1, level: 8 })],
    }),
  );
  render(<DeploymentPage />);

  // The card stays a control surface: clicking a completed row opens the dialog.
  const row = await screen.findByRole("button", { name: /8\s*已完成/ });
  expect(screen.queryByRole("region", { name: "指标曲线" })).not.toBeInTheDocument();

  await userEvent.click(row);
  const dialog = await screen.findByRole("dialog", { name: "并发 8 · 压测结果" });
  expect(within(dialog).getByText("64/64")).toBeInTheDocument();
  expect(within(dialog).getByText("788.7 ms")).toBeInTheDocument();
  expect(within(dialog).getByText("TTFT 分布（ms）")).toBeInTheDocument();

  const charts = within(dialog).getByRole("region", { name: "指标曲线" });
  for (const metric of ["TTFT p99", "TPOT p99", "E2E p99", "输出吞吐", "成功率"]) {
    expect(within(charts).getByText(new RegExp(metric))).toBeInTheDocument();
  }

  const download = within(dialog).getByRole("link", { name: /下载全部产物/ });
  expect(download).toHaveAttribute("href", "/api/cells/1/artifacts.zip");
});

test("the timing caveat is stated where the numbers are", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ ...SEED, workloads: WORKLOADS, cells: [makeCell({ id: 1, level: 8 })] }),
  );
  render(<DeploymentPage />);
  await userEvent.click(await screen.findByRole("button", { name: /8\s*已完成/ }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/服务时间/)).toBeInTheDocument();
  expect(within(dialog).getByText(/排队等待并发许可的时间不计入/)).toBeInTheDocument();
});

test("a qps group labels its axis as offered rate", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: WORKLOADS,
      cells: [makeCell({ id: 1, mode: "qps", level: 4 })],
    }),
  );
  render(<DeploymentPage />);
  await userEvent.click(await screen.findByRole("button", { name: /4\s*已完成/ }));
  const charts = within(await screen.findByRole("dialog")).getByRole("region", {
    name: "指标曲线",
  });
  expect(within(charts).getAllByText("提供的 QPS").length).toBeGreaterThan(0);
});

// --- staleness ---------------------------------------------------------------

test("editing num_requests marks the old result as from an older configuration", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      ...SEED,
      workloads: WORKLOADS,
      cells: [makeCell({ id: 1, level: 8 })],
    }),
  );
  render(<DeploymentPage />);

  // A completed row opens its results; the editor lives behind 编辑参数.
  await userEvent.click(await screen.findByRole("button", { name: "更多操作" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "编辑参数" }));
  const editor = await screen.findByLabelText("新的每档请求数");
  await userEvent.clear(editor);
  await userEvent.type(editor, "128");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByText(/结果来自旧配置/)).toBeInTheDocument();
});
