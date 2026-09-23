import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import ComparePage from "../app/models/[id]/compare/page";
import { fakeApi, makeCell, makeDeployment, makeModel } from "./helpers";

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement("a", { href }, children),
  };
});

let query = "deployments=1,2";
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "1" }),
  useSearchParams: () => new URLSearchParams(query),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  query = "deployments=1,2";
});

const DEPLOYMENTS = [
  makeDeployment({ id: 1, model_id: 1, name: "2P1D-tp8" }),
  makeDeployment({ id: 2, model_id: 1, name: "3P2D-tp4" }),
];

function pairedCells() {
  return [
    makeCell({ id: 1, deployment_id: 1, level: 4, ttft_p99: 800 }),
    makeCell({ id: 2, deployment_id: 1, level: 16, ttft_p99: 1500 }),
    makeCell({ id: 3, deployment_id: 2, level: 4, ttft_p99: 1200 }),
    makeCell({ id: 4, deployment_id: 2, level: 16, ttft_p99: 2600 }),
  ];
}

test("one deployment is not a comparison", async () => {
  query = "deployments=1";
  vi.stubGlobal("fetch", fakeApi({}));
  render(<ComparePage />);
  expect(await screen.findByText(/至少需要勾选两个部署方式/)).toBeInTheDocument();
});

test("deployments with no shared measurements are told what is missing", async () => {
  vi.stubGlobal("fetch", fakeApi({ models: [makeModel()], deployments: DEPLOYMENTS }));
  render(<ComparePage />);
  expect(
    await screen.findByText(/还没有可比对的测量/),
  ).toBeInTheDocument();
});

test("cells pair up by workload, mode and level without anyone choosing runs", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ models: [makeModel()], deployments: DEPLOYMENTS, cells: pairedCells() }),
  );
  render(<ComparePage />);

  const section = await screen.findByText("synthetic-1024-128");
  expect(section).toBeInTheDocument();
  // The table shows both deployments side by side at the default level.
  expect(screen.getAllByText("2P1D-tp8").length).toBeGreaterThan(0);
  expect(screen.getAllByText("3P2D-tp4").length).toBeGreaterThan(0);
  expect(screen.getByText("2.60 s")).toBeInTheDocument();
});

test("a level only one side reached is marked 未测, and curves still draw the union", async () => {
  const cells = [
    ...pairedCells(),
    makeCell({ id: 5, deployment_id: 1, level: 64, ttft_p99: 3100 }),
  ];
  vi.stubGlobal(
    "fetch",
    fakeApi({ models: [makeModel()], deployments: DEPLOYMENTS, cells }),
  );
  render(<ComparePage />);

  // Level 64 is on the axis and in the picker (the union); picking it shows
  // 未测 for the deployment that never ran it.
  await screen.findByText("synthetic-1024-128");
  const picker = screen.getByText("档位").closest("div") as HTMLElement;
  expect(within(picker).getByRole("button", { name: "16" })).toBeInTheDocument();
  await userEvent.click(within(picker).getByRole("button", { name: "64" }));
  expect((await screen.findAllByText("未测")).length).toBeGreaterThan(0);
});

test("a section with no common level says so, and shows 未测 rather than hiding levels", async () => {
  const cells = [
    makeCell({ id: 1, deployment_id: 1, level: 4 }),
    makeCell({ id: 2, deployment_id: 2, level: 16 }),
  ];
  vi.stubGlobal(
    "fetch",
    fakeApi({ models: [makeModel()], deployments: DEPLOYMENTS, cells }),
  );
  render(<ComparePage />);

  expect(await screen.findByText(/没有任何大家都测过的档位/)).toBeInTheDocument();
  // The curves still render from the points each side has.
  expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
  // The picker still offers the union, and the table marks the missing side.
  expect(screen.getAllByText("未测").length).toBeGreaterThan(0);
});

test("a stale cell is still shown, with its time, not hidden", async () => {
  const cells = pairedCells();
  cells[0] = { ...cells[0], num_requests: 128, stale: true };
  vi.stubGlobal(
    "fetch",
    fakeApi({ models: [makeModel()], deployments: DEPLOYMENTS, cells }),
  );
  render(<ComparePage />);

  expect((await screen.findAllByText("2P1D-tp8")).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/测于/).length).toBeGreaterThan(0);
});

test("mixed tool versions produce a notice, not a verdict", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel()],
      deployments: DEPLOYMENTS,
      comparison: {
        deployments: [
          { id: 1, name: "2P1D-tp8" },
          { id: 2, name: "3P2D-tp4" },
        ],
        sections: [
          {
            workload: {
              id: 1,
              name: "synthetic-1024-128",
              kind: "synthetic",
              input_tokens: 1024,
              output_tokens: 128,
              dataset: null,
            },
            mode: "concurrency",
            levels: [4],
            no_common_levels: false,
            notices: ["负载发生器版本不一致：llmbench 0.1.0、llmbench 0.2.0"],
            rows: [],
          },
        ],
      },
    }),
  );
  render(<ComparePage />);

  expect(await screen.findByText(/负载发生器版本不一致/)).toBeInTheDocument();
});

test("the default level is the highest common one", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ models: [makeModel()], deployments: DEPLOYMENTS, cells: pairedCells() }),
  );
  render(<ComparePage />);

  await screen.findByText("synthetic-1024-128");
  const picker = screen.getByText("档位").closest("div") as HTMLElement;
  await userEvent.click(within(picker).getByRole("button", { name: "4" }));
  expect(screen.getByText("1.20 s")).toBeInTheDocument();
});
