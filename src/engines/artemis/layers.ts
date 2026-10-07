import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisImageSource, ArtemisLoadedImage} from './image-loader.js';
import {ArtemisScene} from './scene.js';
import {artemisLayerProperties, type ArtemisLayerPropertyPatch} from './layer-properties.js';
import {createSolidImage} from '../../graphics/solid-image.js';
import {artemisHexUint32} from './numbers.js';

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

export interface ArtemisLayerHost<T extends object> {
  /** Native 0x1400d5930 has a separate nonzero capture-mode branch. */
  creationMode(): number;
  /** Allocate a fresh actor; success transfers the resource lease to its outer wrapper. */
  createImageLayer(
    resource: ArtemisLoadedImage,
    anchor: {readonly x: number; readonly y: number},
  ): T;
  /** Allocate the native default property holder of an empty group. */
  createGroupLayer?(): T;
  releaseImageLayer(layer: T): void;
  /** Copy native inner-actor state; the owner retains any shared raster resources. */
  copyImageLayer(layer: T): T;
  /** Apply inner actor properties and the separate outer-wrapper alpha effect. */
  applyImageProperties(id: string, layer: T, properties: ArtemisLayerPropertyPatch): void;
  recordLayerProperties(tag: AsbTag): void;
  layerNotFound(tag: AsbTag): void;
  /** Remove the selected native layer command registrations, after structural deletion. */
  clearLayerCommands(ids: readonly string[]): void;
  /** Native ordinary lyc replaces this id's command list with an empty list. */
  resetLayerCommands(id: string): void;
  /** Native load failure reports a script error and leaves the old layer intact. */
  imageLoadFailed(tag: AsbTag): void;
}

/** Ordinary image-backed lyc/lydel and image/direct-group lyprop subset.
 * Raster resources and command registrations remain required owner effects.
 */
export class ArtemisLayers<T extends object> {
  readonly scene: ArtemisScene<T>;
  private generation = 0;
  private pending: number | null = null;
  private closed = false;
  private readonly owned = new Set<T>();
  private readonly released: T[] = [];
  constructor(
    executableSha256: string,
    private readonly images: ArtemisImageSource,
    private readonly host: ArtemisLayerHost<T>,
  ) {
    this.scene = new ArtemisScene(
      executableSha256,
      (layer) => this.released.push(layer),
      host.createGroupLayer
        ? () => {
            const group = host.createGroupLayer!();
            this.owned.add(group);
            return group;
          }
        : undefined,
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
    for (const layer of [...this.released.splice(0), ...this.owned])
      if (!referenced.has(layer)) {
        if (this.owned.delete(layer)) this.host.releaseImageLayer(layer);
      }
  }
  /** Commit structure and release actors no longer retained by either structural view. */
  commit(): void {
    if (this.closed) throw new Error('Artemis layer owner closed');
    this.scene.commit();
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
  async dispatch(input: AsbTag): Promise<boolean> {
    if (this.closed) throw new Error('Artemis layer owner closed');
    if (input.name !== 'lyc' && input.name !== 'lydel' && input.name !== 'lyprop') return false;
    if (this.pending !== null) throw new Error('Artemis layer resource operation already pending');
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
      try {
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
        this.host.recordLayerProperties(tag);
      } finally {
        this.collect();
      }
      return true;
    }
    if (tag.name === 'lydel') {
      try {
        this.remove(id);
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
    let resource: ArtemisLoadedImage | null = null;
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
}
