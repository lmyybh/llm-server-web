import { vi } from "vitest";

import type {
  Artifacts,
  Cell,
  CellMode,
  CellStatus,
  Comparison,
  ComparisonCell,
  DatasetEntry,
  Deployment,
  InspectionRun,
  Service,
  Model,
  Workload,
} from "../app/lib/api";

export function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 1,
    name: "DeepSeek-V4-Flash",
    note: "",
    deployment_count: 0,
    latest_run_at: null,
    active_cells: 0,
    created_at: "2026-09-17T00:00:00+00:00",
    updated_at: "2026-09-17T00:00:00+00:00",
    ...overrides,
  };
}

export function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 1,
    model_id: 1,
    name: "2P1D-tp8",
    note: "",
    router_url: "http://host:9000",
    model_name: "DeepSeek-V4-Flash-0731",
    api_key_env: "LLM_API_KEY",
    context_length: null,
    synthetic_input_limit: 65536,
    gpu_model: "",
    gpu_count: null,
    topology: "",
    image: "",
    created_at: "2026-09-17T00:00:00+00:00",
    updated_at: "2026-09-17T00:00:00+00:00",
    ...overrides,
  };
}

export function makeWorkload(overrides: Partial<Workload> = {}): Workload {
  return {
    id: 1,
    name: "synthetic-1024-128",
    note: "",
    kind: "synthetic",
    input_tokens: 1024,
    output_tokens: 128,
    dataset: null,
    cell_count: 0,
    deployment_count: 0,
    created_at: "2026-09-17T00:00:00+00:00",
    ...overrides,
  };
}

/** A completed Cell's numbers, so a chart has something to draw. */
export const CELL_RESULTS = {
  total_requests: 64,
  successful_requests: 64,
  failed_requests: 0,
  duration_seconds: 19.6,
  offered_qps: null,
  achieved_qps: 3.27,
  input_token_throughput: 3343.5,
  output_token_throughput: 417.9,
  ttft_p50: 788.7,
  ttft_p95: 801.2,
  ttft_p99: 805.9,
  tpot_p50: 13.07,
  tpot_p95: 13.38,
  tpot_p99: 13.4,
  e2e_p50: 2446.8,
  e2e_p95: 2487.3,
  e2e_p99: 2487.9,
  ttft_histogram: { "500-1000": 64 },
  tpot_histogram: { "10-20": 64 },
  e2e_histogram: { "1000-2500": 64 },
  finish_reasons: { length: 64 },
  error_categories: null,
} as const;

export function makeCell(overrides: Partial<Cell> = {}): Cell {
  const completed = !("status" in overrides) || overrides.status === "completed";
  const measured = completed
    ? {
        ...CELL_RESULTS,
        status: "completed" as CellStatus,
        last_run_at: "2026-09-17T00:00:20+00:00",
        started_at: "2026-09-17T00:00:00+00:00",
        finished_at: "2026-09-17T00:00:20+00:00",
        executed_snapshot: {
          workload: {
            id: 1,
            name: "synthetic-1024-128",
            kind: "synthetic" as const,
            input_tokens: 1024,
            output_tokens: 128,
            dataset: null,
          },
          mode: "concurrency" as CellMode,
          level: 8,
          num_requests: 64,
          warmup_requests: 5,
          flush_cache: true,
          seed: 42,
          tool: "llmbench 0.1.0",
        },
      }
    : {};
  const cell: Cell = {
    id: 1,
    deployment_id: 1,
    workload_id: 1,
    mode: "concurrency",
    level: 8,
    num_requests: 64,
    status: "idle",
    progress: null,
    executed_snapshot: null,
    stale: false,
    last_run_at: null,
    total_requests: null,
    successful_requests: null,
    failed_requests: null,
    duration_seconds: null,
    offered_qps: null,
    achieved_qps: null,
    actual_concurrency: null,
    input_token_throughput: null,
    output_token_throughput: null,
    metric_summaries: null,
    ttft_p50: null,
    ttft_p95: null,
    ttft_p99: null,
    tpot_p50: null,
    tpot_p95: null,
    tpot_p99: null,
    e2e_p50: null,
    e2e_p95: null,
    e2e_p99: null,
    ttft_histogram: null,
    tpot_histogram: null,
    e2e_histogram: null,
    finish_reasons: null,
    error_categories: null,
    artifact_dir: null,
    queued_at: null,
    started_at: null,
    finished_at: null,
    error: null,
    created_at: "2026-09-17T00:00:00+00:00",
    workload_name: "synthetic-1024-128",
    workload_kind: "synthetic",
    workload_input_tokens: 1024,
    workload_output_tokens: 128,
    workload_dataset: null,
    ...measured,
    ...overrides,
  };
  // The snapshot describes what was executed; by default that is the cell's
  // own configuration, so a seeded cell is not stale unless a test says so.
  if (cell.executed_snapshot && !("stale" in overrides && overrides.stale)) {
    cell.executed_snapshot = {
      ...cell.executed_snapshot,
      mode: cell.mode,
      level: cell.level,
      num_requests: cell.num_requests,
    };
  }
  if (cell.status === "completed" && cell.artifact_dir === null) {
    cell.artifact_dir = `/artifacts/cells/${cell.id}`;
  }
  return cell;
}

