import {allocateFrame, type YuvFrame} from './frame.js';
import {WINDOWS_MEDIA_WASM_BINARY} from './windows-media-wasm-binary.js';

type NativeFn = (...args: number[]) => number;
type NativeExports = Record<string, NativeFn> & {memory: WebAssembly.Memory};
let compiled: WebAssembly.Module | undefined;

export type WindowsMediaCodec =
  | {
      readonly kind: 'video';
      /** BITMAPINFOHEADER FourCC; WMV3 (Windows Media Video 9) is supported. */
      readonly codec: number;
      readonly width: number;
      readonly height: number;
      readonly extra: Uint8Array;
    }
  | {
      readonly kind: 'audio';
      /** WAVEFORMATEX tag: 0x161 WMA, 0x162 WMA Pro, 0x163 WMA Lossless. */
      readonly codec: number;
      readonly sampleRate: number;
      readonly channels: number;
      readonly bytesPerSecond: number;
      readonly blockAlign: number;
      readonly bitsPerSample: number;
      readonly extra: Uint8Array;
    };

export interface WindowsMediaPicture {
  readonly frame: YuvFrame;
  /** Presentation time in milliseconds, -1 when the decoder has none. */
  readonly time: number;
}
export interface WindowsMediaAudio {
  readonly channels: Float32Array[];
  readonly time: number;
}

/** Windows Media decoder (FFmpeg 7.1.1 libavcodec subset in wasm, one instance per stream).
 * Video pictures are copied into caller-owned 4:2:0 frames; audio is planar float. */
export class WindowsMediaDecoder {
  private readonly native: NativeExports;
  private readonly handle: number;
  private closed = false;
  private index = 0;
  constructor(readonly codec: WindowsMediaCodec) {
    compiled ??= new WebAssembly.Module(
      Uint8Array.from(atob(WINDOWS_MEDIA_WASM_BINARY), (c) => c.charCodeAt(0)),
    );
    this.native = new WebAssembly.Instance(compiled, {
      env: {emscripten_notify_memory_growth: () => {}},
      wasi_snapshot_preview1: {
        fd_write: () => 8,
        fd_close: () => 8,
        fd_read: () => 8,
        fd_seek: () => 8,
        fd_fdstat_get: () => 8,
        clock_time_get: () => 8,
        environ_sizes_get: (count: number, size: number) => {
          new Uint32Array(this.native.memory.buffer, count, 1)[0] = 0;
          new Uint32Array(this.native.memory.buffer, size, 1)[0] = 0;
          return 0;
        },
        environ_get: () => 0,
      },
    }).exports as NativeExports;
    this.native['_initialize']?.();
    const extra = this.native.malloc!(Math.max(1, codec.extra.length));
    if (!extra) throw Error('Windows Media decoder allocation failed');
    new Uint8Array(this.native.memory.buffer, extra, codec.extra.length).set(codec.extra);
    this.handle =
      codec.kind === 'video'
        ? this.native.wm_open!(
            0,
            codec.codec,
            codec.width,
            codec.height,
            0,
            0,
            0,
            0,
            0,
            extra,
            codec.extra.length,
          )
        : this.native.wm_open!(
            1,
            codec.codec,
            0,
            0,
            codec.sampleRate,
            codec.channels,
            codec.bytesPerSecond * 8,
            codec.blockAlign,
            codec.bitsPerSample,
            extra,
            codec.extra.length,
          );
    this.native.free!(extra);
    if (!this.handle)
      throw Error(`Unsupported Windows Media ${codec.kind} codec 0x${codec.codec.toString(16)}`);
  }

  /** Decodes one media object (`null` drains at the end of the stream) and returns the
   * output it completes. */
  decode(
    data: Uint8Array | null,
    time = 0,
    key = false,
  ): (WindowsMediaPicture | WindowsMediaAudio)[] {
    if (this.closed) throw Error('Windows Media decoder is closed');
    const out: (WindowsMediaPicture | WindowsMediaAudio)[] = [];
    const n = this.native;
    let pointer = 0;
    if (data) {
      if (!data.length) return out;
      pointer = n.wm_alloc!(data.length);
      if (!pointer) throw Error('Windows Media packet allocation failed');
      new Uint8Array(n.memory.buffer, pointer, data.length).set(data);
    }
    try {
      for (;;) {
        const sent = n.wm_send!(this.handle, pointer, data ? data.length : 0, time, key ? 1 : 0);
        if (sent === 1) {
          this.receive(out);
          continue;
        }
        if (sent < 0 && !(sent === -541478725 && !data))
          throw Error('Windows Media decode error ' + sent);
        break;
      }
      this.receive(out);
    } finally {
      if (pointer) n.wm_free!(pointer);
    }
    return out;
  }

  private receive(out: (WindowsMediaPicture | WindowsMediaAudio)[]): void {
    const n = this.native,
      h = this.handle;
    for (;;) {
      const r = n.wm_receive!(h);
      if (r === 0 || r === 2) return;
      if (r < 0) throw Error('Windows Media decode error ' + r);
      const memory = new Uint8Array(n.memory.buffer);
      const time = n.wm_pts!(h);
      if (this.codec.kind === 'video') {
        const width = n.wm_width!(h),
          height = n.wm_height!(h),
          frame = allocateFrame(width, height);
        for (let plane = 0; plane < 3; plane++) {
          const target = plane === 0 ? frame.y : plane === 1 ? frame.cb : frame.cr,
            targetStride = plane ? frame.stride >> 1 : frame.stride,
            w = plane ? (width + 1) >> 1 : width,
            rows = plane ? (height + 1) >> 1 : height,
            base = n.wm_plane!(h, plane),
            stride = n.wm_stride!(h, plane);
          for (let y = 0; y < rows; y++)
            target.set(memory.subarray(base + y * stride, base + y * stride + w), y * targetStride);
        }
        frame.index = this.index++;
        frame.pictureType = n.wm_picture_type!(h);
        out.push({frame, time});
      } else {
        const samples = n.wm_samples!(h),
          channels = n.wm_channels!(h),
          pcm = new Float32Array(n.memory.buffer, n.wm_pcm!(h), samples * channels);
        out.push({
          channels: Array.from({length: channels}, (_, c) =>
            pcm.slice(c * samples, (c + 1) * samples),
          ),
          time,
        });
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.native.wm_close!(this.handle);
  }
}
