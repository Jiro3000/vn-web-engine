import type {ArtemisShaderPropertyPatch, ArtemisShaderTextureLease} from './shader-properties.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import type {TriangleImage} from '../../graphics/triangle-draw.js';
import type {
  ArtemisImageSource,
  ArtemisLoadedImage,
  ArtemisImageDimensions,
} from './image-loader.js';
import {ArtemisScene} from './scene.js';
import {artemisLayerProperties, type ArtemisLayerPropertyPatch} from './layer-properties.js';
import {createSolidImage} from '../../graphics/solid-image.js';
import {artemisHexUint32, artemisInteger} from './numbers.js';
import {ArtemisAnimationFrames} from './animation-layer.js';
import {ArtemisTheoraVideo, artemisVideoMaskName} from './video.js';

function dimension(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const result = token ? Number(token[1]) : 0;
  if (!Number.isInteger(result) || result < 0 || result > 0x7fffffff)
    throw new Error('Unsupported Artemis solid surface dimension');
  return result;
}
function solidImage(tag: AsbTag): ArtemisLoadedImage {
  const value = tag.args.get('color')!;
  const length = new TextEncoder().encode(value).length;
  const format = length === 6 || (length === 8 && /^0[xX]/.test(value)) ? 1 : 2;
  const color = artemisHexUint32(value);
  const argb = format === 1 ? color | 0xff000000 : color;
  return {
    path: '',
    surfaceFormat: format,
    image: createSolidImage(dimension(tag.args.get('width')!), dimension(tag.args.get('height')!), [
      (argb >>> 16) & 255,
      (argb >>> 8) & 255,
      argb & 255,
      argb >>> 24,
    ]),
  };
}

export interface ArtemisLayerHost<
  T extends object,
  I extends ArtemisImageDimensions = TriangleImage,
> {
  /** Native 0x1400d5930 has a separate nonzero capture-mode branch. */
  creationMode(): number;
  /** Allocate a fresh actor; success transfers the resource lease to its outer wrapper. */
  createImageLayer(
    resource: ArtemisLoadedImage<I | TriangleImage>,
    anchor: {readonly x: number; readonly y: number},
  ): T;
  /** Allocate the native default property holder of an empty group. */
  createGroupLayer?(): T;
  releaseImageLayer(layer: T): void;
  /** Node-owned captures precede child-map and holder destruction (0x1400b1860). */
  releaseGroupResources?(layer: T): void;
  /** Copy native inner-actor state; the owner retains any shared raster resources. */
  copyImageLayer(layer: T): T;
  /** Apply inner actor properties and the separate outer-wrapper alpha effect. */
  applyImageProperties(id: string, layer: T, properties: ArtemisLayerPropertyPatch): void;
  supportsShaderProperties?(): boolean;
  createShaderTexture?(resource: ArtemisLoadedImage<I>): ArtemisShaderTextureLease<object>;
  applyShaderProperties?(
    layer: T,
    patch: ArtemisShaderPropertyPatch,
    textures?: readonly {name: string; lease: ArtemisShaderTextureLease<object>}[],
  ): void;
  recordLayerProperties(tag: AsbTag): void;
  layerNotFound(tag: AsbTag): void;
  /** Remove the selected native layer command registrations, after structural deletion. */
  clearLayerCommands(ids: readonly string[]): void;
  /** Native ordinary lyc replaces this id's command list with an empty list. */
  resetLayerCommands(id: string): void;
  /** Native load failure reports a script error and leaves the old layer intact. */
  imageLoadFailed(tag: AsbTag): void;
  /** CAnimationLayer allocation (0x140101520, 0x1400b0db0) around its frame map. The
   * owner closes the frames on release and copies them (sharing frames) on copy. */
  createAnimationLayer?(frames: ArtemisAnimationFrames<T>): T;
  /** 0x1400f8820: dynamic cast of a scene actor to CAnimationLayer. */
  animationFrames?(layer: T): ArtemisAnimationFrames<T> | undefined;
  /** c7260 with 0x140372360 (`not-found`) or 0x1403723a0 (`mode`). */
  animationError?(tag: AsbTag, error: 'not-found' | 'mode'): void;
  /** Appends the tag to the id's command list (save object +0x68). */
  appendLayerCommand?(id: string, tag: AsbTag): void;
  /** Pack-file open used by the video tag; null when the name does not exist. */
  readVideoFile?(path: string): Promise<Uint8Array | null>;
  /** Renderer vtbl+0x60 video actor holding the decoder (actor +0x88). */
  createVideoLayer?(video: ArtemisTheoraVideo, anchor: {readonly x: number; readonly y: number}): T;
  /** c7260 with 0x140372540 (`not-found`) or 0x140372518 (`unsupported`). */
  videoError?(tag: AsbTag, error: 'not-found' | 'unsupported'): void;
}

