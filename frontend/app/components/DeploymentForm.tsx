"use client";

import { useState } from "react";

import { Button, ErrorBanner, Field, TextInput } from "./ui";
import { describe, type Deployment, type DeploymentInput } from "../lib/api";

export type FormValues = {
  name: string;
  note: string;
  router_url: string;
  model_name: string;
  api_key_env: string;
  context_length: string;
  synthetic_input_limit: string;
  topology: string;
  gpu_model: string;
  gpu_count: string;
  image: string;
};

export const BLANK_DEPLOYMENT: FormValues = {
  name: "",
  note: "",
  router_url: "",
  model_name: "",
  api_key_env: "LLM_API_KEY",
  context_length: "",
  synthetic_input_limit: "65536",
  topology: "",
  gpu_model: "",
  gpu_count: "",
  image: "",
};

/** A blank Deployment. Built-in defaults only; anything else comes from
 * copying the previous Deployment (see the model page). */
export function blankDeployment(): FormValues {
  return { ...BLANK_DEPLOYMENT };
}

/**
 * A new Deployment usually differs from the previous one in name only, so
 * the create form starts from a copy of it — minus the identity fields.
 */
export function copyFrom(deployment: Deployment): FormValues {
  return { ...valuesFrom(deployment), name: "" };
}

export function valuesFrom(deployment: Deployment): FormValues {
  return {
    name: deployment.name,
    note: deployment.note,
    router_url: deployment.router_url,
    model_name: deployment.model_name,
    api_key_env: deployment.api_key_env,
    context_length: deployment.context_length?.toString() ?? "",
    synthetic_input_limit: deployment.synthetic_input_limit.toString(),
    topology: deployment.topology,
    gpu_model: deployment.gpu_model,
    gpu_count: deployment.gpu_count?.toString() ?? "",
    image: deployment.image,
  };
}

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : Number(trimmed);
}

export function toPayload(values: FormValues): DeploymentInput {
  return {
    name: values.name,
    note: values.note,
    router_url: values.router_url,
    model_name: values.model_name,
    api_key_env: values.api_key_env,
    context_length: optionalNumber(values.context_length),
    synthetic_input_limit: Number(values.synthetic_input_limit),
    topology: values.topology,
    gpu_model: values.gpu_model,
    gpu_count: optionalNumber(values.gpu_count),
    image: values.image,
  };
}

export function DeploymentForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: FormValues;
  submitLabel: string;
  onSubmit: (values: FormValues) => Promise<void>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<FormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5 p-4">
      <ErrorBanner message={error} />

      <Section title="身份">
        <Field label="部署方式名称" hint="例如 2P1D-tp8、3P2D-tp4">
          <TextInput
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="2P1D-tp8"
            required
          />
        </Field>
        <Field label="备注">
          <TextInput value={values.note} onChange={(event) => set("note", event.target.value)} />
        </Field>
      </Section>

      <Section title="连接">
        <Field label="Router 地址">
          <TextInput
            value={values.router_url}
            onChange={(event) => set("router_url", event.target.value)}
            placeholder="http://172.18.16.149:9000"
            required
          />
        </Field>
        <Field label="模型名" hint="发给服务时使用的 model 参数">
          <TextInput
            value={values.model_name}
            onChange={(event) => set("model_name", event.target.value)}
            placeholder="DeepSeek-V4-Flash-0731"
            required
          />
        </Field>
        <Field
          label="API Key 的环境变量名"
          hint="只记变量名，密钥本身不落盘、不入库。执行时若该变量未设置，则不发送鉴权头。"
        >
          <TextInput
            value={values.api_key_env}
            onChange={(event) => set("api_key_env", event.target.value)}
            placeholder="LLM_API_KEY"
          />
        </Field>
      </Section>

      <Section title="压测默认值">
        <Field label="生成上限（输入 token）" hint="合成 workload 的输入长度封顶">
          <TextInput
            type="number"
            min={1}
            value={values.synthetic_input_limit}
            onChange={(event) => set("synthetic_input_limit", event.target.value)}
            required
          />
        </Field>
        <Field label="上下文长度" hint="留空则在压测时自动发现">
          <TextInput
            type="number"
            min={1}
            value={values.context_length}
            onChange={(event) => set("context_length", event.target.value)}
            placeholder="自动发现"
          />
        </Field>
      </Section>

      <Section title="部署元数据（仅展示）">
        <Field label="拓扑">
          <TextInput
            value={values.topology}
            onChange={(event) => set("topology", event.target.value)}
            placeholder="2P1D"
          />
        </Field>
        <Field label="GPU 型号">
          <TextInput value={values.gpu_model} onChange={(event) => set("gpu_model", event.target.value)} />
        </Field>
        <Field label="GPU 数量">
          <TextInput
            type="number"
            min={1}
            value={values.gpu_count}
            onChange={(event) => set("gpu_count", event.target.value)}
          />
        </Field>
        <Field label="镜像">
          <TextInput value={values.image} onChange={(event) => set("image", event.target.value)} />
        </Field>
      </Section>

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            取消
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {title}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}
