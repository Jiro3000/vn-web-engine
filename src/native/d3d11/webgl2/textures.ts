import {
  gpuTextureDecodeFragment,
  packedGpuTexture,
  type GpuTextureFormat,
} from '../../../graphics/block-texture.js';
import type {
  D3d11Box,
  D3d11DepthStencilViewDesc,
  D3d11ShaderResourceViewDesc,
  D3d11RenderTargetViewDesc,
} from '../contract.js';
import type {D3d11DeviceOwner} from '../runtime/com.js';
import {D3d11Texture2D, type D3d11ResourceStorage} from '../runtime/resources.js';
import type {D3d11TextureView} from '../runtime/views.js';

const MAX_GPU_BYTES = 512 * 1024 * 1024;
const MAX_AUXILIARY_BYTES = 64 * 1024 * 1024;
const READBACK_BYTES = 1024 * 1024;
export class D3d11TextureError extends Error {
  constructor(
    message: string,
    readonly hr = 0x80004005 | 0,
  ) {
    super(message);
  }
}
interface Format {
  readonly internal: number;
  readonly format: number;
  readonly type: number;
  readonly bytes: number;
  readonly decode: GpuTextureFormat | null;
}
interface Alias {
  readonly owner: Texture;
  readonly key: string;
  readonly texture: WebGLTexture;
  readonly first: number;
  readonly count: number;
  readonly bytes: number;
  revision: number;
  pins: number;
}
interface Texture {
  readonly resource: D3d11Texture2D;
  readonly texture: WebGLTexture;
  readonly format: Format;
  readonly bytes: number;
  readonly framebuffers: Map<number, WebGLFramebuffer>;
  readonly aliases: Map<string, Alias>;
  readonly dirty: Set<number>;
  fence: WebGLSync | null;
  revision: number;
}

/**
 * Private device texture storage. Native row0 occupies GL row0, including render targets.
 * Operations can change GL bindings/state; the context reapplies its complete draw state.
 * The resource owner routes synchronization and final-resource callbacks here.
 */
export class D3d11GpuTextures {
  private readonly textures = new Map<D3d11Texture2D, Texture>();
  private readonly aliases = new Map<Alias, Alias>();
  private readonly aliasImages = new Map<WebGLTexture, Alias>();
  private readonly decoders = new Map<GpuTextureFormat, WebGLProgram>();
  private scratch: WebGLTexture | null = null;
  private zero: WebGLTexture | null = null;
  private scratchBytes = 0;
  private vao: WebGLVertexArrayObject | null = null;
  private readback = new Uint8Array(0);
  private bytes = 0;
  private aliasBytes = 0;
  private disposed = false;
  private readonly maxSize: number;

  constructor(
    private readonly owner: D3d11DeviceOwner,
    private readonly gl: WebGL2RenderingContext,
  ) {
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  }

  /** Allocate or refresh the canonical complete mip chain. No native reference is acquired. */
  image(resource: D3d11Texture2D): WebGLTexture {
    return this.get(resource).texture;
  }

