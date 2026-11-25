import type {ByteSource} from '../../core/source.js';
import {readTheoraOgg, TheoraDecoder, type TheoraStream} from '../theora/index.js';
import {omvHeaderSize, readOmvHeader, SiglusOmvIndex} from './omv-index.js';

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const redShift = littleEndian ? 0 : 24;
const greenShift = littleEndian ? 8 : 16;
const blueShift = littleEndian ? 16 : 8;
const alphaShift = littleEndian ? 24 : 0;
const opaque = 255 << alphaShift;
const greenTie = 32767;

function buildColorTables() {
  const red = new Uint8ClampedArray(65536);
  const blue = new Uint8ClampedArray(65536);
  const green = new Int16Array(65536);
  const clamp = Uint8ClampedArray.from({length: 768}, (_, i) => i - 256);
  for (let high = 0; high < 256; high++) {
    for (let low = 0; low < 256; low++) {
      const index = (high << 8) | low;
      red[index] = high + 1.402 * (low - 128);
      blue[index] = high + 1.772 * (low - 128);
      const adjustment = -34414 * (high - 128) - 71414 * (low - 128);
      // Only exact half values depend on luma parity and float evaluation order.
      green[index] =
        Math.abs(adjustment) % 100000 === 50000 ? greenTie : Math.round(adjustment / 100000);
    }
  }
  return {red, green, blue, clamp};
}

let colorTables: ReturnType<typeof buildColorTables> | undefined;

/** Siglus OMV 1.1 wraps Theora with page and frame index tables. */
export class SiglusOmv {
  readonly width: number;
  readonly height: number;
  readonly frameTime: number;
  readonly frames: number;
  private readonly mode: number;
  private readonly stream: TheoraStream;
  private readonly keyframes: Int32Array;
  private readonly packetIndex?: SiglusOmvIndex;
  private fallback?: SiglusOmv;
  private decoder: TheoraDecoder;
  private decoded = -1;

  static async open(source: ByteSource): Promise<SiglusOmv> {
    // Large files usually fit the tables, codec headers, and first frame in one initial read.
    const length = source.size < 1 << 20 ? Math.min(omvHeaderSize, source.size) : 256 << 10;
    const prefix = await source.read(0, length);
    const header = readOmvHeader(prefix, source.size);
    try {
      return new SiglusOmv({header, ...(await SiglusOmvIndex.open(source, header, prefix))});
    } catch {
      // Some encoders leave the index entries empty. The Ogg stream still carries every frame.
      return new SiglusOmv(await source.read(0, source.size));
    }
  }

  constructor(
    input:
      | Uint8Array
      | {
          header: ReturnType<typeof readOmvHeader>;
          stream: TheoraStream;
          index: SiglusOmvIndex;
        },
  ) {
    const header = input instanceof Uint8Array ? readOmvHeader(input) : input.header;
    this.mode = header.mode;
    this.width = header.width;
    this.height = header.height;
    this.frameTime = header.frameTime;
    this.stream =
      input instanceof Uint8Array ? readTheoraOgg(input.subarray(header.offset)) : input.stream;
    this.packetIndex = input instanceof Uint8Array ? undefined : input.index;
    const {info, setup, packets} = this.stream;
    this.frames = this.packetIndex?.keyframes.length ?? packets.length;
    const encodedHeight = this.height + (this.mode === 1 ? Math.ceil(this.height / 3) : 0);
    if (
      info.pixelFormat !== 3 ||
      info.pictureWidth !== this.width ||
      info.pictureHeight !== encodedHeight ||
      !this.frames
    )
      throw new Error('Invalid Siglus OMV Theora picture');
    const keyframes = this.packetIndex?.keyframes;
    this.keyframes = keyframes ?? new Int32Array(this.frames);
    if (!keyframes) {
      let keyframe = -1;
      for (const [index, packet] of packets.entries()) {
        if (packet.length && !(packet[0]! & 0x40)) keyframe = index;
        this.keyframes[index] = keyframe;
      }
    }
    this.decoder = new TheoraDecoder(info, setup, {rgbaCapacity: this.width * this.height * 4});
  }

