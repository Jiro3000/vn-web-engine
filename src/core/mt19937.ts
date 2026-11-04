/**
 * MT19937, the 32-bit Mersenne Twister of Matsumoto and Nishimura (1998), with the
 * `init_genrand` seeding of the reference implementation.
 * https://doi.org/10.1145/272991.272995
 */
export class Mt19937 {
  private readonly state = new Uint32Array(624);
  private index = 625;

  constructor(seed: number) {
    this.seed(seed);
  }

  seed(seed: number): void {
    const mt = this.state;
    mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const previous = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
      mt[i] = Math.imul(previous, 0x6c078965) + i;
    }
    this.index = 624;
  }

  /** The next 32-bit output. */
  next(): number {
    const mt = this.state;
    if (this.index >= 624) {
      for (let i = 0; i < 624; i++) {
        const y = (mt[i]! & 0x80000000) | (mt[(i + 1) % 624]! & 0x7fffffff);
        mt[i] = mt[(i + 397) % 624]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    return (y ^ (y >>> 18)) >>> 0;
  }
}
