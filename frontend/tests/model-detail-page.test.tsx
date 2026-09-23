import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import ModelPage from "../app/models/[id]/page";
import { fakeApi, makeCell, makeDeployment, makeModel } from "./helpers";

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

test("a model with no deployments prompts for one", async () => {
  vi.stubGlobal("fetch", fakeApi({ models: [makeModel({ id: 1, name: "V4-Flash" })] }));
  render(<ModelPage />);

  expect(await screen.findByText("还没有部署方式，点这里建一个")).toBeInTheDocument();
});

test("an existing deployment shows its router and model name", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel({ id: 1 })],
      deployments: [makeDeployment({ model_id: 1, name: "2P1D-tp8", topology: "2P1D" })],
    }),
  );
  render(<ModelPage />);

  expect(await screen.findByText("2P1D-tp8")).toBeInTheDocument();
  expect(screen.getByText(/http:\/\/host:9000/)).toBeInTheDocument();
  expect(screen.getByText("2P1D")).toBeInTheDocument();
});

test("a deployment created in the form appears in the list", async () => {
  vi.stubGlobal("fetch", fakeApi({ models: [makeModel({ id: 1 })] }));
  render(<ModelPage />);
  await screen.findByText("还没有部署方式，点这里建一个");

  await userEvent.click(screen.getByRole("button", { name: /新建部署方式/ }));
  await userEvent.type(screen.getByLabelText(/部署方式名称/), "3P2D-tp4");
  await userEvent.type(screen.getByLabelText(/Router 地址/), "http://172.18.16.149:9000");
  await userEvent.type(screen.getByLabelText(/模型名/), "DeepSeek-V4-Flash-0731");
  await userEvent.click(screen.getByRole("button", { name: "创建" }));

  expect(await screen.findByText("3P2D-tp4")).toBeInTheDocument();
  expect(screen.getByText(/172\.18\.16\.149:9000/)).toBeInTheDocument();
});

test("editing a deployment updates it in place rather than adding another", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel({ id: 1 })],
      deployments: [makeDeployment({ id: 1, model_id: 1, name: "2P1D-tp8", topology: "" })],
    }),
  );
  render(<ModelPage />);
  await screen.findByText("2P1D-tp8");

  await userEvent.click(screen.getByRole("button", { name: /编辑/ }));
  await userEvent.type(screen.getByLabelText(/拓扑/), "2P1D");
  await userEvent.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByText("2P1D")).toBeInTheDocument();
  expect(screen.getAllByText("2P1D-tp8")).toHaveLength(1);
  expect(screen.queryByText("还没有部署方式，点这里建一个")).not.toBeInTheDocument();
});

test("the deployment row summarises its cells", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel({ id: 1 })],
      deployments: [makeDeployment({ id: 1, model_id: 1 })],
      cells: [
        makeCell({ id: 1, deployment_id: 1 }),
        makeCell({ id: 2, deployment_id: 1, level: 16, status: "idle" }),
      ],
    }),
  );
  render(<ModelPage />);

  expect(await screen.findByText(/2 个 Cell · 1 已完成/)).toBeInTheDocument();
});

test("a deployment with no cells says so", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({ models: [makeModel({ id: 1 })], deployments: [makeDeployment({ id: 1, model_id: 1 })] }),
  );
  render(<ModelPage />);
  expect(await screen.findByText("还没配置压测")).toBeInTheDocument();
});

test("a duplicate deployment name is reported, and the form stays open", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel({ id: 1 })],
      deployments: [makeDeployment({ id: 1, model_id: 1, name: "2P1D-tp8" })],
    }),
  );
  render(<ModelPage />);
  await screen.findByText("2P1D-tp8");

  await userEvent.click(screen.getByRole("button", { name: /新建部署方式/ }));
  await userEvent.type(screen.getByLabelText(/部署方式名称/), "2P1D-tp8");
  await userEvent.type(screen.getByLabelText(/Router 地址/), "http://host:9000");
  await userEvent.type(screen.getByLabelText(/模型名/), "m");
  await userEvent.click(screen.getByRole("button", { name: "创建" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "this model already has a deployment with that name",
  );
  // The form is still there with the typed values, so the mistake is editable.
  expect(screen.getByLabelText(/部署方式名称/)).toHaveValue("2P1D-tp8");
});

// --- creating a deployment ---------------------------------------------------
//
// A new Deployment usually differs from the previous one in name only, so the
// create form starts from a copy of it. With no previous Deployment, only the
// built-in defaults apply.

test("a new deployment is prefilled from the previous one, minus the name", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel({ id: 1 })],
      deployments: [
        makeDeployment({ id: 1, model_id: 1, topology: "2P1D", api_key_env: "MY_KEY", synthetic_input_limit: 2048 }),
      ],
    }),
  );
  render(<ModelPage />);

  await userEvent.click(await screen.findByRole("button", { name: /新建部署方式/ }));

  expect(screen.getByLabelText(/拓扑/)).toHaveValue("2P1D");
  expect(screen.getByLabelText(/生成上限/)).toHaveValue(2048);
  expect(screen.getByLabelText(/API Key 的环境变量名/)).toHaveValue("MY_KEY");
  expect(screen.getByLabelText(/Router 地址/)).toHaveValue("http://host:9000");
  // The name is what makes this deployment *this* one — never copied.
  expect(screen.getByLabelText(/部署方式名称/)).toHaveValue("");
});

test("with no previous deployment, the form falls back to the built-in defaults", async () => {
  vi.stubGlobal("fetch", fakeApi({ models: [makeModel({ id: 1 })] }));
  render(<ModelPage />);

  await userEvent.click(await screen.findByRole("button", { name: /新建部署方式/ }));
  expect(screen.getByLabelText(/API Key 的环境变量名/)).toHaveValue("LLM_API_KEY");
});

test("an existing deployment keeps the values it was created with", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel({ id: 1 })],
      deployments: [makeDeployment({ id: 1, model_id: 1, synthetic_input_limit: 65536 })],
    }),
  );
  render(<ModelPage />);

  await screen.findByText("2P1D-tp8");
  await userEvent.click(screen.getByRole("button", { name: /编辑/ }));
  expect(screen.getByLabelText(/生成上限/)).toHaveValue(65536);
});

test("deleting a deployment asks first, then removes the card", async () => {
  vi.stubGlobal(
    "fetch",
    fakeApi({
      models: [makeModel({ id: 1 })],
      deployments: [makeDeployment({ id: 1, model_id: 1 })],
    }),
  );
  render(<ModelPage />);

  await userEvent.click(await screen.findByRole("button", { name: /删除 2P1D-tp8/ }));
  // Nothing is deleted until the dialog confirms it.
  expect(screen.getByText(/不可恢复/)).toBeInTheDocument();
  expect(screen.getByText("2P1D-tp8")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(screen.queryByText("2P1D-tp8")).not.toBeInTheDocument());
});
