// Pure timeline helpers. Unit tests in packages/ui/test.

/** Highest number of lanes with work at the same instant. */
export function maxConcurrency(spans: ReadonlyArray<{ lane: string; start: number; end: number }>): number {
  const points: Array<[number, number, string]> = [];
  for (const s of spans) {
    points.push([s.start, 1, s.lane], [s.end, -1, s.lane]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const active = new Map<string, number>();
  let best = 0;
  for (const [, d, lane] of points) {
    active.set(lane, (active.get(lane) ?? 0) + d);
    if ((active.get(lane) ?? 0) <= 0) active.delete(lane);
    best = Math.max(best, active.size);
  }
  return best;
}