export function makeService(overrides: Partial<Service> = {}): Service {
  return {
    id: 1,
    name: "V4-Flash 灰度",
    note: "",
    router_url: "http://host:9000",
    api_key_env: "LLM_API_KEY",
    enabled_case_ids: ["completion.non_stream", "extensions.tools"],
    created_at: "2026-09-17T00:00:00+00:00",
    updated_at: "2026-09-17T00:00:00+00:00",
    ...overrides,
  };
}

export function makeInspection(overrides: Partial<InspectionRun> = {}): InspectionRun {
  return {
    id: 1,
    service_id: 1,
    suite_version: "2",
    case_ids: ["completion.non_stream", "extensions.tools"],
    completed_cases: 2,
    target: {
      base_url: "http://host:9000",
      model: "DeepSeek-V4-Flash-0731",
      context_length: 32768,
      tokenizer_available: true,
      tools: "supported",
      thinking: "supported",
      server_kind: "sglang",
      server_version: null,
    },
    status: "completed",
    verdict: "PASS",
    current_case: null,
    progress: null,
    queued_at: "2026-09-17T00:00:00+00:00",
    started_at: "2026-09-17T00:00:01+00:00",
    finished_at: "2026-09-17T00:00:20+00:00",
    error: null,
    pid: 123,
    cases: [
      {
        case_id: "completion.non_stream",
        required: true,
        verdict: "PASS",
        reason_code: "assertions_passed",
        message: "",
      },
      {
        case_id: "extensions.tools",
        required: false,
        verdict: "SKIPPED",
        reason_code: "capability_unsupported",
        message: "",
      },
    ],
    ...overrides,
  };
}

/**
 * A stateful stand-in for the backend.
 *
 * Written as a small in-memory API rather than a per-test return value, so a
 * test can read like the thing a person does: fill a form, submit, watch the
 * list change. A mock that always returns the same payload would pass even if
 * the page never refreshed.
 *
 * A queued Cell advances one step per ``listCells`` poll — queued → running →
 * completed — which is how polling is exercised without a real clock.
 */
