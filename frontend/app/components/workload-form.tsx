"use client";

import { useEffect, useState } from "react";

import { Button, ErrorBanner, Field, SelectInput, TextInput } from "./ui";
import {
  api,
  describe,
  type DatasetEntry,
  type WorkloadInput,
  type WorkloadKind,
} from "../lib/api";

/**
 * Create a Workload. The shape is frozen at creation — only name and note may
 * change later, so there is no edit form for tokens or dataset.
 */
export function WorkloadForm({
  submitLabel,
  className = "",
  onSubmit,
  onCancel,
}: {
  submitLabel: string;
  className?: string;
  onSubmit: (payload: WorkloadInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<WorkloadKind>("synthetic");
  const [inputTokens, setInputTokens] = useState("");
  const [outputTokens, setOutputTokens] = useState("");
  const [dataset, setDataset] = useState("");
  const [datasets, setDatasets] = useState<DatasetEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .listDatasets()
      .then((registered) => setDatasets(registered.filter((entry) => entry.exists)))
      .catch(() => setDatasets([]));
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const payload: WorkloadInput =
        kind === "synthetic"
          ? {
              name,
              note,
              kind,
              input_tokens: Number(inputTokens),
              output_tokens: Number(outputTokens),
            }
          : { name, note, kind, dataset };
      await onSubmit(payload);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  const shapeReady =
    kind === "synthetic"
      ? Number(inputTokens) > 0 && Number(outputTokens) > 0
      : dataset.trim() !== "";

  return (
    <form
      className={`flex flex-col gap-3 ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ErrorBanner message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名称">
          <TextInput
            aria-label="名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 prefill-1k-128"
          />
        </Field>
        <Field label="类型">
          <div className="flex gap-2" role="radiogroup" aria-label="类型">
            {(
              [
                ["synthetic", "合成数据"],
                ["dataset", "真实数据集"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1 text-sm">
                <input
                  type="radio"
                  name="workload-kind"
                  checked={kind === value}
                  onChange={() => setKind(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </Field>
      </div>

      {kind === "synthetic" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="输入 tokens">
            <TextInput
              aria-label="输入 tokens"
              type="number"
              min={1}
              value={inputTokens}
              onChange={(event) => setInputTokens(event.target.value)}
            />
          </Field>
          <Field label="输出 tokens">
            <TextInput
              aria-label="输出 tokens"
              type="number"
              min={1}
              value={outputTokens}
              onChange={(event) => setOutputTokens(event.target.value)}
            />
          </Field>
        </div>
      ) : (
        <Field label="数据集" hint="来自服务端预置的数据集目录。">
          <SelectInput
            ariaLabel="数据集"
            value={dataset}
            onValueChange={setDataset}
            placeholder="选择一个数据集…"
            options={datasets.map((entry) => ({ value: entry.name, label: entry.name }))}
          />
        </Field>
      )}

      <Field label="备注">
        <TextInput
          aria-label="备注"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      <div className="flex gap-2">
        <Button type="submit" disabled={busy || name.trim() === "" || !shapeReady}>
          {submitLabel}
        </Button>
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          取消
        </Button>
      </div>
    </form>
  );
}
