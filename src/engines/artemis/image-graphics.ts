import type {DrawList, DrawListTarget, DrawCommand} from '../../graphics/draw-list.js';
import {GpuRenderSurface} from '../../graphics/gpu-render-surface.js';
import type {TriangleImage} from '../../graphics/triangle-draw.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisLayerHost} from './layers.js';
import type {
  ArtemisLayerPropertyPatch,
  ArtemisLayerMode,
  ArtemisImageClip,
} from './layer-properties.js';
import type {ArtemisLoadedImage} from './image-loader.js';
import type {ArtemisScene} from './scene.js';
import {ArtemisDisplayObject, artemisDisplayPoint} from './display-object.js';
import {artemisRevision} from './revision.js';
import {
  artemisHasRasterEffects,
  type ArtemisRasterPolicy,
  type ArtemisRasterEffects,
} from './gpu-raster.js';

export interface ArtemisImageActor {
  readonly texture: number;
  readonly display: ArtemisDisplayObject;
  /** Outer wrapper metadata is shared by its retained/current inner actor copies. */
  readonly wrapper: {alpha: number};
  readonly raster: {layerMode: ArtemisLayerMode} & ArtemisRasterEffects;
  readonly clip: ArtemisImageClip;
}
/** CLayerSet's copied property holder; its outer wrapper owns capture storage. */
export interface ArtemisGroupActor {
  readonly texture: null;
  readonly raster: ArtemisImageActor['raster'];
  readonly clip: ArtemisImageClip;
  readonly display: ArtemisDisplayObject;
  readonly wrapper: {alpha: number};
}
export type ArtemisDisplayActor = ArtemisImageActor | ArtemisGroupActor;
export type ArtemisLayerServices = Pick<
  ArtemisLayerHost<ArtemisDisplayActor>,
  | 'creationMode'
  | 'clearLayerCommands'
  | 'resetLayerCommands'
  | 'recordLayerProperties'
  | 'imageLoadFailed'
  | 'layerNotFound'
>;
interface Texture {
  readonly id: number;
  readonly image: TriangleImage;
  references: number;
  readonly managed: boolean;
}
interface RenderNode {
  readonly id: string;
  readonly actor: ArtemisDisplayActor | undefined;
  readonly group: boolean;
  readonly children: RenderNode[];
}
interface CaptureTexture {
  readonly id: number;
  readonly image: GpuRenderSurface;
}
interface GroupCapture {
  enabled: boolean;
  format: 1 | 2;
  revision: number;
  storage?: {
    readonly fore: CaptureTexture;
    readonly back?: CaptureTexture;
    readonly format: 1 | 2;
    readonly display: ArtemisDisplayObject;
    signature?: readonly unknown[];
    plan?: ArtemisImageClip;
  };
}
interface RenderContext {
  readonly surface: GpuRenderSurface | null;
  readonly width: number;
  readonly height: number;
  readonly format?: 1 | 2;
  readonly back?: CaptureTexture;
  pendingClear: boolean;
}
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const f = Math.fround;
const clipKeys = ['left', 'top', 'width', 'height', 'right', 'bottom'] as const;

/** Image and group preparation through the shared raster target.
 * Intermediate surfaces, sampler/blend selection and nonzero-rotation math require owners.
 */
