/**
 * xoshiro128++ 1.0 of Blackman and Vigna (2019), a 32-bit generator with 128 bits of state.
 * https://prng.di.unimi.it/xoshiro128plusplus.c
 */
export class Xoshiro128pp {
  private readonly s: Uint32Array;

  constructor(state: ArrayLike<number>) {
    this.s = Uint32Array.from(state);
  }

  /**
   * The state from one 32-bit seed: word k (0..3) is the MurmurHash3 finaliser of
   * seed + (k + 1) · 0x9E3779B9.
   */
  static fromSeed(seed: number): Xoshiro128pp {
    const state: number[] = [];
    for (let k = 1; k <= 4; k++) {
      let h = (seed + Math.imul(k, 0x9e3779b9)) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      state.push((h ^ (h >>> 16)) >>> 0);
    }
    return new Xoshiro128pp(state);
  }

  /** The next 32-bit output. */
  next(): number {
    const s = this.s;
    const sum = (s[0]! + s[3]!) | 0;
    const result = (((sum << 7) | (sum >>> 25)) + s[0]!) >>> 0;
    const t = s[1]! << 9;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3] = (s[3]! << 11) | (s[3]! >>> 21);
    return result;
  }
}
