import {artemisLayerExtent, type ArtemisLayerInfo} from './layer-info.js';
import {
  ArtemisShaderProperties,
  ArtemisShaderConstantStorage,
  type ArtemisShaderPropertyPatch,
  type ArtemisShaderTextureLease,
} from './shader-properties.js';
import type {ArtemisDrawShaderResource} from './draw-shader.js';
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
import type {ArtemisScene, ArtemisSceneView} from './scene.js';
import type {ArtemisAnimationFrames} from './animation-layer.js';
import {ArtemisDisplayObject, artemisDisplayPoint} from './display-object.js';
import {artemisRevision} from './revision.js';
import type {ArtemisTheoraThreadOpener, ArtemisTheoraVideo} from './video.js';
import type {ArtemisStagePresentation} from './layer-owner.js';
import {
  artemisHasRasterEffects,
  type ArtemisRasterPolicy,
  type ArtemisRasterEffects,
} from './gpu-raster.js';

export interface ArtemisImageActor {
  readonly texture: number;
  readonly shaderState: ArtemisShaderProperties<object>;
  readonly shaderConstants: ArtemisShaderConstantStorage;
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
  readonly shaderState: ArtemisShaderProperties<object>;
  readonly shaderConstants: ArtemisShaderConstantStorage;
  readonly display: ArtemisDisplayObject;
  readonly wrapper: {alpha: number};
}
/** CAnimationLayer: its own CLayer geometry, drawing only the current frame actor as a
 * child (draw passes 0x1400b1240/0x1400b12a0). Its texture, clip and raster state are
 * stored by 115650 but never drawn. */
export interface ArtemisAnimationActor extends Omit<ArtemisGroupActor, 'texture'> {
  readonly texture: null;
  readonly animation: ArtemisAnimationFrames<ArtemisDisplayActor>;
}
/** One painted glyph of a text layer: its image, its layer-local 2x3 matrix (row-major
 * `[a, b, tx, c, d, ty]`) and opacity. */
export interface ArtemisTextSprite {
  readonly image: TriangleImage;
  readonly matrix: Float32Array;
  readonly alpha: number;
}
/** One character of a text layer for browser text: its layer-local 2x3 cell matrix, whose
 * origin is the pen position at the top of the character's em box, and the font it was
 * inserted with. Characters without ink (spaces) are cells too. */
export interface ArtemisTextCell {
  readonly text: string;
  readonly matrix: Float32Array;
  readonly advance: number;
  /** Em size in pixels. */
  readonly size: number;
  /** The font file; null for a face no provider opens. */
  readonly face: string | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly color: number;
  readonly alpha: number;
  readonly shadow: number;
  readonly shadowcolor: number;
  readonly outline: number;
  readonly outlinecolor: number;
  readonly ruby: boolean;
  /** Display line and block (word) of the character, counted in the layer. */
  readonly line: number;
  readonly block: number;
}
/** An image layer drawn over text: its stage matrix, opacity, texture and drawn source
 * rect. */
