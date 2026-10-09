import {readTheoraOgg, TheoraDecoder, type TheoraStream} from '../../formats/theora/index.js';
import {artemisRevision} from './revision.js';

/** Native BT.601 conversion tables built by the CTheora constructor 0x140015b50. Luma is
 * not range-expanded; red/blue offsets are added to Y, green uses the summed 16.16 parts. */
const crRed = new Int32Array(256),
  cbBlue = new Int32Array(256),
  crGreen = new Int32Array(256),
  cbGreen = new Int32Array(256);
for (let index = 0; index < 256; index++) {
  crRed[index] = (index * 0x166e9 - 0xb2f480) >> 16;
  cbBlue[index] = (index * 0x1c5a2 - 0xe25100) >> 16;
  crGreen[index] = 0x5b6900 - index * 0xb6d2;
  cbGreen[index] = 0x2c8c80 - index * 0x5819;
}
const clamp = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : value);

/** One CTheora decode stream (main or mask): the decode thread 0x140017010 run
 * synchronously up to the target frame. */
class TheoraStreamState {
  readonly decoder: TheoraDecoder;
  /** +0x220 */
  ended = false;
  /** +0x221 */
  newFrame = false;
  /** +0x228 */
  decoded = -1;
  /** +0x22c */
  target = 0;
  /** Bumped whenever the decoder's reference frame changes. */
  frameRevision = 0;
  private packet = 0;
  constructor(
    private readonly stream: TheoraStream,
    private readonly loop: boolean,
  ) {
    this.decoder = new TheoraDecoder(stream.info, stream.setup);
  }
  /** Runs the decode thread until it would block (`!end && target <= decoded`). */
  pump(): void {
    const packets = this.stream.packets;
    while (!this.ended && this.target > this.decoded) {
      if (this.packet >= packets.length) {
        // End of data: a looping stream seeks to 0; the header packets fed again fail to
        // decode and are not counted, so decoding resumes at the first data packet.
        if (!this.loop || !packets.length) this.ended = true;
        else this.packet = 0;
        continue;
      }
      const packet = packets[this.packet++]!;
      const skipping = this.target - this.decoded > 1;
      // While behind, only intra frames are decoded; skipped packets are still counted.
      if (!skipping || (packet.length > 0 && !(packet[0]! & 0x40))) {
        let duplicate: boolean;
        if (!packet.length) duplicate = true;
        else {
          try {
            duplicate = !this.decoder.decode(packet);
          } catch {
            // th_decode_packetin errors skip the packet without counting it.
            continue;
          }
          this.frameRevision++;
        }
        this.newFrame = !duplicate;
      }
      this.decoded++;
    }
  }
}

/** Native CTheora video decoder object (vtable 0x1403636f8) behind the `video` tag's layer
 * actor. The decoder threads are modelled synchronously: `update` runs each stream up to
 * its target before using it, which is the state native reaches after its waits.
 *
 * The surface is the picture region in RGBA. Conversion follows 0x140016390: the native
 * tables, 4:2:0 chroma indexing for every pixel format (row floor(picY/2) + floor(r/2),
 * column floor(picX/2) + floor(c/2)) and alpha 0xff, or the luma of the `_m` mask stream
 * at the main stream's picture offsets. */
export class ArtemisTheoraVideo {
  readonly width: number;
  readonly height: number;
  /** RGBA picture; contents change when `revision` changes. */
  readonly pixels: Uint8Array;
  revision = 0;
  /** +0x28 finish callback, run when update finds the stream finished. */
  onFinish: (() => void) | null = null;
  private readonly main: TheoraStreamState;
  private readonly mask: TheoraStreamState | null;
  /** +0x40 */
  private readonly frameMs: number;
  /** +0x204 */
  private readonly skipCap: number;
  /** +0x2c, constructor default -1. */
  private delayMargin = -1;
  /** +0x224 timeGetTime of the first update; 0 = not started. */
  private start = 0;
  private open = true;
  private converted: readonly number[] = [];
  private readonly picX: number;
  private readonly picY: number;

  private constructor(
    executableSha256: string,
    main: TheoraStream,
    loop: boolean,
    mask: TheoraStream | null,
  ) {
    artemisRevision(executableSha256);
    const info = main.info;
    this.main = new TheoraStreamState(main, loop);
    this.mask = mask ? new TheoraStreamState(mask, loop) : null;
    this.width = info.pictureWidth;
    this.height = info.pictureHeight;
    this.pixels = new Uint8Array(this.width * this.height * 4);
    this.picX = info.pictureX;
    // th_info pic_y counts from the top; the identification header stores it from the bottom.
    this.picY = info.macroblockHeight * 16 - info.pictureHeight - info.pictureY;
    const fps = Math.fround(
      Math.fround(info.frameRateNumerator) / Math.fround(info.frameRateDenominator),
    );
    this.frameMs = Math.fround(1000 / fps);
    this.skipCap = Math.ceil(fps) | 0;
  }

