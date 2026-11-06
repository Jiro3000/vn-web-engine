/** Unpremultiplied BGRA stored in the four integer lanes of a WebGL texture. */
export interface IntegerImage {
  pixels: Uint8Array;
  width: number;
  height: number;
  revision: number;
}
export interface IntegerScale {
  columns: Int32Array;
  rows: Int32Array;
  sse: boolean;
}
export interface IntegerRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface IntegerLayer extends IntegerRegion {
  image: IntegerImage;
  scale?: IntegerScale;
  rule?: {image: IntegerImage; weights: Int32Array};
  x: number;
  y: number;
  alpha: number;
  masked: boolean;
}

const vertex = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const header = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp isampler2D;
`;
const blend =
  header +
  `
uniform usampler2D image, base, ruleImage;
uniform isampler2D weights, columns, rows;
uniform ivec2 origin;
uniform int opacity, masked, ruled, scaled;
layout(location=0) out uvec4 color;
uvec4 sourceAt(ivec2 p) {
  ivec2 size = textureSize(image, 0);
  int index = p.y * size.x + p.x;
  if (index < 0 || index >= size.x * size.y) return uvec4(0);
  return texelFetch(image, ivec2(index % size.x, index / size.x), 0);
}
uvec4 source(ivec2 p) {
  if (scaled == 0) return texelFetch(image, p, 0);
  ivec2 x = texelFetch(columns, ivec2(p.x, 0), 0).rg;
  ivec2 y = texelFetch(rows, ivec2(p.y, 0), 0).rg;
  if (x.x < 0 || y.x < 0) return uvec4(0);
  ivec2 at = ivec2(x.x, y.x);
  uint wx = uint(x.y), wy = uint(y.y);
  uvec4 a = sourceAt(at) * (256u - wx) + sourceAt(at + ivec2(1,0)) * wx;
  if (wy == 0u) return a >> 8u;
  uvec4 b = sourceAt(at + ivec2(0,1)) * (256u - wx)
          + sourceAt(at + ivec2(1,1)) * wx;
  if (scaled == 1) return ((a * (256u - wy)) >> 16u) + ((b * wy) >> 16u);
  return (((a >> 8u) * (256u - wy)) + ((b >> 8u) * wy)) >> 8u;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), at = p - origin;
  uvec4 s = source(at);
  if (ruled == 0 && masked == 0 && opacity == 256) { color = s; return; }
  uvec4 d = texelFetch(base, p, 0);
  if (ruled != 0) {
    int k = texelFetch(weights, ivec2(int(texelFetch(ruleImage, at, 0).r), 0), 0).r;
    if (k <= 1) { color = d; return; }
    ivec3 delta = ivec3(s.rgb) - ivec3(d.rgb);
    ivec3 v;
    if (masked != 0) v = (delta * (int(s.a) * k)) >> 16;
    else if (opacity == 256) v = -(((-delta) * k) >> 8);
    else v = (delta * k) >> 8;
    color = uvec4(ivec3(d.rgb) + v, d.a);
  } else {
    uint k = masked == 0 ? uint(opacity) : ((s.a * uint(opacity)) >> 8u) + 1u;
    color = (s * k + d * (256u - k)) >> 8u;
    if (masked != 0) color.a = d.a;
  }
}`;
const present =
  header +
  `
