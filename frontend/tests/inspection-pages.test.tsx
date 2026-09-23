import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import InspectionPage from "../app/inspections/[id]/page";
import ServicesPage from "../app/services/page";
import ServicePage from "../app/services/[id]/page";
import { fakeApi, makeInspection, makeService } from "./helpers";

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

/** The case list, so a verdict in the header badge is not mistaken for one here. */
function cases(): HTMLElement {
  return screen.getByText("用例").closest("div") as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- the services list ------------------------------------------------------

test("an empty install says what to do first", async () => {
  vi.stubGlobal("fetch", fakeApi({}));
  render(<ServicesPage />);
  expect(await screen.findByText(/还没有登记服务/)).toBeInTheDocument();
});

test("a service needs a name and a router address and nothing else", async () => {
  vi.stubGlobal("fetch", fakeApi({}));
  render(<ServicesPage />);
  await screen.findByText(/还没有登记服务/);

  await userEvent.type(screen.getByLabelText("名称"), "灰度");
  await userEvent.type(screen.getByLabelText(/Router 地址/), "http://host:9000");
  await userEvent.click(screen.getByRole("button", { name: "新建服务" }));

  expect(await screen.findByText("灰度")).toBeInTheDocument();
});

test("the 巡检 nav entry is live", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService()] }));
  render(<ServicesPage />);
  // The page itself is what the nav points at; reaching it at all is the check.
  expect(await screen.findByText("V4-Flash 灰度")).toBeInTheDocument();
});

// --- one service ------------------------------------------------------------

test("a service offers to be inspected", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService({ id: 1 })] }));
  render(<ServicePage />);
  expect(await screen.findByRole("button", { name: "开始巡检" })).toBeInTheDocument();
});

test("starting an inspection puts it in the history", async () => {
  vi.stubGlobal("fetch", fakeApi({ services: [makeService({ id: 1 })], inspections: [] }));
  render(<ServicePage />);
  await screen.findByText("还没有巡检过。");

  await userEvent.click(screen.getByRole("button", { name: "开始巡检" }));
  expect(await screen.findByText("#1")).toBeInTheDocument();
});

test("an inspection history shows the suite version, because results depend on it", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ services: [makeService({ id: 1 })], inspections: [makeInspection({ id: 4 })] }),
  );
  render(<ServicePage />);
  expect(await screen.findByText("用例集 v2")).toBeInTheDocument();
  expect(screen.getByText("通过")).toBeInTheDocument();
});

// --- one inspection ---------------------------------------------------------

test("every case is listed with its verdict", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ services: [makeService()], inspections: [makeInspection({ id: 1 })] }),
  );
  render(<InspectionPage />);

  await screen.findByText("completion.non_stream");
  const list = cases();
  expect(within(list).getByText("completion.non_stream")).toBeInTheDocument();
  expect(within(list).getByText("extensions.tools")).toBeInTheDocument();
  expect(within(list).getByText("通过")).toBeInTheDocument();
  expect(within(list).getByText("跳过")).toBeInTheDocument();
  expect(within(list).getByText("非必需")).toBeInTheDocument();
});

test("inconclusive is shown as its own thing, not as a failure", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      services: [makeService()],
      inspections: [
        makeInspection({
          id: 1,
          verdict: "INCONCLUSIVE",
          cases: [
            {
              case_id: "extensions.thinking",
              required: true,
              verdict: "INCONCLUSIVE",
              reason_code: "capability_unknown",
              message: "the toggle had no visible effect",
            },
          ],
        }),
      ],
    }),
  );
  render(<InspectionPage />);

  await screen.findByText("extensions.thinking");
  const list = cases();
  expect(within(list).getByText("无法判定")).toBeInTheDocument();
  expect(within(list).queryByText("失败")).not.toBeInTheDocument();
  expect(screen.getByText(/不是一回事，所以分开显示/)).toBeInTheDocument();
});

test("a failure is shown as a failure, with the evidence", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      services: [makeService()],
      inspections: [
        makeInspection({
          id: 1,
          verdict: "FAIL",
          cases: [
            {
              case_id: "validation.malformed_json",
              required: true,
              verdict: "FAIL",
              reason_code: "assertion_failed",
              message: "HTTP 200: the service accepted malformed JSON",
            },
          ],
        }),
      ],
    }),
  );
  render(<InspectionPage />);

  await screen.findByText("validation.malformed_json");
  expect(within(cases()).getByText("失败")).toBeInTheDocument();
  expect(screen.getByText(/accepted malformed JSON/)).toBeInTheDocument();
});

test("what the service said about itself is shown", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ services: [makeService()], inspections: [makeInspection({ id: 1 })] }),
  );
  render(<InspectionPage />);

  const heading = await screen.findByText("目标");
  const panel = heading.closest("div")!;
  expect(within(panel).getByText("DeepSeek-V4-Flash-0731")).toBeInTheDocument();
  expect(within(panel).getByText("32,768")).toBeInTheDocument();
  expect(within(panel).getAllByText("支持")).toHaveLength(2);
});

test("an unknown capability is shown as undeclared rather than as unsupported", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      services: [makeService()],
      inspections: [
        makeInspection({
          id: 1,
          target: { ...makeInspection().target!, tools: "unknown", thinking: "unknown" },
        }),
      ],
    }),
  );
  render(<InspectionPage />);

  // "not declared" and "does not support it" lead to different verdicts, so
  // showing them the same way would hide which one happened.
  expect(await screen.findAllByText("未声明")).toHaveLength(2);
});

test("a discovery failure is reported as the inspection not completing", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      services: [makeService()],
      inspections: [
        makeInspection({
          id: 1,
          status: "failed",
          verdict: "FAIL",
          target: null,
          error: "/health returned 502",
          cases: [],
        }),
      ],
    }),
  );
  render(<InspectionPage />);

  expect(await screen.findByText("巡检未能完成")).toBeInTheDocument();
  expect(screen.getByText("/health returned 502")).toBeInTheDocument();
});
