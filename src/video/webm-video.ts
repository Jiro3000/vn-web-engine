import {type Webm, type WebmFrame, type WebmTrack, parseWebm} from '../formats/webm.js';
import {type ArgbTarget, type YuvLayout, type YuvPlane, yuvToArgb} from './libyuv.js';

/** Matroska TrackType 1: video. */
const VIDEO_TRACK = 1;

/** A decoded picture; `readArgb` converts it with libyuv's BT.601 conversion. */
export interface WebmPicture {
  readonly width: number;
  readonly height: number;
  /** Writes the picture's rows; false when its pixel format cannot be read. */
  readArgb(target: ArgbTarget): Promise<boolean>;
  close(): void;
}

/** One shown frame: its packet time in nanoseconds and, when a decoder exists, its picture. */
export interface WebmVideoFrame {
  readonly time: number;
  readonly picture: WebmPicture | null;
}

/**
 * The video stream of a WebM file in decode order, as libvpx returns it through nestegg: the
 * first video track, VP8 or VP9 only. Frames come from WebCodecs; where the browser has no
 * `VideoDecoder` (or it fails), each shown frame is reported without a picture so callers
 * keep their timing.
 */
export class WebmVideo {
  readonly width: number;
  readonly height: number;
  /** The segment duration in nanoseconds; 0 when the file states none. */
  readonly duration: number;
  /** 0 VP8, 2 VP9 (`nestegg_track_codec_id`). */
  readonly codec: number;
  private readonly frames: readonly WebmFrame[];
  private next = 0;
  /** The time of the last packet read (`nestegg_packet_tstamp`), in nanoseconds. */
  lastTime = 0;
  private decoder: BrowserVideoDecoder | null;

  private constructor(webm: Webm, track: WebmTrack, codec: number) {
    this.width = track.width;
    this.height = track.height;
    this.duration = webm.duration < 0 ? 0 : Math.trunc(webm.duration);
    this.codec = codec;
    this.frames = webm.frames.filter((frame) => frame.track === track.number);
    this.decoder = BrowserVideoDecoder.create(codec, track, this.frames);
  }

  /**
   * Opens `data`; null when it is not WebM, has no video track or the first video track is
   * neither VP8 nor VP9.
   */
  static open(data: Uint8Array): WebmVideo | null {
    let webm: Webm;
    try {
      webm = parseWebm(data);
    } catch {
      return null;
    }
    const track = webm.tracks.find((t) => t.type === VIDEO_TRACK);
    if (!track) return null;
    const codec = track.codec === 'V_VP8' ? 0 : track.codec === 'V_VP9' ? 2 : -1;
    if (codec < 0) return null;
    return new WebmVideo(webm, track, codec);
  }

  /** The next shown frame, or null at the end of the stream. */
  async read(): Promise<WebmVideoFrame | null> {
    if (this.decoder) {
      const decoded = await this.decoder.read();
      if (decoded !== 'failed') {
        if (decoded) this.lastTime = this.frames[decoded.index]!.time;
        else if (this.frames.length) this.lastTime = this.frames[this.frames.length - 1]!.time;
        this.next = this.frames.length;
        return decoded ? {time: this.lastTime, picture: decoded.picture} : null;
      }
      // A decoder error leaves the rest of the stream without pictures.
      this.next = this.decoder.fed;
      this.decoder.close();
      this.decoder = null;
    }
    while (this.next < this.frames.length) {
      const frame = this.frames[this.next++]!;
      this.lastTime = frame.time;
      if (shown(this.codec, frame.data)) return {time: frame.time, picture: null};
    }
    return null;
  }

  close(): void {
    this.decoder?.close();
    this.decoder = null;
  }
}

/** Whether a VP8 or VP9 frame is displayed (`show_frame`; VP9 `show_existing_frame` too). */
function shown(codec: number, data: Uint8Array): boolean {
  if (data.length === 0) return false;
  const b = data[0]!;
  if (codec === 0) return ((b >> 4) & 1) === 1;
  const bits = new BitReader(data);
  if (bits.read(2) !== 2) return false;
  const profile = bits.read(1) | (bits.read(1) << 1);
  if (profile === 3) bits.read(1);
  if (bits.read(1)) return true;
  bits.read(1);
  return bits.read(1) === 1;
}

/** Whether a VP8 or VP9 frame is a key frame. */
function keyFrame(codec: number, data: Uint8Array): boolean {
  if (data.length === 0) return false;
  if (codec === 0) return (data[0]! & 1) === 0;
  const bits = new BitReader(data);
  if (bits.read(2) !== 2) return false;
  const profile = bits.read(1) | (bits.read(1) << 1);
  if (profile === 3) bits.read(1);
  if (bits.read(1)) return false;
  return bits.read(1) === 0;
}

class BitReader {
  private bit = 0;
  constructor(private readonly data: Uint8Array) {}
  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++, this.bit++)
      value = (value << 1) | (((this.data[this.bit >> 3] ?? 0) >> (7 - (this.bit & 7))) & 1);
    return value;
  }
}

interface DecodedFrame {
  readonly index: number;
  readonly picture: WebmPicture;
}

