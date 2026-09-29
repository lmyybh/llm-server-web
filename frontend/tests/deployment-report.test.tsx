import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { WorkloadReport } from "../app/components/workload-report";
import { DeploymentReport } from "../app/components/deployment-report";
import { ReportChart, REPORT_CHARTS } from "../app/components/report-chart";
import { reportCell, reportSummaryValue } from "../app/lib/report-metrics";
import { deploymentReportCsv } from "../app/lib/report-csv";
import { makeCell, makeDeployment, makeModel, makeWorkload } from "./helpers";

test("missing recorded statistics stay missing and execution identity is retained", () => {
  const cell = makeCell({ metric_summaries: { ttft_ms: { mean: 1, p50: null, p70: 3, p95: 4, p99: 5 } } });
  expect(reportSummaryValue(cell, "ttft_ms", "p50")).toBeNull();
  expect(reportSummaryValue(makeCell(), "ttft_ms", "p50")).toBe(788.7);
  expect(reportSummaryValue(makeCell(), "input_tokens", "mean")).toBeNull();
  expect(reportCell({ ...cell, level: 999 }).level).toBe(cell.executed_snapshot?.level);
});

test("charts expose every statistic and break lines at missing samples", () => {
  const { container } = render(<ReportChart metric={REPORT_CHARTS[1]} mode="concurrency" onShowData={() => {}} cells={[
    makeCell({ id: 1, level: 1 }),
    makeCell({ id: 2, level: 2, e2e_p50: null }),
    makeCell({ id: 3, level: 3 }),
  ]} />);
  for (const name of ["Mean", "P50", "P70", "P95", "P99"]) expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  expect(container.querySelector('[data-series="p50"]')?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
  fireEvent.focus(screen.getByRole("button", { name: /并发 1，P50/ }));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Mean");
  expect(screen.getByRole("tooltip")).toHaveTextContent("P70");
  fireEvent.click(screen.getByRole("button", { name: "P50" }));
  expect(container.querySelector('[data-series="p50"]')).toBeNull();
});

test("report orders four charts, reuses full tables and keeps empty workloads when mode changes", () => {
  const { container } = render(<DeploymentReport deployment={makeDeployment()} model={makeModel()} workloads={[makeWorkload(), makeWorkload({ id: 2, name: "empty-workload" })]} cells={[makeCell()]} />);
  expect(Array.from(container.querySelectorAll(".report-chart h4")).map(n => n.textContent)).toEqual(["输出吞吐", "E2E · 请求总延迟", "TTFT · 首 Token 延迟", "TPOT · 每 Token 延迟"]);
  fireEvent.click(screen.getByRole("button", { name: "查看E2E · 请求总延迟数据表" }));
  expect(screen.getByRole("heading", { name: "Token 用量" })).toBeVisible();
  expect(container.querySelector('[data-report-metric="overview"]')).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "QPS" }));
  expect(screen.getAllByText("暂无QPS测试")).toHaveLength(2);
  expect(screen.getByRole("link", { name: /empty-workload/ })).toBeVisible();
  expect(screen.queryByText("统计口径与报告说明")).not.toBeInTheDocument();
});

test("CSV includes both modes, all token statistics and protects spreadsheet formulas", () => {
  const csv = deploymentReportCsv(makeDeployment({ name: "=formula" }), [makeCell(), makeCell({ id: 2, mode: "qps", level: 2 })]);
  expect(csv).toContain('"input_tokens p70"');
  expect(csv).toContain('"output_tokens p99"');
  expect(csv).toContain('"concurrency"');
  expect(csv).toContain('"qps"');
  expect(csv).toContain('"\'=formula"');
  expect(csv.split("\r\n")).toHaveLength(3);
});

test("bottom of report selects the last workload even when its heading cannot reach the top", () => {
  const { container } = render(<DeploymentReport deployment={makeDeployment()} model={makeModel()} workloads={[makeWorkload(), makeWorkload({ id: 2, name: "last-workload" })]} cells={[]} />);
  const panel = screen.getByRole("tabpanel");
  Object.defineProperties(panel, {
    clientHeight: { value: 1000 },
    scrollHeight: { value: 1500 },
    scrollTop: { value: 499.5, writable: true },
  });
  panel.getBoundingClientRect = () => new DOMRect(0, 100, 1000, 1000);
  const sections = container.querySelectorAll<HTMLElement>(".deployment-report-section");
  sections[0].getBoundingClientRect = () => new DOMRect(0, -399.5, 1000, 700);
  sections[1].getBoundingClientRect = () => new DOMRect(0, 324.5, 1000, 700);
  fireEvent.scroll(panel);
  expect(screen.getByRole("link", { name: /last-workload/ })).toHaveAttribute("aria-current", "location");
  panel.scrollTop = 200;
  fireEvent.scroll(panel);
  expect(screen.getByRole("link", { name: /synthetic-1024-128/ })).toHaveAttribute("aria-current", "location");
  panel.scrollTop = 0;
  fireEvent.scroll(panel);
  expect(screen.getByRole("link", { name: /synthetic-1024-128/ })).toHaveAttribute("aria-current", "location");
});


test("standalone workload uses the same card, retains table view across modes and shows missing modes", () => {
  render(<WorkloadReport cells={[makeCell({ level: 8 }), makeCell({ id: 2, mode: "qps", level: 4 })]} name="shared-workload" shape="test shape" />);
  const panel = screen.getByRole("tabpanel");
  expect(within(panel).getAllByRole("heading", { level: 4 }).map(h => h.textContent)).toEqual(["输出吞吐", "E2E · 请求总延迟", "TTFT · 首 Token 延迟", "TPOT · 每 Token 延迟"]);
  fireEvent.click(within(panel).getByRole("button", { name: "查看TTFT · 首 Token 延迟数据表" }));
  expect(within(panel).getByRole("heading", { name: "Token 用量" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "QPS 测试" }));
  expect(within(panel).getByRole("button", { name: "数据表" })).toHaveAttribute("aria-pressed", "true");
  expect(within(within(panel).getAllByRole("table")[0]).getByRole("cell", { name: "4" })).toBeVisible();
  fireEvent.click(within(panel).getByRole("button", { name: "曲线" }));
  expect(within(panel).getByRole("button", { name: /QPS 4，测量值/ })).toBeVisible();
});

test("standalone and deployment cards share markup and support empty modes", () => {
  const cell = makeCell();
  const standalone = render(<WorkloadReport cells={[cell]} name="synthetic-1024-128" shape="test" />);
  const standaloneHeading = standalone.container.querySelector(".deployment-report-section > div")!;
  const headerClass = standaloneHeading.className;
  const chartTitles = Array.from(standalone.container.querySelectorAll(".report-chart h4")).map(e => e.textContent);
  fireEvent.click(screen.getByRole("tab", { name: "QPS 测试" }));
  expect(screen.getByText("暂无QPS测试")).toBeVisible();
  standalone.unmount();
  const deployment = render(<DeploymentReport deployment={makeDeployment()} model={makeModel()} workloads={[makeWorkload()]} cells={[cell]} />);
  expect(deployment.container.querySelector(".deployment-report-section > div")?.className).toBe(headerClass);
  expect(Array.from(deployment.container.querySelectorAll(".report-chart h4")).map(e => e.textContent)).toEqual(chartTitles);
});
