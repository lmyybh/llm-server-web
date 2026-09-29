import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import Page from "../app/inspection-projects/page";
import { api, type InspectionProject } from "../app/lib/api";

const item: InspectionProject = {
  case_id: "health.generate", title: "生成接口健康检查", group: "基础接口",
  description: "检查生成健康入口", steps: ["请求健康入口"], pass_rule: "返回 200",
  fail_rule: "状态异常", other_rule: "执行出错", endpoint: "GET /health_generate",
  timeout_seconds: 60, default_enabled: true, suite_version: "8",
};
afterEach(() => vi.restoreAllMocks());

test("filters projects and saves edited settings through the API", async () => {
  vi.spyOn(api, "listInspectionProjects").mockResolvedValue([item]);
  const save = vi.spyOn(api, "updateInspectionProject").mockImplementation(async (_, changes) => ({ ...item, ...changes }));
  render(<Page />);
  await userEvent.click(await screen.findByRole("button", { name: item.title }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("返回 200")).toBeInTheDocument();
  const name = within(dialog).getByLabelText("项目名称");
  await userEvent.clear(name);
  await userEvent.type(name, "健康入口");
  await userEvent.click(within(dialog).getByRole("button", { name: "保存更改" }));
  expect(save).toHaveBeenCalledWith("health.generate", { title: "健康入口", group: "基础接口", timeout_seconds: 60, default_enabled: true });
  await userEvent.click(within(dialog).getByRole("button", { name: "关闭详情" }));
  expect(await screen.findByRole("button", { name: "健康入口" })).toBeInTheDocument();
  await userEvent.type(screen.getByRole("searchbox"), "不存在");
  expect(screen.getByText(/没有匹配的巡检项目/)).toBeInTheDocument();
});

test("failed toggle keeps the saved selection and shows an error", async () => {
  vi.spyOn(api, "listInspectionProjects").mockResolvedValue([item]);
  vi.spyOn(api, "updateInspectionProject").mockRejectedValue(new Error("保存失败"));
  render(<Page />);
  await userEvent.click(await screen.findByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
});

test("creates a new tag on save and makes it available for filtering", async () => {
  vi.spyOn(api, "listInspectionProjects").mockResolvedValue([item]);
  const save = vi.spyOn(api, "updateInspectionProject").mockImplementation(async (_, changes) => ({ ...item, ...changes }));
  render(<Page />);
  await userEvent.click(await screen.findByRole("button", { name: item.title }));
  await userEvent.click(screen.getByRole("combobox", { name: "分组标签" }));
  await userEvent.click(screen.getByRole("option", { name: "＋ 输入新标签" }));
  await userEvent.type(screen.getByLabelText("新标签名称"), "专项检查");
  await userEvent.click(screen.getByRole("button", { name: "保存更改" }));
  expect(save).toHaveBeenCalledWith(item.case_id, expect.objectContaining({ group: "专项检查" }));
  await userEvent.click(screen.getByRole("button", { name: "关闭详情" }));
  await userEvent.click(screen.getByRole("combobox", { name: "按分组筛选" }));
  await userEvent.click(screen.getByRole("option", { name: "专项检查" }));
  expect(screen.getByRole("button", { name: item.title })).toBeInTheDocument();
});

test("restoring defaults requires confirmation", async () => {
  vi.spyOn(api, "listInspectionProjects").mockResolvedValue([item]);
  const reset = vi.spyOn(api, "resetInspectionProjects").mockResolvedValue([item]);
  render(<Page />);
  await screen.findByRole("switch");
  await userEvent.click(screen.getByRole("button", { name: "恢复初始设置" }));
  expect(reset).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  expect(reset).toHaveBeenCalledOnce();
  expect(await screen.findByRole("status")).toHaveTextContent("已恢复初始设置");
});
