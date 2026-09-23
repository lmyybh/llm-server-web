export type Buckets = Record<string, number>;

/**
 * Sum per-level histograms into a whole-run distribution.
 *
 * This is why per-request samples never have to be stored: buckets are
 * additive, so the whole-run shape is recoverable exactly from what each level
 * kept. It only works because every level of a given metric shares one set of
 * bucket edges — the server guarantees that, and changing an edge set
 * invalidates stored histograms for that metric.
 *
 * Bucket order comes from insertion order, and every histogram supplies its
 * buckets in the same order, so the merged key order stays meaningful.
 */
export function mergeHistograms(histograms: (Buckets | null | undefined)[]): Buckets | null {
  const merged: Buckets = {};
  let sawAny = false;
  for (const histogram of histograms) {
    if (!histogram) continue;
    sawAny = true;
    for (const [bucket, count] of Object.entries(histogram)) {
      merged[bucket] = (merged[bucket] ?? 0) + count;
    }
  }
  return sawAny ? merged : null;
}

export function totalCount(histogram: Buckets | null | undefined): number {
  if (!histogram) return 0;
  return Object.values(histogram).reduce((sum, count) => sum + count, 0);
}
