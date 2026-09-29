import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import Page from "../app/inspection-projects/page";
import { api, type InspectionProject } from "../app/lib/api";

const item: InspectionProject = {
  case_id: "health.generate", title: "生成接口健康检查", group: "基础接口",
  description: "检查生成健康入口", steps: ["请求健康入口"], pass_rule: "返回 200",
  fail_rule: "状态异常", other_rule: "执行出错", endpoint: "GET /health_generate",
  timeout_seconds: 60, default_enabled: true,
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
  const tagInput = screen.getByRole("combobox", { name: "分组标签" });
  await userEvent.clear(tagInput);
  await userEvent.type(tagInput, "专项检查");
  expect(screen.getByRole("option", { name: "创建“专项检查”（回车）" })).toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  expect(tagInput).toHaveValue("专项检查");
  expect(tagInput).toHaveAttribute("aria-expanded", "false");
  expect(save).not.toHaveBeenCalled();
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

test("different custom tags have distinct colors that survive filtering and opening details", async () => {
  const projects = ["自定义A", "自定义F"].map((group, index) => ({ ...item, group, case_id: `case.${index}`, title: `项目${index}` }));
  vi.spyOn(api, "listInspectionProjects").mockResolvedValue(projects);
  render(<Page />);
  await screen.findByRole("button", { name: "项目0" });
  const badge = (group: string) => screen.getByText(group, { selector: ".inspection-group" });
  const color = (element: HTMLElement) => element.getAttribute("style") || element.className;
  const first = color(badge("自定义A"));
  const second = color(badge("自定义F"));
  expect(first).not.toBe(second);
  await userEvent.type(screen.getByRole("searchbox"), "项目1");
  expect(color(badge("自定义F"))).toBe(second);
  await userEvent.click(screen.getByRole("button", { name: "项目1" }));
  expect(color(within(screen.getByRole("dialog")).getByText("自定义F", { selector: ".inspection-group" }))).toBe(second);
});


test("dragging saves the full order and a failed keyboard reorder restores it", async () => {
  const second = { ...item, case_id: "second", title: "第二项" };
  vi.spyOn(api, "listInspectionProjects").mockResolvedValue([item, second]);
  const save = vi.spyOn(api, "reorderInspectionProjects").mockResolvedValue([second, item]);
  render(<Page />);
  const handle = await screen.findByRole("button", { name: `调整${item.title}顺序` });
  const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(handle, { dataTransfer });
  fireEvent.dragOver(screen.getByRole("button", { name: "第二项" }).closest("tr")!, { dataTransfer });
  fireEvent.drop(screen.getByRole("button", { name: "第二项" }).closest("tr")!, { dataTransfer });
  expect(await screen.findByRole("status")).toHaveTextContent("排序已保存");
  expect(save).toHaveBeenCalledWith(["second", item.case_id]);
  const titles = () => screen.getAllByRole("button", { name: /顺序$/ }).map(button => button.getAttribute("aria-label"));
  expect(titles()[0]).toBe("调整第二项顺序");
  save.mockRejectedValueOnce(new Error("排序保存失败"));
  fireEvent.keyDown(screen.getByRole("button", { name: "调整第二项顺序" }), { key: "ArrowDown" });
  expect(await screen.findByRole("alert")).toHaveTextContent("排序保存失败");
  expect(titles()[0]).toBe("调整第二项顺序");
  await userEvent.type(screen.getByRole("searchbox"), "第二项");
  expect(screen.getByRole("button", { name: "调整第二项顺序" })).toBeDisabled();
});
