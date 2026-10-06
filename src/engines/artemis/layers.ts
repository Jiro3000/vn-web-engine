import type {AsbTag} from '../../formats/artemis/asb.js';
import type {ArtemisImageLoader, ArtemisLoadedImage} from './image-loader.js';
import {ArtemisScene} from './scene.js';
import {artemisLayerProperties, type ArtemisLayerPropertyPatch} from './layer-properties.js';

export interface ArtemisLayerHost<T extends object> {
  /** Native 0x1400d5930 has a separate nonzero capture-mode branch. */
  creationMode(): number;
  /** Allocate a fresh owned image actor, including raster and default geometry effects. */
  createImageLayer(
    resource: ArtemisLoadedImage,
    anchor: {readonly x: number; readonly y: number},
  ): T;
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

/** Ordinary image-backed lyc/lydel/lyprop subset of native layer commands.
 * Raster resources and command registrations remain required owner effects.
 */
export class ArtemisLayers<T extends object> {
  readonly scene: ArtemisScene<T>;
  private generation = 0;
  private pending: number | null = null;
  private closed = false;
  private readonly owned = new Set<T>();
  constructor(
    executableSha256: string,
    private readonly images: ArtemisImageLoader,
    private readonly host: ArtemisLayerHost<T>,
  ) {
    this.scene = new ArtemisScene(executableSha256);
  }
  /** Call alongside cancellation of the old script's Lua continuations. */
  cancelPending(): void {
    this.generation++;
    this.pending = null;
  }
  private collect(): void {
    const referenced = this.scene.payloads();
    for (const layer of this.owned)
      if (!referenced.has(layer)) {
        this.owned.delete(layer);
        this.host.releaseImageLayer(layer);
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
    for (const layer of this.owned) {
      this.owned.delete(layer);
      this.host.releaseImageLayer(layer);
    }
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
      if (id === '!' || (!entry && id.startsWith('~')) || (entry && entry.value === undefined))
        throw new Error('Unsupported Artemis group/shader property owner');
      if (!entry) {
        this.host.layerNotFound(tag);
        return true;
      }
      const properties = artemisLayerProperties(tag.args);
      try {
        const actor = this.scene.editValue(id, (old) => {
          const copy = this.host.copyImageLayer(old);
          this.owned.add(copy);
          return copy;
        })!;
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
    try {
      const resource = await this.images.load(tag.args.get('file') ?? '');
      if (token !== this.generation) throw new Error('Artemis layer resource operation cancelled');
      if (resource === null) {
        if (['width', 'height', 'color'].every((key) => tag.args.has(key)))
          throw new Error('Unsupported Artemis solid-color surface owner');
        this.host.imageLoadFailed(tag);
        return true;
      }
      const layer = this.host.createImageLayer(resource, {
        x: Math.fround(Math.fround(resource.image.width) * 0.5),
        y: Math.fround(Math.fround(resource.image.height) * 0.5),
      });
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
      if (this.pending === token) this.pending = null;
    }
  }
}
