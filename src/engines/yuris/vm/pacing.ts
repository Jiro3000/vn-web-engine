/**
 * The frame pacing 0x4109A8 and its FPS settings. A frame lasts 1000 / FPS milliseconds,
 * accumulated in 16.16 fixed point so fractional periods average out. A frame that finishes
 * early sleeps for the rest of its period; a late one moves the reference time instead, and
 * when it is at least three periods late and SKIP is set, the next frame skips its window
 * output and drawing.
 */
export class YurisFramePacer {
  /** 0x59B6F0: frames per second, FPS SET (1..256). */
  fps = 60;
  /** 0x59B6F4: FPS SKIP. */
  skip = 1;
  /** 0x5B8740: the previous frame's pacing asked this frame to skip its output. */
  skipping = false;
  /** 0x5B8748: the skip decision of this frame, applied to the next one. */
  private next = false;
  /** 0x5BA5E0: the 16.16 period; its low word carries the fraction to the next frame. */
  private period = 0;
  /** 0x871FDC: the reference time the elapsed time of a frame is measured from. */
  private base = 0;
  /** 0x8725A8: the frame time after pacing. */
  time = 0;
  /** 0x871FE0: the start of the counted second; 0x871FE4 and 0x871FE8 its paced and drawn frames. */
  private second = 0;
  private paced = 0;
  private drawn = 0;
  /** 0x8722B8 and 0x8722BC: the previous second's paced and drawn frames. */
  lastPaced = 0;
  lastDrawn = 0;
  /** Host: a key or button press arrived; the frame that polls it is shown without waiting. */
  private pressed = false;
  private restart = false;

  /** Host: a key or button press ends the current wait; see `poll`. */
  interrupt(): void {
    this.pressed = true;
  }

  /** Host: the input poll of a frame consumes the press, so this frame's `begin` returns 0. */
  poll(): void {
    this.restart = this.pressed;
    this.pressed = false;
  }

  /** 0x4459F8 (after LOAD restores a layer): the reference time becomes `now`. */
  rebase(now: number): void {
    this.base = now >>> 0;
  }

  /** 0x442AB8: FPS SET restarts the per-second counts. */
  setRate(fps: number, now: number): void {
    this.fps = fps;
    this.lastPaced = this.paced;
    this.lastDrawn = this.drawn;
    this.paced = 0;
    this.drawn = 0;
    this.second = now >>> 0;
  }

  /** 0x410D24: a frame was drawn. */
  countDrawn(): void {
    this.drawn++;
  }

  /**
   * 0x4109A8 up to its `Sleep`: the milliseconds the frame still has to wait, 0 when it is on
   * time or late.
   */
  begin(now: number): number {
    now >>>= 0;
    this.time = now;
    this.period = (this.period & 0xffff) + Math.trunc(0x3e80000 / this.fps);
    const interval = this.period >>> 16;
    const elapsed = (now - this.base) >>> 0;
    if (this.restart) {
      // Host: the frame that handles a press shows at once. The reference time stays, so
      // the next frames keep the frame grid of the frames before the press.
      this.restart = false;
      this.next = false;
      return 0;
    }
    if (elapsed < interval) {
      this.base = (this.base + interval) >>> 0;
      this.next = false;
      return interval - elapsed;
    }
    let late = elapsed - interval;
    if (late >= 0xfa) late = 0;
    this.next = late >= interval * 3 && (this.skip & 1) !== 0;
    this.time = this.base = (now + late) >>> 0;
    return 0;
  }

  /** The rest of 0x4109A8 after the sleep (`now` is read again only when it slept). */
  end(now: number, slept: boolean): void {
    if (slept) this.time = now >>> 0;
    if (Math.trunc(this.second / 1000) !== Math.trunc(this.time / 1000)) {
      this.lastPaced = this.paced;
      this.lastDrawn = this.drawn;
      this.paced = 0;
      this.drawn = 0;
      this.second = this.time;
    }
    this.paced++;
  }

  /** The end of 0x404164: the decision of this frame takes effect on the next one. */
  advance(): void {
    this.skipping = this.next;
  }
}
