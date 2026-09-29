/**
 * The external URL prefix this app is served under.
 *
 * When a platform gateway strips a prefix before forwarding to Next.js, the
 * browser still has to *send* it. Must stay in step with next.config.mjs, which
 * applies the same value as an assetPrefix. Inlined at build time.
 */
function normalizeGatewayPrefix(value: string | undefined): string {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

const GATEWAY_PREFIX = normalizeGatewayPrefix(process.env.NEXT_PUBLIC_GATEWAY_PREFIX);

/**
 * API requests are same-origin: Next.js rewrites ``/api/*`` to the backend.
 * Nothing here needs to know where the backend actually runs.
 */
const API_BASE = GATEWAY_PREFIX;

/**
 * Put an internal path back under the gateway prefix.
 *
 * ``assetPrefix`` prefixes ``_next/*`` but **not** the URLs the client router
 * navigates to, so every internal link has to be prefixed by hand. Without it a
 * click sends the browser to ``/models/1`` instead of
 * ``<prefix>/models/1`` — off the gateway's route and into a 404.
 */
export function withGatewayPrefix(path: string): string {
  if (!GATEWAY_PREFIX || path.startsWith(GATEWAY_PREFIX)) return path;
  return `${GATEWAY_PREFIX}${path}`;
}

/** The inverse of withGatewayPrefix, for matching against ``usePathname``. */
export function stripGatewayPrefix(path: string): string {
  if (!GATEWAY_PREFIX || !path.startsWith(GATEWAY_PREFIX)) return path;
  return path.slice(GATEWAY_PREFIX.length) || "/";
}

export type Model = {
  id: number;
  name: string;
  note: string;
  deployment_count: number;
  /** The most recent measurement across all of this Model's Deployments. */
  latest_run_at: string | null;
  /** Cells queued or running right now, across all of its Deployments. */
  active_cells: number;
  created_at: string;
  updated_at: string;
};

/** A one-line summary of a Deployment's Cells, attached to list responses. */
export type CellSummary = {
  total: number;
  by_status: Partial<Record<CellStatus, number>>;
  latest_run_at: string | null;
};

export type Deployment = {
  id: number;
  model_id: number;
  name: string;
  note: string;
  router_url: string;
  model_name: string;
  api_key_env: string;
  context_length: number | null;
  synthetic_input_limit: number;
  gpu_model: string;
  gpu_count: number | null;
  topology: string;
  image: string;
  created_at: string;
  updated_at: string;
  cells?: CellSummary;
};

export type DeploymentInput = {
  name: string;
  note?: string;
  router_url: string;
  model_name: string;
  api_key_env?: string;
  context_length?: number | null;
  synthetic_input_limit?: number;
  gpu_model?: string;
  gpu_count?: number | null;
  topology?: string;
  image?: string;
};

// --- workloads ---------------------------------------------------------------
//
// A Workload is a preset load shape in the *global* library — a category, not
// a measurement. It knows nothing about bench parameters; mode, level and
// request count belong to the Cell.

export type WorkloadKind = "synthetic" | "dataset";

export type Workload = {
  id: number;
  name: string;
  note: string;
  kind: WorkloadKind;
  /** Synthetic only: input/output token counts. Null for dataset workloads. */
  input_tokens: number | null;
  output_tokens: number | null;
  /** Dataset only: the registered dataset's name. Null for synthetic ones. */
  dataset: string | null;
  cell_count?: number;
  deployment_count?: number;
  suite_count?: number;
  created_at: string;
  /** Present when listed under a Deployment: when it was added to that Deployment. */
  added_at?: string;
};

export type WorkloadInput =
  | { name: string; note?: string; kind: "synthetic"; input_tokens: number; output_tokens: number }
  | { name: string; note?: string; kind: "dataset"; dataset: string };

export type SuiteCell = {
  workload_id: number;
  mode: CellMode;
  level: number;
  num_requests: number;
};

export type BenchSuite = {
  id: number;
  name: string;
  note: string;
  cells: SuiteCell[];
  created_at: string;
  updated_at: string;
};

export type SuiteInput = Pick<BenchSuite, "name" | "note" | "cells">;

export type SuiteImportResult = {
  created_cells: number;
  skipped_cells: number;
  attached_workloads: number;
};

// --- cells -------------------------------------------------------------------
//
// A Cell is one measurement point: a (deployment, workload, mode, level)
// combination. It stores only its LATEST result — re-running overwrites, and
// there is no run history (ADR-0001).

export type CellStatus = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";

export type CellMode = "concurrency" | "qps";

/**
 * The configuration the executor actually ran with, frozen at execution time.
 * When it disagrees with the Cell's current parameters the Cell is ``stale``:
 * the displayed result came from an older configuration.
 */
export type ExecutedSnapshot = {
  workload: {
    id: number;
    name: string;
    kind: WorkloadKind;
    input_tokens: number | null;
    output_tokens: number | null;
    dataset: string | null;
  };
  mode: CellMode;
  level: number;
  num_requests: number;
  warmup_requests: number;
  flush_cache: boolean;
  seed: number;
  executor?: string;
  tool?: string;
};

export type Cell = {
  id: number;
  deployment_id: number;
  workload_id: number;
  mode: CellMode;
  level: number;
  num_requests: number;
  status: CellStatus;
  progress: {
    error?: string;
    phase?: string;
    completed_requests?: number;
    total_requests?: number;
  } | null;
  executed_snapshot: ExecutedSnapshot | null;
  /** True when the displayed result came from a different configuration. */
  stale: boolean;
  last_run_at: string | null;
  total_requests: number | null;
  successful_requests: number | null;
  failed_requests: number | null;
  duration_seconds: number | null;
  /** Set only for open-loop (qps) Cells, where the level *is* an offered rate. */
  offered_qps: number | null;
  achieved_qps: number | null;
  /** Time-averaged requests actually in flight during the measured run. */
  actual_concurrency: number | null;
  input_token_throughput: number | null;
  output_token_throughput: number | null;
  metric_summaries: Partial<Record<
    "ttft_ms" | "tpot_ms" | "e2e_ms" | "input_tokens" | "output_tokens",
    { mean: number | null; p50: number | null; p70: number | null; p95: number | null; p99: number | null }
  >> | null;
  ttft_p50: number | null;
  ttft_p95: number | null;
  ttft_p99: number | null;
  tpot_p50: number | null;
  tpot_p95: number | null;
  tpot_p99: number | null;
  e2e_p50: number | null;
  e2e_p95: number | null;
  e2e_p99: number | null;
  ttft_histogram: Record<string, number> | null;
  tpot_histogram: Record<string, number> | null;
  e2e_histogram: Record<string, number> | null;
  finish_reasons: Record<string, number> | null;
  error_categories: Record<string, number> | null;
  artifact_dir: string | null;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  /** Joined in for list responses, so a page need not resolve the Workload. */
  workload_name?: string;
  workload_kind?: WorkloadKind;
  workload_input_tokens?: number | null;
  workload_output_tokens?: number | null;
  workload_dataset?: string | null;
  /** The full Workload, attached to single-Cell responses. */
  workload?: Workload;
};

/**
 * Configure Cells under a Deployment: one Workload, one mode, a ladder of
 * levels, and one request count per level. A single count broadcasts across
 * the whole ladder; several counts must pair with the levels one-to-one.
 */
export type CellBatchInput = {
  workload_id: number;
  mode: CellMode;
  levels: number[];
  num_requests: number[];
};

export type Estimate = {
  estimated_seconds: number;
  cell_count: number;
  request_count: number;
  latency_seconds: number;
  latency_is_estimated: boolean;
};

export type DatasetEntry = {
  name: string;
  path: string;
  exists: boolean;
};

// --- comparison --------------------------------------------------------------
//
// Cells aligned by (workload, mode, level) across Deployments of one Model.
// The axis is the union of levels; a Deployment missing a point contributes
// null — rendered 未测.

/** A Cell's numbers, trimmed to what a comparison table or curve needs. */
export type ComparisonCell = Pick<
  Cell,
  | "id"
  | "level"
  | "num_requests"
  | "total_requests"
  | "successful_requests"
  | "failed_requests"
  | "duration_seconds"
  | "offered_qps"
  | "achieved_qps"
  | "input_token_throughput"
  | "output_token_throughput"
  | "ttft_p50"
  | "ttft_p95"
  | "ttft_p99"
  | "tpot_p50"
  | "tpot_p95"
  | "tpot_p99"
  | "e2e_p50"
  | "e2e_p95"
  | "e2e_p99"
  | "last_run_at"
  | "stale"
>;

export type ComparisonSection = {
  workload: {
    id: number;
    name: string;
    kind: WorkloadKind;
    input_tokens: number | null;
    output_tokens: number | null;
    dataset: string | null;
  };
  mode: CellMode;
  levels: number[];
  /** True when no level was measured by every selected Deployment. */
  no_common_levels: boolean;
  /** Advisories that do not participate in pairing, e.g. tool version drift. */
  notices: string[];
  rows: { level: number; cells: Record<string, ComparisonCell | null> }[];
};

export type Comparison = {
  deployments: { id: number; name: string }[];
  sections: ComparisonSection[];
};

// --- inspection --------------------------------------------------------------
//
// A separate system with its own entities. A Service is not a Deployment.

export type Service = {
  id: number;
  name: string;
  note: string;
  router_url: string;
  api_key_env: string;
  enabled_case_ids: string[];
  created_at: string;
  updated_at: string;
};

export type ServiceInput = {
  name: string;
  note?: string;
  router_url: string;
  api_key_env?: string;
};

export type InspectionTarget = {
  base_url: string;
  model: string;
  context_length: number | null;
  tokenizer_available: boolean;
  tools: "supported" | "unsupported" | "unknown";
  thinking: "supported" | "unsupported" | "unknown";
  server_kind: string;
  server_version: string | null;
};

/**
 * ``INCONCLUSIVE`` is not ``FAIL``. One means the service broke a contract;
 * the other means the probe produced no usable evidence. Collapsing them turns
 * "we did not check" into "it is broken".
 */
export type CaseVerdict = "PASS" | "FAIL" | "SKIPPED" | "INCONCLUSIVE" | "ERROR";

export type InspectionCase = {
  case_id: string;
  required: boolean;
  verdict: CaseVerdict;
  reason_code: string;
  message: string;
  evidence?: InspectionExchange[];
};

export type InspectionCaseDefinition = {
  case_id: string;
  title: string;
  group: string;
};

export type InspectionProject = InspectionCaseDefinition & {
  description: string;
  steps: string[];
  pass_rule: string;
  fail_rule: string;
  other_rule: string;
  endpoint: string;
  timeout_seconds: number;
  default_enabled: boolean;
};
export type InspectionProjectSettings = Pick<InspectionProject, "title" | "group" | "timeout_seconds" | "default_enabled">;

export type InspectionExchange = {
  method: string;
  url: string;
  request_body: string | null;
  content_type: string | null;
  auth_required: boolean;
  response_status: number | null;
  response_body: string;
  latency_ms: number;
  error: string | null;
};

export type InspectionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type InspectionRun = {
  id: number;
  service_id: number;
  case_ids: string[];
  completed_cases: number;
  target: InspectionTarget | null;
  status: InspectionStatus;
  verdict: CaseVerdict | null;
  current_case: string | null;
  progress: { current_case?: string } | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  pid: number | null;
  cases: InspectionCase[];
};

export type ArtifactFile = { name: string; bytes: number };

export type Artifacts = {
  cell_id: number;
  directory?: string;
  files: ArtifactFile[];
  total_bytes: number;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Turn a FastAPI error body into something a person can act on.
 *
 * Validation failures arrive as a list of nested objects; showing that raw is
 * how a form becomes a puzzle. Our own rejections (a mistyped environment
 * variable name, a duplicate Deployment) arrive as plain strings and are the
 * most useful messages the API produces — they must survive intact.
 */
async function describeError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const parts = detail.map((entry: Record<string, unknown>) => {
        const location = entry.loc;
        const field = Array.isArray(location) ? String(location[location.length - 1]) : "";
        const message = typeof entry.msg === "string" ? entry.msg : "is invalid";
        return field ? `${field}: ${message}` : message;
      });
      if (parts.length > 0) return parts.join("; ");
    }
  } catch {
    // Body was not JSON; fall through to the status line.
  }
  return `${response.status} ${response.statusText}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${API_BASE}. Is the backend running?`);
  }
  if (!response.ok) {
    throw new ApiError(response.status, await describeError(response));
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function body(payload: unknown): RequestInit {
  return { body: JSON.stringify(payload) };
}

/** A human-readable message for anything this module throws. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export const api = {
  listModels: () => request<Model[]>("/api/models"),
  createModel: (payload: { name: string; note?: string }) =>
    request<Model>("/api/models", { method: "POST", ...body(payload) }),
  getModel: (id: number) => request<Model>(`/api/models/${id}`),
  updateModel: (id: number, payload: { name?: string; note?: string }) =>
    request<Model>(`/api/models/${id}`, { method: "PATCH", ...body(payload) }),
  deleteModel: (id: number) => request<void>(`/api/models/${id}`, { method: "DELETE" }),

  listDeployments: (modelId: number) =>
    request<Deployment[]>(`/api/models/${modelId}/deployments`),
  deleteDeployment: (id: number) =>
    request<void>(`/api/deployments/${id}`, { method: "DELETE" }),
  getDeployment: (id: number) => request<Deployment>(`/api/deployments/${id}`),
  createDeployment: (modelId: number, payload: DeploymentInput) =>
    request<Deployment>(`/api/models/${modelId}/deployments`, { method: "POST", ...body(payload) }),
  updateDeployment: (id: number, payload: Partial<DeploymentInput>) =>
    request<Deployment>(`/api/deployments/${id}`, { method: "PATCH", ...body(payload) }),

  listWorkloads: () => request<Workload[]>("/api/workloads"),
  createWorkload: (payload: WorkloadInput) =>
    request<Workload>("/api/workloads", { method: "POST", ...body(payload) }),
  getWorkload: (id: number) => request<Workload>(`/api/workloads/${id}`),
  updateWorkload: (id: number, payload: { name?: string; note?: string }) =>
    request<Workload>(`/api/workloads/${id}`, { method: "PATCH", ...body(payload) }),
  deleteWorkload: (id: number) => request<void>(`/api/workloads/${id}`, { method: "DELETE" }),

  listSuites: () => request<BenchSuite[]>("/api/suites"),
  createSuite: (payload: SuiteInput) =>
    request<BenchSuite>("/api/suites", { method: "POST", ...body(payload) }),
  updateSuite: (id: number, payload: SuiteInput) =>
    request<BenchSuite>(`/api/suites/${id}`, { method: "PUT", ...body(payload) }),
  deleteSuite: (id: number) => request<void>(`/api/suites/${id}`, { method: "DELETE" }),
  importSuite: (deploymentId: number, suiteId: number) =>
    request<SuiteImportResult>(`/api/deployments/${deploymentId}/suites/${suiteId}/import`, {
      method: "POST",
    }),

  listCells: (deploymentId: number) => request<Cell[]>(`/api/deployments/${deploymentId}/cells`),
  listDeploymentWorkloads: (deploymentId: number) =>
    request<Workload[]>(`/api/deployments/${deploymentId}/workloads`),
  attachWorkload: (deploymentId: number, workloadId: number) =>
    request<Workload>(`/api/deployments/${deploymentId}/workloads/${workloadId}`, {
      method: "PUT",
    }),
  detachWorkload: (deploymentId: number, workloadId: number) =>
    request<void>(`/api/deployments/${deploymentId}/workloads/${workloadId}`, {
      method: "DELETE",
    }),
  createCells: (deploymentId: number, payload: CellBatchInput) =>
    request<Cell[]>(`/api/deployments/${deploymentId}/cells`, {
      method: "POST",
      ...body(payload),
    }),
  getCell: (id: number) => request<Cell>(`/api/cells/${id}`),
  updateCell: (id: number, payload: { num_requests: number }) =>
    request<Cell>(`/api/cells/${id}`, { method: "PATCH", ...body(payload) }),
  deleteCell: (id: number) => request<void>(`/api/cells/${id}`, { method: "DELETE" }),
  runCell: (id: number) => request<Cell>(`/api/cells/${id}/run`, { method: "POST" }),
  runCells: (cellIds: number[]) =>
    request<Cell[]>("/api/cells/run", { method: "POST", ...body({ cell_ids: cellIds }) }),
  cancelCell: (id: number) => request<Cell>(`/api/cells/${id}/cancel`, { method: "POST" }),
  estimateCells: (deploymentId: number, payload: CellBatchInput) =>
    request<Estimate>(`/api/deployments/${deploymentId}/estimate`, {
      method: "POST",
      ...body(payload),
    }),

  compare: (modelId: number, deploymentIds: number[]) =>
    request<Comparison>(`/api/compare?model_id=${modelId}&deployment_ids=${deploymentIds.join(",")}`),

  listDatasets: () => request<DatasetEntry[]>("/api/datasets"),

  listServices: () => request<Service[]>("/api/services"),
  createService: (payload: ServiceInput) =>
    request<Service>("/api/services", { method: "POST", ...body(payload) }),
  getService: (id: number) => request<Service>(`/api/services/${id}`),
  updateService: (id: number, payload: Partial<ServiceInput>) =>
    request<Service>(`/api/services/${id}`, { method: "PATCH", ...body(payload) }),

  listInspections: (serviceId: number) =>
    request<InspectionRun[]>(`/api/services/${serviceId}/inspections`),
  listInspectionCases: () => request<InspectionCaseDefinition[]>("/api/inspection-cases"),
  listInspectionProjects: () => request<InspectionProject[]>("/api/inspection-cases"),
  updateInspectionProject: (id: string, changes: Partial<InspectionProjectSettings>) =>
    request<InspectionProject>(`/api/inspection-cases/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }),
  resetInspectionProjects: () => request<InspectionProject[]>("/api/inspection-cases/reset", { method: "POST" }),
  configureInspectionCases: (serviceId: number, caseIds: string[]) =>
    request<Service>(`/api/services/${serviceId}/inspection-cases`, {
      method: "PUT", body: JSON.stringify({ case_ids: caseIds }),
    }),
  startInspection: (serviceId: number) =>
    request<InspectionRun>(`/api/services/${serviceId}/inspections`, { method: "POST" }),
  getInspection: (id: number) => request<InspectionRun>(`/api/inspections/${id}`),
  deleteInspection: (id: number) => request<void>(`/api/inspections/${id}`, { method: "DELETE" }),
  cancelInspection: (id: number) =>
    request<InspectionRun>(`/api/inspections/${id}/cancel`, { method: "POST" }),

  artifacts: (cellId: number) => request<Artifacts>(`/api/cells/${cellId}/artifacts`),
};

/** A download is a navigation, not a fetch — the browser handles it directly. */
export function artifactsZipUrl(cellId: number): string {
  return withGatewayPrefix(`/api/cells/${cellId}/artifacts.zip`);
}

export const TERMINAL_STATUSES: CellStatus[] = ["completed", "failed", "cancelled"];

export function isTerminal(status: CellStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
