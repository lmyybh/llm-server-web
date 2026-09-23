import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import ModelsPage from "../app/page";
import { fakeApi, makeCell, makeDeployment, makeModel } from "./helpers";

// next/link needs the app-router context, which does not exist outside Next.
// The async factory keeps this hoist-safe.
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

test("an empty install says so instead of showing a bare box", async () => {
  vi.stubGlobal("fetch", fakeApi());
  render(<ModelsPage />);
  expect(await screen.findByText("还没有模型，点这里建第一个")).toBeInTheDocument();
});

test("a model created in the form appears in the list", async () => {
  vi.stubGlobal("fetch", fakeApi());
  render(<ModelsPage />);
  await screen.findByText("还没有模型，点这里建第一个");

  await userEvent.click(screen.getByRole("button", { name: /新建模型/ }));
  await userEvent.type(screen.getByLabelText("模型名称"), "GLM-5.2");
  await userEvent.type(screen.getByLabelText("备注"), "生产");
  await userEvent.click(screen.getByRole("button", { name: "新建模型" }));

  expect(await screen.findByText("GLM-5.2")).toBeInTheDocument();
  expect(screen.getByText("生产")).toBeInTheDocument();
  expect(screen.queryByText("还没有模型，点这里建第一个")).not.toBeInTheDocument();
});

test("existing models are listed with how many deployments each has", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel({ id: 1, name: "GLM-5.2" }), makeModel({ id: 2, name: "V4-Flash" })],
    }),
  );
  render(<ModelsPage />);

  expect(await screen.findByText("GLM-5.2")).toBeInTheDocument();
  expect(screen.getByText("V4-Flash")).toBeInTheDocument();
  expect(screen.getAllByText("0 种部署方式")).toHaveLength(2);
});

test("the form closes and clears after a successful create, so a second one is easy", async () => {
  vi.stubGlobal("fetch", fakeApi());
  render(<ModelsPage />);
  await screen.findByText("还没有模型，点这里建第一个");

  await userEvent.click(screen.getByRole("button", { name: /新建模型/ }));
  await userEvent.type(screen.getByLabelText("模型名称"), "GLM-5.2");
  await userEvent.click(screen.getByRole("button", { name: "新建模型" }));
  await screen.findByText("GLM-5.2");

  await userEvent.click(screen.getByRole("button", { name: /新建模型/ }));
  expect(screen.getByLabelText("模型名称")).toHaveValue("");
});

test("a rejected create is reported in words the API produced", async () => {
  vi.stubGlobal("fetch", fakeApi({ models: [makeModel({ name: "GLM-5.2" })] }));
  render(<ModelsPage />);
  await screen.findByText("GLM-5.2");

  await userEvent.click(screen.getByRole("button", { name: /新建模型/ }));
  await userEvent.type(screen.getByLabelText("模型名称"), "GLM-5.2");
  await userEvent.click(screen.getByRole("button", { name: "新建模型" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "a model named 'GLM-5.2' already exists",
  );
});

test("a create button is disabled until a name is typed", async () => {
  vi.stubGlobal("fetch", fakeApi());
  render(<ModelsPage />);
  await screen.findByText("还没有模型，点这里建第一个");

  await userEvent.click(screen.getByRole("button", { name: /新建模型/ }));
  const button = screen.getByRole("button", { name: "新建模型" });
  expect(button).toBeDisabled();

  await userEvent.type(screen.getByLabelText("模型名称"), "x");
  expect(button).toBeEnabled();
});

test("a card shows when its cells last ran, and how many are running now", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel({ id: 1 })],
      deployments: [makeDeployment({ id: 1, model_id: 1 })],
      cells: [
        makeCell({ id: 1, deployment_id: 1, status: "running" }),
        makeCell({ id: 2, deployment_id: 1, level: 16 }),
      ],
    }),
  );
  render(<ModelsPage />);

  expect(await screen.findByText("1 进行中")).toBeInTheDocument();
  expect(screen.getByText(/最近测量/)).toBeInTheDocument();
});

test("editing a model from its card renames it", async () => {
  vi.stubGlobal("fetch", fakeApi({ models: [makeModel({ id: 1, name: "GLM-5.2" })] }));
  render(<ModelsPage />);

  await userEvent.click(await screen.findByRole("button", { name: /编辑 GLM-5.2/ }));
  const nameInput = screen.getByLabelText("模型名称");
  await userEvent.clear(nameInput);
  await userEvent.type(nameInput, "GLM-6");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByText("GLM-6")).toBeInTheDocument();
  expect(screen.queryByText("GLM-5.2")).not.toBeInTheDocument();
});

test("deleting a model asks first, then removes the card", async () => {
  vi.stubGlobal("fetch", fakeApi({ models: [makeModel({ id: 1, name: "GLM-5.2" })] }));
  render(<ModelsPage />);

  await userEvent.click(await screen.findByRole("button", { name: /删除 GLM-5.2/ }));
  expect(screen.getByText(/不可恢复/)).toBeInTheDocument();
  expect(screen.getByText("GLM-5.2")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByText("GLM-5.2")).not.toBeInTheDocument());
});
