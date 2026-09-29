import type { CSSProperties } from "react";

// Convert HSV to CSS HSL without rounding away differences between nearby hues.
function hsv(hue: number, saturation: number, value: number): string {
  const lightness = value * (1 - saturation / 2);
  const hslSaturation = lightness === 0 || lightness === 1 ? 0 : (value - lightness) / Math.min(lightness, 1 - lightness);
  return `hsl(${hue} ${hslSaturation * 100}% ${lightness * 100}%)`;
}

function seededHue(content: string): number {
  let hash = 2166136261;
  for (const char of content) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return (hash >>> 0) / 2 ** 32 * 360;
}

/** Stable for the same set of labels, independent of input order and filtering. */
export function createTagColors(contents: readonly string[]): Map<string, CSSProperties> {
  const hues: number[] = [];
  const colors = new Map<string, CSSProperties>();
  for (const content of Array.from(new Set(contents)).sort()) {
    let hue = seededHue(content);
    if (hues.some(used => Math.min(Math.abs(used - hue), 360 - Math.abs(used - hue)) < 24)) {
      // Split the widest remaining gap when the seeded color is too close.
      const sorted = [...hues].sort((a, b) => a - b);
      let widest = -1;
      sorted.forEach((start, index) => {
        const end = index + 1 < sorted.length ? sorted[index + 1] : sorted[0] + 360;
        if (end - start > widest) {
          widest = end - start;
          hue = (start + widest / 2) % 360;
        }
      });
    }
    hues.push(hue);
    colors.set(content, {
      color: hsv(hue, 0.65, 0.62),
      backgroundColor: hsv(hue, 0.065, 1),
      borderColor: hsv(hue, 0.17, 0.94),
    });
  }
  return colors;
}