export class ArtemisImageGraphics implements ArtemisLayerHost<ArtemisDisplayActor> {
  private readonly hash: string;
  private nextTexture = 1;
  private readonly textures = new Map<number, Texture>();
  private readonly images = new Map<TriangleImage, Texture>();
  private readonly actors = new Set<ArtemisDisplayActor>();
  private readonly changes = new WeakMap<ArtemisDisplayActor, number>();
  private nextChange = 1;
  private readonly wrappers = new Map<
    ArtemisImageActor['wrapper'],
    {
      references: number;
      lease: ArtemisLoadedImage['lease'];
      capture?: GroupCapture;
    }
  >();
  constructor(
    executableSha256: string,
    private readonly target: DrawListTarget,
    private readonly services: ArtemisLayerServices,
    private readonly raster: ArtemisRasterPolicy,
  ) {
    this.hash = artemisRevision(executableSha256).executableSha256;
    if (![target.width, target.height].every((n) => Number.isInteger(n) && n > 0))
      throw new Error('Invalid Artemis raster target');
    if (
      !raster ||
      !['nearest', 'linear'].includes(raster.filter) ||
      !raster.blend ||
      ![raster.blend.color, raster.blend.alpha].every(
        (channel) =>
          channel &&
          [channel.source, channel.destination, channel.operation].every(
            (value) => typeof value === 'string',
          ),
      )
    )
      throw new Error('Artemis raster sampler and blend require explicit owners');
  }
  creationMode(): number {
    return this.services.creationMode();
  }
  clearLayerCommands(ids: readonly string[]): void {
    this.services.clearLayerCommands(ids);
  }
  resetLayerCommands(id: string): void {
    this.services.resetLayerCommands(id);
  }
  recordLayerProperties(tag: AsbTag): void {
    this.services.recordLayerProperties(tag);
  }
  imageLoadFailed(tag: AsbTag): void {
    this.services.imageLoadFailed(tag);
  }
  layerNotFound(tag: AsbTag): void {
    this.services.layerNotFound(tag);
  }
  createImageLayer(
    resource: ArtemisLoadedImage,
    anchor: {readonly x: number; readonly y: number},
  ): ArtemisImageActor {
    const display = new ArtemisDisplayObject(this.hash);
    display.apply({anchorx: anchor.x, anchory: anchor.y});
    const image = resource.image;
    if (
      ![image.width, image.height].every((n) => Number.isInteger(n) && n >= 0) ||
      image.pixels.byteLength !== image.width * image.height * 4
    )
      throw new Error('Invalid Artemis raster image');
    let texture = this.images.get(image);
    if (texture && texture.managed !== (resource.lease !== undefined))
      throw new Error('Artemis image cannot mix cached and unmanaged raster ownership');
    if (!texture) {
      this.target.prepareImage(image);
      texture = {
        id: this.nextTexture++,
        image,
        references: 0,
        managed: resource.lease !== undefined,
      };
      this.images.set(image, texture);
      this.textures.set(texture.id, texture);
    }
    texture.references++;
    const actor: ArtemisImageActor = {
      texture: texture.id,
      display,
      wrapper: {alpha: 1},
      raster: {layerMode: 'normal', negative: false, grayscale: false, colorMultiply: 0xffffff},
      clip: {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0},
    };
    this.wrappers.set(actor.wrapper, {references: 1, lease: resource.lease});
    this.actors.add(actor);
    return actor;
  }
  createGroupLayer(): ArtemisGroupActor {
    const actor: ArtemisGroupActor = {
      texture: null,
      raster: {layerMode: 'normal', negative: false, grayscale: false, colorMultiply: 0xffffff},
      clip: {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0},
      display: new ArtemisDisplayObject(this.hash),
      wrapper: {alpha: 1},
    };
    this.wrappers.set(actor.wrapper, {
      references: 1,
      lease: undefined,
      capture: {enabled: false, format: 2, revision: 0},
    });
    this.actors.add(actor);
    return actor;
  }
  private checkActor(actor: ArtemisDisplayActor): void {
    if (!this.actors.has(actor))
      throw new Error('Artemis image actor is not owned or was released');
  }
  private check(actor: ArtemisImageActor): Texture {
    if (!this.actors.has(actor))
      throw new Error('Artemis image actor is not owned or was released');
    return this.textures.get(actor.texture)!;
  }
  copyImageLayer(old: ArtemisImageActor): ArtemisImageActor;
  copyImageLayer(old: ArtemisGroupActor): ArtemisGroupActor;
  copyImageLayer(old: ArtemisDisplayActor): ArtemisDisplayActor;
  copyImageLayer(old: ArtemisDisplayActor): ArtemisDisplayActor {
    this.checkActor(old);
    const actor: ArtemisDisplayActor = {
      ...old,
      display: old.display.copy(),
      raster: {...old.raster},
    };
    if (old.texture !== null) this.check(old).references++;
    this.wrappers.get(actor.wrapper)!.references++;
    this.actors.add(actor);
    return actor;
  }
  applyImageProperties(
    _id: string,
    actor: ArtemisDisplayActor,
    patch: ArtemisLayerPropertyPatch,
  ): void {
    this.checkActor(actor);
    const capture = this.wrappers.get(actor.wrapper)!.capture;
    const intermediate = patch.intermediateRender;
    if (
      intermediate &&
      (typeof intermediate.enabled !== 'boolean' ||
        (intermediate.format !== undefined &&
          intermediate.format !== 1 &&
          intermediate.format !== 2))
    )
      throw new Error('Invalid Artemis intermediate render mode');
    if (capture && intermediate?.enabled) {
      if (!this.target.prepareRenderSurface)
        throw new Error('Artemis intermediate groups require a GPU surface owner');
      if ((intermediate.format ?? capture.format) === 2 && !this.raster.captured)
        throw new Error('Artemis intermediate groups require a captured raster policy owner');
    }
    if (
      patch.clip &&
      !clipKeys.every(
        (key) => Number.isFinite(patch.clip![key]) && Number.isFinite(f(patch.clip![key])),
      )
    )
      throw new Error('Invalid Artemis image clip rectangle');
    const clip: ArtemisImageClip | undefined = patch.clip && {
      left: f(patch.clip.left),
      top: f(patch.clip.top),
      width: f(patch.clip.width),
      height: f(patch.clip.height),
      right: f(patch.clip.right),
      bottom: f(patch.clip.bottom),
    };
    if (
      ![patch.negative, patch.grayscale].every(
        (value) => value === undefined || typeof value === 'boolean',
      )
    )
      throw new Error('Invalid Artemis image effect flag');
    if (
      patch.colormultiply !== undefined &&
      (!Number.isInteger(patch.colormultiply) ||
        patch.colormultiply < 0 ||
        patch.colormultiply > 0xffffffff)
    )
      throw new Error('Invalid Artemis image color multiply');
    if (
      (patch.negative ||
        patch.grayscale ||
        (patch.colormultiply !== undefined && patch.colormultiply !== 0xffffff)) &&
      !this.raster.effects
    )
      throw new Error('Artemis image effects require a raster policy owner');
    if (patch.layermode !== undefined && patch.layermode !== 'normal' && !this.raster.layerMode)
      throw new Error('Artemis layer mode requires a raster policy owner');
    actor.display.apply(patch);
    // Native 0a45d0 compares endpoints only, then copies all six rectangle fields.
    // In particular, an initial 0,0,1,1 has the default zero endpoints and is ignored.
    if (
      clip &&
      ['left', 'top', 'right', 'bottom'].some(
        (key) => clip[key as keyof ArtemisImageClip] !== actor.clip[key as keyof ArtemisImageClip],
      )
    )
      Object.assign(actor, {clip});
    if (patch.layermode !== undefined) actor.raster.layerMode = patch.layermode;
    // Raster state is immutable by contract to callers; only this owner updates it.
    Object.assign(actor.raster, {
      negative: patch.negative ?? actor.raster.negative,
      grayscale: patch.grayscale ?? actor.raster.grayscale,
      colorMultiply: patch.colormultiply ?? actor.raster.colorMultiply,
    });
    if (patch.wrapperAlpha !== undefined) actor.wrapper.alpha = patch.wrapperAlpha;
    this.changes.set(actor, this.nextChange++);
    if (capture && intermediate) {
      if (intermediate.format !== undefined && intermediate.format !== capture.format) {
        capture.format = intermediate.format;
        capture.revision++;
      }
      if (capture.enabled !== intermediate.enabled) {
        capture.enabled = intermediate.enabled;
        capture.revision++;
        if (!capture.enabled) this.releaseCapture(capture);
      }
    }
  }
  releaseImageLayer(actor: ArtemisDisplayActor): void {
    this.checkActor(actor);
    const texture = actor.texture === null ? undefined : this.check(actor);
    this.actors.delete(actor);
    if (texture && --texture.references === 0) {
      this.textures.delete(texture.id);
      this.images.delete(texture.image);
      if (!texture.managed) this.target.invalidate(texture.image);
    }
    const wrapper = this.wrappers.get(actor.wrapper)!;
    if (--wrapper.references === 0) {
      this.wrappers.delete(actor.wrapper);
      if (wrapper.capture) this.releaseCapture(wrapper.capture);
      wrapper.lease?.release();
    }
  }
  image(id: number): TriangleImage {
    const texture = this.textures.get(id);
    if (!texture) throw new Error('Artemis image texture was released');
    return texture.image;
  }
  releaseGroupResources(actor: ArtemisDisplayActor): void {
    this.checkActor(actor);
    const capture = this.wrappers.get(actor.wrapper)!.capture;
    if (capture) this.releaseCapture(capture);
  }
  private releaseCapture(capture: GroupCapture): void {
    const storage = capture.storage;
    if (!storage) return;
    for (const texture of [storage.back, storage.fore])
      if (texture) {
        this.target.invalidate(texture.image);
        this.textures.delete(texture.id);
      }
    capture.storage = undefined;
  }
  private captureTexture(width: number, height: number): CaptureTexture {
    if (!this.target.prepareRenderSurface)
      throw new Error('Artemis intermediate GPU surface owner missing');
    const image = new GpuRenderSurface(width, height);
    this.target.prepareRenderSurface(image);
    const id = this.nextTexture++;
    this.textures.set(id, {id, image, references: 0, managed: true});
    return {id, image};
  }
  private nodes(scene: ArtemisScene<ArtemisDisplayActor>): RenderNode[] {
    const roots: RenderNode[] = [],
      groups = new Map<string, RenderNode>();
    for (const entry of scene.prepareEntries('retained')) {
      const node: RenderNode = {
        id: entry.id,
        actor: entry.value,
        group: entry.acceptsChildren,
        children: [],
      };
      const separator = entry.id.lastIndexOf('.');
      const children = separator < 0 ? roots : groups.get(entry.id.slice(0, separator))?.children;
      if (!children) throw new Error('Artemis scene traversal lost its parent group');
      children.push(node);
      if (node.group) groups.set(node.id, node);
    }
    return roots;
  }
  /** Bounds callbacks ignore visibility and opacity, use local (uncached) matrices,
   * include pixel centers at width/height minus one, and start with zero endpoints. */
  private bounds(nodes: readonly RenderNode[]): ArtemisImageClip {
    const rect = {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0};
    const add = (x: number, y: number) => {
      if (x < rect.left) {
        rect.left = x;
        rect.width = f(f(rect.right - x) + 1);
      }
      if (rect.right < x) {
        rect.right = x;
        rect.width = f(f(x - rect.left) + 1);
      }
      if (y < rect.top) {
        rect.top = y;
        rect.height = f(f(rect.bottom - y) + 1);
      }
      if (rect.bottom < y) {
        rect.bottom = y;
        rect.height = f(f(y - rect.top) + 1);
      }
    };
    const visit = (children: readonly RenderNode[], parent: Float32Array) => {
      for (const node of children) {
        const actor = node.actor;
        if (actor) this.checkActor(actor);
        if (node.group) {
          if (actor && actor.texture !== null)
            throw new Error('Unsupported Artemis group raster owner');
          visit(node.children, actor ? actor.display.matrix(parent, this.raster.trig) : parent);
          continue;
        }
        if (!actor || actor.texture === null) continue;
        const texture = this.check(actor),
          width = actor.clip.width !== 0 ? actor.clip.width : f(texture.image.width),
          height = actor.clip.height !== 0 ? actor.clip.height : f(texture.image.height);
        if (width === 0 || height === 0) continue;
        const matrix = actor.display.matrix(parent, this.raster.trig),
          w = f(width - 1),
          h = f(height - 1);
        for (const [x, y] of [
          [0, 0],
          [w, 0],
          [w, h],
          [0, h],
        ]) {
          const point = artemisDisplayPoint(matrix, x!, y!);
          add(point[0], point[1]);
        }
      }
    };
    visit(nodes, new Float32Array([1, 0, 0, 0, 1, 0]));
    return rect;
  }
  private fingerprint(node: RenderNode, capture: GroupCapture): unknown[] {
    const signature: unknown[] = [node.actor?.clip, capture.revision];
    const visit = (nodes: readonly RenderNode[]) => {
      for (const child of nodes) {
        signature.push(
          child.id,
          child.actor,
          child.actor?.display.propertyRevision,
          child.actor ? this.changes.get(child.actor) : undefined,
        );
        if (child.actor?.texture === null)
          signature.push(this.wrappers.get(child.actor.wrapper)?.capture?.revision);
        visit(child.children);
      }
    };
    visit(node.children);
    return signature;
  }
  /** Retained GPU preparation in ascending native child order. */
  drawCommitted(scene: ArtemisScene<ArtemisDisplayActor>): DrawList {
    const commands: DrawCommand[] = [],
      updates: (() => void)[] = [];
    const clear = (context: RenderContext) => {
      if (context.pendingClear) {
        commands.push({kind: 'gpu-target', surface: context.surface, clearColor: [0, 0, 0, 0]});
        context.pendingClear = false;
      }
    };
    const quad = (
      texture: number,
      matrix: Float32Array,
      alpha: number,
      raster: ArtemisImageActor['raster'],
      clip: ArtemisImageClip,
      context: RenderContext,
    ) => {
      const image = this.image(texture),
        imageWidth = f(image.width),
        imageHeight = f(image.height);
      clear(context); // Native clears lazily before source clip rejection.
      let width = imageWidth,
        height = imageHeight,
        sourceLeft = 0,
        sourceTop = 0;
      if (clip.width > 0 && clip.height > 0) {
        if (clip.left >= imageWidth || clip.top >= imageHeight || clip.right < 0 || clip.bottom < 0)
          return;
        sourceLeft = Math.max(0, clip.left);
        sourceTop = Math.max(0, clip.top);
        width = f((clip.right < imageWidth ? f(clip.right + 1) : imageWidth) - sourceLeft);
        height = f((clip.bottom < imageHeight ? f(clip.bottom + 1) : imageHeight) - sourceTop);
      }
      const mode =
        context.format === 2
          ? this.raster.captured?.(raster.layerMode, raster)
          : artemisHasRasterEffects(raster)
            ? this.raster.effects?.(raster.layerMode, raster)
            : this.raster.layerMode?.(raster.layerMode);
      if (context.format === 2 && !mode)
        throw new Error('Artemis captured raster policy owner missing');
      if (context.format !== 2 && artemisHasRasterEffects(raster) && !mode)
        throw new Error('Artemis image effects require a raster policy owner');
      const vertices = new Float32Array(36),
        backgroundUV = new Float32Array(8),
        color = raster.colorMultiply,
        tint = [
          f(((color >>> 16) & 255) / 255),
          f(((color >>> 8) & 255) / 255),
          f((color & 255) / 255),
        ];
      const corners = [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ] as const;
      for (const [index, [x, y]] of corners.entries()) {
        const point = artemisDisplayPoint(matrix, x, y);
        vertices.set(
          [
            f(f(point[0] / f(f(context.width) * 0.5)) - 1),
            f(1 - f(point[1] / f(f(context.height) * 0.5))),
            0,
            ...tint,
            alpha,
            f(f(x + sourceLeft) / imageWidth),
            f(f(y + sourceTop) / imageHeight),
          ],
          index * 9,
        );
        backgroundUV.set(
          [f(point[0] / f(context.width)), f(point[1] / f(context.height))],
          index * 2,
        );
      }
      if (context.format === 2)
        commands.push({
          kind: 'gpu-copy',
          source: context.surface!,
          destination: context.back!.image,
        });
      commands.push({
        kind: 'triangles',
        texture,
        vertices,
        topology: 'triangle-strip',
        normalizedUV: true,
        transform: identity.slice(),
        depthClip: false,
        filter: this.raster.filter,
        blendState: mode?.blend ?? this.raster.blend,
        fragment: mode?.fragment,
        additionalTextures:
          context.format === 2
            ? [{texture: context.back!.id, uv: backgroundUV, filter: this.raster.filter}]
            : undefined,
        discardTransparent: this.raster.discardTransparent,
      });
    };
    const visit = (
      nodes: readonly RenderNode[],
      parent: Float32Array,
      parentAlpha: number,
      context: RenderContext,
    ) => {
      for (const node of nodes) {
        const actor = node.actor;
        if (!actor) {
          if (node.group) visit(node.children, parent, parentAlpha, context);
          continue;
        }
        this.checkActor(actor);
        if (node.group !== (actor.texture === null))
          throw new Error('Unsupported Artemis group raster owner');
        const p = actor.display.properties;
        if (p.xscale <= 0 || p.yscale <= 0) continue;
        const matrix = actor.display.worldMatrix(parent, this.raster.trig),
          alpha = f(parentAlpha * p.alpha);
        if (!p.visible || alpha < 2 ** -23) continue;
        if (actor.texture !== null) {
          const image = this.check(actor).image;
          if (image.width > 0 && image.height > 0)
            quad(actor.texture, matrix, alpha, actor.raster, actor.clip, context);
          continue;
        }
        const capture = this.wrappers.get(actor.wrapper)!.capture!;
        if (!capture.enabled) {
          visit(node.children, matrix, alpha, context);
          continue;
        }
        const signature = this.fingerprint(node, capture),
          previous = capture.storage?.signature,
          changed =
            !previous ||
            previous.length !== signature.length ||
            signature.some((value, index) => value !== previous[index]);
        let storage = capture.storage,
          plan = storage?.plan;
        if (changed) {
          plan =
            actor.clip.width > 0 && actor.clip.height > 0 ? actor.clip : this.bounds(node.children);
          const width = Math.ceil(plan.width),
            height = Math.ceil(plan.height);
          if (![width, height].every((n) => Number.isSafeInteger(n) && n <= 0x7fffffff))
            throw new Error('Unsupported Artemis intermediate surface size');
          if (!storage || storage.fore.image.width < width || storage.fore.image.height < height) {
            if (width <= 0 || height <= 0) continue; // Native cannot allocate an empty capture.
            const fore = this.captureTexture(width, height);
            let back: CaptureTexture | undefined;
            try {
              if (capture.format === 2) back = this.captureTexture(width, height);
            } catch (error) {
              this.target.invalidate(fore.image);
              this.textures.delete(fore.id);
              throw error;
            }
            this.releaseCapture(capture);
            storage = {
              fore,
              back,
              format: capture.format,
              display: new ArtemisDisplayObject(this.hash),
            };
            capture.storage = storage;
          }
          const local = new Float32Array([1, 0, f(-plan.left), 0, 1, f(-plan.top)]),
            childContext: RenderContext = {
              surface: storage.fore.image,
              width: storage.fore.image.width,
              height: storage.fore.image.height,
              format: storage.format,
              back: storage.back,
              pendingClear: true,
            };
          commands.push({kind: 'gpu-target', surface: storage.fore.image});
          visit(node.children, local, 1, childContext);
          commands.push({kind: 'gpu-target', surface: context.surface});
          const completed = storage,
            completedPlan = plan;
          updates.push(() => {
            completed.signature = signature;
            completed.plan = completedPlan;
          });
        }
        if (!storage || !plan) continue;
        const explicit = actor.clip.width > 0 && actor.clip.height > 0,
          sourceClip: ArtemisImageClip = explicit
            ? {
                left: 0,
                top: 0,
                width: plan.width,
                height: plan.height,
                right: f(plan.width - 1),
                bottom: f(plan.height - 1),
              }
            : {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0};
        storage.display.apply({left: explicit ? 0 : plan.left, top: explicit ? 0 : plan.top});
        quad(
          storage.fore.id,
          storage.display.worldMatrix(matrix, this.raster.trig),
          alpha,
          actor.raster,
          sourceClip,
          context,
        );
      }
    };
    visit(this.nodes(scene), new Float32Array([1, 0, 0, 0, 1, 0]), 1, {
      surface: null,
      width: this.target.width,
      height: this.target.height,
      pendingClear: false,
    });
    const list: DrawList = {sprites: [], commands, clearColor: this.raster.clearColor};
    this.target.draw(list, (id) => this.image(id));
    for (const update of updates) update();
    return list;
  }
}
