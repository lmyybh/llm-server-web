import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import InspectionPage from "../app/inspections/[id]/page";
import ServicesPage from "../app/services/page";
import ServicePage from "../app/services/[id]/page";
import { curlCommand } from "../app/components/inspection-workspace";
import { fakeApi, makeInspection, makeService } from "./helpers";
import type { InspectionExchange } from "../app/lib/api";

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      React.createElement("a", { href }, children),
  };
});

const routerReplace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "1" }), useRouter: () => ({ replace: routerReplace }) }));

afterEach(() => { vi.unstubAllGlobals(); routerReplace.mockClear(); });

const exchange: InspectionExchange = {
  method: "POST",
  url: "http://host:9000/v1/chat/completions",
  request_body: '{"model":"DeepSeek-V4-Flash"}',
  content_type: "application/json",
  auth_required: true,
  response_status: 200,
  response_body: '{"choices":[{"message":{"content":"pong"}}]}',
  latency_ms: 123,
  error: null,
};

test("an empty install offers a new service card", async () => {
  vi.stubGlobal("fetch", fakeApi({}));
  render(<ServicesPage />);
  expect(await screen.findByText(/暂无已登记服务/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /新建服务/ })).toBeInTheDocument();
});

test("a service needs a name and a router address", async () => {
  vi.stubGlobal("fetch", fakeApi({}));
  render(<ServicesPage />);
  await screen.findByText(/暂无已登记服务/);
  await userEvent.click(screen.getByRole("button", { name: /新建服务/ }));
  const dialog = screen.getByRole("dialog", { name: "新建服务" });
  await userEvent.type(screen.getByLabelText("服务名称"), "灰度");
  await userEvent.type(screen.getByLabelText(/Router 地址/), "http://host:9000");
  await userEvent.click(within(dialog).getByRole("button", { name: "新建服务" }));
  expect(await screen.findByText("灰度")).toBeInTheDocument();
});

test("the new service dialog can be cancelled", async () => {
  vi.stubGlobal("fetch", fakeApi({}));
  render(<ServicesPage />);
  await userEvent.click(await screen.findByRole("button", { name: /新建服务/ }));
  const dialog = screen.getByRole("dialog", { name: "新建服务" });
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog", { name: "新建服务" })).not.toBeInTheDocument();
});

test("a service creation error remains visible in the dialog", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService({ name: "灰度" })] }));
  render(<ServicesPage />);
  await userEvent.click(await screen.findByRole("button", { name: /新建服务/ }));
  const dialog = screen.getByRole("dialog", { name: "新建服务" });
  await userEvent.type(within(dialog).getByLabelText("服务名称"), "灰度");
  await userEvent.type(within(dialog).getByLabelText("Router 地址"), "http://host:9000");
  await userEvent.click(within(dialog).getByRole("button", { name: "新建服务" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("a service named '灰度' already exists");
});

test("the 巡检 nav entry is live", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()] }));
  render(<ServicesPage />);
  expect(await screen.findByText("V4-Flash 灰度")).toBeInTheDocument();
});

test("service page uses a timeline without four summary cards", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection()] }));
  render(<ServicePage />);
  expect(await screen.findByRole("button", { name: "配置巡检项" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始巡检" })).toBeInTheDocument();
  expect(screen.getByText("用例进度 2 / 2")).toBeInTheDocument();
  expect(screen.queryByText("最近一次巡检")).not.toBeInTheDocument();
});

test("configured cases are used for the next inspection", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [] }));
  render(<ServicePage />);
  await userEvent.click(await screen.findByRole("button", { name: "配置巡检项" }));
  const dialog = screen.getByRole("dialog", { name: "配置巡检项" });
  await userEvent.click(within(dialog).getByRole("checkbox", { name: /工具调用能力/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "保存配置" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "开始巡检" }));
  expect(await screen.findByText("用例进度 0 / 1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^巡检 #1/ })).toBeInTheDocument();
});

