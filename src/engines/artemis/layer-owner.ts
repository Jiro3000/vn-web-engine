import type {ArtemisLayerInfo} from './layer-info.js';
import type {AsbTag} from '../../formats/artemis/asb.js';
import type {TriangleImage} from '../../graphics/triangle-draw.js';
import type {ArtemisImageDimensions, ArtemisImageSource} from './image-loader.js';
import {ArtemisLayerCommands} from './layer-commands.js';
import {
  ArtemisLayerEventSlots,
  ArtemisLayerEvents,
  type ArtemisLayerEventSink,
  type ArtemisLayerEventType,
} from './layer-events.js';
import type {ArtemisLayerPropertyPatch} from './layer-properties.js';
import {ArtemisLayerTweens} from './layer-tweens.js';
import {ArtemisLayers, type ArtemisLayerHost} from './layers.js';
import {artemisRevision} from './revision.js';
import {ArtemisStage} from './stage.js';
import {
  ArtemisTransition,
  type ArtemisRuleBitmap,
  type ArtemisRuleImage,
  type ArtemisTransitionTween,
} from './transition.js';
import {ArtemisTweenRegistry} from './tween.js';
import type {ArtemisTheoraVideo} from './video.js';

/** The script services the layer owner uses: the transition and sync-tween run modes, the
 * frame clock, tween completion events, the stage size and the skip state. */
export interface ArtemisLayerRunModeHost {
  /** c6160 entry: c74 = c70, c70 = `mode`. */
  enter(mode: number): void;
  /** c6480: c70 = c74, then the deferred script events. */
  release(): void;
  now(): number;
  emit(tag: AsbTag): void;
  stageSize(): {readonly width: number; readonly height: number};
  skipState(): {readonly allowed: boolean; readonly command: boolean; readonly control: boolean};
}

/** The save-object command registry services a graphics backend forwards. */
export type ArtemisLayerRegistryServices = Pick<
  ArtemisLayerHost<object>,
  'clearLayerCommands' | 'resetLayerCommands' | 'recordLayerProperties' | 'appendLayerCommand'
>;

/** A message layer's text resource and the retain/release of its loans. */
export interface ArtemisMessageActorOwner<M> {
  retain(message: M): void;
  release(message: M): void;
}

export interface ArtemisLayerOwnerHost<T extends object, I extends ArtemisImageDimensions, M> {
  /** The actor backend (image graphics, or a geometry-only diagnostic owner). */
  createGraphics(registry: ArtemisLayerRegistryServices): ArtemisLayerHost<T, I>;
  readonly images: ArtemisImageSource<I>;
  readonly runMode: ArtemisLayerRunModeHost;
  /** Stage loader for transition rule images. */
  loadRule(path: string): Promise<ArtemisRuleImage | null>;
  /** A message-layer actor (CLinkableTextLayer wrapper) holding a loan of `message`. */
  createMessageActor(message: M, owner: ArtemisMessageActorOwner<M>): T;
  /** Per-frame layer tween values: inner actor properties without a command record. */
  applyTweenProperties(id: string, actor: T, patch: ArtemisLayerPropertyPatch): void;
  /** The video decoder a video actor holds. */
  videoOf(actor: T): ArtemisTheoraVideo | undefined;
  /** The fields `var system=get_layer_info` reads from an actor. */
  layerInfo?(actor: T): ArtemisLayerInfo;
  /** Transition presentation state the renderer reads. */
  setCrossfade?(value: number): void;
  setVague?(value: number): void;
  setRuleThreshold?(value: number): void;
  /** Diagnostic records of stage, transition and tween effects. */
  trace?(effect: {readonly kind: string} & Record<string, unknown>): void;
}

export interface ArtemisStagePresentation {
  readonly state: number;
  readonly crossfade: number;
  readonly vague: number;
  readonly threshold: number;
  readonly rule: ArtemisRuleBitmap | null;
  readonly ruleRevision: number;
}

/** The stage's layer system: the layer tree (`ArtemisLayers`), the save object's layer
 * command registry (+0x68), layer events, the stage (flip/commit), `trans` and the tween
 * registry with layer tweens, over an actor backend. */
export class ArtemisLayerOwner<
  T extends object,
  I extends ArtemisImageDimensions = TriangleImage,
  M = unknown,