uniform usampler2D frame;
out vec4 color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = textureSize(frame, 0).y - 1 - p.y;
  color = vec4(vec3(texelFetch(frame, p, 0).bgr) / 255.0, 1.0);
}`;

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

const TEXTURE_CACHE_BYTES = 160 * 1024 * 1024;

/** Keeps the exact integer buffer separate from the opaque display surface. */
export class IntegerWindowGl {
  static create(width: number, height: number): IntegerWindowGl | null {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const canvas = new OffscreenCanvas(width, height);
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      failIfMajorPerformanceCaveat: true,
    });
    if (!gl) return null;
    try {
      return new IntegerWindowGl(canvas, gl);
    } catch {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return null;
    }
  }

  private readonly programs: [WebGLProgram, WebGLProgram];
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;
  private readonly tables: [WebGLTexture, WebGLTexture, WebGLTexture];
  private readonly cache = new Map<
    Uint8Array,
    {texture: WebGLTexture; revision: number; stamp: number; width: number; height: number}
  >();
  private readonly targets: [Target, Target];
  private readonly maxSize: number;
  private front = 0;
  private stamp = 0;
  private textureBytes = 0;
  private readonly fences: WebGLSync[] = [];
  private readonly boundTables: (Int32Array | undefined)[] = [];
  queueWaits = 0;
  peakQueue = 0;

  private constructor(
    readonly canvas: OffscreenCanvas,
    private readonly gl: WebGL2RenderingContext,
  ) {
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (canvas.width > this.maxSize || canvas.height > this.maxSize)
      throw new Error('Texture too large');
    this.programs = [this.program(blend), this.program(present)];
    gl.useProgram(this.programs[0]);
    this.uniforms = Object.fromEntries(
      ['origin', 'opacity', 'masked', 'ruled', 'scaled'].map((name) => [
        name,
        gl.getUniformLocation(this.programs[0], name),
      ]),
    );
    for (const [unit, name] of [
      'image',
      'base',
      'ruleImage',
      'weights',
      'columns',
      'rows',
    ].entries())
      gl.uniform1i(gl.getUniformLocation(this.programs[0], name), unit);
    gl.useProgram(this.programs[1]);
    gl.uniform1i(gl.getUniformLocation(this.programs[1], 'frame'), 0);
    this.tables = [this.texture(3), this.texture(4), this.texture(5)];
    // Keep all active integer sampler units complete, including unused branches.
    this.table(3, this.tables[0], new Int32Array(1), false);
    this.table(4, this.tables[1], new Int32Array(2), true);
    this.table(5, this.tables[2], new Int32Array(2), true);
    this.targets = [this.target(), this.target()];
    gl.disable(gl.DITHER);
  }

  private program(fragment: string): WebGLProgram {
    const gl = this.gl;
    const result = gl.createProgram()!;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? 'Invalid shader');
      gl.attachShader(result, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(result) ?? 'Invalid program');
    return result;
  }

  private bind(unit: number, texture: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  private texture(unit: number): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    this.bind(unit, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  private target(): Target {
    const gl = this.gl;
    const texture = this.texture(0);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8UI, this.canvas.width, this.canvas.height);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('Incomplete integer framebuffer');
    return {texture, framebuffer};
  }

  acceptsSize(width: number, height: number): boolean {
    return width > 0 && height > 0 && width <= this.maxSize && height <= this.maxSize;
  }

  accepts(image: IntegerImage): boolean {
    return (
      this.acceptsSize(image.width, image.height) &&
      image.pixels.byteLength >= image.width * image.height * 4
    );
  }

  private image(unit: number, image: IntegerImage): void {
    const gl = this.gl;
    let entry = this.cache.get(image.pixels);
    if (!entry) {
      entry = {texture: this.texture(unit), revision: -1, stamp: 0, width: 0, height: 0};
      this.cache.set(image.pixels, entry);
    }
    this.bind(unit, entry.texture);
    if (
      entry.revision !== image.revision ||
      entry.width !== image.width ||
      entry.height !== image.height
    ) {
      this.textureBytes += (image.width * image.height - entry.width * entry.height) * 4;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8UI,
        image.width,
        image.height,
        0,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_BYTE,
        image.pixels,
      );
      entry.revision = image.revision;
      entry.width = image.width;
      entry.height = image.height;
    }
    entry.stamp = this.stamp;
  }

  private table(unit: number, texture: WebGLTexture, table: Int32Array, pair: boolean): void {
    const gl = this.gl;
    this.bind(unit, texture);
    if (this.boundTables[unit] === table) return;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      pair ? gl.RG32I : gl.R32I,
      table.length / (pair ? 2 : 1),
      1,
      0,
      pair ? gl.RG_INTEGER : gl.RED_INTEGER,
      gl.INT,
      table,
    );
    this.boundTables[unit] = table;
  }

  /** A pending fence lets callers avoid growing the GPU queue without bound. */
  ready(): boolean {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    while (this.fences.length) {
      const state = gl.clientWaitSync(this.fences[0]!, 0, 0);
      if (state === gl.WAIT_FAILED) return false;
      if (state === gl.TIMEOUT_EXPIRED) break;
      gl.deleteSync(this.fences.shift()!);
    }
    if (this.fences.length < 2) return true;
    this.queueWaits++;
    return false;
  }

  render(layers: readonly IntegerLayer[], region?: IntegerRegion): void {
    const gl = this.gl;
    const {width, height} = this.canvas;
    ++this.stamp;
    if (this.textureBytes > TEXTURE_CACHE_BYTES || this.cache.size > 64) {
      for (const [pixels, entry] of this.cache) {
        if (entry.stamp === this.stamp - 1) continue;
        if (this.textureBytes <= TEXTURE_CACHE_BYTES && entry.stamp === this.stamp - 2) continue;
        gl.deleteTexture(entry.texture);
        this.cache.delete(pixels);
        this.textureBytes -= entry.width * entry.height * 4;
      }
    }
    gl.useProgram(this.programs[0]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[this.front]!.framebuffer);
    if (region) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(region.left, region.top, region.width, region.height);
    }
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array(4));
    gl.enable(gl.SCISSOR_TEST);
    for (const layer of layers) {
      let {left, top, width: w, height: h} = layer;
      if (region) {
        const right = Math.min(left + w, region.left + region.width);
        const bottom = Math.min(top + h, region.top + region.height);
        left = Math.max(left, region.left);
        top = Math.max(top, region.top);
        w = right - left;
        h = bottom - top;
        if (w <= 0 || h <= 0) continue;
      }
      const old = this.targets[this.front]!;
      const next = this.targets[this.front ^ 1]!;
      this.image(0, layer.image);
      this.bind(1, old.texture);
      if (layer.rule) {
        this.image(2, layer.rule.image);
        this.table(3, this.tables[0], layer.rule.weights, false);
      } else this.bind(2, old.texture);
      if (layer.scale) {
        this.table(4, this.tables[1], layer.scale.columns, true);
        this.table(5, this.tables[2], layer.scale.rows, true);
      }
      const u = this.uniforms;
      gl.uniform2i(u.origin!, layer.x, layer.y);
      gl.uniform1i(u.opacity!, layer.alpha);
      gl.uniform1i(u.masked!, Number(layer.masked));
      gl.uniform1i(u.ruled!, Number(!!layer.rule));
      gl.uniform1i(u.scaled!, layer.scale ? (layer.scale.sse ? 1 : 2) : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer);
      gl.scissor(left, top, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (w === width && h === height) this.front ^= 1;
      else {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, next.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, old.framebuffer);
        gl.blitFramebuffer(
          left,
          top,
          left + w,
          top + h,
          left,
          top,
          left + w,
          top + h,
          gl.COLOR_BUFFER_BIT,
          gl.NEAREST,
        );
      }
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  show(context: CanvasRenderingContext2D, region?: IntegerRegion): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.programs[1]);
    this.bind(0, this.targets[this.front]!.texture);
    if (region) {
      const {left, top, width, height} = region;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(left, this.canvas.height - top - height, width, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.SCISSOR_TEST);
      context.drawImage(this.canvas, left, top, width, height, left, top, width, height);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      context.drawImage(this.canvas, 0, 0);
    }
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (fence) this.fences.push(fence);
    this.peakQueue = Math.max(this.peakQueue, this.fences.length);
    gl.flush();
  }

  read(pixels: Uint8Array): boolean {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[this.front]!.framebuffer);
    gl.readPixels(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    return !gl.isContextLost();
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.cache.clear();
  }
}
