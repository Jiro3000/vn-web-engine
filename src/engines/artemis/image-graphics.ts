import type {DrawList, DrawListTarget} from '../../graphics/draw-list.js';
import type {TriangleDraw, TriangleImage} from '../../graphics/triangle-draw.js';
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
/** CLayerSet's ordinary property holder, without an intermediate raster surface. */
export interface ArtemisGroupActor {
  readonly texture: null;
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
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const f = Math.fround;
const clipKeys = ['left', 'top', 'width', 'height', 'right', 'bottom'] as const;

/** Ordinary straight-RGBA images and direct group transforms through the shared raster target.
 * Intermediate groups, sampler/blend selection and nonzero-rotation math require owners.
 */
export class ArtemisImageGraphics implements ArtemisLayerHost<ArtemisDisplayActor> {
  private readonly hash: string;
  private nextTexture = 1;
  private readonly textures = new Map<number, Texture>();
  private readonly images = new Map<TriangleImage, Texture>();
  private readonly actors = new Set<ArtemisDisplayActor>();
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
      clip: {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0},
    };
    this.wrappers.set(actor.wrapper, {references: 1, lease: resource.lease});
    this.actors.add(actor);
    return actor;
  }
  createGroupLayer(): ArtemisGroupActor {
    const actor: ArtemisGroupActor = {
      texture: null,
      display: new ArtemisDisplayObject(this.hash),
      wrapper: {alpha: 1},
    };
    this.wrappers.set(actor.wrapper, {references: 1, lease: undefined});
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
    const actor: ArtemisDisplayActor =
      old.texture === null
        ? {...old, display: old.display.copy()}
        : {...old, display: old.display.copy(), raster: {...old.raster}};
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
    if (actor.texture === null) {
      if (
        ['clip', 'layermode', 'negative', 'grayscale', 'colormultiply'].some(
          (key) => patch[key as keyof ArtemisLayerPropertyPatch] !== undefined,
        )
      )
        throw new Error('Unsupported Artemis intermediate group raster property');
      actor.display.apply(patch);
      if (patch.wrapperAlpha !== undefined) actor.wrapper.alpha = patch.wrapperAlpha;
      return;
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
      wrapper.lease?.release();
    }
  }
  image(id: number): TriangleImage {
    const texture = this.textures.get(id);
    if (!texture) throw new Error('Artemis image texture was released');
    return texture.image;
  }
  /** Emit retained ordinary scene actors; the stage owner decides presentation/commit timing. */
  drawCommitted(scene: ArtemisScene<ArtemisDisplayActor>): DrawList {
    const commands: TriangleDraw[] = [];
    const root: {matrix: Float32Array; alpha: number; visible: boolean} = {
      matrix: new Float32Array([1, 0, 0, 0, 1, 0]),
      alpha: 1,
      visible: true,
    };
    const groups = new Map<string, typeof root>();
    for (const entry of scene.prepareEntries('retained')) {
      const actor = entry.value;
      const separator = entry.id.lastIndexOf('.');
      const parent = separator < 0 ? root : groups.get(entry.id.slice(0, separator))!;
      if (!parent) throw new Error('Artemis scene traversal lost its parent group');
      if (entry.acceptsChildren) {
        if (actor && actor.texture !== null)
          throw new Error('Unsupported Artemis group raster owner');
        if (actor) this.checkActor(actor);
        const p = actor?.display.properties;
        const scales = !p || (p.xscale > 0 && p.yscale > 0);
        // Native updates the holder's matrix before its own visibility/alpha gate.
        const matrix =
          actor && parent.visible && scales
            ? actor.display.worldMatrix(parent.matrix, this.raster.trig)
            : parent.matrix;
        const alpha = p ? f(parent.alpha * p.alpha) : parent.alpha;
        const visible =
          parent.visible &&
          (!p || (p.visible && p.xscale > 0 && p.yscale > 0 && alpha >= 2 ** -23));
        groups.set(entry.id, {
          matrix,
          alpha,
          visible,
        });
        continue;
      }
      if (!actor) continue;
      if (actor.texture === null) throw new Error('Artemis group actor cannot own an image leaf');
      const texture = this.check(actor),
        p = actor.display.properties,
        alpha = f(parent.alpha * p.alpha);
      if (!parent.visible || p.xscale <= 0 || p.yscale <= 0) continue;
      const matrix = actor.display.worldMatrix(parent.matrix, this.raster.trig);
      if (!p.visible || alpha < 2 ** -23 || texture.image.width === 0 || texture.image.height === 0)
        continue;
      const hasEffects = artemisHasRasterEffects(actor.raster);
      if (hasEffects && !this.raster.effects)
        throw new Error('Artemis image effects require a raster policy owner');
      const mode = hasEffects
        ? this.raster.effects!(actor.raster.layerMode, actor.raster)
        : this.raster.layerMode?.(actor.raster.layerMode);
      const imageWidth = f(texture.image.width),
        imageHeight = f(texture.image.height);
      let width = imageWidth,
        height = imageHeight,
        sourceLeft = 0,
        sourceTop = 0;
      const clip = actor.clip;
      // 15d120 crops source UVs but rebases the resulting local quad to 0,0.
      // Nonpositive dimensions disable clipping rather than making an empty quad.
      if (clip.width > 0 && clip.height > 0) {
        if (clip.left >= imageWidth || clip.top >= imageHeight || clip.right < 0 || clip.bottom < 0)
          continue;
        sourceLeft = Math.max(0, clip.left);
        sourceTop = Math.max(0, clip.top);
        width = f((clip.right < imageWidth ? f(clip.right + 1) : imageWidth) - sourceLeft);
        height = f((clip.bottom < imageHeight ? f(clip.bottom + 1) : imageHeight) - sourceTop);
      }
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
        vertices.set(
          [
            clipX,
            clipY,
            0,
            ...tint,
            alpha,
            f(f(x + sourceLeft) / imageWidth),
            f(f(y + sourceTop) / imageHeight),
          ],
          index * 9,
        );
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
