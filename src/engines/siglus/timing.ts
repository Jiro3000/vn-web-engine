// A third and two thirds along the x axis give the Bézier a linear time parameter.
export function eventEasing(mode: number): string {
  if (mode === 1) return 'cubic-bezier(0.3333333333, 0, 0.6666666667, 0.3333333333)';
  if (mode === 2) return 'cubic-bezier(0.3333333333, 0.6666666667, 0.6666666667, 1)';
  return mode === 0 ? 'linear' : 'steps(1, end)';
}

/** The native timetable consumes a separate list for each segment. */
export function timetable(
  elapsed: number,
  initial: number,
  segments: readonly (readonly number[])[],
): number {
  let previous = initial;
  for (const [start = 0, end = 0, target = 0, mode = 0] of segments) {
    if (elapsed < start) break;
    if (elapsed >= end) {
      previous = target;
      continue;
    }
    const position = (elapsed - start) / (end - start);
    const distance = target - previous;
    let value = previous;
    if (mode === 0) value += distance * position;
    else if (mode === 1) value += distance * position ** 2;
    else if (mode === 2) value = target - distance * (1 - position) ** 2;
    return Math.trunc(value + (value < 0 ? -0.5 : 0.5)) || 0;
  }
  return previous;
}
