import type { Cell, Workload } from "../lib/api";
import { workloadShape } from "./cell";

export type WorkloadGroup = {
  workloadId: number;
  workloadName: string;
  shapeText: string;
  /** When the Workload was added to *this* Deployment — cards sort oldest
      first, newest last (bottom right of the grid). */
  addedAt: string;
  cells: Cell[];
};

/**
 * Cards come from two sources: Workloads added to the Deployment (possibly
 * with no Cells yet) and the Cells themselves. The union is what renders.
 */
export function mergeGroups(cells: Cell[], attached: Workload[]): WorkloadGroup[] {
  const groups = new Map<number, WorkloadGroup>();
  for (const workload of attached) {
    groups.set(workload.id, {
      workloadId: workload.id,
      workloadName: workload.name,
      shapeText: workloadShape(workload),
      addedAt: workload.added_at ?? workload.created_at,
      cells: [],
    });
  }
  for (const cell of cells) {
    let group = groups.get(cell.workload_id);
    if (!group) {
      group = {
        workloadId: cell.workload_id,
        workloadName: cell.workload_name ?? `workload ${cell.workload_id}`,
        shapeText: cell.workload_kind
          ? workloadShape({
              kind: cell.workload_kind,
              input_tokens: cell.workload_input_tokens ?? null,
              output_tokens: cell.workload_output_tokens ?? null,
              dataset: cell.workload_dataset ?? null,
            })
          : "",
        // Cell rows don't carry the attachment's added_at; a cell-derived
        // group without an attachment sorts as oldest.
        addedAt: "",
        cells: [],
      };
      groups.set(cell.workload_id, group);
    }
    group.cells.push(cell);
  }
  const out = Array.from(groups.values());
  out.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.workloadId - b.workloadId);
  for (const group of out) {
    group.cells.sort((a, b) => a.mode.localeCompare(b.mode) || a.level - b.level);
  }
  return out;
}
