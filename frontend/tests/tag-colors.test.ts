import { expect, test } from "vitest";
import { createTagColors } from "../app/lib/tag-colors";

test("assigns distinct colors beyond the old five-color limit, including similar and Unicode labels", () => {
  const labels = Array.from({ length: 40 }, (_, i) => `专项检查${i}🚀`);
  const colors = createTagColors(labels);
  expect(new Set(Array.from(colors.values(), style => style.color)).size).toBe(labels.length);
  expect(createTagColors([...labels].reverse())).toEqual(colors);
  expect(createTagColors([...labels, labels[0]])).toEqual(colors);
  expect(createTagColors([]).size).toBe(0);
});