/**
 * WebCodecs decoding of one track. Chunks are fed a few ahead of the reader; their timestamps
 * are packet indices so each output maps back to its packet. Frames before the first key frame
 * are dropped, as libvpx fails on them.
 */
class BrowserVideoDecoder {
  fed = 0;
  private readonly outputs: VideoFrame[] = [];
  private failed = false;
  private flushed = false;
  private started = false;
  private wake: (() => void) | null = null;
  private readonly decoder: VideoDecoder;

  private constructor(
    private readonly codec: number,
    private readonly frames: readonly WebmFrame[],
    track: WebmTrack,
  ) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.outputs.push(frame);
        this.signal();
      },
      error: () => {
        this.failed = true;
        this.signal();
      },
    });
    this.decoder.addEventListener('dequeue', () => this.signal());
    this.decoder.configure({
      codec: codec === 0 ? 'vp8' : 'vp09.00.10.08',
      codedWidth: track.width || undefined,
      codedHeight: track.height || undefined,
      optimizeForLatency: true,
    });
  }

  static create(
    codec: number,
    track: WebmTrack,
    frames: readonly WebmFrame[],
  ): BrowserVideoDecoder | null {
    if (typeof VideoDecoder === 'undefined') return null;
    try {
      return new BrowserVideoDecoder(codec, frames, track);
    } catch {
      return null;
    }
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** The next decoded frame, null at the end, 'failed' after a decoder error. */
  async read(): Promise<DecodedFrame | null | 'failed'> {
    for (;;) {
      const frame = this.outputs.shift();
      if (frame) return {index: frame.timestamp, picture: new Picture(frame)};
      if (this.failed || this.decoder.state === 'closed') return 'failed';
      if (this.fed < this.frames.length) {
        if (this.decoder.decodeQueueSize < 2) {
          this.feed();
          continue;
        }
      } else if (!this.flushed) {
        this.flushed = true;
        try {
          await this.decoder.flush();
        } catch {
          return 'failed';
        }
        continue;
      } else return null;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private feed(): void {
    const index = this.fed++;
    const frame = this.frames[index]!;
    const key = keyFrame(this.codec, frame.data);
    if (!this.started && !key) return;
    this.started = true;
    try {
      this.decoder.decode(
        new EncodedVideoChunk({type: key ? 'key' : 'delta', timestamp: index, data: frame.data}),
      );
    } catch {
      this.failed = true;
    }
  }

  close(): void {
    for (const frame of this.outputs.splice(0)) frame.close();
    if (this.decoder.state !== 'closed') this.decoder.close();
    this.signal();
  }
}

const PLANAR: Readonly<Record<string, readonly [YuvLayout, boolean]>> = {
  I420: ['i420', false],
  I420A: ['i420', false],
  I444: ['i444', false],
  I444A: ['i444', false],
  NV12: ['nv12', false],
  I420P10: ['i420', true],
  I420AP10: ['i420', true],
  I444P10: ['i444', true],
  I444AP10: ['i444', true],
};

class Picture implements WebmPicture {
  readonly width: number;
  readonly height: number;
  constructor(private readonly frame: VideoFrame) {
    this.width = frame.visibleRect?.width ?? frame.codedWidth;
    this.height = frame.visibleRect?.height ?? frame.codedHeight;
  }

  async readArgb(target: ArgbTarget): Promise<boolean> {
    const frame = this.frame;
    const width = Math.min(target.width, this.width),
      height = Math.min(target.height, this.height);
    const format = frame.format ?? '';
    const planar = PLANAR[format];
    if (planar) {
      const bytes = new Uint8Array(frame.allocationSize());
      const layout = await frame.copyTo(bytes);
      const [kind, wide] = planar;
      const plane = (i: number): YuvPlane => {
        const {offset, stride} = layout[i]!;
        return wide
          ? {
              data: new Uint16Array(bytes.buffer, 0, bytes.length >> 1),
              offset: offset >> 1,
              stride: stride >> 1,
            }
          : {data: bytes, offset, stride};
      };
      yuvToArgb(kind, plane(0), plane(1), kind === 'nv12' ? null : plane(2), {
        ...target,
        width,
        height,
      });
      return true;
    }
    if (format === 'BGRA' || format === 'BGRX' || format === 'RGBA' || format === 'RGBX') {
      const bytes = new Uint8Array(frame.allocationSize());
      const [first] = await frame.copyTo(bytes);
      const offset = first?.offset ?? 0,
        stride = first?.stride ?? width * 4;
      const swap = format.startsWith('RGB');
      for (let row = 0; row < height; row++) {
        const o = row * target.stride;
        if (o + width * 4 > target.out.length) break;
        for (let x = 0, s = offset + row * stride, d = o; x < width; x++, s += 4, d += 4) {
          target.out[d] = bytes[swap ? s + 2 : s]!;
          target.out[d + 1] = bytes[s + 1]!;
          target.out[d + 2] = bytes[swap ? s : s + 2]!;
          target.out[d + 3] = 255;
        }
      }
      return true;
    }
    return false;
  }

  close(): void {
    this.frame.close();
  }
}
