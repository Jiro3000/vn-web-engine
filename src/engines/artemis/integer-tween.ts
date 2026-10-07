import {artemisRevision} from './revision.js';
function int32(value: number): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    throw Error('Unsupported Artemis int32 tween value');
}
/** Default ed9d0/eccf0 audio tween: curve0, no delay/repeat/yoyo. Native timing
 * initializes on first tick and compares absolute uint32 times, including its
 * zero-start sentinel and wrap behavior. Interpolation is float64, truncated
 * toward zero before calling the integer setter. No timer is invented here. */
export class ArtemisLinearIntegerTween {
  private start = 0;
  private end = 0;
  private completed = false;
  constructor(
    hash: string,
    readonly from: number,
    readonly to: number,
    readonly milliseconds: number,
    private readonly apply: (value: number) => void,
    private readonly onComplete: () => void = () => {},
  ) {
    artemisRevision(hash);
    int32(from);
    int32(to);
    int32(milliseconds);
  }
  get done(): boolean {
    return this.completed;
  }
  cancel(): void {
    this.completed = true;
  }
  finish(): void {
    if (this.completed) return;
    this.apply(this.to);
    this.completed = true;
    this.onComplete();
  }
  tick(now: number): boolean {
    if (!Number.isInteger(now) || now < 0 || now > 0xffffffff)
      throw Error('Unsupported Artemis uint32 tween clock');
    if (this.completed) return true;
    if (this.start === 0) {
      this.start = now;
      this.end = (this.start + (this.milliseconds >>> 0)) >>> 0;
    }
    if (now <= this.start) {
      this.apply(this.from);
      return false;
    }
    if (this.end <= now) {
      this.finish();
      return true;
    }
    const elapsed = (now - this.start) >>> 0,
      duration = this.milliseconds >>> 0,
      value = Math.trunc(this.from + ((this.to - this.from) / duration) * elapsed) | 0;
    this.apply(value);
    return false;
  }
}