  private frameStart(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.frames)
      throw new RangeError('Invalid Siglus OMV frame index');
    const keyframe = this.keyframes[index]!;
    // Intra packets rebuild both references. Seek to the nearest one in either direction.
    return index < this.decoded || keyframe > this.decoded + 1
      ? Math.max(0, keyframe)
      : this.decoded + 1;
  }

  async readFrame(index: number): Promise<Uint8ClampedArray<ArrayBuffer>> {
    if (this.fallback) return this.fallback.frame(index);
    const packets = this.packetIndex;
    const start = this.frameStart(index);
    if (packets && start <= index) {
      try {
        await packets.load(start, index);
      } catch {
        this.fallback = new SiglusOmv(await packets.source.read(0, packets.source.size));
        return this.fallback.frame(index);
      }
    }
    return this.frame(index);
  }

  frame(index: number): Uint8ClampedArray<ArrayBuffer> {
    const start = this.frameStart(index);
    if (index < this.decoded && this.keyframes[index]! < 0)
      this.decoder = new TheoraDecoder(this.stream.info, this.stream.setup, {
        rgbaCapacity: this.width * this.height * 4,
      });
    for (let current = start; current <= index; current++) {
      this.decoder.decode(this.packetIndex?.packet(current) ?? this.stream.packets[current]!);
      this.decoded = current;
    }
    const accelerated = this.decoder.omvRgba(this.mode, this.height);
    if (accelerated) return accelerated;
    const planes = this.decoder.frame!;
    const [first, second, third] = planes;
    const stride = first!.width;
    const bPlane = first!.data,
      gPlane = second!.data,
      rPlane = third!.data;
    const {info} = this.stream;
    const {width, height, mode} = this;
    const alphaRows = Math.ceil(height / 3);
    const bottom = info.pictureHeight + info.pictureY - 1;
    const rgba = new Uint8ClampedArray(width * height * 4);
    const pixels = new Uint32Array(rgba.buffer);
    if (mode !== 2) {
      for (let row = 0; row < height; row++) {
        const source = (bottom - row) * stride + info.pictureX;
        const dest = row * width;
        if (mode === 1) {
          const mask = planes[Math.floor(row / alphaRows)]!.data;
          const alpha = (bottom - height - (row % alphaRows)) * stride + info.pictureX;
          for (let col = 0; col < width; col++) {
            const i = source + col;
            pixels[dest + col] =
              (rPlane[i]! << redShift) |
              (gPlane[i]! << greenShift) |
              (bPlane[i]! << blueShift) |
              (mask[alpha + col]! << alphaShift);
          }
        } else {
          for (let col = 0; col < width; col++) {
            const i = source + col;
            pixels[dest + col] =
              opaque |
              (rPlane[i]! << redShift) |
              (gPlane[i]! << greenShift) |
              (bPlane[i]! << blueShift);
          }
        }
      }
      return rgba;
    }
    const {red, green, blue, clamp} = (colorTables ??= buildColorTables());
    for (let row = 0; row < height; row++) {
      const source = (bottom - row) * stride + info.pictureX;
      const dest = row * width;
      for (let column = 0; column < width; column++) {
        const input = source + column;
        const out = dest + column;
        const y = bPlane[input]!;
        const cb = gPlane[input]!;
        const cr = rPlane[input]!;
        const adjustment = green[(cb << 8) | cr]!;
        const g = adjustment === greenTie ? 0 : clamp[y + adjustment + 256]!;
        pixels[out] =
          opaque |
          (red[(y << 8) | cr]! << redShift) |
          (g << greenShift) |
          (blue[(y << 8) | cb]! << blueShift);
        if (adjustment === greenTie)
          rgba[out * 4 + 1] = y - 0.34414 * (cb - 128) - 0.71414 * (cr - 128);
      }
    }
    return rgba;
  }
}