  /** Borrow a draw's context-owned views together, pinning aliases until release. */
  acquireShaderResources(
    views: readonly (D3d11TextureView<D3d11ShaderResourceViewDesc> | null)[],
  ): {
    readonly images: readonly WebGLTexture[];
    release(): void;
  } {
    this.checkLive();
    const held = new Set<Alias>(),
      images: WebGLTexture[] = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const alias of held) alias.pins--;
      for (const alias of held) {
        const entry = alias.owner;
        while (entry.aliases.size > 8) {
          const unused = [...entry.aliases.values()].find((a) => a.pins === 0);
          if (!unused) break;
          this.deleteAlias(unused);
        }
      }
      held.clear();
    };
    try {
      for (const view of views) {
        const image = view === null ? this.zeroImage() : this.shaderResource(view),
          alias = this.aliasImages.get(image);
        if (alias && !held.has(alias)) {
          alias.pins++;
          held.add(alias);
        }
        images.push(image);
      }
      return {images, release};
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Independent image storage implements simultaneous SRVs with different mip ranges. */
  shaderResource(view: D3d11TextureView<D3d11ShaderResourceViewDesc>): WebGLTexture {
    if (!view.live || view.kind !== 'shader-resource')
      throw new D3d11TextureError('Invalid shader resource view');
    const entry = this.get(view.resource),
      first = view.firstMip,
      count = view.mipCount;
    if (first === 0 && count === entry.resource.levels.length) return entry.texture;
    const key = `${first}/${count}`;
    let alias = entry.aliases.get(key);
    if (!alias) {
      const bytes = entry.resource.levels
        .slice(first, first + count)
        .reduce((n, l) => n + l.width * l.height * entry.format.bytes, 0);
      if (bytes > MAX_AUXILIARY_BYTES)
        throw new D3d11TextureError(
          'D3D11 shader view exceeds alias storage limit',
          0x8007000e | 0,
        );
      while (entry.aliases.size >= 8 || this.aliasBytes + bytes > MAX_AUXILIARY_BYTES) {
        const needsSpace = this.aliasBytes + bytes > MAX_AUXILIARY_BYTES;
        const oldest = [...(needsSpace ? this.aliases : entry.aliases).values()].find(
          (a) => a.pins === 0,
        );
        if (!oldest) {
          if (needsSpace)
            throw new D3d11TextureError(
              'Active D3D11 shader views exceed alias storage limit',
              0x8007000e | 0,
            );
          break;
        }
        this.deleteAlias(oldest);
      }
      this.budget(bytes);
      const texture = this.gl.createTexture();
      if (!texture)
        throw new D3d11TextureError('D3D11 shader view allocation failed', 0x8007000e | 0);
      try {
        const level = resourceLevel(entry, first);
        this.allocate(texture, entry.format, count, level.width, level.height);
        this.checkError('shader view allocation');
      } catch (error) {
        this.gl.deleteTexture(texture);
        throw error;
      }
      alias = {owner: entry, key, texture, first, count, bytes, revision: -1, pins: 0};
      entry.aliases.set(key, alias);
      this.aliases.set(alias, alias);
      this.aliasImages.set(texture, alias);
      this.bytes += bytes;
      this.aliasBytes += bytes;
    }
    if (alias.revision !== entry.revision) {
      const gl = this.gl;
      for (let i = 0; i < alias.count; i++) {
        const mip = alias.first + i,
          level = resourceLevel(entry, mip);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebufferFor(entry, mip));
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, alias.texture);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, i, 0, 0, 0, 0, level.width, level.height);
      }
      this.checkError('shader view copy');
      alias.revision = entry.revision;
    }
    this.aliases.delete(alias);
    this.aliases.set(alias, alias);
    entry.aliases.delete(key);
    entry.aliases.set(key, alias);
    return alias.texture;
  }

  /** Single-mip attachment for clears, copies and readback; depth attachments are supported. */
  framebuffer(resource: D3d11Texture2D, mip: number): WebGLFramebuffer {
    return this.framebufferFor(this.get(resource), mip);
  }

  clearColor(
    view: D3d11TextureView<D3d11RenderTargetViewDesc>,
    color: readonly [number, number, number, number],
  ): void {
    if (!view.live || view.kind !== 'render-target')
      throw new D3d11TextureError('Invalid render target view');
    const entry = this.get(view.resource),
      gl = this.gl;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebufferFor(entry, view.firstMip));
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.DITHER);
    gl.colorMask(true, true, true, true);
    gl.clearBufferfv(
      gl.COLOR,
      0,
      new Float32Array(view.resource.getDesc().format === 65 ? [0, 0, 0, color[3]] : color),
    );
    this.checkError('render target clear');
    this.markWritten(view.resource, view.firstMip);
  }

  clearDepthStencil(
    view: D3d11TextureView<D3d11DepthStencilViewDesc>,
    flags: number,
    depth: number,
    stencil: number,
  ): void {
    if (
      !view.live ||
      view.kind !== 'depth-stencil' ||
      !Number.isInteger(flags) ||
      flags < 0 ||
      flags > 3 ||
      ((flags & 1) !== 0 && Number.isNaN(depth)) ||
      !Number.isInteger(stencil) ||
      stencil < 0 ||
      stencil > 255 ||
      (flags & view.getDesc().flags) !== 0 ||
      ((flags & 2) !== 0 && view.resource.getDesc().format !== 45)
    )
      throw new D3d11TextureError('Invalid or unsupported depth/stencil clear');
    const entry = this.get(view.resource);
    if (flags === 0) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebufferFor(entry, view.firstMip));
    gl.disable(gl.SCISSOR_TEST);
    gl.depthMask(true);
    gl.stencilMask(255);
    const value = Math.max(0, Math.min(1, depth));
    if (flags === 3) gl.clearBufferfi(gl.DEPTH_STENCIL, 0, value, stencil);
    else if (flags & 1) gl.clearBufferfv(gl.DEPTH, 0, new Float32Array([value]));
    else gl.clearBufferiv(gl.STENCIL, 0, new Int32Array([stencil]));
    this.checkError('depth/stencil clear');
    this.markWritten(view.resource, view.firstMip);
  }

  /** Validated native copies of writable texels stay on the GPU, including depth/stencil. */
  copyRegion(
    destination: D3d11ResourceStorage,
    subresource: number,
    x: number,
    y: number,
    z: number,
    source: D3d11ResourceStorage,
    sourceSubresource: number,
    box: D3d11Box | null,
  ): void {
    this.checkCopyResources(destination, source);
    const plan = destination.copyPlan(subresource, x, y, z, source, sourceSubresource, box);
    if (!plan) return;
    if (!this.gpuCopy(destination) || !this.gpuCopy(source)) {
      destination.copyFrom(subresource, x, y, z, source, sourceSubresource, box);
      return;
    }
    const from = this.framebuffer(source, sourceSubresource),
      to = this.framebuffer(destination, subresource);
    this.blit(
      destination,
      from,
      to,
      box?.left ?? 0,
      box?.top ?? 0,
      x,
      y,
      plan.from.width,
      plan.from.height,
    );
    this.markWritten(destination, subresource);
  }

  copyResource(destination: D3d11ResourceStorage, source: D3d11ResourceStorage): void {
    this.checkCopyResources(destination, source);
    destination.validateWholeCopy(source);
    if (!this.gpuCopy(destination) || !this.gpuCopy(source)) {
      destination.copyAllFrom(source);
      return;
    }
    // Prepare every attachment before modifying the first destination mip.
    const attachments = destination.levels.map((level, mip) => ({
      level,
      from: this.framebuffer(source, mip),
      to: this.framebuffer(destination, mip),
    }));
    for (const [mip, {level, from, to}] of attachments.entries()) {
      this.blit(destination, from, to, 0, 0, 0, 0, level.width, level.height);
      this.markWritten(destination, mip);
    }
  }

  /** Generate only the view's lower levels, preserving its source and all excluded mips. */
  generateMips(view: D3d11TextureView<D3d11ShaderResourceViewDesc>): void {
    this.checkLive();
    if (!view.live || view.kind !== 'shader-resource' || view.lifetime !== this.owner.lifetime)
      throw new D3d11TextureError('Invalid shader resource view');
    const desc = view.resource.getDesc();
    if (
      (desc.bindFlags & 0x28) !== 0x28 ||
      !(desc.miscFlags & 1) ||
      view.resource.layout.blockWidth !== 1 ||
      view.resource.layout.depth ||
      view.mipCount <= 1
    )
      return;
    const entry = this.get(view.resource),
      gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, view.firstMip);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, view.firstMip + view.mipCount - 1);
    try {
      gl.generateMipmap(gl.TEXTURE_2D);
      this.checkError('mip generation');
    } finally {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, desc.mipLevels - 1);
    }
    for (let mip = view.firstMip + 1; mip < view.firstMip + view.mipCount; mip++)
      this.markWritten(view.resource, mip);
  }

  private gpuCopy(resource: D3d11ResourceStorage): resource is D3d11Texture2D {
    return (
      resource instanceof D3d11Texture2D &&
      resource.getDesc().arraySize === 1 &&
      resource.layout.blockWidth === 1
    );
  }

  private checkCopyResources(
    destination: D3d11ResourceStorage,
    source: D3d11ResourceStorage,
  ): void {
    this.checkLive();
    if (destination.lifetime !== this.owner.lifetime || source.lifetime !== this.owner.lifetime)
      throw new D3d11TextureError('Copying a foreign D3D11 resource');
  }

  private blit(
    destination: D3d11Texture2D,
    from: WebGLFramebuffer,
    to: WebGLFramebuffer,
    sx: number,
    sy: number,
    dx: number,
    dy: number,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.disable(gl.SCISSOR_TEST);
    const mask = destination.layout.depth
      ? gl.DEPTH_BUFFER_BIT | (destination.getDesc().format === 45 ? gl.STENCIL_BUFFER_BIT : 0)
      : gl.COLOR_BUFFER_BIT;
    gl.blitFramebuffer(
      sx,
      sy,
      sx + width,
      sy + height,
      dx,
      dy,
      dx + width,
      dy + height,
      mask,
      gl.NEAREST,
    );
    this.checkError('resource copy');
  }

  /** The caller has written this attachment using its native draw/copy operation. */
  markWritten(resource: D3d11Texture2D, mip: number): void {
    const entry = this.get(resource);
    if (
      !Number.isInteger(mip) ||
      !entry.resource.levels[mip] ||
      (entry.format.decode && ![65, 87].includes(resource.getDesc().format))
    )
      throw new D3d11TextureError('Invalid D3D11 GPU write');
    resource.revision++;
    entry.revision = resource.revision;
    entry.dirty.add(mip);
    if (entry.fence) {
      this.gl.deleteSync(entry.fence);
      entry.fence = null;
    }
  }

  /** Map(DO_NOT_WAIT) inserts a fence only when a pending device write actually needs one. */
  ready(resource: D3d11ResourceStorage): boolean {
    if (!(resource instanceof D3d11Texture2D)) return true;
    const entry = this.textures.get(resource);
    if (!entry || !entry.dirty.size || entry.revision !== resource.revision) return true;
    this.checkLive();
    const gl = this.gl;
    if (!entry.fence) {
      entry.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!entry.fence)
        throw new D3d11TextureError('D3D11 readiness fence allocation failed', 0x8007000e | 0);
      gl.flush();
    }
    const status = gl.clientWaitSync(entry.fence, 0, 0);
    if (status === gl.WAIT_FAILED) throw new D3d11TextureError('D3D11 readiness fence wait failed');
    return status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED;
  }

  /** Internal resource-owner callback. Readback happens only for pending GPU writes. */
  synchronize(resource: D3d11ResourceStorage): void {
    if (!(resource instanceof D3d11Texture2D)) return;
    const entry = this.textures.get(resource);
    if (!entry) return;
    this.checkLive();
    if (entry.revision !== resource.revision) {
      entry.dirty.clear();
      if (entry.fence) {
        this.gl.deleteSync(entry.fence);
        entry.fence = null;
      }
      return;
    }
    if (!entry.dirty.size) return;
    if (resource.layout.depth)
      throw new D3d11TextureError(
        'Depth/stencil CPU readback is outside this resource subset',
        0x80004001 | 0,
      );
    const gl = this.gl,
      format = resource.getDesc().format;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
    for (const mip of entry.dirty) {
      const level = resourceLevel(entry, mip),
        rows = Math.max(1, Math.floor(READBACK_BYTES / (level.width * 4)));
      const size = level.width * Math.min(rows, level.height) * 4;
      if (this.readback.length < size) this.readback = new Uint8Array(size);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebufferFor(entry, mip));
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      for (let y = 0; y < level.height; y += rows) {
        const height = Math.min(rows, level.height - y);
        gl.readPixels(0, y, level.width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.readback);
        this.checkError('resource readback');
        const pixels = level.width * height,
          output = level.bytes,
          base = y * level.rowPitch;
        if (format === 28) output.set(this.readback.subarray(0, pixels * 4), base);
        else
          for (let i = 0; i < pixels; i++) {
            const from = i * 4;
            if (format === 87) {
              const to = base + from;
              output[to] = this.readback[from + 2]!;
              output[to + 1] = this.readback[from + 1]!;
              output[to + 2] = this.readback[from]!;
              output[to + 3] = this.readback[from + 3]!;
            } else if (format === 61) output[base + i] = this.readback[from]!;
            else if (format === 65) output[base + i] = this.readback[from + 3]!;
            else if (format === 49) {
              output[base + i * 2] = this.readback[from]!;
              output[base + i * 2 + 1] = this.readback[from + 1]!;
            } else throw new D3d11TextureError('Unsupported writable texture format');
          }
      }
    }
    entry.dirty.clear();
    if (entry.fence) {
      gl.deleteSync(entry.fence);
      entry.fence = null;
    }
  }

  /** Called by the native resource's final reference release. */
  destroy(resource: D3d11ResourceStorage): void {
    if (!(resource instanceof D3d11Texture2D)) return;
    const entry = this.textures.get(resource);
    if (!entry) return;
    this.textures.delete(resource);
    this.bytes -= entry.bytes;
    const actions: (() => void)[] = [];
    if (entry.fence) actions.push(() => this.gl.deleteSync(entry.fence));
    for (const alias of entry.aliases.values()) actions.push(() => this.deleteAlias(alias));
    for (const framebuffer of entry.framebuffers.values())
      actions.push(() => this.gl.deleteFramebuffer(framebuffer));
    actions.push(() => this.gl.deleteTexture(entry.texture));
    this.disposeAll(actions);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const actions: (() => void)[] = [
      () => {
        const current = this.gl.getParameter(this.gl.CURRENT_PROGRAM);
        if ([...this.decoders.values()].includes(current)) this.gl.useProgram(null);
      },
    ];
    for (const resource of this.textures.keys()) actions.push(() => this.destroy(resource));
    for (const program of this.decoders.values())
      actions.push(() => this.gl.deleteProgram(program));
    actions.push(
      () => this.gl.deleteTexture(this.scratch),
      () => this.gl.deleteTexture(this.zero),
      () => this.gl.deleteVertexArray(this.vao),
    );
    try {
      this.disposeAll(actions);
    } finally {
      this.decoders.clear();
      this.scratch = null;
      this.zero = null;
      this.vao = null;
      this.readback = new Uint8Array(0);
      this.scratchBytes = 0;
      this.bytes = 0;
      this.aliasBytes = 0;
    }
  }

  private get(resource: D3d11Texture2D): Texture {
    this.checkLive();
    if (
      !(resource instanceof D3d11Texture2D) ||
      !resource.live ||
      resource.lifetime !== this.owner.lifetime ||
      resource.levels.some((l) => l.mapped)
    )
      throw new D3d11TextureError('Invalid, foreign or mapped D3D11 texture');
    let entry = this.textures.get(resource);
    if (!entry) {
      const desc = resource.getDesc();
      if (desc.arraySize !== 1)
        throw new D3d11TextureError(
          'Texture arrays are outside the GPU view subset',
          0x80004001 | 0,
        );
      if (desc.width > this.maxSize || desc.height > this.maxSize)
        throw new D3d11TextureError('Texture exceeds GPU dimension limit', 0x8007000e | 0);
      const format = this.format(desc.format),
        bytes = resource.levels.reduce((n, l) => n + l.width * l.height * format.bytes, 0);
      this.budget(bytes);
      const texture = this.gl.createTexture();
      if (!texture) throw new D3d11TextureError('D3D11 texture allocation failed', 0x8007000e | 0);
      entry = {
        resource,
        texture,
        format,
        bytes,
        revision: -1,
        framebuffers: new Map(),
        aliases: new Map(),
        dirty: new Set(),
        fence: null,
      };
      this.bytes += bytes;
      try {
        this.allocate(texture, format, desc.mipLevels, desc.width, desc.height);
        this.checkError('texture allocation');
        this.upload(entry);
      } catch (error) {
        this.bytes -= bytes;
        for (const framebuffer of entry.framebuffers.values())
          this.gl.deleteFramebuffer(framebuffer);
        this.gl.deleteTexture(texture);
        throw error;
      }
      this.textures.set(resource, entry);
    } else if (entry.revision !== resource.revision) {
      this.upload(entry);
    }
    return entry;
  }

  private allocate(
    texture: WebGLTexture,
    format: Format,
    count: number,
    width: number,
    height: number,
  ): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, count, format.internal, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, count - 1);
  }

  private upload(entry: Texture): void {
    const gl = this.gl;
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    for (const [name, value] of [
      [gl.UNPACK_ALIGNMENT, 1],
      [gl.UNPACK_ROW_LENGTH, 0],
      [gl.UNPACK_SKIP_PIXELS, 0],
      [gl.UNPACK_SKIP_ROWS, 0],
      [gl.UNPACK_FLIP_Y_WEBGL, 0],
      [gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0],
      [gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE],
    ] as const)
      gl.pixelStorei(name, value);
    for (let mip = 0; mip < entry.resource.levels.length; mip++) {
      const level = resourceLevel(entry, mip);
      if (entry.format.decode) {
        this.decode(entry, mip, entry.format.decode);
        continue;
      }
      let data: Uint8Array<ArrayBufferLike> | Uint32Array | Float32Array = level.bytes;
      if (entry.resource.getDesc().format === 40)
        data = new Float32Array(level.bytes.buffer, level.bytes.byteOffset, level.bytes.length / 4);
      else if (entry.resource.getDesc().format === 45) {
        data = new Uint32Array(level.bytes.length / 4);
        const view = new DataView(level.bytes.buffer, level.bytes.byteOffset, level.bytes.length);
        for (let i = 0; i < data.length; i++) {
          const word = view.getUint32(i * 4, true);
          data[i] = ((word << 8) | (word >>> 24)) >>> 0;
        }
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        mip,
        0,
        0,
        level.width,
        level.height,
        entry.format.format,
        entry.format.type,
        data,
      );
    }
    this.checkError('texture upload');
    entry.revision = entry.resource.revision;
    entry.dirty.clear();
    if (entry.fence) {
      gl.deleteSync(entry.fence);
      entry.fence = null;
    }
  }

  private decode(entry: Texture, mip: number, format: GpuTextureFormat): void {
    const gl = this.gl,
      level = resourceLevel(entry, mip),
      image = packedGpuTexture(format, level.width, level.height, level.bytes);
    const size = image.width * image.height * 4;
    if (size > MAX_AUXILIARY_BYTES)
      throw new D3d11TextureError('Packed texture exceeds scratch storage limit', 0x8007000e | 0);
    this.budget(Math.max(0, size - this.scratchBytes));
    if (!this.scratch) this.scratch = gl.createTexture();
    if (!this.scratch)
      throw new D3d11TextureError('Packed texture allocation failed', 0x8007000e | 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scratch);
    gl.bindSampler(0, null);
    try {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        image.width,
        image.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image.pixels,
      );
      this.checkError('packed texture upload');
    } catch (error) {
      gl.deleteTexture(this.scratch);
      this.scratch = null;
      this.bytes -= this.scratchBytes;
      this.scratchBytes = 0;
      throw error;
    }
    this.bytes += size - this.scratchBytes;
    this.scratchBytes = size;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const program = this.decoder(format);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebufferFor(entry, mip));
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'atlas'), 0);
    if (!this.vao) this.vao = gl.createVertexArray();
    if (!this.vao)
      throw new D3d11TextureError('Texture decode VAO allocation failed', 0x8007000e | 0);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, level.width, level.height);
    for (const flag of [
      gl.BLEND,
      gl.CULL_FACE,
      gl.DEPTH_TEST,
      gl.STENCIL_TEST,
      gl.SCISSOR_TEST,
      gl.DITHER,
      gl.RASTERIZER_DISCARD,
    ])
      gl.disable(flag);
    gl.colorMask(true, true, true, true);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private framebufferFor(entry: Texture, mip: number): WebGLFramebuffer {
    if (!Number.isInteger(mip) || !entry.resource.levels[mip])
      throw new D3d11TextureError('Invalid D3D11 framebuffer mip');
    const found = entry.framebuffers.get(mip);
    if (found) return found;
    const gl = this.gl,
      framebuffer = gl.createFramebuffer();
    if (!framebuffer)
      throw new D3d11TextureError('D3D11 framebuffer allocation failed', 0x8007000e | 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      entry.resource.layout.depth
        ? entry.resource.getDesc().format === 45
          ? gl.DEPTH_STENCIL_ATTACHMENT
          : gl.DEPTH_ATTACHMENT
        : gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      entry.texture,
      mip,
    );
    gl.drawBuffers([entry.resource.layout.depth ? gl.NONE : gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(entry.resource.layout.depth ? gl.NONE : gl.COLOR_ATTACHMENT0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      throw new D3d11TextureError('Incomplete D3D11 framebuffer');
    }
    entry.framebuffers.set(mip, framebuffer);
    return framebuffer;
  }

  private decoder(format: GpuTextureFormat): WebGLProgram {
    const cached = this.decoders.get(format);
    if (cached) return cached;
    const gl = this.gl,
      shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    try {
      for (const [type, source] of [
        [
          gl.VERTEX_SHADER,
          '#version 300 es\nvoid main(){vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(p[gl_VertexID],0,1);}',
        ],
        [
          gl.FRAGMENT_SHADER,
          '#version 300 es\nprecision highp float;precision highp int;uniform highp sampler2D atlas;vec2 tex;out vec4 result;\n' +
            gpuTextureDecodeFragment(format) +
            '\nvoid main(){tex=gl_FragCoord.xy;result=shade(vec4(0),vec4(0));}',
        ],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader)
          throw new D3d11TextureError('Texture decode shader allocation failed', 0x8007000e | 0);
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new D3d11TextureError('Texture decode compile: ' + gl.getShaderInfoLog(shader));
      }
      program = gl.createProgram();
      if (!program)
        throw new D3d11TextureError('Texture decode program allocation failed', 0x8007000e | 0);
      for (const shader of shaders) gl.attachShader(program, shader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new D3d11TextureError('Texture decode link: ' + gl.getProgramInfoLog(program));
      this.decoders.set(format, program);
      return program;
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }
  }

  private format(format: number): Format {
    const gl = this.gl;
    if (format === 61)
      return {internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, bytes: 1, decode: null};
    if (format === 49)
      return {internal: gl.RG8, format: gl.RG, type: gl.UNSIGNED_BYTE, bytes: 2, decode: null};
    if (format === 40)
      return {
        internal: gl.DEPTH_COMPONENT32F,
        format: gl.DEPTH_COMPONENT,
        type: gl.FLOAT,
        bytes: 4,
        decode: null,
      };
    if (format === 45)
      return {
        internal: gl.DEPTH24_STENCIL8,
        format: gl.DEPTH_STENCIL,
        type: gl.UNSIGNED_INT_24_8,
        bytes: 4,
        decode: null,
      };
    const decode: Partial<Record<number, GpuTextureFormat>> = {
      65: 'a8',
      87: 'b8g8r8a8',
      71: 'bc1',
      74: 'bc2',
      77: 'bc3',
      98: 'bc7',
    };
    if (format !== 28 && !decode[format])
      throw new D3d11TextureError('Unsupported D3D11 GPU texture format', 0x80004001 | 0);
    return {
      internal: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      bytes: 4,
      decode: decode[format] ?? null,
    };
  }
  private budget(additional: number): void {
    while (this.bytes + additional > MAX_GPU_BYTES && this.aliases.size) {
      const unused = [...this.aliases.values()].find((a) => a.pins === 0);
      if (!unused) break;
      this.deleteAlias(unused);
    }
    if (this.bytes + additional > MAX_GPU_BYTES)
      throw new D3d11TextureError('D3D11 GPU texture storage limit reached', 0x8007000e | 0);
  }
  private deleteAlias(alias: Alias): void {
    alias.owner.aliases.delete(alias.key);
    this.aliases.delete(alias);
    this.aliasImages.delete(alias.texture);
    this.bytes -= alias.bytes;
    this.aliasBytes -= alias.bytes;
    this.gl.deleteTexture(alias.texture);
  }

  private zeroImage(): WebGLTexture {
    if (this.zero) return this.zero;
    this.budget(4);
    const gl = this.gl,
      texture = gl.createTexture();
    if (!texture)
      throw new D3d11TextureError('D3D11 zero texture allocation failed', 0x8007000e | 0);
    try {
      this.allocate(texture, this.format(28), 1, 1, 1);
      // WebGL initializes immutable texture storage to zero in every channel.
      this.checkError('zero texture allocation');
    } catch (error) {
      gl.deleteTexture(texture);
      throw error;
    }
    this.bytes += 4;
    this.zero = texture;
    return texture;
  }
  private checkLive(): void {
    if (this.disposed || this.owner.lifetime.closed)
      throw new D3d11TextureError('Using released D3D11 GPU texture storage');
    if (this.gl.isContextLost())
      throw new D3d11TextureError('D3D11 device removed', 0x887a0005 | 0);
  }
  private checkError(operation: string): void {
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR)
      throw new D3d11TextureError(
        `D3D11 ${operation}: WebGL error${error}`,
        error === this.gl.OUT_OF_MEMORY ? 0x8007000e | 0 : 0x80004005 | 0,
      );
  }
  private disposeAll(actions: readonly (() => void)[]): void {
    const errors: unknown[] = [];
    for (const action of actions)
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, 'D3D11 GPU texture disposal failed');
  }
}

function resourceLevel(entry: Texture, mip: number) {
  return entry.resource.levels[mip]!;
}