export function fakeApi(
    seed: {
    models?: Model[];
    deployments?: Deployment[];
    workloads?: Workload[];
    cells?: Cell[];
    attachments?: { deployment_id: number; workload_id: number; added_at?: string }[];
    comparison?: Comparison;
    artifacts?: Artifacts;
    datasets?: DatasetEntry[];
    services?: Service[];
    inspections?: InspectionRun[];
  } = {},
) {
  const models = [...(seed.models ?? [])];
  const deployments = [...(seed.deployments ?? [])];
  const workloads = [...(seed.workloads ?? [])];
  const cells = [...(seed.cells ?? [])];
  const services = [...(seed.services ?? [])];
  const inspections = [...(seed.inspections ?? [])];
  // Which workloads are added to which deployment, independent of cells.
  type Attachment = { deployment_id: number; workload_id: number; added_at: string };
  const attachments: Attachment[] = (seed.attachments ?? []).map((entry, index) => ({
    ...entry,
    added_at:
      entry.added_at ??
      new Date(Date.UTC(2026, 8, 17, 0, 0, index)).toISOString(),
  }));
  const attachNow = (deploymentId: number, workloadId: number) => {
    attachments.push({
      deployment_id: deploymentId,
      workload_id: workloadId,
      added_at: new Date(Date.UTC(2026, 8, 17, 0, 0, attachments.length)).toISOString(),
    });
  };
  // Ids are per table, the way SQLite's AUTOINCREMENT actually behaves.
  const nextId = (rows: { id: number }[]) => Math.max(0, ...rows.map((row) => row.id)) + 1;

  const cellSummary = (deploymentId: number) => {
    const mine = cells.filter((cell) => cell.deployment_id === deploymentId);
    const byStatus: Record<string, number> = {};
    let latest: string | null = null;
    for (const cell of mine) {
      byStatus[cell.status] = (byStatus[cell.status] ?? 0) + 1;
      if (cell.last_run_at && (!latest || cell.last_run_at > latest)) latest = cell.last_run_at;
    }
    return { total: mine.length, by_status: byStatus, latest_run_at: latest };
  };

  const isStale = (cell: Cell): boolean => {
    const snapshot = cell.executed_snapshot;
    if (!snapshot) return false;
    return (
      snapshot.num_requests !== cell.num_requests ||
      snapshot.mode !== cell.mode ||
      snapshot.level !== cell.level
    );
  };

  const publicCell = (cell: Cell): Cell => ({ ...cell, stale: isStale(cell) });

  // Poll ticks, so a freshly queued Cell is *seen* as queued before it moves:
  // a Cell advances only when at least two reads have passed since it entered
  // its current in-flight state.
  let tick = 0;
  const enteredAt = new Map<number, number>();
  for (const cell of cells) enteredAt.set(cell.id, 0);

  const advance = () => {
    tick += 1;
    // One queue, one Cell at a time — the fake keeps the same invariant.
    for (const cell of cells) {
      if (tick - (enteredAt.get(cell.id) ?? 0) < 2) continue;
      if (cell.status === "queued") {
        cell.status = "running";
        cell.started_at = "2026-09-17T00:00:01+00:00";
        cell.progress = { phase: "测量中", completed_requests: 0, total_requests: cell.num_requests };
        return;
      }
      if (cell.status === "running") {
        Object.assign(cell, CELL_RESULTS, {
          status: "completed" as CellStatus,
          progress: null,
          error: null,
          last_run_at: "2026-09-17T00:00:20+00:00",
          finished_at: "2026-09-17T00:00:20+00:00",
          executed_snapshot: {
            workload: {
              id: cell.workload_id,
              name: cell.workload_name ?? `workload ${cell.workload_id}`,
              kind: cell.workload_kind ?? "synthetic",
              input_tokens: cell.workload_input_tokens ?? null,
              output_tokens: cell.workload_output_tokens ?? null,
              dataset: cell.workload_dataset ?? null,
            },
            mode: cell.mode,
            level: cell.level,
            num_requests: cell.num_requests,
            warmup_requests: 5,
            flush_cache: true,
            seed: 42,
            tool: "llmbench 0.1.0",
          },
          artifact_dir: `/artifacts/cells/${cell.id}`,
        });
        return;
      }
    }
  };

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Requests are same-origin and therefore relative; the base is arbitrary.
    const url = new URL(String(input), "http://test.local");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const payload = init?.body ? JSON.parse(String(init.body)) : {};

    if (path === "/api/models" && method === "GET") {
      return json(
        // Oldest first, like the real API — the newest card sits bottom-right.
        models.map((model) => {
          const ownCells = cells.filter((cell) =>
            deployments.some((d) => d.model_id === model.id && d.id === cell.deployment_id),
          );
          const runAts = ownCells
            .map((cell) => cell.last_run_at)
            .filter((value): value is string => value !== null);
          return {
            ...model,
            deployment_count: deployments.filter((d) => d.model_id === model.id).length,
            latest_run_at: runAts.length > 0 ? runAts.sort().reverse()[0] : null,
            active_cells: ownCells.filter(
              (cell) => cell.status === "queued" || cell.status === "running",
            ).length,
          };
        }),
      );
    }
    if (path === "/api/models" && method === "POST") {
      if (models.some((model) => model.name === payload.name)) {
        return json({ detail: `a model named '${payload.name}' already exists` }, 409);
      }
      const created = makeModel({ id: nextId(models), name: payload.name, note: payload.note ?? "" });
      models.push(created);
      return json(created, 201);
    }

    const modelMatch = path.match(/^\/api\/models\/(\d+)$/);
    if (modelMatch && method === "GET") {
      const found = models.find((model) => model.id === Number(modelMatch[1]));
      return found ? json(found) : json({ detail: "model does not exist" }, 404);
    }
    if (modelMatch && method === "PATCH") {
      const found = models.find((model) => model.id === Number(modelMatch[1]));
      if (!found) return json({ detail: "model does not exist" }, 404);
      if (payload.name) found.name = payload.name;
      if (payload.note !== undefined) found.note = payload.note;
      return json(found);
    }
    if (modelMatch && method === "DELETE") {
      const modelId = Number(modelMatch[1]);
      const index = models.findIndex((model) => model.id === modelId);
      if (index === -1) return json({ detail: "model does not exist" }, 404);
      const ownDeployments = deployments.filter((d) => d.model_id === modelId).map((d) => d.id);
      const inFlight = cells.filter(
        (cell) =>
          ownDeployments.includes(cell.deployment_id) &&
          (cell.status === "queued" || cell.status === "running"),
      ).length;
      if (inFlight > 0) {
        return json({ detail: `${inFlight} cell(s) queued or running; cancel them first` }, 409);
      }
      models.splice(index, 1);
      for (let i = cells.length - 1; i >= 0; i -= 1) {
        if (ownDeployments.includes(cells[i].deployment_id)) cells.splice(i, 1);
      }
      for (let i = deployments.length - 1; i >= 0; i -= 1) {
        if (deployments[i].model_id === modelId) deployments.splice(i, 1);
      }
      return new Response(null, { status: 204 });
    }

    const modelDeployments = path.match(/^\/api\/models\/(\d+)\/deployments$/);
    if (modelDeployments && method === "GET") {
      const modelId = Number(modelDeployments[1]);
      return json(
        deployments
          .filter((deployment) => deployment.model_id === modelId)
          .reverse()
          .map((deployment) => ({ ...deployment, cells: cellSummary(deployment.id) })),
      );
    }
    if (modelDeployments && method === "POST") {
      const modelId = Number(modelDeployments[1]);
      if (
        deployments.some(
          (deployment) => deployment.model_id === modelId && deployment.name === payload.name,
        )
      ) {
        return json({ detail: "this model already has a deployment with that name" }, 409);
      }
      const created = makeDeployment({
        id: nextId(deployments),
        model_id: modelId,
        name: payload.name,
        note: payload.note ?? "",
        router_url: payload.router_url,
        model_name: payload.model_name,
        api_key_env: payload.api_key_env ?? "LLM_API_KEY",
        context_length: payload.context_length ?? null,
        synthetic_input_limit: payload.synthetic_input_limit ?? 65536,
        gpu_model: payload.gpu_model ?? "",
        gpu_count: payload.gpu_count ?? null,
        topology: payload.topology ?? "",
        image: payload.image ?? "",
      });
      deployments.push(created);
      return json(created, 201);
    }

    const deploymentMatch = path.match(/^\/api\/deployments\/(\d+)$/);
    if (deploymentMatch && method === "GET") {
      const found = deployments.find((d) => d.id === Number(deploymentMatch[1]));
      return found ? json(found) : json({ detail: "deployment does not exist" }, 404);
    }
    if (deploymentMatch && method === "PATCH") {
      const found = deployments.find((d) => d.id === Number(deploymentMatch[1]));
      if (!found) return json({ detail: "deployment does not exist" }, 404);
      Object.assign(found, payload);
      return json(found);
    }
    if (deploymentMatch && method === "DELETE") {
      const index = deployments.findIndex((d) => d.id === Number(deploymentMatch[1]));
      if (index === -1) return json({ detail: "deployment does not exist" }, 404);
      const inFlight = cells.filter(
        (cell) =>
          cell.deployment_id === deployments[index].id &&
          (cell.status === "queued" || cell.status === "running"),
      ).length;
      if (inFlight > 0) {
        return json({ detail: `${inFlight} cell(s) queued or running; cancel them first` }, 409);
      }
      deployments.splice(index, 1);
      for (let index2 = cells.length - 1; index2 >= 0; index2 -= 1) {
        if (cells[index2].deployment_id === Number(deploymentMatch[1])) cells.splice(index2, 1);
      }
      return new Response(null, { status: 204 });
    }

    // --- workloads (global library) ---

    if (path === "/api/workloads" && method === "GET") {
      return json(
        workloads.map((workload) => ({
          ...workload,
          cell_count: cells.filter((cell) => cell.workload_id === workload.id).length,
          deployment_count: new Set([
            ...cells
              .filter((cell) => cell.workload_id === workload.id)
              .map((cell) => cell.deployment_id),
            ...attachments
              .filter((entry) => entry.workload_id === workload.id)
              .map((entry) => entry.deployment_id),
          ]).size,
        })),
      );
    }
    if (path === "/api/workloads" && method === "POST") {
      if (workloads.some((workload) => workload.name === payload.name)) {
        return json({ detail: `a workload named '${payload.name}' already exists` }, 409);
      }
      if (payload.kind === "synthetic" && (!payload.input_tokens || !payload.output_tokens)) {
        return json(
          { detail: "a synthetic workload needs input_tokens and output_tokens" },
          422,
        );
      }
      if (payload.kind === "dataset" && !payload.dataset) {
        return json({ detail: "a dataset workload needs a dataset name" }, 422);
      }
      const created = makeWorkload({
        id: nextId(workloads),
        name: payload.name,
        note: payload.note ?? "",
        kind: payload.kind,
        input_tokens: payload.kind === "synthetic" ? payload.input_tokens : null,
        output_tokens: payload.kind === "synthetic" ? payload.output_tokens : null,
        dataset: payload.kind === "dataset" ? payload.dataset : null,
      });
      workloads.push(created);
      return json(created, 201);
    }

    const workloadMatch = path.match(/^\/api\/workloads\/(\d+)$/);
    if (workloadMatch && method === "GET") {
      const found = workloads.find((w) => w.id === Number(workloadMatch[1]));
      return found ? json(found) : json({ detail: "workload does not exist" }, 404);
    }
    if (workloadMatch && method === "PATCH") {
      const found = workloads.find((w) => w.id === Number(workloadMatch[1]));
      if (!found) return json({ detail: "workload does not exist" }, 404);
      if (payload.name) found.name = payload.name;
      if (payload.note !== undefined) found.note = payload.note;
      return json(found);
    }
    if (workloadMatch && method === "DELETE") {
      const id = Number(workloadMatch[1]);
      const index = workloads.findIndex((w) => w.id === id);
      if (index < 0) return json({ detail: "workload does not exist" }, 404);
      const referenced = cells.filter((cell) => cell.workload_id === id).length;
      if (referenced > 0) {
        return json(
          { detail: `workload ${id} is referenced by ${referenced} cell(s); delete those cells first` },
          409,
        );
      }
      const attached = attachments.filter((entry) => entry.workload_id === id).length;
      if (attached > 0) {
        return json(
          { detail: `workload ${id} is added to ${attached} deployment(s); remove it there first` },
          409,
        );
      }
      workloads.splice(index, 1);
      return json(null, 204);
    }

    // --- deployment ↔ workload attachments ---

    const deploymentWorkloadsMatch = path.match(/^\/api\/deployments\/(\d+)\/workloads$/);
    if (deploymentWorkloadsMatch && method === "GET") {
      const deploymentId = Number(deploymentWorkloadsMatch[1]);
      return json(
        attachments
          .filter((entry) => entry.deployment_id === deploymentId)
          .map((entry) => {
            const workload = workloads.find((w) => w.id === entry.workload_id);
            return workload ? { ...workload, added_at: entry.added_at } : null;
          })
          .filter((workload) => workload !== null),
      );
    }

    const attachmentMatch = path.match(/^\/api\/deployments\/(\d+)\/workloads\/(\d+)$/);
    if (attachmentMatch && method === "PUT") {
      const deploymentId = Number(attachmentMatch[1]);
      const workloadId = Number(attachmentMatch[2]);
      const workload = workloads.find((w) => w.id === workloadId);
      if (!workload) return json({ detail: "workload does not exist" }, 404);
      if (
        attachments.some(
          (entry) => entry.deployment_id === deploymentId && entry.workload_id === workloadId,
        )
      ) {
        return json(
          { detail: `workload ${workloadId} is already added to deployment ${deploymentId}` },
          409,
        );
      }
      attachNow(deploymentId, workloadId);
      return json(workload, 201);
    }
    if (attachmentMatch && method === "DELETE") {
      const deploymentId = Number(attachmentMatch[1]);
      const workloadId = Number(attachmentMatch[2]);
      const referenced = cells.filter(
        (cell) => cell.deployment_id === deploymentId && cell.workload_id === workloadId,
      ).length;
      if (referenced > 0) {
        return json(
          {
            detail: `workload ${workloadId} still has ${referenced} cell(s) under deployment ${deploymentId}; delete those cells first`,
          },
          409,
        );
      }
      const index = attachments.findIndex(
        (entry) => entry.deployment_id === deploymentId && entry.workload_id === workloadId,
      );
      if (index < 0) {
        return json(
          { detail: `workload ${workloadId} is not added to deployment ${deploymentId}` },
          404,
        );
      }
      attachments.splice(index, 1);
      return new Response(null, { status: 204 });
    }

    // --- cells ---

    const cellListMatch = path.match(/^\/api\/deployments\/(\d+)\/cells$/);
    if (cellListMatch && method === "GET") {
      advance();
      const deploymentId = Number(cellListMatch[1]);
      return json(cells.filter((cell) => cell.deployment_id === deploymentId).map(publicCell));
    }
    if (cellListMatch && method === "POST") {
      const deploymentId = Number(cellListMatch[1]);
      const workload = workloads.find((w) => w.id === payload.workload_id);
      if (!workload) return json({ detail: "workload does not exist" }, 404);
      const levels = payload.levels as number[];
      const rawCounts = payload.num_requests as number[];
      const counts =
        rawCounts.length === 1 ? levels.map(() => rawCounts[0]) : rawCounts;
      // The first Cell attaches the pair, the way the backend does.
      if (
        !attachments.some(
          (entry) => entry.deployment_id === deploymentId && entry.workload_id === workload.id,
        )
      ) {
        attachNow(deploymentId, workload.id);
      }
      const conflicts = levels.filter((level) =>
        cells.some(
          (cell) =>
            cell.deployment_id === deploymentId &&
            cell.workload_id === payload.workload_id &&
            cell.mode === payload.mode &&
            cell.level === level,
        ),
      );
      if (conflicts.length > 0) {
        return json(
          {
            detail: `these cells already exist for mode=${payload.mode}: level ${conflicts
              .sort((a, b) => a - b)
              .join(", ")}`,
          },
          409,
        );
      }
      const created = levels.map((level, index) => {
        const cell = makeCell({
          id: nextId(cells),
          deployment_id: deploymentId,
          workload_id: workload.id,
          mode: payload.mode,
          level,
          num_requests: counts[index],
          status: "idle",
          workload_name: workload.name,
          workload_kind: workload.kind,
          workload_input_tokens: workload.input_tokens,
          workload_output_tokens: workload.output_tokens,
          workload_dataset: workload.dataset,
        });
        cells.push(cell);
        return cell;
      });
      return json(created.map(publicCell), 201);
    }

    const estimateMatch = path.match(/^\/api\/deployments\/(\d+)\/estimate$/);
    if (estimateMatch && method === "POST") {
      const estimateLevels = payload.levels as number[];
      const estimateCounts =
        (payload.num_requests as number[]).length === 1
          ? estimateLevels.map(() => (payload.num_requests as number[])[0])
          : (payload.num_requests as number[]);
      return json({
        estimated_seconds: estimateLevels.length * 30,
        cell_count: estimateLevels.length,
        request_count: estimateCounts.reduce((sum, count) => sum + count, 0),
        latency_seconds: 2,
        latency_is_estimated: true,
      });
    }

    const cellRunMatch = path.match(/^\/api\/cells\/(\d+)\/run$/);
    if (cellRunMatch && method === "POST") {
      const found = cells.find((cell) => cell.id === Number(cellRunMatch[1]));
      if (!found) return json({ detail: "cell does not exist" }, 404);
      if (found.status === "queued" || found.status === "running") {
        return json({ detail: `cell ${found.id} is ${found.status}; it cannot be started now` }, 409);
      }
      found.status = "queued";
      found.queued_at = "2026-09-17T00:05:00+00:00";
      found.error = null;
      enteredAt.set(found.id, tick);
      return json(publicCell(found));
    }

    if (path === "/api/cells/run" && method === "POST") {
      const ids = payload.cell_ids as number[];
      const targets = ids.map((id) => cells.find((cell) => cell.id === id));
      if (targets.some((cell) => !cell)) return json({ detail: "cell does not exist" }, 404);
      for (const cell of targets as Cell[]) {
        if (cell.status === "queued" || cell.status === "running") {
          return json(
            { detail: `cell ${cell.id} is ${cell.status}; it cannot be started now` },
            409,
          );
        }
      }
      for (const cell of targets as Cell[]) {
        cell.status = "queued";
        cell.queued_at = "2026-09-17T00:05:00+00:00";
        cell.error = null;
        enteredAt.set(cell.id, tick);
      }
      return json((targets as Cell[]).map(publicCell));
    }

    const cellCancelMatch = path.match(/^\/api\/cells\/(\d+)\/cancel$/);
    if (cellCancelMatch && method === "POST") {
      const found = cells.find((cell) => cell.id === Number(cellCancelMatch[1]));
      if (!found) return json({ detail: "cell does not exist" }, 404);
      if (found.status !== "queued" && found.status !== "running") {
        return json({ detail: `cell ${found.id} is ${found.status}, nothing to cancel` }, 409);
      }
      found.status = "cancelled";
      found.finished_at = "2026-09-17T00:10:00+00:00";
      found.error = "cancelled by the user";
      found.progress = null;
      return json(publicCell(found));
    }

    const cellArtifactsMatch = path.match(/^\/api\/cells\/(\d+)\/artifacts$/);
    if (cellArtifactsMatch && method === "GET") {
      const cellId = Number(cellArtifactsMatch[1]);
      const found = cells.find((cell) => cell.id === cellId);
      if (!found?.artifact_dir) return json({ cell_id: cellId, files: [], total_bytes: 0 });
      return json(
        seed.artifacts ?? {
          cell_id: cellId,
          directory: found.artifact_dir,
          files: [
            { name: "plan.json", bytes: 512 },
            { name: "requests.jsonl", bytes: 4096 },
          ],
          total_bytes: 4608,
        },
      );
    }

    const cellMatch = path.match(/^\/api\/cells\/(\d+)$/);
    if (cellMatch && method === "GET") {
      const found = cells.find((cell) => cell.id === Number(cellMatch[1]));
      if (!found) return json({ detail: "cell does not exist" }, 404);
      const workload = workloads.find((w) => w.id === found.workload_id);
      return json({ ...publicCell(found), workload });
    }
    if (cellMatch && method === "PATCH") {
      const found = cells.find((cell) => cell.id === Number(cellMatch[1]));
      if (!found) return json({ detail: "cell does not exist" }, 404);
      if (payload.num_requests !== undefined) found.num_requests = payload.num_requests;
      return json(publicCell(found));
    }
    if (cellMatch && method === "DELETE") {
      const index = cells.findIndex((cell) => cell.id === Number(cellMatch[1]));
      if (index < 0) return json({ detail: "cell does not exist" }, 404);
      if (cells[index].status === "queued" || cells[index].status === "running") {
        return json({ detail: "cancel it before deleting" }, 409);
      }
      cells.splice(index, 1);
      return json(null, 204);
    }

    // --- comparison ---

    if (path === "/api/compare" && method === "GET") {
      if (seed.comparison) return json(seed.comparison);
      const ids = (url.searchParams.get("deployment_ids") ?? "")
        .split(",")
        .map(Number)
        .filter((value) => value > 0);
      const selected = deployments.filter((deployment) => ids.includes(deployment.id));
      const sections = comparisonSections(selected, cells);
      return json({
        deployments: selected.map((deployment) => ({ id: deployment.id, name: deployment.name })),
        sections,
      });
    }

    // --- datasets ---

    if (path === "/api/datasets" && method === "GET") {
      return json(seed.datasets ?? []);
    }

    // --- services and inspection ---

    if (path === "/api/inspection-cases" && method === "GET") {
      return json([
        { case_id: "completion.non_stream", title: "非流式响应格式", group: "基础接口" },
        { case_id: "extensions.tools", title: "工具调用能力", group: "可选能力" },
        { case_id: "validation.malformed_json", title: "拒绝损坏的 JSON", group: "异常输入" },
        { case_id: "extensions.thinking", title: "思考模式开关", group: "可选能力" },
      ]);
    }

    if (path === "/api/services" && method === "GET") {
      return json(services);
    }
    if (path === "/api/services" && method === "POST") {
      if (services.some((service) => service.name === payload.name)) {
        return json({ detail: `a service named '${payload.name}' already exists` }, 409);
      }
      const created = makeService({ id: nextId(services), ...payload });
      services.push(created);
      return json(created, 201);
    }

    const serviceMatch = path.match(/^\/api\/services\/(\d+)$/);
    if (serviceMatch && method === "GET") {
      const found = services.find((s) => s.id === Number(serviceMatch[1]));
      return found ? json(found) : json({ detail: "service does not exist" }, 404);
    }

    const serviceCases = path.match(/^\/api\/services\/(\d+)\/inspection-cases$/);
    if (serviceCases && method === "PUT") {
      const found = services.find((service) => service.id === Number(serviceCases[1]));
      if (!found) return json({ detail: "service does not exist" }, 404);
      found.enabled_case_ids = payload.case_ids;
      return json(found);
    }

    const serviceInspections = path.match(/^\/api\/services\/(\d+)\/inspections$/);
    if (serviceInspections && method === "GET") {
      const id = Number(serviceInspections[1]);
      return json(inspections.filter((run) => run.service_id === id));
    }
    if (serviceInspections && method === "POST") {
      const id = Number(serviceInspections[1]);
      const service = services.find((entry) => entry.id === id);
      const caseIds = service?.enabled_case_ids ?? [];
      const created = makeInspection({ id: nextId(inspections), service_id: id, status: "running", verdict: null, case_ids: caseIds, completed_cases: 0, cases: [], current_case: caseIds[0] ?? null });
      inspections.push(created);
      return json(created, 201);
    }

    const inspectionMatch = path.match(/^\/api\/inspections\/(\d+)$/);
    if (inspectionMatch && method === "GET") {
      const found = inspections.find((r) => r.id === Number(inspectionMatch[1]));
      return found ? json(found) : json({ detail: "inspection does not exist" }, 404);
    }
    if (inspectionMatch && method === "DELETE") {
      const index = inspections.findIndex((r) => r.id === Number(inspectionMatch[1]));
      if (index < 0) return json({ detail: "inspection does not exist" }, 404);
      if (inspections[index].status === "queued" || inspections[index].status === "running") {
        return json({ detail: "cancel it before deleting" }, 409);
      }
      inspections.splice(index, 1);
      return json(null, 204);
    }

    const inspectionCancel = path.match(/^\/api\/inspections\/(\d+)\/cancel$/);
    if (inspectionCancel && method === "POST") {
      const found = inspections.find((r) => r.id === Number(inspectionCancel[1]));
      if (!found) return json({ detail: "inspection does not exist" }, 404);
      found.status = "cancelled";
      return json(found);
    }

    return json({ detail: `no route for ${method} ${path}` }, 404);
  });
}

