import {
  IntegerWindowGl,
  type IntegerLayer,
  type IntegerRegion,
} from '../../../graphics/integer-window-gl.js';
import {
  clearRasterTextGlyphs,
  hasRasterText,
  rasterTextBitmap,
  readRasterText,
  releaseRasterText,
  visibleRasterText,
  type RasterTextGlyph,
} from '../../../text/raster-text.js';
import {ruleWeights} from '../vm/blend.js';
import type {DeferredScale, YurisCgNode, YurisLayers} from '../vm/cg.js';
import {compose, type Rect} from '../vm/compose.js';
import {yurisRasterBitmap} from '../vm/raster-text.js';
import {bilinearCoordinates} from '../vm/resize.js';

function include(
  bounds: Rect | undefined,
  left: number,
  top: number,
  right: number,
  bottom: number,
): Rect {
  if (!bounds) return [left, top, right, bottom];
  bounds[0] = Math.min(bounds[0], left);
  bounds[1] = Math.min(bounds[1], top);
  bounds[2] = Math.max(bounds[2], right);
  bounds[3] = Math.max(bounds[3], bottom);
  return bounds;
}

/** Include all native/alternate differences, including decorative ink without glyphs. */
function rasterDamage(
  pixels: Uint8Array,
  blank: Uint8Array,
  width: number,
  height: number,
): Rect | undefined {
  const source = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length >>> 2);
  const alternate = new Uint32Array(blank.buffer, blank.byteOffset, blank.length >>> 2);
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let row = 0; row < height; row++) {
    const base = row * width;
    let lo = 0,
      hi = width - 1;
    while (lo <= hi && source[base + lo] === alternate[base + lo]) lo++;
    if (lo > hi) continue;
    while (lo < hi && source[base + hi] === alternate[base + hi]) hi--;
    x0 = Math.min(x0, lo);
    x1 = Math.max(x1, hi);
    y0 = Math.min(y0, row);
    y1 = row;
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : undefined;
}

export class YurisIntegerWindow {
  private readonly rasterBounds = new WeakMap<
    Uint8Array,
    {alternate: Uint8Array; revision: number; width: number; height: number; bounds?: Rect}
  >();
  private renderer: IntegerWindowGl | null = null;
  private displayed?: {revision: number; dom: boolean};
  private node?: YurisCgNode;
  private unsupported = false;
  private horizontal?: {scale: DeferredScale; coordinates: Int32Array};
  drawn = 0;
  readbacks = 0;
  get queueWaits(): number {
    return this.renderer?.queueWaits ?? 0;
  }
  get peakQueue(): number {
    return this.renderer?.peakQueue ?? 0;
  }

  private columns(scale: DeferredScale): Int32Array {
    const last = this.horizontal;
    if (
      last &&
      last.scale.fx === scale.fx &&
      last.scale.fx2 === scale.fx2 &&
      last.scale.fsx === scale.fsx &&
      last.scale.width === scale.width
    )
      return last.coordinates;
    const coordinates = bilinearCoordinates(scale.fx, scale.fx2, scale.fsx, scale.width, true);
    this.horizontal = {scale, coordinates};
    return coordinates;
  }