test("choosing a history record switches the timeline without leaving the service page", async () => {
  vi.stubGlobal("fetch", fakeApi({
    services: [makeService()],
    inspections: [makeInspection({ id: 2 }), makeInspection({
      id: 1, case_ids: ["health.generate"], completed_cases: 1,
      cases: [{ case_id: "health.generate", required: true, verdict: "PASS", reason_code: "assertions_passed", message: "" }],
    })],
  }));
  const originalUrl = window.location.href;
  render(<ServicePage />);
  expect(await screen.findByRole("heading", { name: /巡检 #2/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^巡检 #1/ }));
  expect(await screen.findByRole("heading", { name: /巡检 #1/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^巡检 #1/ })).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("heading", { name: "V4-Flash 灰度" })).toBeInTheDocument();
  expect(window.location.href).toBe(originalUrl);
});

test("deleting a history record requires confirmation and selects the remaining record", async () => {
  vi.stubGlobal("fetch", fakeApi({
    services: [makeService()],
    inspections: [makeInspection({ id: 2 }), makeInspection({ id: 1 })],
  }));
  render(<ServicePage />);
  expect(await screen.findByRole("heading", { name: /巡检 #2/ })).toBeInTheDocument();
  const record = screen.getByRole("button", { name: /^巡检 #2/ });
  expect(screen.queryByRole("button", { name: "删除巡检 #2" })).not.toBeInTheDocument();
  fireEvent.contextMenu(record);
  await userEvent.click(await screen.findByRole("menuitem", { name: "删除记录" }));
  const dialog = screen.getByRole("dialog", { name: "删除巡检 #2？" });
  expect(within(dialog).getByText(/请求、响应和错误详情/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  fireEvent.contextMenu(record);
  await userEvent.click(await screen.findByRole("menuitem", { name: "删除记录" }));
  await userEvent.click(within(screen.getByRole("dialog", { name: "删除巡检 #2？" })).getByRole("button", { name: "删除记录" }));
  expect(await screen.findByRole("heading", { name: /巡检 #1/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^巡检 #2/ })).not.toBeInTheDocument();
});

test("an inspection in progress cannot be deleted from history", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection({ status: "running", verdict: null })] }));
  render(<ServicePage />);
  expect(await screen.findByRole("heading", { name: /巡检 #1/ })).toBeInTheDocument();
  fireEvent.contextMenu(screen.getByRole("button", { name: /^巡检 #1/ }));
  expect(screen.queryByRole("menuitem", { name: "删除记录" })).not.toBeInTheDocument();
});

test("deleting a record opened by its direct URL returns to the service", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection({ id: 1 })] }));
  render(<InspectionPage />);
  fireEvent.contextMenu(await screen.findByRole("button", { name: /^巡检 #1/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "删除记录" }));
  await userEvent.click(within(screen.getByRole("dialog", { name: "删除巡检 #1？" })).getByRole("button", { name: "删除记录" }));
  expect(routerReplace).toHaveBeenCalledWith("/services/1");
});

test("a completed inspection has no target block and switches history in place", async () => {
  vi.stubGlobal("fetch", fakeApi({
    services: [makeService()], inspections: [makeInspection({ id: 1 }), makeInspection({ id: 2 })],
  }));
  const originalUrl = window.location.href;
  render(<InspectionPage />);
  expect(await screen.findByRole("heading", { name: /巡检 #1/ })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "目标" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /^巡检 #2/ }));
  expect(await screen.findByRole("heading", { name: /巡检 #2/ })).toBeInTheDocument();
  expect(window.location.href).toBe(originalUrl);
});

test("the suite version is not shown in inspection views", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection({ id: 4 })] }));
  render(<ServicePage />);
  expect(await screen.findByRole("button", { name: /^巡检 #4/ })).toBeInTheDocument();
  expect(screen.queryByText(/用例集/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /非流式响应格式/ }));
  expect(screen.queryByText(/用例集/)).not.toBeInTheDocument();
});

test("the run timeline shows completed, running and waiting states", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection({
    status: "running", completed_cases: 1, current_case: "extensions.tools", cases: [{
      case_id: "completion.non_stream", required: true, verdict: "PASS",
      reason_code: "assertions_passed", message: "", evidence: [exchange],
    }], case_ids: ["completion.non_stream", "extensions.tools", "validation.malformed_json"],
  })] }));
  render(<InspectionPage />);
  await screen.findByRole("button", { name: /非流式响应格式/ });
  expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
  expect(screen.getAllByText("执行中").length).toBeGreaterThan(0);
  expect(screen.getByText("等待")).toHaveClass("text-[10px]");
});

test("case details open in a drawer and copy cURL from the command block", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText } }));
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection({
    case_ids: ["completion.non_stream"], completed_cases: 1, cases: [{
      case_id: "completion.non_stream", required: true, verdict: "PASS",
      reason_code: "assertions_passed", message: "", evidence: [exchange],
    }],
  })] }));
  render(<InspectionPage />);
  await userEvent.click(await screen.findByRole("button", { name: /非流式响应格式/ }));
  const drawer = screen.getByRole("dialog", { name: "非流式响应格式" });
  expect(within(drawer).getByText("请求体 · 完整内容")).toBeInTheDocument();
  expect(within(drawer).getByText("响应内容 · 完整内容")).toBeInTheDocument();
  const copyButton = within(drawer).getByRole("button", { name: "复制请求 1 的 cURL" });
  expect(copyButton).toHaveTextContent("");
  expect(copyButton.querySelector("svg")).toBeInTheDocument();
  const commandBlock = copyButton.parentElement?.parentElement;
  expect(commandBlock).toHaveTextContent("curl -i -X POST");
  const displayedCommand = commandBlock?.querySelector("pre");
  expect(displayedCommand).not.toHaveClass("pt-8");
  expect(displayedCommand?.textContent).toContain('  --data-raw \'{\n  "model": "DeepSeek-V4-Flash"\n}\'');
  const requestBody = within(drawer).getByText("请求体 · 完整内容").closest("section")?.querySelector("pre");
  const responseBody = within(drawer).getByText("响应内容 · 完整内容").closest("section")?.querySelector("pre");
  expect(requestBody?.textContent).toBe('{\n  "model": "DeepSeek-V4-Flash"\n}');
  expect(responseBody?.textContent).toContain('\n  "choices": [\n');
  await userEvent.click(copyButton);
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("http://host:9000/v1/chat/completions"));
  expect(writeText.mock.calls[0][0]).toContain('--data-raw \'{"model":"DeepSeek-V4-Flash"}\'');
  expect(writeText.mock.calls[0][0]).toContain("${LLM_API_KEY}");
  const copyRequest = within(drawer).getByRole("button", { name: "复制请求 1 的请求体" });
  const copyResponse = within(drawer).getByRole("button", { name: "复制请求 1 的响应内容" });
  expect(copyRequest.querySelector("svg")).toBeInTheDocument();
  expect(copyResponse.querySelector("svg")).toBeInTheDocument();
  await userEvent.click(copyRequest);
  expect(writeText).toHaveBeenLastCalledWith(exchange.request_body);
  await userEvent.click(copyResponse);
  expect(writeText).toHaveBeenLastCalledWith(exchange.response_body);
});

test("closing a case drawer from another case keeps the timeline position", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection()] }));
  render(<ServicePage />);
  const firstCase = await screen.findByRole("button", { name: /非流式响应格式/ });
  const timeline = firstCase.closest("ol")?.parentElement as HTMLElement;
  const focus = firstCase.focus.bind(firstCase);
  const focusSpy = vi.spyOn(firstCase, "focus").mockImplementation((options?: FocusOptions) => {
    if (!options?.preventScroll) timeline.scrollTop = 0;
    focus(options);
  });

  await userEvent.click(firstCase);
  const drawer = screen.getByRole("dialog", { name: "非流式响应格式" });
  timeline.scrollTop = 120;
  await userEvent.click(drawer.previousElementSibling as HTMLElement);
  await waitFor(() => expect(drawer).not.toBeInTheDocument());
  expect(focusSpy).toHaveBeenCalledWith(expect.objectContaining({ preventScroll: true }));
  expect(timeline.scrollTop).toBe(120);
});

