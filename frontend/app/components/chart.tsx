"use client";

export type Point = {
  x: number;
  y: number;
};

export type Series = {
  label: string;
  points: Point[];
};

/**
 * Identity, not judgement.
 *
 * Deliberately not a green/red pair: colouring a series by how good its numbers
 * look would make the chart decide something the reader is there to decide.
 */
export const SERIES_COLOURS = ["#2563eb", "#7c3aed", "#d97706", "#0891b2", "#475569"];

const WIDTH = 340;
const HEIGHT = 150;
const PAD = { top: 10, right: 12, bottom: 26, left: 48 };

/**
 * A level on the x axis is a geometric ladder far more often than an
 * arithmetic one — 1, 4, 16, 64 leaves a linear axis with the interesting
 * region crammed into the first few percent. Levels are always positive
 * (the API rejects anything else), so a log axis is safe and shows the knee.
 */
function xFraction(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min));
}

function formatTick(value: number): string {
  if (value === 0) return "0";
  if (Math.abs(value) >= 1) return value.toFixed(0);
  return value.toFixed(2);
}

export function MultiLineChart({
  title,
  unit,
  xLabel,
  series,
  showLegend = false,
}: {
  title: string;
  unit: string;
  xLabel: string;
  series: Series[];
  showLegend?: boolean;
}) {
  const usable = series
    .map((entry, index) => ({
      ...entry,
      colour: SERIES_COLOURS[index % SERIES_COLOURS.length],
      points: entry.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
    }))
    .filter((entry) => entry.points.length > 0);

  if (usable.length === 0) {
    return (
      <figure className="flex flex-col gap-1">
        <figcaption className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
          {title}
        </figcaption>
        <p className="text-xs text-neutral-400">无数据</p>
      </figure>
    );
  }

  const xs = usable.flatMap((entry) => entry.points.map((point) => point.x));
  const ys = usable.flatMap((entry) => entry.points.map((point) => point.y));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);
  const yMin = Math.min(0, ...ys);

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  const toX = (value: number) => PAD.left + xFraction(value, xMin, xMax) * plotWidth;
  // A flat series has no range to scale against; park it in the middle rather
  // than dividing by zero.
  const toY = (value: number) =>
    yMax === yMin
      ? PAD.top + plotHeight / 2
      : PAD.top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight;

  const yTicks = [yMin, yMin + (yMax - yMin) / 2, yMax];

  return (
    // Named on the figure, not the svg: the legend lives out here, and a name
    // that covers only the drawing would leave it unaccounted for.
    <figure aria-label={title} className="flex flex-col gap-1">
      <figcaption className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
        {title} <span className="font-normal text-neutral-400">({unit})</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full text-neutral-300 dark:text-neutral-700"
        role="img"
        aria-label={`${title} 随${xLabel}变化`}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={toY(tick)}
              y2={toY(tick)}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray={tick === yMin ? undefined : "2 3"}
            />
            <text
              x={PAD.left - 6}
              y={toY(tick) + 3}
              textAnchor="end"
              className="fill-current text-[9px]"
            >
              {formatTick(tick)}
            </text>
          </g>
        ))}

        {usable.map((entry) => {
          const [first, ...rest] = entry.points;
          const path = [`M ${toX(first.x)} ${toY(first.y)}`]
            .concat(rest.map((point) => `L ${toX(point.x)} ${toY(point.y)}`))
            .join(" ");
          return (
            <g key={entry.label}>
              <path d={path} fill="none" stroke={entry.colour} strokeWidth={1.8} />
              {entry.points.map((point) => (
                <circle
                  key={point.x}
                  cx={toX(point.x)}
                  cy={toY(point.y)}
                  r={2.6}
                  fill={entry.colour}
                />
              ))}
            </g>
          );
        })}

        {Array.from(new Set(usable.flatMap((entry) => entry.points.map((point) => point.x)))).map((x) => (
          <text
            key={x}
            x={toX(x)}
            y={HEIGHT - PAD.bottom + 12}
            textAnchor="middle"
            className="fill-current text-[9px]"
          >
            {formatTick(x)}
          </text>
        ))}

        <text
          x={PAD.left + plotWidth / 2}
          y={HEIGHT - 3}
          textAnchor="middle"
          className="fill-current text-[9px]"
        >
          {xLabel}
        </text>
      </svg>

      {showLegend ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {usable.map((entry) => (
            <li key={entry.label} className="flex items-center gap-1 text-xs">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: entry.colour }}
              />
              <span className="text-neutral-600 dark:text-neutral-400">{entry.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}

export function LineChart({
  title,
  unit,
  points,
  xLabel,
}: {
  title: string;
  unit: string;
  points: Point[];
  xLabel: string;
}) {
  return (
    <MultiLineChart title={title} unit={unit} xLabel={xLabel} series={[{ label: title, points }]} />
  );
}
