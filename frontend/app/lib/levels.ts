/**
 * Level sequences, as typed into a text field.
 *
 * A page module may not export anything but its component — Next generates
 * types that reject extra exports — so parsing lives here, where it can also be
 * tested on its own.
 *
 * A ladder is a *set*, not a sequence: order and repetition carry no meaning
 * (cells are sorted at display, and the uniqueness key forbids duplicates), so
 * sorting and deduping happen here rather than erroring. Tokens that cannot be
 * a level at all are reported, never silently dropped.
 */
export type ParsedLevels = {
  /** Sorted, deduplicated, positive levels. */
  levels: number[];
  /** Tokens that cannot be a level, as typed. */
  invalid: string[];
};

export function parseLevels(raw: string): ParsedLevels {
  const levels = new Set<number>();
  const invalid: string[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    const value = Number(token);
    if (Number.isFinite(value) && value > 0) {
      levels.add(value);
    } else if (!invalid.includes(token)) {
      invalid.push(token);
    }
  }
  return { levels: Array.from(levels).sort((a, b) => a - b), invalid };
}
