import {byteDataView} from '../../core/binary.js';
import {readTheoraOgg, TheoraDecoder, type TheoraStream} from '../theora/index.js';

/** Siglus OMV 1.1 wraps Theora with page and frame index tables. */
export class SiglusOmv {
  readonly width: number;
  readonly height: number;
  readonly frameTime: number;
  readonly frames: number;
  private readonly mode: number;
  private readonly stream: TheoraStream;
  private decoder: TheoraDecoder;
  private decoded = -1;

  constructor(bytes: Uint8Array) {
    const header = byteDataView(bytes);
    if (
      bytes.length < 168 ||
      header.getUint32(0, true) !== 168 ||
      header.getUint16(4, true) !== 257
    )
      throw new Error('Unsupported Siglus OMV header');
    this.mode = header.getUint32(40, true);
    this.width = header.getUint32(44, true);
    this.height = header.getUint32(48, true);
    this.frameTime = header.getUint32(60, true) / 1000;
    const offset = 168 + header.getUint32(76, true) * 28 + header.getUint32(80, true) * 32;
    if (
      this.mode > 2 ||
      !this.width ||
      !this.height ||
      !this.frameTime ||
      this.width * this.height > 16_777_216 ||
      offset >= bytes.length
    )
      throw new Error('Invalid Siglus OMV dimensions or indexes');
    this.stream = readTheoraOgg(bytes.subarray(offset));
    const {info, setup, packets} = this.stream;
    const encodedHeight = this.height + (this.mode === 1 ? Math.ceil(this.height / 3) : 0);
    if (
      info.pixelFormat !== 3 ||
      info.pictureWidth !== this.width ||
      info.pictureHeight !== encodedHeight ||
      !packets.length
    )
      throw new Error('Invalid Siglus OMV Theora picture');
    this.frames = packets.length;
    this.decoder = new TheoraDecoder(info, setup);
  }

  frame(index: number): Uint8ClampedArray<ArrayBuffer> {
    if (!Number.isInteger(index) || index < 0 || index >= this.frames)
      throw new RangeError('Invalid Siglus OMV frame index');
    // A later intra packet can be decoded independently when playback is behind.
    for (let candidate = index; candidate > Math.max(0, this.decoded + 1); candidate--) {
      const packet = this.stream.packets[candidate]!;
      if (packet.length && !(packet[0]! & 0x40)) {
        this.decoded = candidate - 1;
        break;
      }
    }
    if (index < this.decoded) {
      this.decoder = new TheoraDecoder(this.stream.info, this.stream.setup);
      this.decoded = -1;
    }
    while (this.decoded < index) this.decoder.decode(this.stream.packets[++this.decoded]!);
    const [first, second, third] = this.decoder.frame!;
    const planes = [first!, second!, third!];
    const {info} = this.stream;
    const {width, height, mode} = this;
    const alphaRows = Math.ceil(height / 3);
    const top = planes[0]!.height - info.pictureHeight - info.pictureY;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      const source = (planes[0]!.height - 1 - top - row) * planes[0]!.width + info.pictureX;
      const mask = planes[Math.floor(row / alphaRows)]!;
      const alpha = source - (height + (row % alphaRows) - row) * planes[0]!.width;
      for (let column = 0; column < width; column++) {
        const input = source + column;
        const out = 4 * (row * width + column);
        const a = planes[0]!.data[input]!;
        const b = planes[1]!.data[input]!;
        const c = planes[2]!.data[input]!;
        if (mode === 2) {
          rgba[out] = a + 1.402 * (c - 128);
          rgba[out + 1] = a - 0.34414 * (b - 128) - 0.71414 * (c - 128);
          rgba[out + 2] = a + 1.772 * (b - 128);
        } else {
          rgba[out] = c;
          rgba[out + 1] = b;
          rgba[out + 2] = a;
        }
        rgba[out + 3] = mode === 1 ? mask.data[alpha + column]! : 255;
      }
    }
    return rgba;
  }
}
