import type { Cell, Deployment } from "./api";
import { REPORT_PERCENTILES, reportCell, reportSummaryValue, finite, type ReportMetric } from "./report-metrics";

const metrics: ReportMetric[] = ["e2e_ms", "ttft_ms", "tpot_ms", "input_tokens", "output_tokens"];
function csvValue(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Workload and deployment names are user supplied; do not execute spreadsheet formulas.
  if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function deploymentReportCsv(deployment: Deployment, cells: Cell[]): string {
  const rows: unknown[][] = [["部署", "Workload", "模式", "档位", "状态", "旧配置", "执行时间", "执行器", "执行时请求数", "总请求", "成功", "失败", "耗时(s)", "实际并发", "成功率(%)", "请求吞吐(req/s)", "输入吞吐(tok/s)", "输出吞吐(tok/s)", ...metrics.flatMap(m => REPORT_PERCENTILES.map(p => `${m} ${p}`))]];
  for (const raw of cells) {
    const c = reportCell(raw);
    rows.push([deployment.name, c.executed_snapshot?.workload.name ?? c.workload_name ?? `workload ${c.workload_id}`, c.mode, c.level, c.status, c.stale, c.last_run_at, c.executed_snapshot?.executor, c.executed_snapshot?.num_requests, c.total_requests, c.successful_requests, c.failed_requests, c.duration_seconds, finite(c.actual_concurrency), c.total_requests && c.successful_requests != null ? c.successful_requests / c.total_requests * 100 : null, finite(c.achieved_qps), finite(c.input_token_throughput), finite(c.output_token_throughput), ...metrics.flatMap(m => REPORT_PERCENTILES.map(p => reportSummaryValue(c, m, p)))]);
  }
  return "\ufeff" + rows.map(row => row.map(csvValue).join(",")).join("\r\n");
}
