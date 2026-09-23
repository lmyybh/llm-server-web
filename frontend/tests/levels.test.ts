import { describe, expect, test } from "vitest";

import { parseLevels } from "../app/lib/levels";

describe("parseLevels", () => {
  test("reads a comma separated sequence", () => {
    expect(parseLevels("1,4,16")).toEqual({ levels: [1, 4, 16], invalid: [] });
  });

  test("tolerates spaces", () => {
    expect(parseLevels(" 1 , 4 ,16 ")).toEqual({ levels: [1, 4, 16], invalid: [] });
  });

  test("accepts fractional rates, because QPS levels are not whole numbers", () => {
    expect(parseLevels("0.5,1,2")).toEqual({ levels: [0.5, 1, 2], invalid: [] });
  });

  test("a ladder is a set: input order and repetition carry no meaning", () => {
    expect(parseLevels("16, 1, 4")).toEqual({ levels: [1, 4, 16], invalid: [] });
    expect(parseLevels("4, 1, 4")).toEqual({ levels: [1, 4], invalid: [] });
  });

  test("tokens that cannot be a level are reported, never silently dropped", () => {
    expect(parseLevels("abc,4")).toEqual({ levels: [4], invalid: ["abc"] });
    expect(parseLevels("0,-1,4")).toEqual({ levels: [4], invalid: ["0", "-1"] });
  });

  test("empty segments are not tokens at all", () => {
    expect(parseLevels("1,,4,")).toEqual({ levels: [1, 4], invalid: [] });
    expect(parseLevels("")).toEqual({ levels: [], invalid: [] });
    expect(parseLevels("   ")).toEqual({ levels: [], invalid: [] });
  });
});