> {
  readonly layers: ArtemisLayers<T, I>;
  readonly commands: ArtemisLayerCommands;
  readonly tweenRegistry: ArtemisTweenRegistry;
  readonly graphics: ArtemisLayerHost<T, I>;
  private readonly slots = new WeakMap<T, ArtemisLayerEventSlots>();
  private readonly events: ArtemisLayerEvents<T>;
  private readonly stage: ArtemisStage;
  private readonly transition: ArtemisTransition;
  private readonly layerTweens: ArtemisLayerTweens<T>;
  private transitionState = 0;
  private refreshState = 0;
  private stageRule: ArtemisRuleBitmap | null = null;
  private tweenSync = false;
  private transitionTween: ArtemisTransitionTween | null = null;
  private crossfade = 0;
  private vague = 0;
  private threshold = 0;
  private ruleRevision = 0;

  constructor(
    hash: string,
    private readonly host: ArtemisLayerOwnerHost<T, I, M>,
  ) {
    artemisRevision(hash);
    const trace = (effect: {readonly kind: string} & Record<string, unknown>) =>
      host.trace?.(effect);
    const commands = (this.commands = new ArtemisLayerCommands(hash));
    const graphics = (this.graphics = host.createGraphics({
      clearLayerCommands: (ids) => commands.clear(ids),
      resetLayerCommands: (id, tag) => commands.reset(id, tag),
      // lyprop (and lytween's synthesized end state) outside replay: coalescing record b9cd0.
      recordLayerProperties: (tag) => commands.record(tag),
      appendLayerCommand: (id, tag) => commands.append(id, tag),
    }));
    // Actor copies carry their event slots (CArtemisLayer +0x100). Every other member
    // delegates with the graphics owner as `this`, so its state (texture ids) stays single.
    const copyImageLayer = (old: T): T => {
      const actor = graphics.copyImageLayer(old);
      const slots = this.slots.get(old);
      if (slots) this.slots.set(actor, slots.copy());
      return actor;
    };
    const layerHost = new Proxy(graphics, {
      get: (target, key) => {
        if (key === 'copyImageLayer') return copyImageLayer;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ArtemisLayerHost<T, I>;
    const layers = (this.layers = new ArtemisLayers(hash, host.images, layerHost));
    this.events = new ArtemisLayerEvents(layers.scene, commands, {
      slots: (actor) => this.eventSlots(actor),
    });
    const stage = (this.stage = new ArtemisStage(hash, {
      captureMode: () => 0,
      transitionState: () => this.transitionState,
      clearTransitionRule: () => trace({kind: 'clearTransitionRule', simulation: true}),
      resetTransitionLayerValue: (value) =>
        trace({kind: 'resetTransitionValue', value, simulation: true}),
      setTransitionState: (value) => {
        this.transitionState = value;
      },
      markSceneDirty: () => trace({kind: 'sceneDirty', simulation: true}),
      commitLayers: () => layers.commit(),
      refreshState: () => this.refreshState,
      setRefreshState: (value) => {
        this.refreshState = value;
      },
    }));
    const runMode = host.runMode;
    this.transition = new ArtemisTransition(hash, {
      captureMode: () => 0,
      commit: () => stage.commit(),
      enterRunMode: (mode) => {
        trace({kind: 'runMode', mode, simulation: true});
        runMode.enter(mode);
      },
      releaseRunMode: () => {
        trace({kind: 'runModeRelease', simulation: true});
        runMode.release();
      },
      now: () => runMode.now(),
      setWaitStart: (ms) => trace({kind: 'waitStart', ms, simulation: true}),
      skipState: () => runMode.skipState(),
      setTransitionState: (value) => {
        this.transitionState = value;
      },
      setCrossfade: (value) => {
        trace({kind: 'crossfade', value, simulation: true});
        this.crossfade = value;
        host.setCrossfade?.(value);
      },
      stageSize: () => runMode.stageSize(),
      loadRule: (path) => host.loadRule(path),
      setRuleImage: (image) => {
        this.stageRule = image;
        this.ruleRevision++;
        trace({kind: 'ruleImage', replaced: true});
      },
      ruleImage: () => {
        const {width, height} = runMode.stageSize();
        // Stage +0x50 is created with the stage at stage size, one gray byte per pixel.
        if (this.stageRule?.width !== width || this.stageRule?.height !== height)
          this.stageRule = {
            width,
            height,
            bytesPerPixel: 1,
            pixels: new Uint8Array(width * height),
          };
        // The caller tiles the rule into these pixels.
        this.ruleRevision++;
        trace({kind: 'ruleImage', replaced: false});
        return this.stageRule;
      },
      setVague: (value) => {
        this.vague = value;
        host.setVague?.(value);
      },
      setRuleThreshold: (value) => {
        this.threshold = value;
        host.setRuleThreshold?.(value);
      },
      registerTween: (tween) => {
        this.transitionTween = tween;
      },
      reportError: () => {
        throw Error('Unsupported Artemis trans error report');
      },
    });
    const tweens = (this.tweenRegistry = new ArtemisTweenRegistry(hash));
    this.layerTweens = new ArtemisLayerTweens(hash, layers.scene, tweens, commands, {
      applyImageProperties: (id, actor, patch) => host.applyTweenProperties(id, actor, patch),
      layerNotFound: (tag) => graphics.layerNotFound(tag),
      enterRunMode: (mode) => {
        trace({kind: 'runMode', mode, simulation: true});
        this.tweenSync = true;
        runMode.enter(mode);
      },
      endSyncWait: () => {
        trace({kind: 'tweenSyncEnd', simulation: true});
        this.tweenSync = false;
        // b5be0: c74 = c70, c70 = 0.
        runMode.enter(0);
      },
      deleteLayer: (tag, recordHistory) => {
        trace({kind: 'tweenDelete', id: tag.args.get('id'), simulation: true});
        layers.deleteLayer(tag.args.get('id') ?? '', recordHistory);
      },
      emitEvent: (tag) => {
        trace({kind: 'tweenEvent', id: tag.args.get('id'), simulation: true});
        runMode.emit(tag);
      },
      recordLayerProperties: (tag) => graphics.recordLayerProperties(tag),
    });
  }
  /** The transition state the presenter draws: state 1 crossfades from the previous frame
   * by `crossfade`, state 2 reveals by the stage rule against `threshold` and `vague`.
   * `ruleRevision` changes whenever the rule pixels may have. */
  get presentation(): ArtemisStagePresentation {
    return {
      state: this.transitionState,
      crossfade: this.crossfade,
      vague: this.vague,
      threshold: this.threshold,
      rule: this.stageRule,
      ruleRevision: this.ruleRevision,
    };
  }
  /** Event state of an actor (CArtemisLayer +0x100). */
  eventSlots(actor: T): ArtemisLayerEventSlots {
    let slots = this.slots.get(actor);
    if (!slots) this.slots.set(actor, (slots = new ArtemisLayerEventSlots()));
    return slots;
  }
  /** Steps every registered layer tween and updates every video layer's decoder. */
  tickTweens(now: number): void {
    this.tweenRegistry.tick(now);
    const videos = new Set<ArtemisTheoraVideo>();
    for (const view of ['current', 'retained'] as const)
      for (const entry of this.layers.scene.entries(view)) {
        const video = entry.value && this.host.videoOf(entry.value);
        if (video) videos.add(video);
      }
    for (const video of videos) video.update(now);
  }
  /** `wait video=` frame check: layer `id` is a video layer that is still playing. */
  videoPlaying(id: string): boolean {
    const actor = this.layers.scene.entry(id)?.value;
    return (actor !== undefined && this.host.videoOf(actor)?.playing) === true;
  }
  /** A `sync` layer tween holds run mode 4. */
  get tweenSyncPending(): boolean {
    return this.tweenSync;
  }
  dispatchTween(tag: AsbTag): boolean {
    this.host.trace?.({kind: 'tween', name: tag.name, id: tag.args.get('id'), simulation: true});
    return this.layerTweens.dispatch(tag);
  }
  hasLayer(id: string): boolean {
    return !!this.layers.scene.entry(id);
  }
  /** `var system=get_layer_info`: the current actor of layer `id`, undefined without one. */
  layerInfo(id: string): ArtemisLayerInfo | undefined {
    const actor = this.layers.scene.entry(id)?.value;
    if (actor === undefined) return undefined;
    if (!this.host.layerInfo) throw new Error('Unsupported Artemis layer info owner');
    return this.host.layerInfo(actor);
  }
  /** The registered transition tween is still running. */
  get transitionPending(): boolean {
    return !!this.transitionTween && !this.transitionTween.done;
  }
  /** Steps the transition tween to `now`. */
  tickTransition(now: number): void {
    if (this.transitionPending) this.transitionTween!.tick(now);
  }
  /** Runs the pending transition tween from `start` (nonzero uint32) to its natural end
   * and returns the end tick. */
  finishTransition(start: number): number {
    const tween = this.transitionTween;
    if (!tween || tween.done || !start) throw Error('No pending Artemis transition');
    const end = (start + tween.milliseconds) >>> 0;
    tween.tick(start);
    tween.tick(end);
    return end;
  }
  /** Attaches a message layer's actor at `name` (stage message-layer wrapper). */
  attachMessageActor(name: string, message: M, owner: ArtemisMessageActorOwner<M>): void {
    const actor = this.host.createMessageActor(message, owner);
    if (!this.layers.attachActor(name, actor))
      throw Error('Artemis message scene attachment blocked: ' + name);
    this.host.trace?.({kind: 'messageAttach', id: name, simulation: true});
  }
  detachMessageActor(name: string): void {
    this.layers.detachActor(name);
  }
  /** bf210 order: finish the registered transition tween, then replace the scene root. */
  reset(): void {
    this.transition.reset();
    if (this.transitionTween?.done) this.transitionTween = null;
    this.layers.reset();
    this.host.trace?.({kind: 'reset', simulation: true});
  }
  /** Save-object reset of the layer command registry. */
  clearLayerCommands(): void {
    this.commands.clearAll();
  }
  /** Save-object +0x68 layer command registry for the scenario save and load. */
  snapshotLayerCommands(): ReadonlyMap<string, readonly AsbTag[]> {
    return this.commands.snapshot();
  }
  restoreLayerCommands(snapshot: ReadonlyMap<string, readonly AsbTag[]>): void {
    this.commands.restore(snapshot);
  }
  /** Ids in native child order whose actor has an enabled `click` event and whose layer
   * and ancestors are visible. */
  clickableLayers(): string[] {
    return this.eventLayers('click');
  }
  /** Ids in native child order whose actor has an enabled event of `type` and whose layer
   * and ancestors are visible; `registered` also requires a stored callback. */
  eventLayers(type: ArtemisLayerEventType, registered = false): string[] {
    const scene = this.layers.scene;
    const visible = (id: string) => {
      const parts = id.split('.');
      for (let length = 1; length <= parts.length; length++) {
        const value = scene.entry(parts.slice(0, length).join('.'))?.value as
          {properties?: {visible?: boolean}} | undefined;
        if (value?.properties && value.properties.visible === false) return false;
      }
      return true;
    };
    return scene
      .entries()
      .filter(({id, value}) => {
        const slots = value === undefined ? undefined : this.slots.get(value);
        return (
          !!slots?.isEnabled(type) && (!registered || slots.callback(type) !== null) && visible(id)
        );
      })
      .map(({id}) => id);
  }
  /** Invokes an actor's stored layer event callback. */
  /** The layer exists and has an enabled `type` event. */
  hasLayerEvent(id: string, type: ArtemisLayerEventType): boolean {
    const actor = this.layers.scene.entry(id)?.value;
    return !!actor && !!this.slots.get(actor)?.isEnabled(type);
  }
  invokeLayerEvent(id: string, type: ArtemisLayerEventType, sink: ArtemisLayerEventSink): boolean {
    const actor = this.layers.scene.entry(id)?.value;
    const slots = actor && this.slots.get(actor);
    if (!slots) throw Error('Artemis layer has no events: ' + id);
    if (!slots.isEnabled(type)) throw Error('Artemis layer event disabled: ' + id);
    return slots.invoke(type, sink);
  }
  /** trans runs synchronously except rule loads, which return a promise. */
  dispatchTransition(tag: AsbTag): boolean | Promise<void> {
    return this.transition.dispatch(tag);
  }
  accepts(tag: AsbTag): boolean {
    return ['lyc', 'lyprop', 'lydel', 'flip', 'lyevent', 'anime', 'animedel', 'video'].includes(
      tag.name,
    );
  }
  /** `recordHistory` false is the native replay flag of the scenario loader. */
  dispatch(tag: AsbTag, recordHistory = true): Promise<boolean> {
    return tag.name === 'flip'
      ? Promise.resolve(this.stage.dispatch(tag))
      : tag.name === 'lyevent'
        ? Promise.resolve(this.events.dispatch(tag, !recordHistory))
        : this.layers.dispatch(tag, recordHistory);
  }
  close(): void {
    this.layers.close();
  }
}