  /** Open 0x140015d00 with the stream open 0x140016c40. Returns null when `bytes` is not
   * a Theora stream (native returns 1). A mask that fails to open is dropped (0x140017360). */
  static open(
    executableSha256: string,
    bytes: Uint8Array,
    loop: boolean,
    maskBytes: Uint8Array | null,
  ): ArtemisTheoraVideo | null {
    const main = readStream(bytes);
    if (!main) return null;
    const mask = maskBytes ? readStream(maskBytes) : null;
    return new ArtemisTheoraVideo(executableSha256, main, loop, mask);
  }

  /** Slot +0x18: the end flag +0x220 is clear. */
  get playing(): boolean {
    return !this.main.ended;
  }
  get hasMask(): boolean {
    return this.mask !== null;
  }
  /** Main stream frame counters, for diagnostics. */
  get frame(): {readonly decoded: number; readonly target: number} {
    return {decoded: this.main.decoded, target: this.main.target};
  }

  /** Slot +0x20: `delaymargin` in milliseconds; negative disables frame skipping. */
  setDelayMargin(milliseconds: number): void {
    this.delayMargin = milliseconds | 0;
  }

  /** Slot +0x30: sets the end flag and releases the decoder. */
  close(): void {
    this.main.ended = true;
    this.open = false;
  }

  /** Slot +0x10 (0x140016390) with `now` as timeGetTime. */
  update(now: number): void {
    if (!this.open) return;
    const main = this.main;
    main.pump();
    // The mask thread has meanwhile decoded up to the target set by the previous update.
    this.mask?.pump();
    if (main.ended && main.target > main.decoded) {
      this.close();
      this.onFinish?.();
      return;
    }
    if (this.start === 0) this.start = now >>> 0;
    if (main.newFrame || this.mask?.newFrame) {
      this.convert();
      main.newFrame = false;
    }
    const elapsed = Math.trunc(
      Math.floor(Math.fround(Math.fround(((now >>> 0) - this.start) >>> 0) / this.frameMs)),
    );
    const behind = elapsed - main.target;
    if (behind < 0) return;
    const next = main.target + 1;
    main.target = next;
    if (
      behind !== 0 &&
      this.delayMargin >= 0 &&
      Math.fround(this.delayMargin) < Math.fround(Math.fround(behind) * this.frameMs)
    )
      main.target = Math.min(behind, this.skipCap) + next;
    if (this.mask) this.mask.target = main.target;
  }

  private convert(): void {
    const planes = this.main.decoder.frame;
    if (!planes) return;
    const maskPlanes = this.mask?.decoder.frame ?? null;
    const state = [this.main.frameRevision, this.mask?.frameRevision ?? -1];
    // Converting unchanged planes reproduces the same pixels; skip that work.
    if (state[0] === this.converted[0] && state[1] === this.converted[1]) return;
    this.converted = state;
    const luma = planes[0]!,
      cb = planes[1]!,
      cr = planes[2]!;
    const alpha = maskPlanes?.[0] ?? null;
    const pixels = this.pixels,
      width = this.width,
      picX = this.picX,
      picY = this.picY;
    for (let row = 0; row < this.height; row++) {
      const y = picY + row,
        chromaY = (picY >> 1) + (row >> 1);
      // Planes are stored bottom-up.
      const lumaRow = (luma.height - 1 - y) * luma.width + picX;
      const chromaRow = (cb.height - 1 - chromaY) * cb.width + (picX >> 1);
      const alphaRow = alpha ? (alpha.height - 1 - y) * alpha.width + picX : 0;
      let out = row * width * 4;
      for (let column = 0; column < width; column++) {
        const value = luma.data[lumaRow + column]!;
        const chroma = chromaRow + (column >> 1);
        const u = cb.data[chroma]!,
          v = cr.data[chroma]!;
        pixels[out] = clamp(value + crRed[v]!);
        pixels[out + 1] = clamp(value + ((cbGreen[u]! + crGreen[v]!) >> 16));
        pixels[out + 2] = clamp(value + cbBlue[u]!);
        pixels[out + 3] = alpha ? alpha.data[alphaRow + column]! : 0xff;
        out += 4;
      }
    }
    this.revision++;
  }
}

function readStream(bytes: Uint8Array): TheoraStream | null {
  try {
    return readTheoraOgg(bytes);
  } catch {
    return null;
  }
}

/** 0x140015d00 mask name: the opened name's stem, `_m.`, then its extension. */
export function artemisVideoMaskName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? `${name}_m.` : `${name.slice(0, dot)}_m.${name.slice(dot + 1)}`;
}