  render(
    layers: YurisLayers,
    node: YurisCgNode,
    context: CanvasRenderingContext2D,
    dom: boolean,
    continuous: boolean,
  ): RasterTextGlyph[] | null {
    const cg = node.payload!;
    const {width, height} = cg;
    if (!cg.dirty || width * height < 262144 || this.unsupported) return null;
    if (
      this.renderer &&
      (this.renderer.canvas.width !== width || this.renderer.canvas.height !== height)
    ) {
      // Resolve the previous viewport before disposing its texture owner.
      void this.node?.payload?.pixels;
      this.renderer.dispose();
      this.renderer = null;
      this.displayed = undefined;
    }
    if (!this.renderer) {
      this.renderer = IntegerWindowGl.create(width, height);
      if (!this.renderer) this.unsupported = true;
    }
    const renderer = this.renderer;
    if (!renderer?.ready()) return null;
    let damage: IntegerRegion | undefined;
    if (
      continuous &&
      this.node === node &&
      this.displayed?.dom === dom &&
      this.displayed.revision === cg.pixelRevision
    ) {
      const left = Math.max(0, cg.clip[0]!);
      const top = Math.max(0, cg.clip[1]!);
      const right = Math.min(width - 1, cg.clip[2]!);
      const bottom = Math.min(height - 1, cg.clip[3]!);
      if (
        left <= right &&
        top <= bottom &&
        (right - left + 1) * (bottom - top + 1) < width * height
      )
        damage = {left, top, width: right - left + 1, height: bottom - top + 1};
    }
    const host = layers.compositionHost();
    const draws: IntegerLayer[] = [];
    let strip: Rect | undefined;
    let start = node.children.length - 1;
    // Match the opaque starting layer selected by 0x404A51.
    for (; start >= 0; start--) {
      const d = node.children[start]!.payload!;
      if (d.e !== 1 || d.mode !== 0 || d.a !== 256 || d.masked || (d.tid && d.t !== 256)) continue;
      if (
        d.x <= 0n &&
        d.y <= 0n &&
        Number(d.x) + d.width >= width &&
        Number(d.y) + d.height >= height
      ) {
        if (d.tex || !d.hasPixels) return null;
        break;
      }
    }
    for (let i = Math.max(0, start); i < node.children.length; i++) {
      const child = node.children[i]!;
      const d = child.payload!;
      if (child.group) return null;
      if (!d.e || !d.a || (d.tid && !d.t) || d.tex || !d.hasPixels) continue;
      const x = Number(d.x),
        y = Number(d.y);
      const left = Math.max(0, x),
        top = Math.max(0, y);
      const right = Math.min(width, x + d.width),
        bottom = Math.min(height, y + d.height);
      if (right <= left || bottom <= top) continue;
      const additive = d.mode === 1;
      if ((d.mode !== 0 && !additive) || d.a < 0 || d.a > 256 || d.md !== 0x808080 || d.sd !== 0x80)
        return null;
      const pending = d.deferredScale;
      // Unruled additive layers preserve alpha when masked (0x4011E4) and
      // add into it when unmasked (0x401124). SIZE2 samples feed either blend.
      if (additive && d.tid && d.t <= 255) return null;
      const pixels = pending?.pixels ?? d.pixels!;
      let image = pending ?? {
        pixels,
        width: d.width,
        height: d.height,
        revision: d.pixelRevision,
      };
      if (!pending) {
        const bitmap = yurisRasterBitmap(pixels, d.width, d.height);
        if (hasRasterText(bitmap)) {
          const blank = rasterTextBitmap(bitmap).storage!.bytes;
          if ((pixels.byteOffset | blank.byteOffset) & 3) return null;
          let raster = this.rasterBounds.get(pixels);
          if (
            raster?.alternate !== blank ||
            raster.revision !== d.pixelRevision ||
            raster.width !== d.width ||
            raster.height !== d.height
          ) {
            raster = {
              alternate: blank,
              revision: d.pixelRevision,
              width: d.width,
              height: d.height,
              bounds: rasterDamage(pixels, blank, d.width, d.height),
            };
            this.rasterBounds.set(pixels, raster);
          }
          if (raster.bounds) {
            const [rx0, ry0, rx1, ry1] = raster.bounds;
            const x0 = Math.max(left, x + rx0),
              y0 = Math.max(top, y + ry0);
            const x1 = Math.min(right - 1, x + rx1),
              y1 = Math.min(bottom - 1, y + ry1);
            if (x0 <= x1 && y0 <= y1) strip = include(strip, x0, y0, x1, y1);
          }
          for (const glyph of readRasterText(bitmap)) {
            const c = glyph.clip;
            const x0 = Math.max(left, Math.floor(x + c.x)),
              y0 = Math.max(top, Math.floor(y + c.y));
            const x1 = Math.min(right, Math.ceil(x + c.x + c.width));
            const y1 = Math.min(bottom, Math.ceil(y + c.y + c.height));
            if (x0 < x1 && y0 < y1) strip = include(strip, x0, y0, x1 - 1, y1 - 1);
          }
          if (dom) image = {...image, pixels: blank};
        }
      }
      if (!renderer.accepts(image)) return null;
      const layer: IntegerLayer = {
        image,
        x,
        y,
        left,
        top,
        width: right - left,
        height: bottom - top,
        alpha: d.a,
        masked: d.masked === 1,
        additive,
      };
      if (pending) {
        if (!renderer.acceptsSize(d.width, d.height)) return null;
        if (pixels.length !== pending.width * pending.height * 4) return null;
        layer.scale = {
          columns: this.columns(pending),
          rows: bilinearCoordinates(pending.fy, pending.fy2, pending.fsy, pending.height, false),
          sse: pending.sse,
        };
      }
      if (d.tid && d.t <= 255) {
        const rule = host.ruleLayer(d.tid)?.payload;
        if (rule) {
          if (d.width !== rule.width || d.height !== rule.height || !rule.hasPixels) return null;
          const image = {
            pixels: rule.pixels!,
            width: rule.width,
            height: rule.height,
            revision: rule.pixelRevision,
          };
          if (!renderer.accepts(image)) return null;
          layer.rule = {image, weights: ruleWeights(d.t, d.ta, d.a)};
        }
      }
      draws.push(layer);
    }
    if (strip && (strip[2] - strip[0] + 1) * (strip[3] - strip[1] + 1) > width * height * 0.35)
      return null;
    if (this.node && this.node !== node) void this.node.payload?.pixels;
    this.node = node;
    const pixels = cg.replaceWindowReadback()!;
    const bitmap = yurisRasterBitmap(pixels, width, height);
    cg.masked = 0;
    if (strip) {
      clearRasterTextGlyphs(bitmap);
      // Reproduce raster provenance and visibility only where the two planes
      // can differ. The GPU draws the selected plane over the whole window.
      const saved = cg.clip.slice();
      for (let i = 0; i < 4; i++) cg.clip[i] = strip[i]!;
      compose(host, node, 0, 0, strip);
      for (let i = 0; i < 4; i++) cg.clip[i] = saved[i]!;
    } else releaseRasterText(bitmap.storage!);

    const blank = rasterTextBitmap(bitmap).storage!.bytes;
    const display = dom ? blank : pixels;
    renderer.render(draws, damage);
    renderer.show(context, damage);
    this.drawn++;
    cg.deferWindowReadback(() => {
      this.readbacks++;
      if (!renderer.read(display)) {
        cg.dirty = true;
        cg.clip[0] = cg.clip[1] = 0;
        cg.clip[2] = width - 1;
        cg.clip[3] = height - 1;
        compose(host, node, 0, 0, [0, 0, width - 1, height - 1]);
      } else if (strip && pixels !== blank) {
        const other = dom ? pixels : blank;
        const stride = width * 4;
        for (let y = 0; y < height; y++) {
          const row = y * stride;
          if (y < strip[1] || y > strip[3]) other.set(display.subarray(row, row + stride), row);
          else {
            const left = row + strip[0] * 4,
              right = row + (strip[2] + 1) * 4;
            other.set(display.subarray(row, left), row);
            other.set(display.subarray(right, row + stride), right);
          }
        }
      }
    });
    this.displayed = {revision: cg.pixelRevision, dom};
    if (!dom || !strip) return [];
    const [left, top, right, bottom] = strip;
    const view = yurisRasterBitmap(pixels, width, bottom - top + 1, left, top, right - left + 1);
    return visibleRasterText(view).map((glyph) => ({
      ...glyph,
      x: glyph.x + left,
      y: glyph.y + top,
      clip: {...glyph.clip, x: glyph.clip.x + left, y: glyph.clip.y + top},
    }));
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
  }
}
