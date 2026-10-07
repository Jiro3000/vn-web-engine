import {FREETYPE_WASM_BINARY} from './freetype-wasm-binary.js';

export interface FreeTypeMetrics {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly height: number;
  readonly maxAdvanceWidth: number;
  readonly maxAdvanceHeight: number;
  readonly glyphCount: number;
  readonly faceCount: number;
  readonly xPpem: number;
  readonly yPpem: number;
  readonly scaledAscender: number;
  readonly scaledDescender: number;
  readonly scaledHeight: number;
  readonly scaledMaxAdvance: number;
}
export interface FreeTypeSizeRequest {
  readonly type: 0 | 1 | 2 | 3 | 4;
  readonly width: number;
  readonly height: number;
}
export interface FreeTypeRasterOptions {
  readonly flags?: number;
  readonly bold?: boolean;
  readonly shear?: number;
  /** Apply the size immediately before loading this glyph, including in worker jobs. */
  readonly size?: FreeTypeSizeRequest;
}
export interface FreeTypeGlyph {
  readonly glyphIndex: number;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly advanceX: number;
  readonly advanceY: number;
  /** Packed top-down grayscale coverage, owned independently from FreeType's slot. */
  readonly pixels: Uint8Array;
}
type NativeFn = (...args: number[]) => number;
interface NativeExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
}
let compiled: WebAssembly.Module | undefined;
const metricsKeys = [
  'unitsPerEm',
  'ascender',
  'descender',
  'height',
  'maxAdvanceWidth',
  'maxAdvanceHeight',
  'glyphCount',
  'faceCount',
  'xPpem',
  'yPpem',
  'scaledAscender',
  'scaledDescender',
  'scaledHeight',
  'scaledMaxAdvance',
] as const;
function int(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw Error('Invalid FreeType integer');
  return value;
}
/** Memory-only FreeType 2.4.8. Each instance has an isolated bounded wasm heap and
 * explicit face lifetime. CPU raster jobs belong in the worker owner below.
 */
