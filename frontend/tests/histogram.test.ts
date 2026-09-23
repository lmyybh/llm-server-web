import { describe, expect, test } from "vitest";

import { mergeHistograms, totalCount } from "../app/lib/histogram";

describe("mergeHistograms", () => {
  test("adds counts bucket by bucket", () => {
    const merged = mergeHistograms([
      { "100-250": 3, "250-500": 1 },
      { "100-250": 2, "250-500": 4 },
    ]);
    expect(merged).toEqual({ "100-250": 5, "250-500": 5 });
  });

  test("keeps the bucket order, which is the order the edges were declared in", () => {
    const merged = mergeHistograms([
      { "<10": 1, "10-25": 2, ">=25": 3 },
      { "<10": 1, "10-25": 2, ">=25": 3 },
    ]);
    expect(Object.keys(merged ?? {})).toEqual(["<10", "10-25", ">=25"]);
  });

  test("the total is the sum of the parts", () => {
    const levels = [{ "<10": 5 }, { "<10": 7 }, { "<10": 1 }];
    expect(totalCount(mergeHistograms(levels))).toBe(13);
  });

  test("a level that recorded nothing is skipped, not treated as zeroes", () => {
    const merged = mergeHistograms([{ "<10": 5 }, null, undefined, { "<10": 1 }]);
    expect(merged).toEqual({ "<10": 6 });
  });

  test("nothing recorded anywhere is null rather than an empty distribution", () => {
    // An empty object would render as "all buckets zero" — a claim. Null is
    // the absence of one.
    expect(mergeHistograms([null, null])).toBeNull();
    expect(mergeHistograms([])).toBeNull();
  });

  test("a bucket missing from one level still totals correctly", () => {
    const merged = mergeHistograms([{ "<10": 5, "10-25": 1 }, { "10-25": 2 }]);
    expect(merged).toEqual({ "<10": 5, "10-25": 3 });
  });
});

describe("totalCount", () => {
  test("counts every sample across the buckets", () => {
    expect(totalCount({ a: 1, b: 2, c: 3 })).toBe(6);
  });

  test("nothing is zero, not undefined", () => {
    expect(totalCount(null)).toBe(0);
    expect(totalCount({})).toBe(0);
  });
});
