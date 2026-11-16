type Point = readonly [number, number];

export interface FanWipe {
  softness: number;
  quadrant: number;
  reverse: boolean;
}

// The native mode-60 generator (0x646ab0, 0x646da0) uses a different
// integer origin for each quadrant and assigns 64 values to each sweep.
export function fanWipeMask(
  width: number,
  height: number,
  {quadrant, reverse}: FanWipe,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const x = Math.floor(width / 2);
  const y = Math.floor(height / 2);
  const radius = Math.floor(Math.SQRT2 * (Math.max(x, y) + 64));
  const centers: Point[] = [
    [x - 1, y - 1],
    [x, y - 1],
    [x, y],
    [x - 1, y],
  ];
  const axes: Point[] = [
    [-1, 0],
    [0, -1],
    [1, 0],
    [0, 1],
  ];
  for (let band = 0; band < 4; band++) {
    const index = (quadrant + band) % 4;
    const [cx, cy] = centers[index]!;
    const [dx, dy] = axes[index]!;
    let previous: Point | undefined;
    for (let step = 0; step < 64; step++) {
      // The PE converts degrees with its stored 3.1415 constant.
      const angle = (3.1415 / 2) * (step / 63);
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const next: Point = [
        cx + Math.trunc(radius * (dx * cos - dy * sin) + 0.5),
        cy + Math.trunc(radius * (dy * cos + dx * sin) + 0.5),
      ];
      const level = band * 64 + step;
      if (previous && (previous[0] !== next[0] || previous[1] !== next[1]))
        fillTriangle(mask, width, height, [cx, cy], previous, next, reverse ? level : 255 - level);
      previous = next;
    }
  }
  return mask;
}

function fillTriangle(
  mask: Uint8Array,
  width: number,
  height: number,
  origin: Point,
  first: Point,
  second: Point,
  level: number,
): void {
  const edges = [
    [origin, first],
    [first, second],
    [second, origin],
  ] as const;
  const top = Math.max(0, Math.min(origin[1], first[1], second[1]));
  const bottom = Math.min(height - 1, Math.max(origin[1], first[1], second[1]));
  for (let y = top; y <= bottom; y++) {
    let left = width;
    let right = -1;
    for (const [[x0, y0], [x1, y1]] of edges) {
      if (y < Math.min(y0, y1) || y > Math.max(y0, y1)) continue;
      if (y0 === y1) {
        left = Math.min(left, x0, x1);
        right = Math.max(right, x0, x1);
      } else {
        const x = x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    left = Math.max(0, Math.round(left));
    right = Math.min(width - 1, Math.round(right));
    if (right >= left) mask.fill(level, y * width + left, y * width + right + 1);
  }
}