test("streaming responses format JSON events while preserving the done marker", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection({
    case_ids: ["completion.non_stream"], completed_cases: 1, cases: [{
      case_id: "completion.non_stream", required: true, verdict: "PASS",
      reason_code: "assertions_passed", message: "", evidence: [{
        ...exchange,
        response_body: 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n',
      }],
    }],
  })] }));
  render(<InspectionPage />);
  await userEvent.click(await screen.findByRole("button", { name: /非流式响应格式/ }));
  const drawer = screen.getByRole("dialog", { name: "非流式响应格式" });
  const responseBody = within(drawer).getByText("响应内容 · 完整内容").closest("section")?.querySelector("pre");
  expect(responseBody?.textContent).toContain('data: {\n        "choices": [');
  expect(responseBody?.textContent).toContain("data: [DONE]");
});

test("a failed case shows the full error and response in its drawer", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection({
    verdict: "FAIL", case_ids: ["validation.malformed_json"], completed_cases: 1,
    cases: [{ case_id: "validation.malformed_json", required: true, verdict: "FAIL",
      reason_code: "assertion_failed", message: "Complete assertion error\nwith stack trace",
      evidence: [{ ...exchange, request_body: '{"model":', response_body: "entire response" }] }],
  })] }));
  render(<InspectionPage />);
  await userEvent.click(await screen.findByRole("button", { name: /拒绝损坏的 JSON/ }));
  const drawer = screen.getByRole("dialog", { name: "拒绝损坏的 JSON" });
  expect(within(drawer).getByText(/Complete assertion error/)).toBeInTheDocument();
  expect(within(drawer).getByText("entire response")).toBeInTheDocument();
  expect(within(drawer).getByText("请求体 · 完整内容").closest("section")?.querySelector("pre")?.textContent).toBe('{"model":');
});

test("a discovery failure remains visible", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection({
    status: "failed", verdict: "FAIL", target: null, error: "/health returned 502", cases: [], completed_cases: 0,
  })] }));
  render(<InspectionPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("/health returned 502");
});

test("cURL quoting keeps apostrophes inside a single shell argument", () => {
  expect(curlCommand({ ...exchange, request_body: "it's ready" }, "LLM_API_KEY"))
    .toContain("'it'\\''s ready'");
});

test.each(["ERROR", "INCONCLUSIVE"] as const)("run verdict %s is visible without claiming service failure", async (verdict) => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()], inspections: [makeInspection({
    status: "completed", verdict, cases: [], completed_cases: 0,
  })] }));
  render(<InspectionPage />);
  expect((await screen.findAllByText(verdict === "ERROR" ? "执行出错" : "无法判定")).length).toBeGreaterThan(0);
  expect(screen.queryByText("失败")).not.toBeInTheDocument();
  expect(screen.queryByText("通过")).not.toBeInTheDocument();
});