export interface ArtemisTextCover {
  readonly id: string;
  readonly matrix: Float32Array;
  readonly alpha: number;
  readonly texture: number;
  readonly image: TriangleImage;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
/** The share of text at stage point (x, y) that stays visible under `covers`: each covering
 * image multiplies it by one minus its opacity there. Images without CPU pixels (video
 * frames) are opaque within their rect. */
export function artemisTextVisibility(
  covers: readonly ArtemisTextCover[],
  x: number,
  y: number,
): number {
  let visible = 1;
  for (const cover of covers) {
    const [a, b, tx, c, d, ty] = cover.matrix as unknown as number[];
    const determinant = a! * d! - b! * c!;
    if (determinant === 0) continue;
    const dx = x - tx!,
      dy = y - ty!,
      u = (d! * dx - b! * dy) / determinant,
      v = (a! * dy - c! * dx) / determinant;
    if (!(u >= 0 && v >= 0 && u < cover.width && v < cover.height)) continue;
    const image = cover.image,
      px = Math.floor(u + cover.left),
      py = Math.floor(v + cover.top),
      count = image.width * image.height;
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
    const bytes = count ? image.pixels.length / count : 0;
    const alpha =
      bytes === 4
        ? image.pixels[(py * image.width + px) * 4 + 3]! / 255
        : bytes === 1
          ? image.pixels[py * image.width + px]! / 255
          : 1;
    visible *= 1 - alpha * cover.alpha;
    if (visible <= 0) return 0;
  }
  return visible;
}
/** A visible text layer in drawing order: its stage matrix, its opacity, the stage rect
 * that clips it, if any, and the image layers drawn over it. */
export interface ArtemisTextLayer {
  readonly id: string;
  readonly text: ArtemisTextSource;
  readonly matrix: Float32Array;
  readonly alpha: number;
  readonly covers: readonly ArtemisTextCover[];
  readonly clip: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
}
/** The text of a message layer (CLinkableTextLayer) as glyph sprites. `revision` changes
 * whenever the sprites would. Actor copies share the source and each holds a loan. */
export interface ArtemisTextSource {
  readonly revision: number;
  sprites(): readonly ArtemisTextSprite[];
  /** The characters the sprites show, for browser text. */
  cells?(): readonly ArtemisTextCell[];
  retain(): void;
  release(): void;
}
/** A message-layer actor: CLayer geometry whose content is its text. */
export interface ArtemisTextActor extends Omit<ArtemisGroupActor, 'texture'> {
  readonly texture: null;
  readonly text: ArtemisTextSource;
}
export interface ArtemisImageShaderPrograms {
  bind(id: string): {shader: ArtemisDrawShaderResource; release(): void} | null;
}
export type ArtemisDisplayActor =
  ArtemisImageActor | ArtemisGroupActor | ArtemisAnimationActor | ArtemisTextActor;
function isAnimation(actor: ArtemisDisplayActor): actor is ArtemisAnimationActor {
  return 'animation' in actor;
}
function isText(actor: ArtemisDisplayActor): actor is ArtemisTextActor {
  return 'text' in actor;
}
/** `outer` after `inner` for row-major 2x3 matrices. */
function compose(outer: Float32Array, inner: Float32Array): Float32Array {
  const [a, b, c, d, e, g] = outer as unknown as number[];
  const [p, q, r, s, t, u] = inner as unknown as number[];
  return new Float32Array([
    f(f(a! * p!) + f(b! * s!)),
    f(f(a! * q!) + f(b! * t!)),
    f(f(f(a! * r!) + f(b! * u!)) + c!),
    f(f(d! * p!) + f(e! * s!)),
    f(f(d! * q!) + f(e! * t!)),
    f(f(f(d! * r!) + f(e! * u!)) + g!),
  ]);
}
export type ArtemisLayerServices = Pick<
  ArtemisLayerHost<ArtemisDisplayActor>,
  | 'creationMode'
  | 'clearLayerCommands'
  | 'resetLayerCommands'
  | 'recordLayerProperties'
  | 'imageLoadFailed'
  | 'animationError'
  | 'appendLayerCommand'
  | 'layerNotFound'
  | 'readVideoFile'
  | 'videoError'
  | 'videoThreads'
>;
interface Texture {
  readonly id: number;
  readonly image: TriangleImage;
  references: number;
  readonly managed: boolean;
  /** Video actor decoder; `uploaded` is the decoder revision held by the GPU texture. */
  readonly video?: {readonly decoder: ArtemisTheoraVideo; uploaded: number; updated: boolean};
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
  private readonly shaderTextureResources = new WeakSet<object>();
  /** Glyph images drawn by text actors, with the draw that last used them. */
  private readonly glyphTextures = new Map<TriangleImage, {id: number; draw: number}>();
  private draws = 0;
  /** Stage surfaces: the frame being drawn and the frame a transition starts from. */
  private stage: {
    current: CaptureTexture;
    previous: CaptureTexture;
    drawn: boolean;
    state: number;
    rule?: {texture: number; image: TriangleImage; revision: number};
  } | null = null;
  /** Engine screenshot surface +0x1c0 at stage size, null until `takeScreenshot`. */
  private screenshot: CaptureTexture | null = null;
  private nativeSlotOne: Float32Array | null = null;
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
    private readonly shaderPrograms?: ArtemisImageShaderPrograms,
    /** timeGetTime after timeBeginPeriod(1); required only to draw animation layers. */
    private readonly clock?: {now(): number},
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
  resetLayerCommands(id: string, tag: AsbTag): void {
    this.services.resetLayerCommands(id, tag);
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
  animationError(tag: AsbTag, error: 'not-found' | 'mode'): void {
    if (!this.services.animationError) throw Error('Unsupported Artemis animation error owner');
    this.services.animationError(tag, error);
  }
  get videoThreads(): ArtemisTheoraThreadOpener | undefined {
    return this.services.videoThreads;
  }
  readVideoFile(path: string): Promise<Uint8Array | null> {
    if (!this.services.readVideoFile) throw Error('Unsupported Artemis video file owner');
    return this.services.readVideoFile(path);
  }
  videoError(tag: AsbTag, error: 'not-found' | 'unsupported'): void {
    if (!this.services.videoError) throw Error('Unsupported Artemis video error owner');
    this.services.videoError(tag, error);
  }
  /** Video actor: an image actor whose texture is the decoder's RGBA surface. Copies share
   * the decoder; releasing the last reference closes it. */
  createVideoLayer(
    decoder: ArtemisTheoraVideo,
    anchor: {readonly x: number; readonly y: number},
  ): ArtemisImageActor {
    if (!this.clock) throw Error('Artemis video layers require a clock owner');
    const image: TriangleImage = {
      width: decoder.width,
      height: decoder.height,
      pixels: decoder.pixels,
    };
    this.target.prepareImage(image);
    const texture: Texture = {
      id: this.nextTexture++,
      image,
      references: 1,
      managed: false,
      video: {decoder, uploaded: decoder.revision, updated: false},
    };
    this.textures.set(texture.id, texture);
    const display = new ArtemisDisplayObject(this.hash);
    display.apply({anchorx: anchor.x, anchory: anchor.y});
    const actor: ArtemisImageActor = {
      texture: texture.id,
      display,
      shaderState: new ArtemisShaderProperties<object>(this.hash),
      shaderConstants: new ArtemisShaderConstantStorage(this.hash),
      wrapper: {alpha: 1},
      raster: {layerMode: 'normal', negative: false, grayscale: false, colorMultiply: 0xffffff},
      clip: {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0},
    };
    this.wrappers.set(actor.wrapper, {references: 1, lease: undefined});
    this.actors.add(actor);
    return actor;
  }
  /** The video decoder of a video actor, or undefined for any other actor. */
  videoOf(actor: ArtemisDisplayActor): ArtemisTheoraVideo | undefined {
    this.checkActor(actor);
    return actor.texture === null ? undefined : this.textures.get(actor.texture)!.video?.decoder;
  }
  /** `var system=get_layer_info` of a CLayer (image, color or video actor). Groups,
   * animation and text actors read other native getters and are refused. */
  layerInfo(actor: ArtemisDisplayActor): ArtemisLayerInfo {
    this.checkActor(actor);
    if (actor.texture === null || isText(actor))
      throw new Error('Unsupported Artemis layer info actor');
    const image = this.textures.get(actor.texture)!.image;
    const surface = {width: image.width, height: image.height};
    return {
      display: actor.display,
      ...artemisLayerExtent(surface, actor.clip),
      surface,
      clip: actor.clip,
      layerMode: actor.raster.layerMode,
      negative: actor.raster.negative,
      grayscale: actor.raster.grayscale,
      colorMultiply: actor.raster.colorMultiply,
      shader: actor.shaderState.shaderName,
      shaderConstants: actor.shaderState.constantValues(),
    };
  }
  appendLayerCommand(id: string, tag: AsbTag): void {
    if (!this.services.appendLayerCommand) throw Error('Unsupported Artemis layer command owner');
    this.services.appendLayerCommand(id, tag);
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
      shaderState: new ArtemisShaderProperties<object>(this.hash),
      shaderConstants: new ArtemisShaderConstantStorage(this.hash),
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
      shaderState: new ArtemisShaderProperties<object>(this.hash),
      shaderConstants: new ArtemisShaderConstantStorage(this.hash),
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
  createAnimationLayer(
    animation: ArtemisAnimationFrames<ArtemisDisplayActor>,
  ): ArtemisAnimationActor {
    const actor: ArtemisAnimationActor = {
      texture: null,
      animation,
      raster: {layerMode: 'normal', negative: false, grayscale: false, colorMultiply: 0xffffff},
      clip: {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0},
      display: new ArtemisDisplayObject(this.hash),
      shaderState: new ArtemisShaderProperties<object>(this.hash),
      shaderConstants: new ArtemisShaderConstantStorage(this.hash),
      wrapper: {alpha: 1},
    };
    this.wrappers.set(actor.wrapper, {references: 1, lease: undefined});
    this.actors.add(actor);
    return actor;
  }
  createTextLayer(text: ArtemisTextSource): ArtemisTextActor {
    const actor: ArtemisTextActor = {
      texture: null,
      text,
      raster: {layerMode: 'normal', negative: false, grayscale: false, colorMultiply: 0xffffff},
      clip: {left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0},
      display: new ArtemisDisplayObject(this.hash),
      shaderState: new ArtemisShaderProperties<object>(this.hash),
      shaderConstants: new ArtemisShaderConstantStorage(this.hash),
      wrapper: {alpha: 1},
    };
    text.retain();
    this.wrappers.set(actor.wrapper, {references: 1, lease: undefined});
    this.actors.add(actor);
    return actor;
  }
  animationFrames(
    actor: ArtemisDisplayActor,
  ): ArtemisAnimationFrames<ArtemisDisplayActor> | undefined {
    this.checkActor(actor);
    return isAnimation(actor) ? actor.animation : undefined;
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
      shaderState: old.shaderState.copy(),
      shaderConstants: old.shaderConstants.copy(),
      raster: {...old.raster},
      ...(isAnimation(old) ? {animation: old.animation.copy()} : {}),
    };
    if (isText(old)) old.text.retain();
    if (old.texture !== null) this.check(old).references++;
    this.wrappers.get(actor.wrapper)!.references++;
    this.actors.add(actor);
    return actor;
  }
  supportsShaderProperties(): boolean {
    return this.shaderPrograms !== undefined;
  }
  /** Resource lease transfers into an actual prepared texture, independently of scene nodes. */
  createShaderTexture(resource: ArtemisLoadedImage): ArtemisShaderTextureLease<object> {
    if (!this.shaderPrograms) throw Error('Unsupported Artemis shader program owner');
    const holder = this.createImageLayer(resource, {x: 0, y: 0});
    const texture = Object.freeze({texture: holder.texture});
    this.shaderTextureResources.add(texture);
    const lease = (actor: ArtemisImageActor): ArtemisShaderTextureLease<object> => {
      let live = true;
      return {
        resource: texture,
        retain: () => {
          if (!live) throw Error('Shader texture lease released');
          return lease(this.copyImageLayer(actor));
        },
        release: () => {
          if (live) {
            live = false;
            this.releaseImageLayer(actor);
          }
        },
      };
    };
    return lease(holder);
  }
  applyShaderProperties(
    actor: ArtemisDisplayActor,
    patch: ArtemisShaderPropertyPatch,
    textures?: readonly {name: string; lease: ArtemisShaderTextureLease<object>}[],
  ): void {
    this.checkActor(actor);
    if (!this.shaderPrograms) throw Error('Unsupported Artemis shader program owner');
    if (patch.textures !== undefined && textures === undefined)
      throw Error('Artemis shader textures require prepared resource leases');
    if (textures?.some((entry) => !this.shaderTextureResources.has(entry.lease.resource)))
      throw Error('Foreign Artemis shader texture resource');
    if (patch.shader !== undefined) actor.shaderState.setShader(patch.shader);
    if (patch.constants !== undefined) actor.shaderState.setConstants(patch.constants);
    if (textures !== undefined) actor.shaderState.setTextures(textures);
    this.changes.set(actor, this.nextChange++);
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
    actor.shaderState.close();
    if (isAnimation(actor)) actor.animation.close();
    if (isText(actor)) actor.text.release();
    if (texture && --texture.references === 0) {
      this.textures.delete(texture.id);
      if (!texture.video) this.images.delete(texture.image);
      texture.video?.decoder.close();
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
  private glyphTexture(image: TriangleImage): number {
    let texture = this.glyphTextures.get(image);
    if (!texture) {
      this.target.prepareImage(image);
      texture = {id: this.nextTexture++, draw: this.draws};
      this.glyphTextures.set(image, texture);
      this.textures.set(texture.id, {id: texture.id, image, references: 0, managed: true});
    }
    texture.draw = this.draws;
    return texture.id;
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
  private nodes(
    scene: ArtemisScene<ArtemisDisplayActor>,
    view: ArtemisSceneView = 'retained',
  ): RenderNode[] {
    const roots: RenderNode[] = [],
      groups = new Map<string, RenderNode>();
    for (const entry of scene.prepareEntries(view)) {
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
        if (actor && isAnimation(actor)) {
          visit(
            [{id: node.id, actor: actor.animation.frame(), group: false, children: []}],
            actor.display.matrix(parent, this.raster.trig),
          );
          continue;
        }
        if (actor && isText(actor)) {
          const matrix = actor.display.matrix(parent, this.raster.trig);
          for (const sprite of actor.text.sprites()) {
            const local = compose(matrix, sprite.matrix),
              w = f(sprite.image.width - 1),
              h = f(sprite.image.height - 1);
            if (sprite.image.width === 0 || sprite.image.height === 0) continue;
            for (const [x, y] of [
              [0, 0],
              [w, 0],
              [w, h],
              [0, h],
            ]) {
              const point = artemisDisplayPoint(local, x!, y!);
              add(point[0], point[1]);
            }
          }
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
  /** Browser text presents the text: text layers draw nothing (their hit areas stay). */
  private hiddenText = false;
  get textHidden(): boolean {
    return this.hiddenText;
  }
  hideText(hidden: boolean): void {
    this.hiddenText = hidden;
  }
  /** The text layers the stage draws, in drawing order, each with the ordinary (normal
   * blend, no shader) image layers drawn after it. Matrices are computed without the
   * retained world matrices, so reading them leaves the drawing unchanged; a capture with an
   * explicit clip shifts and clips its children as its surface does. */
  textLayers(scene: ArtemisScene<ArtemisDisplayActor>): ArtemisTextLayer[] {
    type Clip = ArtemisTextLayer['clip'];
    const found: {layer: Omit<ArtemisTextLayer, 'covers'>; start: number}[] = [],
      covers: ArtemisTextCover[] = [];
    const clipOf = (matrix: Float32Array, width: number, height: number, parent: Clip): Clip => {
      const points = [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ].map(([x, y]) => artemisDisplayPoint(matrix, x!, y!));
      let left = Math.min(...points.map((p) => p[0])),
        top = Math.min(...points.map((p) => p[1])),
        right = Math.max(...points.map((p) => p[0])),
        bottom = Math.max(...points.map((p) => p[1]));
      if (parent) {
        left = Math.max(left, parent.x);
        top = Math.max(top, parent.y);
        right = Math.min(right, parent.x + parent.width);
        bottom = Math.min(bottom, parent.y + parent.height);
      }
      return {x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top)};
    };
    const visit = (
      nodes: readonly RenderNode[],
      parent: Float32Array,
      parentAlpha: number,
      clip: Clip,
    ) => {
      for (const node of nodes) {
        const actor = node.actor;
        if (!actor) {
          if (node.group) visit(node.children, parent, parentAlpha, clip);
          continue;
        }
        const p = actor.display.properties;
        if (p.xscale <= 0 || p.yscale <= 0) continue;
        const matrix = actor.display.matrix(parent, this.raster.trig),
          alpha = f(parentAlpha * p.alpha);
        if (!p.visible || alpha < 2 ** -23) continue;
        if (isAnimation(actor)) {
          visit(
            [{id: node.id, actor: actor.animation.frame(), group: false, children: []}],
            matrix,
            alpha,
            clip,
          );
        } else if (isText(actor)) {
          found.push({
            layer: {id: node.id, text: actor.text, matrix, alpha, clip},
            start: covers.length,
          });
        } else if (actor.texture !== null) {
          if (actor.raster.layerMode !== 'normal' || actor.shaderState.shaderName) continue;
          const image = this.check(actor).image,
            c = actor.clip;
          covers.push({
            id: node.id,
            matrix,
            alpha,
            texture: actor.texture,
            image,
            left: c.width !== 0 ? c.left : 0,
            top: c.height !== 0 ? c.top : 0,
            width: c.width !== 0 ? c.width : image.width,
            height: c.height !== 0 ? c.height : image.height,
          });
        } else {
          const capture = this.wrappers.get(actor.wrapper)?.capture,
            c = actor.clip;
          if (capture?.enabled && c.width > 0 && c.height > 0)
            visit(
              node.children,
              compose(matrix, new Float32Array([1, 0, f(-c.left), 0, 1, f(-c.top)])),
              alpha,
              clipOf(matrix, c.width, c.height, clip),
            );
          else visit(node.children, matrix, alpha, clip);
        }
      }
    };
    visit(this.nodes(scene), new Float32Array([1, 0, 0, 0, 1, 0]), 1, null);
    return found.map(({layer, start}) => ({...layer, covers: covers.slice(start)}));
  }
  /** Ids of the visible image, animation and text layers under stage point (x, y), topmost
   * first. A point hits an image when it maps into the image bounds through the inverse
   * local matrix; the actor's clickable threshold then gates the pixel alpha (image hit
   * test 0x14017b6a0). Text layers hit on their glyph rectangles. */
  hitTest(scene: ArtemisScene<ArtemisDisplayActor>, x: number, y: number): string[] {
    const hits: string[] = [];
    const inside = (
      matrix: Float32Array,
      image: TriangleImage,
      left: number,
      top: number,
      width: number,
      height: number,
      display: ArtemisDisplayObject,
    ) => {
      const [a, b, tx, c, d, ty] = matrix as unknown as number[];
      const determinant = a! * d! - b! * c!;
      if (determinant === 0) return false;
      const dx = x - tx!,
        dy = y - ty!,
        u = (d! * dx - b! * dy) / determinant,
        v = (a! * dy - c! * dx) / determinant;
      if (!(u >= 0 && v >= 0 && u < width && v < height)) return false;
      return display.hitsAlpha(() => {
        const px = Math.floor(u + left),
          py = Math.floor(v + top),
          stride = image.width * image.height;
        if (px < 0 || py < 0 || px >= image.width || py >= image.height || !stride) return 0;
        const bytes = image.pixels.length / stride;
        // Format 0 surfaces keep one byte per pixel; GPU surfaces keep no CPU pixels.
        if (bytes === 4) return image.pixels[(py * image.width + px) * 4 + 3]!;
        if (bytes === 1) return image.pixels[py * image.width + px]!;
        return 0;
      });
    };
    const visit = (nodes: readonly RenderNode[], parent: Float32Array, id?: string) => {
      for (const node of nodes) {
        const actor = node.actor;
        if (!actor) {
          if (node.group) visit(node.children, parent);
          continue;
        }
        const p = actor.display.properties;
        if (!p.visible || p.xscale <= 0 || p.yscale <= 0) continue;
        const matrix = actor.display.matrix(parent, this.raster.trig);
        if (isAnimation(actor)) {
          visit(
            [{id: node.id, actor: this.animationFrame(actor), group: false, children: []}],
            matrix,
            node.id,
          );
          continue;
        }
        if (isText(actor)) {
          if (
            actor.text
              .sprites()
              .some((sprite) =>
                inside(
                  compose(matrix, sprite.matrix),
                  sprite.image,
                  0,
                  0,
                  sprite.image.width,
                  sprite.image.height,
                  actor.display,
                ),
              )
          )
            hits.push(id ?? node.id);
          continue;
        }
        if (actor.texture === null) {
          visit(node.children, matrix);
          continue;
        }
        const image = this.check(actor).image,
          width = actor.clip.width !== 0 ? actor.clip.width : image.width,
          height = actor.clip.height !== 0 ? actor.clip.height : image.height;
        if (inside(matrix, image, actor.clip.left, actor.clip.top, width, height, actor.display))
          hits.push(id ?? node.id);
      }
    };
    visit(this.nodes(scene), new Float32Array([1, 0, 0, 0, 1, 0]));
    return hits.reverse();
  }
  private fingerprint(node: RenderNode, capture: GroupCapture): unknown[] {
    const signature: unknown[] = [node.actor?.clip, capture.revision];
    const visit = (nodes: readonly RenderNode[]) => {
      for (const child of nodes) {
        signature.push(
          child.id,
          child.actor,
          child.actor?.display.propertyRevision,
          child.actor?.shaderState.propertyRevision,
          child.actor ? this.changes.get(child.actor) : undefined,
        );
        if (child.actor && isAnimation(child.actor)) {
          const frame = this.animationFrame(child.actor);
          signature.push(frame, frame.display.propertyRevision, this.changes.get(frame));
        } else if (child.actor && isText(child.actor)) {
          signature.push(child.actor.text, child.actor.text.revision, this.hiddenText);
        } else if (child.actor?.texture === null)
          signature.push(this.wrappers.get(child.actor.wrapper)?.capture?.revision);
        else if (child.actor) signature.push(this.videoFrame(child.actor));
        visit(child.children);
      }
    };
    visit(node.children);
    return signature;
  }
  private now: number | null = null;
  /** Native update (0x140156400) precedes each draw pass; one clock sample per draw. */
  private animationFrame(actor: ArtemisAnimationActor): ArtemisDisplayActor {
    if (this.now === null) {
      if (!this.clock) throw Error('Artemis animation layers require a clock owner');
      this.now = this.clock.now() >>> 0;
    }
    if (actor.animation.update(this.now)) this.changes.set(actor, this.nextChange++);
    return actor.animation.frame();
  }
  /** Video update (CTheora slot +0x10) once per draw with the draw's clock sample; a new
   * decoder revision re-uploads the texture. Returns the uploaded revision. */
  private videoFrame(actor: ArtemisImageActor): number | undefined {
    const video = this.check(actor).video;
    if (!video) return undefined;
    if (!video.updated) {
      if (this.now === null) this.now = this.clock!.now() >>> 0;
      video.decoder.update(this.now);
      video.updated = true;
      if (video.decoder.revision !== video.uploaded) {
        const image = this.check(actor).image;
        this.target.invalidate(image);
        this.target.prepareImage(image);
        video.uploaded = video.decoder.revision;
      }
    }
    return video.uploaded;
  }
  /** Retained GPU preparation in ascending native child order. */
  drawCommitted(scene: ArtemisScene<ArtemisDisplayActor>): DrawList {
    return this.render(scene, null);
  }
  /** Draws the committed scene normally, or the pending current scene as the transition
   * target. State 1 mixes from the frame presented when the transition started by
   * `crossfade`; state 2 reveals each pixel as `threshold` passes its rule value, ramping
   * over `vague` on either side (the threshold tweens from -vague to 255+vague). */
  drawStage(
    scene: ArtemisScene<ArtemisDisplayActor>,
    presentation: ArtemisStagePresentation,
  ): DrawList {
    return this.render(scene, presentation);
  }
  /** takess 0x1400e1cf0: renders the committed scene into the screenshot surface; the
   * presented frame is unchanged. */
  takeScreenshot(scene: ArtemisScene<ArtemisDisplayActor>): void {
    this.screenshot ??= this.captureTexture(this.target.width, this.target.height);
    this.render(scene, null, this.screenshot.image);
  }
  /** 0x14014fc10: the screenshot scaled to `width` x `height` as RGBA rows, top row
   * first, or null before any `takeScreenshot`. */
  readScreenshot(width: number, height: number): Uint8Array | null {
    if (!this.screenshot) return null;
    if (!this.target.readRenderSurface) throw new Error('Artemis screenshot readback missing');
    return this.target.readRenderSurface(this.screenshot.image, width, height);
  }
  private stageSurfaces(): NonNullable<ArtemisImageGraphics['stage']> {
    if (!this.stage) {
      const current = this.captureTexture(this.target.width, this.target.height);
      const previous = this.captureTexture(this.target.width, this.target.height);
      this.stage = {current, previous, drawn: false, state: 0};
    }
    return this.stage;
  }
  private stageRule(
    stage: NonNullable<ArtemisImageGraphics['stage']>,
    presentation: ArtemisStagePresentation,
  ): number {
    const rule = presentation.rule;
    if (!rule || rule.bytesPerPixel !== 1)
      throw Error('Artemis rule transition without a gray rule');
    if (stage.rule?.revision !== presentation.ruleRevision) {
      if (stage.rule) {
        this.target.invalidate(stage.rule.image);
        this.textures.delete(stage.rule.texture);
      }
      // Each gray byte fills all four channels: one 32-bit store per pixel, so the
      // expansion is byte-order independent and stays well below a frame at stage size.
      const count = rule.width * rule.height,
        pixels = new Uint8Array(count * 4),
        words = new Uint32Array(pixels.buffer),
        gray = rule.pixels;
      for (let index = 0; index < count; index++) words[index] = gray[index]! * 0x01010101;
      const image: TriangleImage = {width: rule.width, height: rule.height, pixels};
      this.target.prepareImage(image);
      const texture = this.nextTexture++;
      this.textures.set(texture, {id: texture, image, references: 0, managed: true});
      stage.rule = {texture, image, revision: presentation.ruleRevision};
    }
    return stage.rule.texture;
  }
  private render(
    scene: ArtemisScene<ArtemisDisplayActor>,
    presentation: ArtemisStagePresentation | null,
    offscreen?: GpuRenderSurface,
  ): DrawList {
    this.now = null;
    this.draws++;
    for (const texture of this.textures.values()) if (texture.video) texture.video.updated = false;
    const commands: DrawCommand[] = [],
      updates: (() => void)[] = [];
    const shaderLoans: {release(): void}[] = [];
    try {
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
        actor: ArtemisDisplayActor,
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
          if (
            clip.left >= imageWidth ||
            clip.top >= imageHeight ||
            clip.right < 0 ||
            clip.bottom < 0
          )
            return;
          sourceLeft = Math.max(0, clip.left);
          sourceTop = Math.max(0, clip.top);
          width = f((clip.right < imageWidth ? f(clip.right + 1) : imageWidth) - sourceLeft);
          height = f((clip.bottom < imageHeight ? f(clip.bottom + 1) : imageHeight) - sourceTop);
        }
        const shaderName = actor.shaderState.shaderName;
        let custom: ReturnType<ArtemisDrawShaderResource['preset']> | undefined;
        let parameters: Float32Array | undefined;
        let userTextures: {texture: number; uv: Float32Array; filter: 'nearest' | 'linear'}[] = [];
        if (shaderName) {
          if (!this.shaderPrograms) throw Error('Unsupported Artemis shader program owner');
          const prepared = actor.shaderConstants.update(actor.shaderState.constantValues());
          if (prepared) this.nativeSlotOne = prepared;
          const loan = this.shaderPrograms.bind(shaderName);
          if (!loan) {
            // Native null pixel shader emits no target pixels, but capture copy still occurs.
            if (context.format === 2)
              commands.push({
                kind: 'gpu-copy',
                source: context.surface!,
                destination: context.back!.image,
              });
            return;
          }
          shaderLoans.push(loan);
          custom = loan.shader.preset(context.format === 2);
          if (custom.needsUserTexture) {
            const leases = actor.shaderState.leaseTextures();
            shaderLoans.push(...leases.map((entry) => entry.lease));
            if (!leases.length) {
              custom = loan.shader.preset(context.format === 2, false);
            } else {
              const resource = leases[0]!.lease.resource;
              if (
                !this.shaderTextureResources.has(resource) ||
                !('texture' in resource) ||
                typeof resource.texture !== 'number'
              )
                throw Error('Foreign Artemis shader texture resource');
              userTextures = [
                {texture: resource.texture, uv: new Float32Array(8), filter: this.raster.filter},
              ];
            }
          }
          parameters = custom.bufferParameters(this.nativeSlotOne);
        }
        const mode = custom
          ? context.format === 2
            ? {
                blend: {
                  color: {
                    source: 'one' as const,
                    destination: 'zero' as const,
                    operation: 'add' as const,
                  },
                  alpha: {
                    source: 'one' as const,
                    destination: 'zero' as const,
                    operation: 'add' as const,
                  },
                },
              }
            : this.raster.layerMode?.(raster.layerMode)
          : context.format === 2
            ? this.raster.captured?.(raster.layerMode, raster)
            : artemisHasRasterEffects(raster)
              ? this.raster.effects?.(raster.layerMode, raster)
              : this.raster.layerMode?.(raster.layerMode);
        if (context.format === 2 && !mode)
          throw new Error('Artemis captured raster policy owner missing');
        if (!custom && context.format !== 2 && artemisHasRasterEffects(raster) && !mode)
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
          for (const texture of userTextures)
            texture.uv.set(
              [f(f(x + sourceLeft) / imageWidth), f(f(y + sourceTop) / imageHeight)],
              index * 2,
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
          fragment: custom?.fragment ?? mode?.fragment,
          parameters,
          additionalTextures:
            context.format === 2
              ? [
                  {texture: context.back!.id, uv: backgroundUV, filter: this.raster.filter},
                  ...userTextures,
                ]
              : userTextures.length
                ? userTextures
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
          if (node.group !== (actor.texture === null && !isAnimation(actor) && !isText(actor)))
            throw new Error('Unsupported Artemis group raster owner');
          const p = actor.display.properties;
          if (p.xscale <= 0 || p.yscale <= 0) continue;
          const matrix = actor.display.worldMatrix(parent, this.raster.trig),
            alpha = f(parentAlpha * p.alpha);
          if (!p.visible || alpha < 2 ** -23) continue;
          if (isAnimation(actor)) {
            const frame = this.animationFrame(actor);
            visit(
              [{id: node.id, actor: frame, group: false, children: []}],
              matrix,
              alpha,
              context,
            );
            continue;
          }
          if (isText(actor)) {
            const none: ArtemisImageClip = {
              left: 0,
              top: 0,
              width: 0,
              height: 0,
              right: 0,
              bottom: 0,
            };
            for (const sprite of actor.text.sprites()) {
              const spriteAlpha = f(alpha * sprite.alpha);
              if (sprite.image.width === 0 || sprite.image.height === 0 || spriteAlpha < 2 ** -23)
                continue;
              // Hidden text still clears the target lazily, as its quads would.
              if (this.hiddenText) {
                clear(context);
                continue;
              }
              quad(
                this.glyphTexture(sprite.image),
                compose(matrix, sprite.matrix),
                spriteAlpha,
                actor.raster,
                none,
                context,
                actor,
              );
            }
            continue;
          }
          if (actor.texture !== null) {
            this.videoFrame(actor);
            const image = this.check(actor).image;
            if (image.width > 0 && image.height > 0)
              quad(actor.texture, matrix, alpha, actor.raster, actor.clip, context, actor);
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
              actor.clip.width > 0 && actor.clip.height > 0
                ? actor.clip
                : this.bounds(node.children);
            const width = Math.ceil(plan.width),
              height = Math.ceil(plan.height);
            if (![width, height].every((n) => Number.isSafeInteger(n) && n <= 0x7fffffff))
              throw new Error('Unsupported Artemis intermediate surface size');
            if (
              !storage ||
              storage.fore.image.width < width ||
              storage.fore.image.height < height
            ) {
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
            actor,
          );
        }
      };
      const stage = presentation && this.stageSurfaces();
      if (offscreen)
        commands.push({
          kind: 'gpu-target',
          surface: offscreen,
          clearColor: this.raster.clearColor ?? [0, 0, 0, 1],
        });
      if (stage) {
        // A transition starts from the frame presented last; before any, from black.
        if (presentation!.state !== 0 && stage.state === 0)
          commands.push(
            stage.drawn
              ? {kind: 'gpu-copy', source: stage.current.image, destination: stage.previous.image}
              : {kind: 'gpu-target', surface: stage.previous.image, clearColor: [0, 0, 0, 1]},
          );
        commands.push({
          kind: 'gpu-target',
          surface: stage.current.image,
          clearColor: this.raster.clearColor ?? [0, 0, 0, 1],
        });
      }
      // trans commits only at completion. Its target must include pending layer edits;
      // retained still owns the old scene until then, and previous holds its GPU frame.
      const transitioning = presentation?.state === 1 || presentation?.state === 2;
      const view = transitioning ? 'current' : 'retained';
      visit(this.nodes(scene, view), new Float32Array([1, 0, 0, 0, 1, 0]), 1, {
        surface: offscreen ?? (stage ? stage.current.image : null),
        width: this.target.width,
        height: this.target.height,
        pendingClear: false,
      });
      if (stage) {
        const state = presentation!.state;
        const corners = [
          [-1, 1, 0, 0],
          [1, 1, 1, 0],
          [-1, -1, 0, 1],
          [1, -1, 1, 1],
        ];
        const vertices = new Float32Array(36),
          uv = new Float32Array(8);
        corners.forEach(([x, y, u, v], index) => {
          vertices.set([x!, y!, 0, 1, 1, 1, 1, u!, v!], index * 9);
          uv.set([u!, v!], index * 2);
        });
        const additional =
          state === 1 || state === 2
            ? [{texture: stage.previous.id, uv, filter: 'nearest' as const}]
            : [];
        if (state === 2)
          additional.push({texture: this.stageRule(stage, presentation!), uv, filter: 'nearest'});
        commands.push(
          {kind: 'gpu-target', surface: null},
          {
            kind: 'triangles',
            texture: stage.current.id,
            vertices,
            topology: 'triangle-strip',
            normalizedUV: true,
            transform: identity.slice(),
            depthClip: false,
            filter: 'nearest',
            blendState: {
              color: {source: 'one', destination: 'zero', operation: 'add'},
              alpha: {source: 'one', destination: 'zero', operation: 'add'},
            },
            fragment:
              state === 1
                ? 'vec4 shade(vec4 s,vec4 t){vec4 b=texture(additionalAtlas0,additionalUV0);return vec4(mix(b.rgb,s.rgb,parameters[0].x),1.);}'
                : state === 2
                  ? 'vec4 shade(vec4 s,vec4 t){vec4 b=texture(additionalAtlas0,additionalUV0);float r=texture(additionalAtlas1,additionalUV1).r*255.;float v=parameters[0].y;float a=v>0.?clamp((parameters[0].x-r+v)/(2.*v),0.,1.):step(r,parameters[0].x);return vec4(mix(b.rgb,s.rgb,a),1.);}'
                  : 'vec4 shade(vec4 s,vec4 t){return vec4(s.rgb,1.);}',
            parameters: new Float32Array([
              state === 2 ? presentation!.threshold : presentation!.crossfade,
              presentation!.vague,
              ...new Float32Array(30),
            ]),
            additionalTextures: additional.length ? additional : undefined,
            discardTransparent: false,
          },
        );
      }
      if (offscreen) commands.push({kind: 'gpu-target', surface: null});
      const list: DrawList = {
        sprites: [],
        commands,
        clearColor: this.raster.clearColor,
        ...(offscreen ? {offscreen: true} : {}),
      };
      this.target.draw(list, (id) => this.image(id));
      for (const update of updates) update();
      if (stage) {
        stage.drawn = true;
        stage.state = presentation!.state;
      }
      // Glyph images no text actor drew leave the GPU; capture surfaces keep their pixels.
      for (const [image, texture] of this.glyphTextures)
        if (texture.draw !== this.draws) {
          this.glyphTextures.delete(image);
          this.textures.delete(texture.id);
          this.target.invalidate(image);
        }
      return list;
    } finally {
      for (const loan of shaderLoans) loan.release();
    }
  }
}
