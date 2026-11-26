export function measureSiglusFlick(dx: number, dy: number, milliseconds: number) {
  const pixelsPerSecond = milliseconds > 0 ? Math.hypot(dx, dy) * 1000 / milliseconds : 0;
  // At 0x6c081e the native engine converts pixels to millimetres with the device DPI.
  const millimetresPerSecond = pixelsPerSecond * (25.4 / 96);
  return {angle: Math.atan2(dx, dy), pixelsPerSecond, millimetresPerSecond};
}

/** Matches the configured angle regions and 180 mm/s threshold in 1.1.141.3. */
export function siglusFlickScene(
  config: ReadonlyMap<string, string>,
  {angle, millimetresPerSecond}: ReturnType<typeof measureSiglusFlick>,
): string | undefined {
  if (millimetresPerSecond < 180) return;
  const quarter = Math.fround(Math.PI / 4);
  const half = Math.fround(Math.PI / 2);
  const threeQuarters = Math.fround(3 * Math.PI / 4);
  const regions: readonly (readonly [number, number, boolean?])[] = [
    [-half, half, true],
    [-half, half],
    [0, Infinity],
    [-Infinity, 0],
    [-threeQuarters, threeQuarters, true],
    [-quarter, quarter],
    [quarter, threeQuarters],
    [-threeQuarters, -quarter],
  ];
  const count = Number(config.get('FLICK_SCENE.CNT') ?? 0);
  for (let index = 0; index < Math.min(256, count); index++) {
    const prefix = `FLICK_SCENE.${String(index).padStart(3, '0')}`;
    const region = regions[Number(config.get(`${prefix}.ANGLE`)) - 1];
    const key = `${prefix}.SCENE`;
    if (!region || !config.has(key)) continue;
    const [start, end, outside = false] = region;
    if ((angle >= start && angle < end) !== outside) return key;
  }
}
