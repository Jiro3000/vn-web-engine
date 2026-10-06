import {artemisHexUint32} from './numbers.js';

export type ArtemisLayerMode = 'normal' | 'add' | 'screen' | 'multiply';
export interface ArtemisLayerPropertyPatch {
  left?: number;
  top?: number;
  alpha?: number;
  /** Outer CArtemisLayer alpha uses double division before conversion to float. */
  wrapperAlpha?: number;
  anchorx?: number;
  anchory?: number;
  xscale?: number;
  yscale?: number;
  rotate?: number;
  reversex?: boolean;
  reversey?: boolean;
  visible?: boolean;
  layermode?: ArtemisLayerMode;
  negative?: boolean;
  grayscale?: boolean;
  colormultiply?: number;
}
const numeric = [
  'left',
  'top',
  'alpha',
  'anchorx',
  'anchory',
  'xscale',
  'yscale',
  'rotate',
] as const;
const flags = ['reversex', 'reversey', 'visible', 'negative', 'grayscale'] as const;
const supported = new Set<string>(['id', 'layermode', 'colormultiply', ...numeric, ...flags]);

/** Decimal finite subset of native atof; preserve prefix parsing and float32 rounding. */
function decimal(value: string): number {
  const input = value.split('\0', 1)[0]!;
  if (/^[\t\n\v\f\r ]*[+-]?(?:0x|inf|nan)/i.test(input))
    throw new Error('Unsupported Artemis layer property number');
  const token = /^[\t\n\v\f\r ]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(input);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isFinite(Math.fround(number)))
    throw new Error('Unsupported Artemis layer property number');
  return number;
}

/** Ordinary image geometry subset of 0x140115650 and wrapper alpha in 0x1400d76d0. */
export function artemisLayerProperties(
  args: ReadonlyMap<string, string>,
): ArtemisLayerPropertyPatch {
  for (const key of args.keys())
    if (!supported.has(key)) throw new Error(`Unsupported Artemis layer property ${key}`);
  const patch: ArtemisLayerPropertyPatch = {};
  for (const key of numeric) {
    if (!args.has(key)) continue;
    const double = decimal(args.get(key)!);
    const float = Math.fround(double);
    patch[key] =
      key === 'alpha'
        ? Math.fround(float / 255)
        : key === 'xscale' || key === 'yscale'
          ? Math.fround(float / 100)
          : float;
    if (key === 'alpha') patch.wrapperAlpha = Math.fround(double / 255);
  }
  for (const key of flags) if (args.has(key)) patch[key] = args.get(key) !== '0';
  const mode = args.get('layermode');
  if (mode === 'normal' || mode === 'add' || mode === 'screen' || mode === 'multiply')
    patch.layermode = mode;
  // Native 115650 leaves the prior mode unchanged for any other spelling.
  if (args.has('colormultiply')) patch.colormultiply = artemisHexUint32(args.get('colormultiply')!);
  return patch;
}
