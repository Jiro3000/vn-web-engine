import {i64} from './numbers.js';

/**
 * The assignment operators of media command arguments (the op byte of the argument, 0x661780):
 * 0 `=`, 1 `+=`, 2 `-=`, 3 `*=`, 4 `/=`. Other operators keep the current value.
 */

/** 0x425220: 64-bit arithmetic without bounds; division by zero keeps the current value. */
export function applyOp(op: number, current: bigint, value: bigint): bigint {
  switch (op) {
    case 0:
      return value;
    case 1:
      return i64(current + value);
    case 2:
      return i64(current - value);
    case 3:
      return i64(current * value);
    case 4:
      return value === 0n ? current : i64(current / value);
  }
  return current;
}

/**
 * 0x4252A0: as `applyOp`, bounded: `+=` by the maximum, `-=` by the minimum, `*=` and `/=` by
 * both. Plain assignment is not bounded (the decoder's range check covers it).
 */
export function applyBounded(
  op: number,
  current: bigint,
  value: bigint,
  min: bigint,
  max: bigint,
): bigint {
  switch (op) {
    case 0:
      return value;
    case 1: {
      const result = i64(current + value);
      return result > max ? max : result;
    }
    case 2: {
      const result = i64(current - value);
      return result < min ? min : result;
    }
    case 3:
    case 4: {
      if (op === 4 && value === 0n) return current;
      const result = i64(op === 3 ? current * value : current / value);
      return result > max ? max : result < min ? min : result;
    }
  }
  return current;
}

/** 0x4258C8: as `applyOp`, with `-=`, `*=` and `/=` bounded below by `min`. */
export function applyAtLeast(op: number, current: bigint, value: bigint, min: bigint): bigint {
  switch (op) {
    case 0:
      return value;
    case 1:
      return i64(current + value);
    case 2:
    case 3:
    case 4: {
      if (op === 4 && value === 0n) return current;
      const result = i64(op === 2 ? current - value : op === 3 ? current * value : current / value);
      return result < min ? min : result;
    }
  }
  return current;
}