/** anime keys that 0x140115650 never queries. */
const animationKeys = new Set(['mode', 'time', 'loop']);

/** Ordinary image-backed lyc/lydel and image/direct-group lyprop subset.
 * Raster resources and command registrations remain required owner effects.
 */
export class ArtemisLayers<T extends object, I extends ArtemisImageDimensions = TriangleImage> {
  readonly scene: ArtemisScene<T>;
  private readonly hash: string;
  private generation = 0;
  private pending: number | null = null;
  private closed = false;
  private readonly owned = new Set<T>();
  private readonly released: ({kind: 'actor'; layer: T} | {kind: 'node'; layers: readonly T[]})[] =
    [];
  constructor(
    executableSha256: string,
    private readonly images: ArtemisImageSource<I>,
    private readonly host: ArtemisLayerHost<T, I>,
  ) {
    this.hash = executableSha256;
    this.scene = new ArtemisScene(
      executableSha256,
      (layer) => this.released.push({kind: 'actor', layer}),
      host.createGroupLayer
        ? () => {
            const group = host.createGroupLayer!();
            this.owned.add(group);
            return group;
          }
        : undefined,
      (layers) => this.released.push({kind: 'node', layers}),
    );
  }
  /** Call alongside cancellation of the old script's Lua continuations. */
  cancelPending(): void {
    this.generation++;
    this.pending = null;
  }
  private collect(): void {
    const referenced = this.scene.payloads();
    // Scene notifications preserve native release order. The final fallback
    // releases fresh actors that failed to enter the tree, rather than sorting
    // existing actors by allocation order.
    for (const effect of this.released.splice(0)) {
      if (effect.kind === 'node') {
        for (const layer of new Set(effect.layers))
          if (!referenced.has(layer)) this.host.releaseGroupResources?.(layer);
      } else if (!referenced.has(effect.layer)) {
        if (this.owned.delete(effect.layer)) this.host.releaseImageLayer(effect.layer);
      }
    }
    for (const layer of this.owned)
      if (!referenced.has(layer) && this.owned.delete(layer)) this.host.releaseImageLayer(layer);
  }
  /** Adopt a fresh native scene wrapper (for example a message/text actor).
   * The same scene and property/copy/release hooks handle it alongside images.
   * Transfers ownership after open/pending/fresh checks, including insertion failure.
   * Command histories belong to the script owner and are not reset by attachment. */
  attachActor(id: string, actor: T): boolean {
    if (this.closed) throw Error('Artemis layer owner closed');
    if (this.pending !== null) throw Error('Artemis layer resource operation already pending');
    if (this.owned.has(actor) || this.scene.payloads().has(actor))
      throw Error('Artemis scene wrapper must be fresh');
    this.owned.add(actor);
    try {
      this.scene.entry(id);
      return this.scene.set(id, actor);
    } finally {
      this.collect();
    }
  }
  /** Native stage removal leaves command-history maintenance to its script owner.
   * A detached wrapper remains alive while referenced by the retained scene. */
  detachActor(id: string): void {
    if (this.closed) throw Error('Artemis layer owner closed');
    if (this.pending !== null) throw Error('Artemis layer resource operation already pending');
    try {
      this.scene.remove(id);
    } finally {
      this.collect();
    }
  }
  /** Commit structure and release actors no longer retained by either structural view. */
  commit(): void {
    if (this.closed) throw new Error('Artemis layer owner closed');
    this.scene.commit();
    this.collect();
  }
  /** bf210 replaces the stage root (+0x30): both structural views are destroyed. */
  reset(): void {
    if (this.closed) throw Error('Artemis layer owner closed');
    if (this.pending !== null) throw Error('Artemis layer resource operation already pending');
    this.scene.clear();
    this.collect();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending();
    this.scene.clear();
    this.collect();
  }
  private remove(id: string): void {
    const selected = this.scene.select(id).map((entry) => entry.id);
    this.scene.remove(id);
    if (selected.length) this.host.clearLayerCommands(selected);
  }
  /** Synchronous lydel body 0x1400d6670, also bound as a tween completion. Replay leaves
   * the command registrations alone. */
  deleteLayer(id: string, recordHistory = true): void {
    if (this.closed) throw Error('Artemis layer owner closed');
    if (this.pending !== null) throw Error('Artemis layer resource operation already pending');
    try {
      if (recordHistory) this.remove(id);
      else this.scene.remove(id);
    } finally {
      this.collect();
    }
  }
  /** `recordHistory` is the native replay flag; it applies to lydel/animedel and anime. */
  async dispatch(input: AsbTag, recordHistory = true): Promise<boolean> {
    if (this.closed) throw new Error('Artemis layer owner closed');
    if (!['lyc', 'lydel', 'lyprop', 'anime', 'animedel', 'video'].includes(input.name))
      return false;
    if (this.pending !== null) throw new Error('Artemis layer resource operation already pending');
    if (input.name === 'video') {
      await this.video(input, recordHistory);
      return true;
    }
    if (input.name === 'anime') {
      await this.animation(input, recordHistory);
      return true;
    }
    // lydel and animedel both bind 0x1400d6670.
    if (input.name === 'animedel') {
      this.deleteLayer(input.args.get('id') ?? '', recordHistory);
      return true;
    }
    const tag: AsbTag = {...input, args: new Map(input.args)};
    const id = tag.args.get('id') ?? '';
    // Validate the supported key subset before any owner effects or asynchronous reads.
    this.scene.entry(id);
    if (tag.name === 'lyprop') {
      const entry = this.scene.entry(id);
      if (
        id === '!' ||
        (!entry && id.startsWith('~')) ||
        (entry?.acceptsChildren && !this.host.createGroupLayer) ||
        (entry && entry.value === undefined && !entry.acceptsChildren)
      )
        throw new Error('Unsupported Artemis group/shader property owner');
      if (!entry) {
        this.host.layerNotFound(tag);
        return true;
      }
      const properties = artemisLayerProperties(tag.args);
      const shader = properties.customShader;
      if (shader && (!this.host.applyShaderProperties || !this.host.supportsShaderProperties?.()))
        throw Error('Unsupported Artemis shader property owner');
      if (shader?.textures?.length && !this.host.createShaderTexture)
        throw Error('Unsupported Artemis shader texture resource owner');
      const textures: {name: string; lease: ArtemisShaderTextureLease<object>}[] = [];
      const generation = shader ? ++this.generation : null;
      if (generation !== null) this.pending = generation;
      try {
        for (const entry of shader?.textures ?? []) {
          const resource = await this.images.load(entry.path);
          if (this.closed || generation !== this.generation) {
            resource?.lease?.release();
            return true;
          }
          if (resource) {
            try {
              textures.push({name: entry.name, lease: this.host.createShaderTexture!(resource)});
            } catch (error) {
              resource.lease?.release();
              throw error;
            }
          }
          if (this.closed || generation !== this.generation) return true;
        }

        const actor = this.scene.editValue(
          id,
          (old) => {
            const copy = this.host.copyImageLayer(old);
            this.owned.add(copy);
            return copy;
          },
          entry.acceptsChildren
            ? () => {
                const group = this.host.createGroupLayer!();
                this.owned.add(group);
                return group;
              }
            : undefined,
        )!;
        this.host.applyImageProperties(entry.id, actor, properties);
        if (shader)
          this.host.applyShaderProperties!(
            actor,
            shader,
            shader.textures === undefined ? undefined : textures,
          );
        this.host.recordLayerProperties(tag);
      } finally {
        for (const entry of textures) entry.lease.release();
        if (generation !== null && this.pending === generation) this.pending = null;
        this.collect();
      }
      return true;
    }
    if (tag.name === 'lydel') {
      try {
        if (recordHistory) this.remove(id);
        else this.scene.remove(id);
      } finally {
        this.collect();
      }
      return true;
    }
    if (this.host.creationMode() !== 0)
      throw new Error('Unsupported Artemis capture-mode layer creation');
    if (tag.args.has('rule')) throw new Error('Unsupported Artemis rule surface format owner');
    const token = ++this.generation;
    this.pending = token;
    let resource: ArtemisLoadedImage<I | TriangleImage> | null = null;
    try {
      resource = await this.images.load(tag.args.get('file') ?? '');
      if (token !== this.generation) throw new Error('Artemis layer resource operation cancelled');
      if (resource === null) {
        if (['width', 'height', 'color'].every((key) => tag.args.has(key)))
          resource = solidImage(tag);
        else {
          this.host.imageLoadFailed(tag);
          return true;
        }
      }
      const layer = this.host.createImageLayer(resource, {
        x: Math.fround(Math.fround(resource.image.width) * 0.5),
        y: Math.fround(Math.fround(resource.image.height) * 0.5),
      });
      resource = null; // The successful layer owner now owns this loan.
      this.owned.add(layer);
      try {
        this.remove(id);
        this.scene.set(id, layer);
        this.host.resetLayerCommands(id);
      } finally {
        this.collect();
      }
      return true;
    } finally {
      try {
        resource?.lease?.release();
      } finally {
        if (this.pending === token) this.pending = null;
      }
    }
  }
  /** anime 0x1400ddc70 outside capture mode. `init`/`add` load `file` as a frame actor
   * (anchor at its centre, then the tag's 115650 properties); `init` replaces the layer
   * with a fresh CAnimationLayer holding the frame at key 0, `add` stores the frame at
   * `time` and `end` stores the end marker at `time` in the existing animation. History:
   * `init` empties the id's command list, `add`/`end` append the tag. Error paths record
   * nothing. std::map operator[] reads insert empty values into the recorded tag. */
  private async animation(input: AsbTag, recordHistory: boolean): Promise<void> {
    const host = this.host;
    if (
      !host.createAnimationLayer ||
      !host.animationFrames ||
      !host.animationError ||
      !host.appendLayerCommand
    )
      throw Error('Unsupported Artemis animation layer owner');
    if (host.creationMode() !== 0) throw Error('Unsupported Artemis capture-mode animation');
    const args = new Map(input.args),
      tag: AsbTag = {...input, args};
    const read = (key: string): string => {
      if (!args.has(key)) args.set(key, '');
      return args.get(key)!;
    };
    const mode = read('mode');
    let frame: T | null = null;
    if (mode === 'init' || mode === 'add') {
      const file = read('file');
      if (args.has('mask')) throw Error('Unsupported Artemis animation mask owner');
      const token = ++this.generation;
      this.pending = token;
      let resource: ArtemisLoadedImage<I | TriangleImage> | null = null;
      try {
        resource = await this.images.load(file);
        if (token !== this.generation) throw Error('Artemis layer resource operation cancelled');
        if (resource === null) return host.imageLoadFailed(tag);
        frame = host.createImageLayer(resource, {
          x: Math.fround(Math.fround(resource.image.width) * 0.5),
          y: Math.fround(Math.fround(resource.image.height) * 0.5),
        });
        resource = null;
      } finally {
        try {
          resource?.lease?.release();
        } finally {
          if (this.pending === token) this.pending = null;
        }
      }
      try {
        const properties = new Map([...args].filter(([key]) => !animationKeys.has(key)));
        host.applyImageProperties(args.get('id') ?? '', frame, artemisLayerProperties(properties));
      } catch (error) {
        host.releaseImageLayer(frame);
        throw error;
      }
    }
    if (mode === 'init') {
      const frames = ArtemisAnimationFrames.create<T>(this.hash, (value) =>
        host.releaseImageLayer(value),
      );
      let layer: T;
      try {
        frames.reset(frame!);
        if (args.has('loop')) frames.setLoop(artemisInteger(args.get('loop')!));
        layer = host.createAnimationLayer(frames);
      } catch (error) {
        frames.close();
        throw error;
      }
      this.owned.add(layer);
      const id = read('id');
      try {
        if (recordHistory) this.remove(id);
        else this.scene.remove(id);
        this.scene.set(id, layer);
      } finally {
        this.collect();
      }
      if (recordHistory) host.resetLayerCommands(id);
      return;
    }
    if (mode !== 'add' && mode !== 'end') return host.animationError(tag, 'mode');
    const id = read('id'),
      value = this.scene.entry(id)?.value,
      frames = value === undefined ? undefined : host.animationFrames(value);
    if (!frames) {
      if (frame) host.releaseImageLayer(frame);
      return host.animationError(tag, 'not-found');
    }
    // The layer's CAnimationLayer is updated in place, shared by any retained copy node.
    frames.add(frame, artemisInteger(read('time')));
    if (recordHistory) host.appendLayerCommand(id, tag);
  }
  /** video 0x1400e4650 with `id`: open `file`, then `file.mja`, then `file.ogv`; the
   * decoder (CMja, then CTheora) takes the loop flag (`loop` present and not "0"),
   * `delaymargin` goes to slot +0x20, the actor is anchored at its centre, the old layer
   * is deleted (0x1400d6670) and the actor inserted. History empties the id's command
   * list. CMja (`.mja`) is not implemented; the fullscreen path without `id` belongs to
   * `ArtemisFullscreenVideo`. */
  private async video(input: AsbTag, recordHistory: boolean): Promise<void> {
    const host = this.host;
    if (!host.readVideoFile || !host.createVideoLayer || !host.videoError)
      throw Error('Unsupported Artemis video layer owner');
    const args = input.args;
    if (!args.has('id')) throw Error('Artemis fullscreen video belongs to ArtemisFullscreenVideo');
    const file = args.get('file') ?? '';
    const token = ++this.generation;
    this.pending = token;
    let video: ArtemisTheoraVideo | null;
    try {
      let name = '',
        bytes: Uint8Array | null = null;
      for (const candidate of [file, file + '.mja', file + '.ogv']) {
        bytes = await host.readVideoFile(candidate);
        if (token !== this.generation) throw Error('Artemis layer resource operation cancelled');
        if (bytes) {
          name = candidate;
          break;
        }
      }
      if (!bytes) return host.videoError(input, 'not-found');
      const loop = args.has('loop') && args.get('loop') !== '0';
      const mask = await host.readVideoFile(artemisVideoMaskName(name));
      if (token !== this.generation) throw Error('Artemis layer resource operation cancelled');
      video = ArtemisTheoraVideo.open(this.hash, bytes, loop, mask);
      if (!video) {
        // CMja is tried first natively; its format is not implemented here.
        if (!/^OggS/.test(String.fromCharCode(...bytes.subarray(0, 4))))
          throw Error('Unsupported Artemis MJA video');
        return host.videoError(input, 'unsupported');
      }
    } finally {
      if (this.pending === token) this.pending = null;
    }
    if (args.has('delaymargin')) video.setDelayMargin(artemisInteger(args.get('delaymargin')!));
    const layer = host.createVideoLayer(video, {
      x: Math.fround(Math.fround(video.width) * 0.5),
      y: Math.fround(Math.fround(video.height) * 0.5),
    });
    this.owned.add(layer);
    const id = args.get('id')!;
    try {
      if (recordHistory) this.remove(id);
      else this.scene.remove(id);
      this.scene.set(id, layer);
    } finally {
      this.collect();
    }
    if (recordHistory) host.resetLayerCommands(id);
  }
}