/** Align completed Cells by (workload, mode, level), the way the backend does. */
function comparisonSections(deployments: Deployment[], cells: Cell[]): Comparison["sections"] {
  const sections = new Map<string, Comparison["sections"][number]>();
  for (const cell of cells.filter(
    (cell) =>
      cell.status === "completed" && deployments.some((d) => d.id === cell.deployment_id),
  )) {
    const key = `${cell.workload_id}-${cell.mode}`;
    const section =
      sections.get(key) ??
      (() => {
        const created: Comparison["sections"][number] = {
          workload: {
            id: cell.workload_id,
            name: cell.workload_name ?? `workload ${cell.workload_id}`,
            kind: cell.workload_kind ?? "synthetic",
            input_tokens: cell.workload_input_tokens ?? null,
            output_tokens: cell.workload_output_tokens ?? null,
            dataset: cell.workload_dataset ?? null,
          },
          mode: cell.mode,
          levels: [],
          no_common_levels: false,
          notices: [],
          rows: [],
        };
        sections.set(key, created);
        return created;
      })();
    if (!section.levels.includes(cell.level)) {
      section.levels.push(cell.level);
      section.levels.sort((a, b) => a - b);
    }
    let row = section.rows.find((entry) => entry.level === cell.level);
    if (!row) {
      row = { level: cell.level, cells: {} };
      section.rows.push(row);
      section.rows.sort((a, b) => a.level - b.level);
    }
    const trimmed = Object.fromEntries(
      [
        "id",
        "level",
        "num_requests",
        "total_requests",
        "successful_requests",
        "failed_requests",
        "duration_seconds",
        "offered_qps",
        "achieved_qps",
        "input_token_throughput",
        "output_token_throughput",
        "ttft_p50",
        "ttft_p95",
        "ttft_p99",
        "tpot_p50",
        "tpot_p95",
        "tpot_p99",
        "e2e_p50",
        "e2e_p95",
        "e2e_p99",
        "last_run_at",
        "stale",
      ].map((field) => [field, cell[field as keyof Cell]]),
    ) as unknown as ComparisonCell;
    row.cells[String(cell.deployment_id)] = trimmed;
  }
  const out: Comparison["sections"] = [];
  sections.forEach((section) => {
    const common = section.levels.filter((level: number) =>
      deployments.every((deployment) => {
        const row = section.rows.find((entry) => entry.level === level);
        return row?.cells[String(deployment.id)];
      }),
    );
    section.no_common_levels = common.length === 0;
    out.push(section);
  });
  return out;
}
