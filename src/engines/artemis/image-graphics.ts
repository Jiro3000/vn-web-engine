import type {DrawList, DrawListTarget} from '../../graphics/draw-list.js';
import type {TriangleDraw, TriangleImage} from '../../graphics/triangle-draw.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisLayerHost} from './layers.js';
import type {ArtemisLayerPropertyPatch, ArtemisLayerMode} from './layer-properties.js';
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
}
export type ArtemisLayerServices = Pick<
  ArtemisLayerHost<ArtemisImageActor>,
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
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const f = Math.fround;

/** Ordinary unclipped straight-RGBA image actors through the shared raster target.
 * Sampler/blend selection, command services and nonzero-rotation math require owners.
 */
export class ArtemisImageGraphics implements ArtemisLayerHost<ArtemisImageActor> {
  private readonly hash: string;
  private nextTexture = 1;
  private readonly textures = new Map<number, Texture>();
  private readonly images = new Map<TriangleImage, Texture>();
  private readonly actors = new Set<ArtemisImageActor>();
  private readonly wrappers = new Map<
    ArtemisImageActor['wrapper'],
    {
      references: number;
      lease: ArtemisLoadedImage['lease'];
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
    };
    this.wrappers.set(actor.wrapper, {references: 1, lease: resource.lease});
    this.actors.add(actor);
    return actor;
  }
  private check(actor: ArtemisImageActor): Texture {
    if (!this.actors.has(actor))
      throw new Error('Artemis image actor is not owned or was released');
    return this.textures.get(actor.texture)!;
  }
  copyImageLayer(old: ArtemisImageActor): ArtemisImageActor {
    const texture = this.check(old);
    const actor = {...old, display: old.display.copy(), raster: {...old.raster}};
    texture.references++;
    this.wrappers.get(actor.wrapper)!.references++;
    this.actors.add(actor);
    return actor;
  }
  applyImageProperties(
    _id: string,
    actor: ArtemisImageActor,
    patch: ArtemisLayerPropertyPatch,
  ): void {
    this.check(actor);
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
    if (patch.layermode !== undefined) actor.raster.layerMode = patch.layermode;
    // Raster state is immutable by contract to callers; only this owner updates it.
    Object.assign(actor.raster, {
      negative: patch.negative ?? actor.raster.negative,
      grayscale: patch.grayscale ?? actor.raster.grayscale,
      colorMultiply: patch.colormultiply ?? actor.raster.colorMultiply,
    });
    if (patch.wrapperAlpha !== undefined) actor.wrapper.alpha = patch.wrapperAlpha;
  }
  releaseImageLayer(actor: ArtemisImageActor): void {
    const texture = this.check(actor);
    this.actors.delete(actor);
    if (--texture.references === 0) {
      this.textures.delete(texture.id);
      this.images.delete(texture.image);
      if (!texture.managed) this.target.invalidate(texture.image);
    }
    const wrapper = this.wrappers.get(actor.wrapper)!;
    if (--wrapper.references === 0) {
      this.wrappers.delete(actor.wrapper);
      wrapper.lease?.release();
    }
  }
  image(id: number): TriangleImage {
    const texture = this.textures.get(id);
    if (!texture) throw new Error('Artemis image texture was released');
    return texture.image;
  }
  /** Emit retained ordinary scene actors; the stage owner decides presentation/commit timing. */
  drawCommitted(scene: ArtemisScene<ArtemisImageActor>): DrawList {
    const commands: TriangleDraw[] = [];
    for (const entry of scene.drawEntries('retained')) {
      const actor = entry.value;
      if (!actor) continue;
      if (entry.acceptsChildren) throw new Error('Unsupported Artemis group raster owner');
      const texture = this.check(actor),
        p = actor.display.properties;
      if (
        !p.visible ||
        p.xscale <= 0 ||
        p.yscale <= 0 ||
        p.alpha < 2 ** -23 ||
        texture.image.width === 0 ||
        texture.image.height === 0
      )
        continue;
      const matrix = actor.display.matrix(undefined, this.raster.trig);
      const hasEffects = artemisHasRasterEffects(actor.raster);
      if (hasEffects && !this.raster.effects)
        throw new Error('Artemis image effects require a raster policy owner');
      const mode = hasEffects
        ? this.raster.effects!(actor.raster.layerMode, actor.raster)
        : this.raster.layerMode?.(actor.raster.layerMode);
      const width = f(texture.image.width),
        height = f(texture.image.height);
      const vertices = new Float32Array(36);
      const color = actor.raster.colorMultiply;
      const tint = [
        f(((color >>> 16) & 255) / 255),
        f(((color >>> 8) & 255) / 255),
        f((color & 255) / 255),
      ];
      const corners: readonly (readonly [number, number])[] = [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ];
      for (const [index, [x, y]] of corners.entries()) {
        const point = artemisDisplayPoint(matrix, x, y);
        const clipX = f(f(point[0] / f(f(this.target.width) * 0.5)) - 1);
        const clipY = f(1 - f(point[1] / f(f(this.target.height) * 0.5)));
        vertices.set([clipX, clipY, 0, ...tint, p.alpha, f(x / width), f(y / height)], index * 9);
      }
      commands.push({
        kind: 'triangles',
        texture: texture.id,
        vertices,
        topology: 'triangle-strip',
        normalizedUV: true,
        transform: identity.slice(),
        depthClip: false,
        filter: this.raster.filter,
        blendState: mode?.blend ?? this.raster.blend,
        fragment: mode?.fragment,
        discardTransparent: this.raster.discardTransparent,
      });
    }
    const list: DrawList = {sprites: [], commands, clearColor: this.raster.clearColor};
    this.target.draw(list, (id) => this.image(id));
    return list;
  }
}