export class FreeType {
  private readonly exports: NativeExports;
  private readonly library: number;
  private readonly faces = new Map<number, number>();
  private closed = false;
  private poisoned = false;
  constructor() {
    compiled ??= new WebAssembly.Module(
      Uint8Array.from(atob(FREETYPE_WASM_BINARY), (c) => c.charCodeAt(0)),
    );
    this.exports = new WebAssembly.Instance(compiled, {
      env: {emscripten_notify_memory_growth: () => {}},
      wasi_snapshot_preview1: {
        fd_write: () => 8,
        fd_close: () => 8,
        fd_seek: () => 8,
        proc_exit: () => {
          this.poisoned = true;
          throw Error('FreeType process exit');
        },
      },
    }).exports as NativeExports;
    (this.exports['_initialize'] as (() => void) | undefined)?.();
    this.library = this.call('font_init');
    if (!this.library) throw Error('Cannot initialize FreeType');
  }
  private call(name: string, ...args: number[]): number {
    if (this.closed || this.poisoned) throw Error('FreeType closed or interrupted');
    try {
      return (this.exports[name] as NativeFn)(...args);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }
  get version(): readonly number[] {
    return [0, 1, 2].map((i) => this.call('font_version', i));
  }
  open(bytes: Uint8Array, faceIndex = 0): FreeTypeFace {
    int(bytes.byteLength, 1, 64 * 1024 * 1024);
    int(faceIndex, 0, 0x7fffffff);
    if (this.faces.size >= 16) throw Error('FreeType face budget exceeded');
    const pointer = this.call('malloc', bytes.byteLength);
    if (!pointer) throw Error('FreeType font allocation failed');
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
    const face = this.call('font_open', this.library, pointer, bytes.byteLength, faceIndex);
    if (!face) {
      const error = this.call('font_error');
      this.call('free', pointer);
      throw Error('FreeType font error ' + error);
    }
    this.faces.set(face, pointer);
    return new FreeTypeFace(this, face);
  }
  /** Internal owner operation; callers use FreeTypeFace.close(). */
  release(face: number): void {
    const pointer = this.faces.get(face);
    if (pointer === undefined) return;
    this.faces.delete(face);
    if (!this.poisoned) {
      this.call('font_close', face);
      this.call('free', pointer);
    }
  }
  metrics(face: number): FreeTypeMetrics {
    this.assertFace(face);
    return Object.fromEntries(
      metricsKeys.map((key, i) => [key, this.call('font_info', face, i)]),
    ) as unknown as FreeTypeMetrics;
  }
  size(face: number, type: 0 | 1 | 2 | 3 | 4, width: number, height: number): void {
    this.assertFace(face);
    int(type, 0, 4);
    int(width, 0, 4096 * 64);
    int(height, 1, 4096 * 64);
    const error = this.call('font_size', face, type, width, height, 0, 0);
    if (error) throw Error('FreeType size error ' + error);
  }
  glyph(
    face: number,
    codePoint: number,
    flags: number,
    bold: boolean,
    shear: number,
  ): FreeTypeGlyph {
    this.assertFace(face);
    int(codePoint, 0, 0x10ffff);
    int(flags, 0, 0x7fffffff);
    int(shear, -0x10000, 0x10000);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw Error('Invalid FreeType Unicode scalar');
    if (!(flags & 4)) throw Error('FreeType raster glyph requires render flag');
    const error = this.call('font_glyph', face, codePoint, flags, Number(bold), shear);
    if (error) throw Error('FreeType glyph error ' + error);
    const info = (key: number) => this.call('font_glyph_info', face, key);
    const width = info(0),
      height = info(1),
      pitch = info(2),
      mode = info(7),
      pointer = info(8) >>> 0;
    int(width, 0, 4096);
    int(height, 0, 4096);
    if (width * height > 4 * 1024 * 1024) throw Error('FreeType glyph pixel budget exceeded');
    if (width && height && mode !== 1 && mode !== 2)
      throw Error('Unsupported FreeType bitmap mode ' + mode);
    const pixels = new Uint8Array(width * height);
    if (pixels.length) {
      const stride = Math.abs(pitch),
        length = stride * height;
      if (stride < (mode === 1 ? Math.ceil(width / 8) : width))
        throw Error('Invalid FreeType bitmap stride');
      const start = pitch < 0 ? pointer - stride * (height - 1) : pointer;
      const source = new Uint8Array(this.exports.memory.buffer, start, length);
      for (let y = 0; y < height; y++) {
        const row = (pitch < 0 ? height - 1 - y : y) * stride;
        if (mode === 2) pixels.set(source.subarray(row, row + width), y * width);
        else
          for (let x = 0; x < width; x++)
            pixels[y * width + x] = source[row + (x >> 3)]! & (0x80 >> (x & 7)) ? 255 : 0;
      }
    }
    return {
      glyphIndex: this.call('font_char_index', face, codePoint),
      width,
      height,
      left: info(3),
      top: info(4),
      advanceX: info(5),
      advanceY: info(6),
      pixels,
    };
  }
  private assertFace(face: number): void {
    if (!this.faces.has(face)) throw Error('FreeType face closed');
  }
  close(): void {
    if (this.closed) return;
    for (const face of this.faces.keys()) this.release(face);
    if (!this.poisoned) this.call('font_done', this.library);
    this.closed = true;
  }
}
/** Face owns the copied font bytes through its parent library. Pixel size requests
 * use native 26.6 units, independent of CSS or platform font substitution.
 */
export class FreeTypeFace {
  private closed = false;
  private assertOpen(): void {
    if (this.closed) throw Error('FreeType face closed');
  }
  constructor(
    private readonly owner: FreeType,
    private readonly handle: number,
  ) {}
  get metrics(): FreeTypeMetrics {
    this.assertOpen();
    return this.owner.metrics(this.handle);
  }
  requestSize(type: 0 | 1 | 2 | 3 | 4, width: number, height: number): void {
    this.assertOpen();
    this.owner.size(this.handle, type, width, height);
  }
  rasterize(codePoint: number, options: FreeTypeRasterOptions = {}): FreeTypeGlyph {
    this.assertOpen();
    if (options.size) this.requestSize(options.size.type, options.size.width, options.size.height);
    return this.owner.glyph(
      this.handle,
      codePoint,
      options.flags ?? 6,
      options.bold ?? false,
      options.shear ?? 0,
    );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.owner.release(this.handle);
  }
}
