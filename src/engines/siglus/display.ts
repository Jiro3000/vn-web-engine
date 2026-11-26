import type {ByteSource} from '../../core/source.js';
import {workerSourceOf, type WorkerSource} from '../../core/worker-source.js';
import {BrowserWindowDisplayHost} from '../../platform/browser-window-display.js';
import {WorkerPool} from '../../platform/worker-pool.js';
import {
  domTextClasses,
  domTextFamily,
  getDomTextStyle,
  subscribeDomTextStyle,
} from '../../text/dom-text-style.js';
import {readSfntFontMetadata} from '../../formats/sfnt.js';
import {readGan} from '../../formats/siglus/gan.js';
import {G00Image, type G00Frame, type G00Resource} from '../../formats/siglus/g00.js';
import {readSiglusToneCurves, type SiglusToneCurve} from '../../formats/siglus/tonecurve.js';
import {SiglusOmvPlayback} from '../../video/siglus-omv-playback.js';
import {captureLayers, encodeCaptureBmp} from './capture.js';
import {siglusFontShadow, type SiglusFontChoice} from './configuration.js';
import {
  computeAlignedNameLeft,
  computeColorMatrix,
  computeObjectPlacement,
  computeSpriteOffset,
  computeWakuButtonOrigin,
  listConfiguredWakuIndices,
  parseButtonActionStates,
  parseIconConfig,
  parseMwndColors,
  parseMwndLayout,
  parseSpaceHideObjectIds,
  parseWakuConfig,
  type ButtonActionSet,
  type ButtonActionState,
  type IconConfig,
  type MwndAnimation,
  type MwndLayout,
  type NameAlign,
  type WakuConfig,
} from './mwnd.js';
import {layoutObjectText} from './object-text.js';
import {
  layoutSelbtnItems,
  readSelbtnTemplate,
  selbtnPresentation,
  type SelbtnCall,
  type SelbtnTemplate,
} from './selbtn.js';
import {eventEasing} from './timing.js';
import {
  fanWipeMask,
  g00MaskValues,
  type CustomMaskWipe,
  type FanWipe,
} from './wipe.js';

export type WipeSpec = FanWipe | CustomMaskWipe;

const svgNamespace = 'http://www.w3.org/2000/svg';
let nextWipeMaskId = 0;
const isLittleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
const GRAPHIC_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const GRAPHIC_CACHE_MAX_ENTRIES = 256;
const COMPOSITE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const COMPOSITE_CACHE_MAX_ENTRIES = 96;

interface SiglusTextFragment {
  text: string;
  ruby?: string;
  color?: number;
}

export interface SiglusHistoryEntry {
  name: string;
  text: readonly SiglusTextFragment[];
  voices: readonly {id: number; character?: number}[];
}

interface SiglusMessageSnapshot extends Omit<SiglusHistoryEntry, 'voices'> {
  face?: string;
  faceCostume?: string;
  index: number;
  size?: number;
  slideTime?: number;
  position?: readonly [number, number];
  textColors?: [number, number][];
}

export interface Graphic {
  image: CanvasImageSource;
  width: number;
  height: number;
  x: number;
  y: number;
  centerX: number;
  centerY: number;
  contentBounds?: G00Frame['contentBounds'];
  pixels?: Uint8ClampedArray;
}

export interface SiglusCaptureOptions {
  limit?: readonly [order: number, layer: number];
  overlay?: string;
  size?: readonly [width: number, height: number];
}

export interface ObjectIntEvent {
  mode: 0 | 1 | 2;
  from: number;
  target: number;
  duration: number;
  delay: number;
  easing: number;
  started: number;
  endAt: number;
}

/** Evaluates a Siglus object intEvent at timestamp `now`, returning undefined once a one-shot event finishes. */
export function evalObjectIntEvent(ev: ObjectIntEvent, now: number): number | undefined {
  const elapsed = now - ev.started;
  if (ev.duration <= 0) return elapsed < ev.delay ? ev.from : ev.mode === 0 ? undefined : ev.target;
  if (elapsed < ev.delay) return ev.from;
  const t = elapsed - ev.delay;
  let p: number;
  if (ev.mode === 0) {
    if (t >= ev.duration) return undefined;
    p = t / ev.duration;
  } else if (ev.mode === 1) {
    p = (t % ev.duration) / ev.duration;
  } else {
    const cycle = Math.floor(t / ev.duration);
    const frac = (t % ev.duration) / ev.duration;
    p = cycle & 1 ? 1 - frac : frac;
  }
  const eased =
    ev.easing === 0
      ? p
      : ev.easing === 1
        ? p * p
        : ev.easing === 2
          ? 1 - (1 - p) * (1 - p)
          : p >= 1
            ? 1
            : 0;
  return ev.from + (ev.target - ev.from) * eased;
}

interface ObjectGanCheckpoint {
  file: string;
  sequence?: number;
  loop?: boolean;
  elapsed?: number;
}

export interface DrawObject {
  type?: number;
  name: string;
  frames: (Graphic | undefined)[];
  x: number;
  y: number;
  visible: boolean;
  layer?: number;
  order?: number;
  transparency?: number;
  trOffsets?: number[];
  flags?: number[];
  pattern: number;
  scale?: readonly [number, number];
  scaleEvents?: DrawObject['positionEvents'];
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  center?: readonly [number, number];
  centerRep?: readonly [number, number];
  colorProps?: {
    bright?: number;
    dark?: number;
    mono?: number;
    reverse?: number;
    colorR?: number;
    colorG?: number;
    colorB?: number;
    colorRate?: number;
    addR?: number;
    addG?: number;
    addB?: number;
  };
  intEvents?: Map<string, ObjectIntEvent>;
  mask?: number;
  blend?: number;
  tonecurveNo?: number;
  wipeCopy?: boolean;
  rect?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    r: number;
    g: number;
    b: number;
    a: number;
  };
  positionEvents?: Partial<
    Record<
      'x' | 'y',
      {
        from: number;
        started: number;
        time: KeyframeAnimationOptions;
      }
    >
  >;
  positionOffsets?: Partial<Record<'x' | 'y', number[]>>;
  offsetEventCounts?: Partial<Record<'x' | 'y' | 'tr', number>>;
  frameActionChannelCount?: number;
  offsetEvents?: Partial<
    Record<'x' | 'y', Map<number, {from: number; started: number; time: KeyframeAnimationOptions}>>
  >;
  patternCycle?: {count: number; duration: number; started: number};
  button?: {
    id: number;
    group: number;
    actionNo?: number;
    seNo?: number;
    buttonCall?: {scene: string; command: string};
  };
  buttonCall?: {scene: string; command: string};
  children?: Map<number, DrawObject>;
  childCount?: number;
  movie?: SiglusOmvPlayback;
  movieMeta?: {loop: boolean; autoFree: boolean; readyOnly: boolean};
  text?: {
    value: string;
    font?: string;
    size: number;
    bold: boolean;
    shadow: number;
    spaceX?: number;
    spaceY?: number;
    maxChars?: number;
    color?: number;
    shadowColor?: number;
    outlineColor?: number;
    shadowMode?: number;
  };
  weather?: {mode: 0 | 1 | 2; params: Record<number, number>; started: number};
  gan?: ObjectGanCheckpoint & {started?: number};
  number?: {
    value: number;
    ketaMax: number;
    dispZero: number;
    dispSign: number;
    tumeruSign: number;
    spaceMod: number;
    space: number;
  };
  clip?: [number, number, number, number, number];
  sourceClipEnabled?: boolean;
  sourceClipBounds?: [number, number, number, number];
  pushKeep?: boolean;
  alphaTest?: boolean;
  disabled?: boolean;
  buttonState?: 'normal' | 'select' | 'disable';
  slotId?: number;
  opacity?: [target: number, duration: number, delay: number, easing: number, start: number];
  opacityStarted?: number;
  opacityElapsed?: number;
  horizontalMotion?: {
    from: number;
    duration: number;
    delay: number;
    easing: number;
    started: number;
  };
  movement?: [target: number, duration: number, delay: number, easing: number, start: number];
  movementStarted?: number;
}

export interface SiglusGanCheckpoint {
  slot?: number;
  name: string;
  sequence: number;
  loop: boolean;
  x: number;
  y: number;
  elapsed: number;
}

export interface SiglusMovieEffectCheckpoint {
  slot: number;
  name: string;
  layer: number;
  scale: readonly [number, number];
  loop: boolean;
  elapsed: number;
}

type GanLayer = {
  checkpoint: SiglusGanCheckpoint;
  layer: HTMLElement;
  animations: Animation[];
};
type MovieEffectLayer = {
  checkpoint: SiglusMovieEffectCheckpoint;
  layer: HTMLElement;
  movie: SiglusOmvPlayback;
};
export interface SiglusRectangleEffectCheckpoint {
  slot: number;
  layer: number;
  rectangles: readonly (readonly [x: number, y: number, width: number, height: number])[];
  rgba: readonly [number, number, number, number];
  retire?: boolean;
}

type RectangleEffect = {geometry: SiglusRectangleEffectCheckpoint};
type StageEffect = GanLayer | MovieEffectLayer | RectangleEffect;
type BackgroundPan = {
  from: [number, number];
  to: [number, number];
  time: number;
  scale?: [number, number];
};
export type SiglusBackground = {name: string; pan?: BackgroundPan};

export interface SiglusCastPlacement {
  position: [x: number, y: number];
  drawOrder?: [layer: number, objectId: number];
}

export interface SiglusFrameAction {
  id: number;
  type: string;
  state: number | undefined;
  slot: number | undefined;
  sound: number;
  call: string | undefined;
}

export interface SerializedDrawObject {
  type?: number;
  name: string;
  x: number;
  y: number;
  visible: boolean;
  layer?: number;
  order?: number;
  transparency?: number;
  opacity?: {values: NonNullable<DrawObject['opacity']>; elapsed: number};
  trOffsets?: number[];
  flags?: number[];
  pattern: number;
  scale?: [number, number];
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  center?: [number, number];
  centerRep?: [number, number];
  colorProps?: DrawObject['colorProps'];
  mask?: number;
  blend?: number;
  tonecurveNo?: number;
  wipeCopy?: boolean;
  rect?: DrawObject['rect'];
  positionOffsets?: DrawObject['positionOffsets'];
  offsetEventCounts?: DrawObject['offsetEventCounts'];
  offsetEvents?: Partial<Record<'x' | 'y', [number, {
    from: number;
    elapsed: number;
    time: KeyframeAnimationOptions;
  }][]>>;
  frameActionChannelCount?: number;
  button?: DrawObject['button'];
  buttonCall?: {scene: string; command: string};
  childCount?: number;
  children?: [number, SerializedDrawObject][];
  movieMeta?: DrawObject['movieMeta'];
  text?: DrawObject['text'];
  weather?: {mode: 0 | 1 | 2; params: Record<number, number>};
  gan?: ObjectGanCheckpoint;
  number?: DrawObject['number'];
  clip?: [number, number, number, number, number];
  /** Bounds saved by older browser builds before the clip command shared the property fields. */
  sourceClip?: [number, number, number, number];
  sourceClipEnabled?: boolean;
  sourceClipBounds?: [number, number, number, number];
  pushKeep?: boolean;
  alphaTest?: boolean;
  disabled?: boolean;
  buttonState?: 'normal' | 'select' | 'disable';
}

function objectGanElapsed(gan: NonNullable<DrawObject['gan']>, now: number): number {
  return (gan.elapsed ?? 0) + (gan.started === undefined ? 0 : Math.max(0, now - gan.started));
}

export function serializeDrawObject(
  object: DrawObject,
  now = performance.now(),
): SerializedDrawObject {
  const opacityElapsed = object.opacityStarted === undefined
    ? (object.opacityElapsed ?? 0)
    : Math.max(0, now - object.opacityStarted);
  const offsetEvents: NonNullable<SerializedDrawObject['offsetEvents']> = {};
  for (const axis of ['x', 'y'] as const) {
    const events = object.offsetEvents?.[axis];
    if (!events?.size) continue;
    for (const [index, event] of events) {
      const elapsed = Math.max(0, now - event.started);
      if (elapsed >= Number(event.time.duration ?? 0) + Number(event.time.delay ?? 0)) continue;
      (offsetEvents[axis] ??= []).push([index, {from: event.from, elapsed, time: {...event.time}}]);
    }
  }
  return {
    type: object.type,
    name: object.name,
    x: object.x,
    y: object.y,
    visible: object.visible,
    layer: object.layer,
    order: object.order,
    transparency: object.transparency,
    // 1.1.137.0 saves and restores the active transparency event at 0x5e90a2 and 0x5ea941.
    opacity: object.opacity && opacityElapsed < object.opacity[1] + object.opacity[2]
      ? {values: [...object.opacity], elapsed: opacityElapsed}
      : undefined,
    trOffsets: object.trOffsets?.slice(),
    flags: object.flags?.slice(),
    pattern: object.pattern,
    scale: object.scale ? [object.scale[0], object.scale[1]] : undefined,
    rotateX: object.rotateX,
    rotateY: object.rotateY,
    rotateZ: object.rotateZ,
    center: object.center ? [object.center[0], object.center[1]] : undefined,
    centerRep: object.centerRep ? [object.centerRep[0], object.centerRep[1]] : undefined,
    colorProps: object.colorProps ? {...object.colorProps} : undefined,
    mask: object.mask,
    blend: object.blend,
    tonecurveNo: object.tonecurveNo,
    wipeCopy: object.wipeCopy,
    rect: object.rect ? {...object.rect} : undefined,
    positionOffsets: object.positionOffsets
      ? {
          x: object.positionOffsets.x?.slice(),
          y: object.positionOffsets.y?.slice(),
        }
      : undefined,
    offsetEventCounts: object.offsetEventCounts && {...object.offsetEventCounts},
    offsetEvents: offsetEvents.x || offsetEvents.y ? offsetEvents : undefined,
    frameActionChannelCount: object.frameActionChannelCount,
    button: object.button ? {...object.button} : undefined,
    buttonCall: object.buttonCall ? {...object.buttonCall} : undefined,
    childCount: object.childCount,
    children: object.children?.size
      ? [...object.children].map(([id, child]) => [id, serializeDrawObject(child, now)])
      : undefined,
    movieMeta: object.movieMeta ? {...object.movieMeta} : undefined,
    text: object.text ? {...object.text} : undefined,
    weather: object.weather
      ? {mode: object.weather.mode, params: {...object.weather.params}}
      : undefined,
    gan: object.gan
      ? {
          file: object.gan.file,
          sequence: object.gan.sequence,
          loop: object.gan.loop,
          // Siglus 1.1.134.0 saves and restores the GAN clock at 0x68801d and 0x688242.
          elapsed:
            object.gan.sequence === undefined
              ? undefined
              : Math.floor(objectGanElapsed(object.gan, now)),
        }
      : undefined,
    number: object.number ? {...object.number} : undefined,
    clip: object.clip ? [...object.clip] : undefined,
    sourceClipEnabled: object.sourceClipEnabled,
    sourceClipBounds: object.sourceClipBounds ? [...object.sourceClipBounds] : undefined,
    pushKeep: object.pushKeep,
    alphaTest: object.alphaTest,
    disabled: object.disabled,
    buttonState: object.buttonState,
  };
}

export function orderedObjects(
  objects: ReadonlyMap<number, DrawObject>,
  assignSlotId = false,
): DrawObject[] {
  return [...objects]
    .sort(
      ([a, first], [b, second]) =>
        (first.order ?? 0) - (second.order ?? 0) ||
        (first.layer ?? 0) - (second.layer ?? 0) ||
        a - b,
    )
    .map(([id, object]) => {
      if (assignSlotId) object.slotId = id;
      return object;
    });
}

const registeredNumberProperties = new Set<string>();

const explicitCompositeDimPattern = /^\(\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*\)$/;
const compositeLayerPattern =
  /^([^()]+?)(?:\(\s*([+-]?\d+)\s*,\s*([+-]?\d+)(?:\s*,\s*([+-]?\d+))?(?:\s*,\s*blend\s*=\s*([+-]?\d+))?\s*\))?$/;

/** A parsed layer entry inside a Siglus composite graphic specification. */
export interface SiglusCompositeLayerSpec {
  part: string;
  name: string;
  dx: number;
  dy: number;
  pattern: number;
  blend?: string;
}

/** Parses a Siglus composite image string into optional canvas size and ordered layer specs. */
export function parseSiglusCompositeSpec(specification: string): {
  explicitDim?: {width: number; height: number};
  layers: SiglusCompositeLayerSpec[];
} {
  const tokens = specification
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const explicitMatch = explicitCompositeDimPattern.exec(tokens[0] ?? '');
  const explicitDim = explicitMatch
    ? {width: Number(explicitMatch[1]), height: Number(explicitMatch[2])}
    : undefined;
  const partTokens = explicitDim ? tokens.slice(1) : tokens;
  const layers = partTokens.map((part) => {
    const layer = compositeLayerPattern.exec(part);
    if (!layer) throw new Error('Invalid Siglus composite image component ' + part);
    return {
      part,
      name: layer[1]!.trim(),
      dx: Number(layer[2] ?? 0),
      dy: Number(layer[3] ?? 0),
      pattern: Number(layer[4] ?? 0),
      blend: layer[5],
    };
  });
  return {explicitDim, layers};
}

/** Computes composite surface dimensions, base center pivot, and per-layer blit coordinates. */
export function layoutSiglusCompositeLayers(
  layers: ReadonlyArray<{
    frame: {width: number; height: number; x: number; y: number; centerX: number; centerY: number};
    dx: number;
    dy: number;
  }>,
  explicitDim?: {width: number; height: number},
): {
  width: number;
  height: number;
  baseX: number;
  baseY: number;
  baseCenterX: number;
  baseCenterY: number;
  placements: Array<{drawX: number; drawY: number}>;
} {
  let width = explicitDim ? explicitDim.width : 0;
  let height = explicitDim ? explicitDim.height : 0;
  let baseX = 0;
  let baseY = 0;
  let baseCenterX = 0;
  let baseCenterY = 0;
  if (!explicitDim && layers.length > 0) {
    const first = layers[0]!;
    baseX = first.frame.x;
    baseY = first.frame.y;
    baseCenterX = first.frame.centerX;
    baseCenterY = first.frame.centerY;
    width = first.frame.width;
    height = first.frame.height;
    for (const [idx, {frame, dx, dy}] of layers.entries()) {
      if (idx === 0) continue;
      const right = dx + baseCenterX + frame.x - frame.centerX + frame.width;
      const bottom = dy + baseCenterY + frame.y - frame.centerY + frame.height;
      if (right > width) width = right;
      if (bottom > height) height = bottom;
    }
  }
  const placements = layers.map(({frame, dx, dy}, idx) => ({
    drawX: !explicitDim && idx === 0 ? dx : dx + baseCenterX + frame.x - frame.centerX,
    drawY: !explicitDim && idx === 0 ? dy : dy + baseCenterY + frame.y - frame.centerY,
  }));
  return {width, height, baseX, baseY, baseCenterX, baseCenterY, placements};
}

function isCompositeGraphic(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.includes('|') ||
    /\(\s*[+-]?\d+\s*,\s*[+-]?\d+(?:\s*,\s*[+-]?\d+)?(?:\s*,\s*blend\s*=\s*[+-]?\d+)?\s*\)$/.test(trimmed)
  );
}

function embeddedCut(files: ReadonlyMap<string, unknown>, name: string): [string, number] | undefined {
  if (files.has(`g00/${name.toLowerCase()}.g00`)) return;
  const cut = /^(.*?)___(\d+)$/.exec(name);
  if (cut) return [cut[1]!, Number(cut[2])];
}

function registerAnimatedNumber(name: string): void {
  if (registeredNumberProperties.has(name)) return;
  CSS.registerProperty({name, syntax: '<number>', inherits: true, initialValue: '1'});
  registeredNumberProperties.add(name);
}

export class SiglusDisplay {
  readonly stage = document.createElement('div');
  private readonly sceneLayers = document.createElement('div');
  private readonly layers = document.createElement('div');
  private readonly cast = document.createElement('div');
  private readonly effect = document.createElement('div');
  private readonly effectTint = document.createElement('div');
  private readonly activeEffects = new Map<number, StageEffect>();
  private readonly pendingEffects = new Map<number, StageEffect | null>();
  private castTransition?: Promise<void>;
  private readonly controls = document.createElement('div');
  private objectButtonGroups?: ReadonlySet<number>;
  private readonly objectMasks = new Map<
    number,
    {name?: string; url?: string; x: number; y: number}
  >();
  private readonly pendingObjectMasks = new Map<number, object>();
  private objectMaskRestoreGeneration = 0;
  private readonly spaceHideIds: ReadonlySet<number>;
  private messageDisplayed = true;
  private readonly messageFilterOverrides = new Map<
    number,
    {file: string; layer?: HTMLCanvasElement; frame?: Graphic}
  >();
  private readonly messageFrameOverrides = new Map<
    number,
    {file: string; layer?: HTMLCanvasElement; frame?: Graphic}
  >();
  private messageColors = {text: 'white', shadow: 'black', fuchi: 'black'};
  private readonly frameActionsByWaku = new Map<
    number,
    {
      action: SiglusFrameAction;
      decorative: boolean;
      element: HTMLElement;
      button?: HTMLButtonElement;
      canvas: HTMLCanvasElement;
      frames: Graphic[];
      baseCut: number;
      actionStates: ButtonActionSet;
      anchor: number;
      posX: number;
      posY: number;
      frameOrigin: {x: number; y: number; centerX: number; centerY: number};
      pointerState: 'normal' | 'hit' | 'push';
      refresh: () => void;
      motion?: Animation;
    }[]
  >();
  private readonly frameActionsLoading = new Map<number, Promise<void>>();
  private activeFrameActions: NonNullable<
    ReturnType<SiglusDisplay['frameActionsByWaku']['get']>
  > = [];
  private readonly messageButtonStates = new Map<
    string,
    {
      visible: boolean;
      posX: number;
      posY: number;
      repX: number;
      repY: number;
      patno: number;
      positionEventEnds?: Partial<Record<'x' | 'y', number>>;
    }
  >();
  private activateFrameAction?: (action: SiglusFrameAction) => void;
  private frameActionStateResolver?: (
    action: SiglusFrameAction,
  ) => 'hidden' | 'disabled' | 'enabled';
  private readonly editLayer = document.createElement('div');
  private readonly edits = new Map<number, {input: HTMLInputElement; result: string}>();
  private readonly systemLayer = document.createElement('div');
  private readonly systemFrontLayer = document.createElement('div');
  private readonly message = document.createElement('div');
  private messagePosition?: readonly [number, number];
  private readonly messageObjects = document.createElement('div');
  private readonly speaker = document.createElement('div');
  private readonly text = document.createElement('div');
  private readonly nativeText = document.createElement('canvas');
  private nativeTextTop = 0;
  private textMode: 'native' | 'dom' = 'dom';
  private textMetrics = {
    x: 0,
    y: 0,
    width: 0,
    rows: 0,
    spacing: 0,
    lineSpace: 0,
    rubySize: 13,
    rubySpace: 2,
  };
  private speakerMetrics: {x: number; y: number; align: NameAlign; spacing: number; size: number} = {
    x: 0,
    y: 0,
    align: 0,
    spacing: 0,
    size: 0,
  };
  private mwndLayout?: MwndLayout;
  private readonly wakuAssets = new Map<
    number,
    {
      config: WakuConfig;
      filterLayer?: HTMLCanvasElement;
      filterFrame?: Graphic;
      wakuLayer?: HTMLCanvasElement;
      wakuFrame?: Graphic;
    }
  >();
  private readonly waitIcons = new Map<number, {config: IconConfig; frames: Graphic[]}>();
  private waitIconElement?: HTMLCanvasElement;
  private waitIconTimer?: ReturnType<typeof setInterval>;
  private colorFilterSvg?: SVGSVGElement;
  private readonly colorFilterCache = new Map<string, string>();
  private toneCurves?: ReadonlyMap<number, SiglusToneCurve>;
  private lastFilterColor: readonly number[] = [0, 0, 0, 255];
  private readonly domBaselineOffsets = new Map<string, number>();
  private messageShadow = 2;
  private readonly portrait = document.createElement('div');
  private readonly media = new Map<string, Promise<G00Image>>();
  private g00Worker?: WorkerPool<WorkerSource, G00Resource>;
  private readonly graphicCache = new Map<string, {graphic: Graphic; bytes: number}>();
  private graphicCacheBytes = 0;
  private readonly inFlightGraphics = new Map<string, Promise<Graphic>>();
  private readonly compositeCache = new Map<string, {graphic: Graphic; bytes: number}>();
  private compositeCacheBytes = 0;
  private readonly inFlightComposites = new Map<string, Promise<Graphic>>();
  private readonly maskUrlCache = new Map<string, string>();
  private readonly maskWipeCache = new Map<string, CustomMaskWipe>();
  private readonly hitPaths = new WeakMap<Graphic, string>();
  private background?: HTMLElement;
  private objectLayer?: HTMLElement;
  private positionTargets?: WeakMap<HTMLElement, {
    object: DrawObject;
    originX: number;
    originY: number;
  }>;
  private stageGeneration = 0;
  private refreshGeneration = 0;
  private activeWipeLayer?: HTMLElement;
  private readonly wipeMaskUrlCache = new WeakMap<WipeSpec, string>();
  private dynamicColorFilterId = 0;
  private readonly systemLayerDraws = new WeakMap<HTMLElement, object>();
  private wipe?: Animation;
  private systemInput = false;
  private readonly keys = [this.inputKey(), this.inputKey()];
  private readonly vkDown = new Set<number>();
  private readonly vkPressed = new Set<number>();
  private readonly vkReleased = new Set<number>();
  private readonly disabledShortcutKeys = new Set<number>();
  private wheelDelta = 0;
  private sampledWheel = 0;
  private pressed?: {id: number; group: number};
  private heldButton?: {
    pointerId: number;
    pushKeep: boolean;
    element: HTMLButtonElement;
    target: {id: number; group: number};
    release: () => void;
  };
  private hovered?: {id: number; group: number};
  private hoveredControlKey?: string;
  private pointer: [number, number] = [-1, -1];
  private currentFace?: string;
  private currentFaceCostume?: string;
  private currentName = '';
  private currentText: SiglusTextFragment[] = [];
  private messageTextColors = new Map<number, number>();
  private messageVisibilityAnimation?: Animation;
  private pendingOpenAnimation?: MwndAnimation;
  private selectionTemplate?: SelbtnTemplate;
  private windowIndex = 0;
  private frameIndex = 0;
  private defaultTextSize = 38;
  private messageTextSize = 0;
  private ruby = '';
  private slideTime?: number;
  private slideOffset = 0;
  private slideTarget = 0;
  private slideOrigin = 0;
  private slideStarted = 0;
  private slideFrame = 0;
  private filter?: HTMLCanvasElement;
  private filterFrame?: Graphic;
  readonly windowDisplay: BrowserWindowDisplayHost;
  private readonly click: (event: MouseEvent) => void;
  private readonly pointerDown: (event: PointerEvent) => void;
  private readonly key: (event: KeyboardEvent) => void;

  constructor(
    readonly root: HTMLElement,
    private readonly files: ReadonlyMap<string, ByteSource>,
    private readonly config: ReadonlyMap<string, string>,
    readonly width: number,
    readonly height: number,
    private readonly signal: AbortSignal,
    private readonly advance: () => void,
    windowOptions: {root: HTMLElement; changed(): void; report(message: string): void},
    skip: (active: boolean) => void,
    cancel: () => boolean,
    private readonly onButtonSound?: (seNo: number, kind: 'hit' | 'push' | 'decide') => void,
    toggleHideMessage?: () => boolean,
  ) {
    this.spaceHideIds = parseSpaceHideObjectIds(config);
    root.replaceChildren(this.stage);
    this.stage.dataset.textMode = this.textMode;
    // Keep focus and history scrolling from moving the fixed game viewport.
    this.stage.style.cssText =
      'position:absolute;overflow:clip;isolation:isolate;background:#000;color:white';
    this.layers.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.message.style.cssText = 'position:absolute;isolation:isolate;pointer-events:none';
    this.messageObjects.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.speaker.style.cssText = 'position:absolute;white-space:pre;text-shadow:0 1px 4px #000';
    this.text.style.cssText =
      'position:absolute;white-space:pre-wrap;overflow-wrap:anywhere;text-shadow:0 1px 4px #000';
    for (const element of [this.speaker, this.text]) {
      element.classList.add(domTextClasses.text, domTextClasses.horizontal);
      element.dataset.gameText = '';
      element.style.pointerEvents = 'auto';
      element.style.userSelect = 'text';
      element.style.cursor = 'text';
    }
    this.text.classList.add(domTextClasses.multiline);
    this.message.classList.add('game-glyph-slots');
    const unsubscribeStyle = subscribeDomTextStyle(() => this.styleMessageText());
    signal.addEventListener('abort', unsubscribeStyle, {once: true});
    this.portrait.style.cssText = 'position:absolute;overflow:hidden';
    this.cast.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.effect.style.cssText = 'position:absolute;inset:0;pointer-events:none;isolation:isolate';
    this.effectTint.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none';
    this.effect.append(this.effectTint);
    this.controls.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.controls.hidden = true;
    this.systemLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.systemFrontLayer.style.cssText = this.systemLayer.style.cssText;
    this.editLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3';
    this.sceneLayers.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.sceneLayers.dataset.siglusSceneLayers = '';
    this.sceneLayers.append(
      this.layers,
      this.cast,
      this.effect,
      this.message,
      this.controls,
      this.systemFrontLayer,
      this.systemLayer,
      this.editLayer,
    );
    this.stage.append(this.sceneLayers);
    this.nativeText.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.nativeText.dataset.siglusNativeText = '';
    this.nativeText.hidden = true;
    this.message.append(
      this.portrait,
      this.nativeText,
      this.speaker,
      this.text,
      this.messageObjects,
    );
    this.message.hidden = true;
    this.windowDisplay = new BrowserWindowDisplayHost(
      windowOptions.root,
      root,
      this.stage,
      windowOptions.changed,
      windowOptions.report,
      this.stage,
      false,
    );
    this.windowDisplay.configure({width, height, fullscreen: false});
    this.click = () => {
      if (this.hasTextSelection()) return;
      this.advance();
    };
    const pushKey = (index: number, down: boolean): void => {
      const pending = this.keys[index]!.pending;
      if (pending.length >= 8) pending.shift();
      pending.push(down);
    };
    this.pointerDown = (event) => {
      if (event.button === 0 || event.button === 2) {
        if (this.systemInput && !(event.target as Element).closest('[data-siglus-button]')) {
          this.stage.setPointerCapture(event.pointerId);
        }
        pushKey(event.button === 0 ? 0 : 1, true);
      }
      if (event.button === 0 && this.hasTextSelection())
        this.stage.ownerDocument.getSelection()?.removeAllRanges();
    };
    this.key = (event) => {
      const vk = event.keyCode || 0;
      if (vk > 0 && vk < 256) {
        if (event.type === 'keydown') {
          if (!this.vkDown.has(vk)) this.vkPressed.add(vk);
          this.vkDown.add(vk);
        } else {
          this.vkDown.delete(vk);
          this.vkReleased.add(vk);
        }
      }
      if (this.disabledShortcutKeys.has(vk)) {
        event.preventDefault();
        return;
      }
      if (
        event.key === ' ' &&
        event.type === 'keydown' &&
        event.target === this.stage &&
        !event.repeat &&
        !this.systemInput &&
        toggleHideMessage?.()
      ) {
        event.preventDefault();
        return;
      }
      const keyIndex =
        event.key === 'Escape' ? 1 : event.key === 'Enter' || event.key === ' ' ? 0 : -1;
      if (keyIndex !== -1 && !event.repeat) {
        pushKey(keyIndex, event.type === 'keydown');
      }
      if (
        event.key === 'Escape' &&
        event.type === 'keydown' &&
        event.target === this.stage &&
        !event.repeat &&
        cancel()
      ) {
        event.preventDefault();
        return;
      }
      if (this.systemInput && event.target === this.stage && keyIndex !== -1) {
        event.preventDefault();
        return;
      }
      if (event.key === 'Control') skip(event.type === 'keydown' && !this.hasTextSelection());
      if (
        event.type === 'keydown' &&
        (event.key === 'Enter' || event.key === ' ') &&
        event.target === this.stage &&
        !event.repeat
      ) {
        event.preventDefault();
        this.advance();
      }
    };
    this.stage.tabIndex = 0;
    this.stage.addEventListener('click', this.click);
    this.stage.addEventListener('pointerdown', this.pointerDown);
    this.stage.addEventListener('pointerenter', (event) => this.trackPointer(event));
    this.stage.addEventListener('pointermove', (event) => this.trackPointer(event));
    this.stage.addEventListener('pointerdown', (event) => this.trackPointer(event));
    this.stage.addEventListener('pointerleave', () => {
      this.hovered = undefined;
      this.hoveredControlKey = undefined;
      this.pointer = [-1, -1];
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
      this.stage.addEventListener(type, (event) => {
        if (type === 'pointerup' && (event.button === 0 || event.button === 2))
          pushKey(event.button === 0 ? 0 : 1, false);
        if (type === 'pointercancel') this.clearInput(true);
        this.pressed = undefined;
        const held = this.heldButton;
        if (held?.pointerId !== event.pointerId) return;
        this.heldButton = undefined;
        if (type === 'pointerup') {
          this.trackPointer(event);
          if (
            held.pushKeep ||
            (!held.element.isConnected &&
              this.hovered?.id === held.target.id &&
              this.hovered?.group === held.target.group)
          ) {
            held.release();
          }
        }
      });
    this.stage.addEventListener('contextmenu', (event) => {
      if (!this.hasTextSelection() && cancel()) {
        event.preventDefault();
        return;
      }
      if (this.systemInput) event.preventDefault();
    });
    this.stage.addEventListener(
      'wheel',
      (event) => {
        if (!this.systemInput || !event.deltaY) return;
        event.preventDefault();
        this.wheelDelta -= Math.sign(event.deltaY);
      },
      {passive: false},
    );
    this.stage.addEventListener('keydown', this.key);
    this.stage.addEventListener('keyup', this.key);
    this.stage.addEventListener('focusout', (event) => this.handleStageFocusOut(event, skip));
    this.stage.focus({preventScroll: true});
  }

  private handleStageFocusOut(event: FocusEvent, skip: (active: boolean) => void): void {
    if (this.stage.contains(event.relatedTarget as Node | null)) return;
    // Layer replacement restores focus synchronously after the focused control is removed.
    queueMicrotask(() => {
      const doc = this.stage.ownerDocument;
      if (doc.hasFocus() && this.stage.contains(doc.activeElement)) return;
      skip(false);
      this.clearInput(true);
    });
  }

  private preserveStageFocus(mutate: () => void): void {
    const doc = this.stage.ownerDocument;
    const hadFocus = this.stage.contains(doc.activeElement);
    mutate();
    if (hadFocus && !this.stage.contains(doc.activeElement)) {
      this.stage.focus({preventScroll: true});
    }
  }

  private hasTextSelection(): boolean {
    const selection = this.stage.ownerDocument.getSelection();
    return Boolean(
      selection && !selection.isCollapsed && this.message.contains(selection.anchorNode),
    );
  }

  private trackPointer(event: PointerEvent): void {
    const bounds = this.stage.getBoundingClientRect();
    this.pointer = [
      Math.trunc(((event.clientX - bounds.left) * this.width) / bounds.width),
      Math.trunc(((event.clientY - bounds.top) * this.height) / bounds.height),
    ];
    this.trackHoveredButton(event.target as Element);
  }

  movePointer(x: number, y: number): void {
    const bounds = this.stage.getBoundingClientRect();
    this.pointer = [x | 0, y | 0];
    const target = this.stage.ownerDocument.elementFromPoint(
      bounds.left + x * bounds.width / this.width,
      bounds.top + y * bounds.height / this.height,
    );
    this.trackHoveredButton(target && this.stage.contains(target) ? target : null);
  }

  private trackHoveredButton(target: Element | null): void {
    const button = target?.closest<HTMLButtonElement>('[data-siglus-button]');
    const activeButton =
      button && !button.disabled && !button.closest('[inert]') ? button : undefined;
    this.hovered = activeButton
      ? {id: Number(activeButton.dataset.siglusButton), group: Number(activeButton.dataset.siglusGroup)}
      : undefined;
    const wakuButton = activeButton
      ? undefined
      : target?.closest<HTMLButtonElement>('[data-siglus-waku-button]');
    const activeWaku =
      wakuButton && !wakuButton.disabled && !wakuButton.closest('[inert]') ? wakuButton : undefined;
    const controlKey = activeButton?.dataset.siglusHoverKey ?? activeWaku?.dataset.siglusHoverKey;
    if (!controlKey || (this.hoveredControlKey !== undefined && this.hoveredControlKey !== controlKey)) {
      this.hoveredControlKey = undefined;
    }
  }

  private enterButtonHover(key: string, seNo: number | undefined): void {
    if (this.hoveredControlKey === key) return;
    this.hoveredControlKey = key;
    if (seNo !== undefined && seNo >= 0) this.onButtonSound?.(seNo, 'hit');
  }

  private leaveButtonHover(key: string, element: HTMLElement): void {
    // Layer rebuilds mark the outgoing layer inert and detach old <button> nodes;
    // ignore synthetic leave events from replaced nodes so stationary hover stays active.
    if (!element.isConnected || element.closest('[inert]')) return;
    if (this.hoveredControlKey === key) this.hoveredControlKey = undefined;
  }

  private syncHoverAfterDomUpdate(): void {
    const [x, y] = this.pointer;
    if (x < 0 || y < 0) {
      this.hovered = undefined;
      this.hoveredControlKey = undefined;
      return;
    }
    const bounds = this.stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const target = this.stage.ownerDocument.elementFromPoint(
      bounds.left + (x * bounds.width) / this.width,
      bounds.top + (y * bounds.height) / this.height,
    );
    this.trackHoveredButton(target && this.stage.contains(target) ? target : null);
  }

  buttonState(group: number, pressed: boolean): number {
    const button = pressed ? this.pressed : this.hovered;
    return button?.group === group ? button.id : -1;
  }

  syncObjectButtonGroups(groups: ReadonlySet<number>): void {
    this.objectButtonGroups = groups;
    for (const control of this.stage.querySelectorAll<HTMLButtonElement>('button[data-siglus-group]'))
      control.inert = !groups.has(Number(control.dataset.siglusGroup));
    if (this.hovered && !groups.has(this.hovered.group)) {
      this.hovered = undefined;
      if (this.hoveredControlKey?.startsWith('obj:')) this.hoveredControlKey = undefined;
    }
    this.syncHoverAfterDomUpdate?.();
  }

  pointerPosition(axis: number): number {
    return this.pointer[axis]!;
  }

  setMessageDisplayed(displayed: boolean): void {
    this.messageDisplayed = displayed;
    const visibility = displayed ? '' : 'hidden';
    this.message.style.visibility = visibility;
    this.controls.style.visibility = visibility;
    for (const el of this.layers.querySelectorAll<HTMLElement>('[data-siglus-space-hide="1"]')) {
      el.style.visibility = visibility;
    }
  }

  setScenePaused(paused: boolean): void {
    const animations = [
      ...this.sceneLayers.getAnimations(),
      ...[this.layers, this.cast, this.effect].flatMap((layer) =>
        layer.getAnimations({subtree: true}),
      ),
    ];
    for (const effect of this.activeEffects.values()) {
      if (!('movie' in effect)) continue;
      if (paused) effect.movie.pause();
      else effect.movie.play();
    }
    for (const animation of new Set(animations)) {
      if (paused && animation.playState === 'running') animation.pause();
      else if (!paused && animation.playState === 'paused') animation.play();
    }
  }

  private inputKey(): {
    down: boolean;
    edge?: boolean;
    pending: boolean[];
  } {
    return {down: false, pending: []};
  }

  clearInput(reset = false): void {
    for (const key of this.keys) {
      key.edge = undefined;
      key.pending.length = 0;
      if (reset) key.down = false;
    }
    this.sampledWheel = 0;
    if (reset) {
      this.wheelDelta = 0;
      this.vkDown.clear();
      this.vkPressed.clear();
      this.vkReleased.clear();
    }
  }

  virtualKeyState(vk: number, command: number): number {
    switch (command) {
      case 1: {
        // on_down (0x54f1c0)
        const v = this.vkPressed.has(vk);
        this.vkPressed.delete(vk);
        return Number(v);
      }
      case 4: {
        const v = this.vkReleased.has(vk);
        this.vkReleased.delete(vk);
        return Number(v);
      }
      case 5:
      case 6:
        return Number(this.vkDown.has(vk));
      case 7:
        return Number(!this.vkDown.has(vk));
      default:
        return 0;
    }
  }

  setShortcutKeyDisabled(vk: number, disabled: boolean): void {
    if (vk < 0 || vk >= 256) return;
    if (disabled) this.disabledShortcutKeys.add(vk);
    else this.disabledShortcutKeys.delete(vk);
  }

  sampleInput(): void {
    for (const key of this.keys) {
      const next = key.pending.shift();
      key.edge = next !== undefined && next !== key.down ? next : undefined;
      if (next !== undefined) key.down = next;
    }
    this.sampledWheel = this.wheelDelta;
    this.wheelDelta = 0;
  }

  inputState(index: number, command: number): number | undefined {
    const key = this.keys[index]!;
    switch (command) {
      case 1: // on_down
        return Number(key.edge === true);
      case 4: // on_up
      case 5: // on_down_up
        return Number(key.edge === false);
      case 6: // is_down
        return Number(key.down);
      case 7: // is_up
        return Number(!key.down);
    }
  }

  inputWheel(): number {
    return this.sampledWheel;
  }

  setSystemInput(active: boolean): void {
    this.systemInput = active;
    this.clearInput(true);
    this.layers.inert = active;
    this.message.inert = active;
    this.controls.inert = active;
    this.stage.focus({preventScroll: true});
    this.syncHoverAfterDomUpdate();
  }

  async showSystemObjects(
    objects: Iterable<DrawObject>,
    button: (target: NonNullable<DrawObject['button']>) => void,
    front = false,
    duration = 0,
    speedMode = 0,
  ): Promise<void> {
    const container = front ? this.systemFrontLayer : this.systemLayer;
    const draw = {};
    this.systemLayerDraws.set(container, draw);
    const next = await this.drawObjects(objects, button, true, front ? 'systemFront' : 'system');
    this.signal.throwIfAborted();
    if (this.systemLayerDraws.get(container) !== draw) return;
    if (duration > 0 && typeof next.animate === 'function') {
      const easing = eventEasing(speedMode);
      const previous = [...container.children] as HTMLElement[];
      this.preserveStageFocus(() => {
        for (const child of previous) child.inert = true;
        if (next.childElementCount > 0) container.append(next);
      });
      const animations: Animation[] = [];
      if (next.childElementCount > 0) {
        animations.push(next.animate({opacity: [0, 1]}, {duration, easing}));
      }
      if (previous.length > 0) {
        for (const child of previous) {
          animations.push(child.animate({opacity: [1, 0]}, {duration, easing, fill: 'forwards'}));
        }
      }
      if (animations.length > 0) {
        const primary = animations[0]!;
        this.wipe = primary;
        try {
          await Promise.all(animations.map((a) => a.finished));
        } finally {
          if (this.wipe === primary) this.wipe = undefined;
        }
      }
      this.preserveStageFocus(() => {
        for (const child of previous) child.remove();
      });
      this.syncHoverAfterDomUpdate();
      return;
    }
    this.preserveStageFocus(() => {
      for (const child of container.children) (child as HTMLElement).inert = true;
      container.replaceChildren(next);
    });
    this.syncHoverAfterDomUpdate();
  }

  editBox(
    id: number,
    command: number,
    n: (index: number) => number,
    s: (index: number) => string,
  ): number | string | undefined {
    const edit = this.edits.get(id);
    if (command === 0) {
      edit?.input.remove();
      const input = document.createElement('input');
      const state = {input, result: ''};
      input.type = 'text';
      input.style.cssText = `position:absolute;left:${n(0)}px;top:${n(1)}px;width:${n(2)}px;height:${n(3)}px;font-size:${n(4)}px;box-sizing:border-box;pointer-events:auto`;
      input.setAttribute('aria-label', 'Save comment');
      input.addEventListener('keydown', (event) => {
        if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape')) return;
        event.preventDefault();
        event.stopPropagation();
        state.result = event.key;
      });
      input.addEventListener('pointerdown', (event) => event.stopPropagation());
      input.addEventListener('click', (event) => event.stopPropagation());
      this.edits.set(id, state);
      this.editLayer.append(input);
      return 0;
    }
    if (command === 1) {
      if (edit) {
        edit.input.remove();
        this.edits.delete(id);
        this.stage.focus({preventScroll: true});
      }
      return 0;
    }
    if (command === 7) {
      if (edit) edit.result = '';
      return 0;
    }
    if (!edit) return undefined;
    switch (command) {
      case 2:
        edit.input.value = s(0);
        return 0;
      case 3:
        return edit.input.value;
      case 4:
        return Number(edit.result === 'Enter');
      case 5:
        return Number(edit.result === 'Escape');
      case 6:
        edit.input.focus({preventScroll: true});
        return 0;
    }
  }

  clearEdits(): void {
    this.edits.clear();
    this.preserveStageFocus(() => this.editLayer.replaceChildren());
  }

  clearSystemObjects(): void {
    this.systemLayerDraws.delete(this.systemLayer);
    this.preserveStageFocus(() => this.systemLayer.replaceChildren());
    this.syncHoverAfterDomUpdate();
  }

  clearSystemFrontObjects(): void {
    this.systemLayerDraws.delete(this.systemFrontLayer);
    this.preserveStageFocus(() => this.systemFrontLayer.replaceChildren());
    this.syncHoverAfterDomUpdate();
  }

  async prepare(): Promise<void> {
    const toneFile = this.config.get('TONECURVE_FILE')?.split('"')[1]?.toLowerCase();
    const toneSource = toneFile && this.files.get(`dat/${toneFile}`);
    if (toneSource)
      this.toneCurves = readSiglusToneCurves(await toneSource.read(0, toneSource.size, this.signal));
    for (const [key, value] of this.config) {
      if (!/^FONT_FILE\.\d+\.NAME$/.test(key)) continue;
      const name = value.split('"')[1]?.toLowerCase();
      const file = name ? this.files.get(`dat/${name}`) : undefined;
      if (!file) continue;
      const [metadata] = await readSfntFontMetadata(file);
      const bytes = new Uint8Array(await file.read(0, file.size));
      const family = 'SiglusGame' + this.loadedFonts.length;
      const font = await new FontFace(family, bytes.buffer).load();
      this.signal.throwIfAborted();
      document.fonts.add(font);
      this.loadedFonts.push(font);
      const names = metadata?.names ?? [];
      for (const entry of names)
        if ((entry.id === 1 || entry.id === 16) && entry.unicode)
          this.fontNames.set(entry.unicode.toLowerCase(), family);
      const familyName =
        names.find(({id, unicode}) => id === 16 && unicode) ??
        names.find(({id, unicode}) => id === 1 && unicode);
      if (familyName?.unicode) {
        const context = this.nativeText.getContext('2d')!;
        context.font = `16px ${family}`;
        const proportional =
          context.measureText('iiii').width !== context.measureText('WWWW').width;
        this.fontChoices.push({name: familyName.unicode, family, proportional});
      }
    }
    this.setMessageFont(this.config.get('CONFIG.FONT.NAME')?.split('"')[1]);
    await this.prepareWakuLayers();
    await this.prepareFrameActions(0);
    this.selectMessageWindow(0);
  }

  private async prepareWakuLayers(): Promise<void> {
    for (const wakuIndex of listConfiguredWakuIndices(this.config)) {
      const config = parseWakuConfig(this.config, wakuIndex);
      let filterLayer: HTMLCanvasElement | undefined;
      let filterFrame: Graphic | undefined;
      let wakuLayer: HTMLCanvasElement | undefined;
      let wakuFrame: Graphic | undefined;
      if (config.filterFile && this.files.has(`g00/${config.filterFile.toLowerCase()}.g00`)) {
        filterFrame = await this.graphic(config.filterFile);
        const offset = computeSpriteOffset(0, 0, filterFrame);
        filterLayer = this.node(filterFrame);
        filterLayer.style.left = `${offset.left}px`;
        filterLayer.style.top = `${offset.top}px`;
        filterLayer.style.zIndex = '-2';
        filterLayer.style.pointerEvents = 'none';
        filterLayer.dataset.siglusWakuFilter = String(wakuIndex);
        filterLayer.hidden = true;
        this.message.prepend(filterLayer);
      }
      if (config.wakuFile && this.files.has(`g00/${config.wakuFile.toLowerCase()}.g00`)) {
        wakuFrame = await this.graphic(config.wakuFile);
        const offset = computeSpriteOffset(0, 0, wakuFrame);
        wakuLayer = this.node(wakuFrame);
        wakuLayer.style.left = `${offset.left}px`;
        wakuLayer.style.top = `${offset.top}px`;
        wakuLayer.style.zIndex = '-1';
        wakuLayer.style.pointerEvents = 'none';
        wakuLayer.dataset.siglusWakuFrame = String(wakuIndex);
        wakuLayer.hidden = true;
        this.message.prepend(wakuLayer);
      }
      this.wakuAssets.set(wakuIndex, {
        config,
        filterLayer,
        filterFrame,
        wakuLayer,
        wakuFrame,
      });
      if (config.iconNo >= 0 && !this.waitIcons.has(config.iconNo)) {
        const iconCfg = parseIconConfig(this.config, config.iconNo);
        if (iconCfg.file && this.files.has(`g00/${iconCfg.file.toLowerCase()}.g00`)) {
          const res = await this.resource(iconCfg.file);
          const count = Math.max(1, Math.min(res.count, iconCfg.count, 64));
          const frames: Graphic[] = [];
          for (let cut = 0; cut < count; cut++) frames.push(await this.graphic(iconCfg.file, cut));
          this.waitIcons.set(config.iconNo, {config: iconCfg, frames});
        }
      }
    }
  }

  private updateWaitIcon(visible: boolean): void {
    if (this.waitIconTimer !== undefined) {
      clearInterval(this.waitIconTimer);
      this.waitIconTimer = undefined;
    }
    this.waitIconElement?.remove();
    this.waitIconElement = undefined;
    if (!visible || this.message.hidden) return;
    const asset = this.wakuAssets.get(this.frameIndex);
    if (!asset || asset.config.iconNo < 0) return;
    const icon = this.waitIcons.get(asset.config.iconNo);
    if (!icon?.frames.length) return;
    const [anchor, ix, iy] = asset.config.iconPos;
    const windowSize = this.mwndLayout?.windowSize ?? [this.width, this.height];
    const first = icon.frames[0]!;
    const origin = computeWakuButtonOrigin(anchor, [0, 0], windowSize, ix, iy, first);
    const canvas = this.node(first);
    canvas.dataset.siglusWaitIcon = String(asset.config.iconNo);
    canvas.style.left = `${origin.left}px`;
    canvas.style.top = `${origin.top}px`;
    canvas.style.zIndex = '2';
    canvas.style.pointerEvents = 'none';
    this.message.append(canvas);
    this.waitIconElement = canvas;
    if (icon.frames.length > 1) {
      let frameIndex = 0;
      const context = canvas.getContext('2d')!;
      this.waitIconTimer = setInterval(() => {
        if (!canvas.isConnected) return;
        frameIndex = (frameIndex + 1) % icon.frames.length;
        const next = icon.frames[frameIndex]!;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(next.image, 0, 0);
      }, icon.config.speed);
    }
  }

  private paintMessageFilter(
    config: WakuConfig,
    canvas: HTMLCanvasElement,
    frame: Graphic,
    [red, green, blue, alpha]: readonly number[],
  ): void {
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frame.image, 0, 0);
    if (config.filterConfigColor && (red || green || blue)) {
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = image.data[i]! + red!;
        image.data[i + 1] = image.data[i + 1]! + green!;
        image.data[i + 2] = image.data[i + 2]! + blue!;
      }
      context.putImageData(image, 0, 0);
    }
    canvas.style.opacity = config.filterConfigTr ? String(alpha! / 255) : '1';
  }

  setMessageFilter(color: readonly number[]): void {
    this.lastFilterColor = color;
    const asset = this.wakuAssets.get(this.frameIndex);
    const cfg = asset?.config ?? parseWakuConfig(this.config, Math.max(0, this.frameIndex));
    const override = this.messageFilterOverrides.get(this.windowIndex);
    if (override?.layer && override.frame) {
      this.paintMessageFilter(cfg, override.layer, override.frame, color);
      return;
    }
    if (!asset?.filterLayer || !asset.filterFrame) return;
    this.paintMessageFilter(asset.config, asset.filterLayer, asset.filterFrame, color);
  }

  private async setMessageLayerOverride(
    overrides: Map<number, {file: string; layer?: HTMLCanvasElement; frame?: Graphic}>,
    windowIndex: number,
    file: string,
    zIndex: string,
    dataKey: 'siglusWakuFilterOverride' | 'siglusWakuFrameOverride',
  ): Promise<void> {
    const prev = overrides.get(windowIndex);
    prev?.layer?.remove();
    if (!file) {
      overrides.delete(windowIndex);
      if (windowIndex === this.windowIndex) this.applyMessageFrame(this.frameIndex);
      return;
    }
    const entry: {file: string; layer?: HTMLCanvasElement; frame?: Graphic} = {file};
    overrides.set(windowIndex, entry);
    if (this.files.has(`g00/${file.toLowerCase()}.g00`)) {
      const frame = await this.graphic(file);
      if (overrides.get(windowIndex) !== entry || this.signal.aborted) return;
      const offset = computeSpriteOffset(0, 0, frame);
      const layer = this.node(frame);
      layer.style.left = `${offset.left}px`;
      layer.style.top = `${offset.top}px`;
      layer.style.zIndex = zIndex;
      layer.style.pointerEvents = 'none';
      layer.dataset[dataKey] = String(windowIndex);
      layer.hidden = true;
      this.message.prepend(layer);
      entry.frame = frame;
      entry.layer = layer;
    }
    if (windowIndex === this.windowIndex) this.applyMessageFrame(this.frameIndex);
  }

  async setMessageFilterFile(windowIndex: number, file: string): Promise<void> {
    return this.setMessageLayerOverride(
      this.messageFilterOverrides,
      windowIndex,
      file,
      '-2',
      'siglusWakuFilterOverride',
    );
  }

  async setMessageFrameFile(windowIndex: number, file: string): Promise<void> {
    return this.setMessageLayerOverride(
      this.messageFrameOverrides,
      windowIndex,
      file,
      '-1',
      'siglusWakuFrameOverride',
    );
  }

  clearMessageFilterFiles(): void {
    for (const entry of this.messageFilterOverrides.values()) entry.layer?.remove();
    this.messageFilterOverrides.clear();
  }

  clearMessageFrameFiles(): void {
    for (const entry of this.messageFrameOverrides.values()) entry.layer?.remove();
    this.messageFrameOverrides.clear();
  }

  private applyMessageFrame(index: number): void {
    this.frameIndex = index;
    for (const asset of this.wakuAssets.values()) {
      if (asset.filterLayer) asset.filterLayer.hidden = true;
      if (asset.wakuLayer) asset.wakuLayer.hidden = true;
    }
    for (const entry of this.messageFilterOverrides.values()) {
      if (entry.layer) entry.layer.hidden = true;
    }
    for (const entry of this.messageFrameOverrides.values()) {
      if (entry.layer) entry.layer.hidden = true;
    }
    const asset = this.wakuAssets.get(index);
    const cfg = asset?.config ?? parseWakuConfig(this.config, Math.max(0, index));
    const override = this.messageFilterOverrides.get(this.windowIndex);
    if (override?.layer && override.frame) {
      this.filter = override.layer;
      this.filterFrame = override.frame;
      override.layer.hidden = false;
      this.paintMessageFilter(cfg, override.layer, override.frame, this.lastFilterColor);
    } else {
      this.filter = asset?.filterLayer;
      this.filterFrame = asset?.filterFrame;
      if (asset?.filterLayer && asset.filterFrame) {
        asset.filterLayer.hidden = false;
        this.paintMessageFilter(
          asset.config,
          asset.filterLayer,
          asset.filterFrame,
          this.lastFilterColor,
        );
      }
    }
    const frameOverride = this.messageFrameOverrides.get(this.windowIndex);
    if (frameOverride?.layer) frameOverride.layer.hidden = false;
    else if (asset?.wakuLayer) asset.wakuLayer.hidden = false;
    const facePos = asset?.config.facePos ?? parseWakuConfig(this.config, Math.max(0, index)).facePos;
    const windowHeight = this.mwndLayout?.windowSize[1] ?? 353;
    Object.assign(this.portrait.style, {
      left: `${facePos[0]}px`,
      top: `${facePos[1]}px`,
      width: '340px',
      height: `${Math.max(0, windowHeight - facePos[1])}px`,
    });
    this.mountFrameActions(index);
  }

  private mountFrameActions(wakuIndex: number): void {
    if (wakuIndex < 0) {
      this.activeFrameActions = [];
      this.preserveStageFocus(() => this.controls.replaceChildren());
      this.controls.hidden = true;
      return;
    }
    const existing = this.frameActionsByWaku.get(wakuIndex);
    if (existing) {
      this.activeFrameActions = existing;
      this.preserveStageFocus(() =>
        this.controls.replaceChildren(...existing.map((entry) => entry.element)),
      );
      this.positionMessageButtons();
      if (this.activateFrameAction) {
        this.pageControls(this.activateFrameAction, this.frameActionStateResolver);
      }
      return;
    }
    const prefix = `WAKU.${String(wakuIndex).padStart(3, '0')}.BTN.`;
    let hasButtons = false;
    for (const key of this.config.keys()) {
      if (key.startsWith(prefix)) {
        hasButtons = true;
        break;
      }
    }
    if (!hasButtons) {
      this.frameActionsByWaku.set(wakuIndex, []);
      this.activeFrameActions = [];
      this.preserveStageFocus(() => this.controls.replaceChildren());
      this.controls.hidden = true;
      return;
    }
    let loading = this.frameActionsLoading.get(wakuIndex);
    if (!loading) {
      loading = this.prepareFrameActions(wakuIndex).finally(() => {
        this.frameActionsLoading.delete(wakuIndex);
      });
      this.frameActionsLoading.set(wakuIndex, loading);
    }
    void loading
      .then(() => {
        if (this.frameIndex === wakuIndex && !this.signal.aborted) {
          this.mountFrameActions(wakuIndex);
        }
      })
      .catch(() => {});
  }

  setTextMode(mode: 'native' | 'dom'): void {
    if (mode === this.textMode) return;
    const selection = this.stage.ownerDocument.getSelection();
    if (selection && this.message.contains(selection.anchorNode)) selection.removeAllRanges();
    this.textMode = mode;
    this.nativeText.hidden = mode !== 'native';
    this.text.hidden = this.speaker.hidden = mode === 'native';
    this.stage.dataset.textMode = mode;
    this.styleMessageText();
    if (mode === 'native') {
      this.text.style.top = `${this.textMetrics.y}px`;
      this.speaker.style.top = `${this.speakerMetrics.y}px`;
    }
    this.paintMessageText();
    this.stage.focus({preventScroll: true});
  }

  private styleMessageText(): void {
    const reader = getDomTextStyle();
    const styled = reader.enabled && this.textMode === 'dom';
    const scale = styled ? reader.scale : 1;
    const natural = styled && reader.layout === 'natural';
    const pitch = this.messageTextSize + this.textMetrics.lineSpace;
    const vertical = Boolean(this.mwndLayout?.vertical);
    const outline = siglusFontShadow(this.messageShadow);
    this.message.classList.toggle('game-glyph-slots', this.textMode === 'dom');
    for (const [element, size] of [
      [this.text, this.messageTextSize],
      [this.speaker, this.speakerMetrics.size],
    ] as const) {
      element.dataset.fontSize = String(size);
      element.style.fontFamily = styled ? domTextFamily(reader, this.message.style.fontFamily) : '';
      element.style.fontWeight = styled && reader.weight !== null ? String(reader.weight) : '';
      element.style.fontSize = size > 0 ? `${size * scale}px` : '';
      element.style.textShadow = styled && !reader.effects ? 'none' : outline;
    }
    this.text.style.lineHeight = natural
      ? `${this.messageTextSize * scale + Math.max(0, this.textMetrics.lineSpace)}px`
      : `${pitch}px`;
    this.text.style[vertical ? 'width' : 'height'] = natural && this.slideTime === undefined
      ? 'auto'
      : `${pitch * this.textMetrics.rows}px`;
    const fitClip = styled && !natural && this.slideTime === undefined;
    const rubyRoom = this.textMetrics.rubySize + this.textMetrics.rubySpace + 2;
    this.text.style.clipPath = fitClip ? (vertical ? `inset(-8px ${-rubyRoom}px -8px 0)` : `inset(${-rubyRoom}px -8px 0 -8px)`) : '';
    this.text.style.setProperty('--siglus-ruby-size', `${this.textMetrics.rubySize * scale}px`);
    this.text.style.setProperty(
      '--siglus-ruby-offset',
      `${this.messageTextSize * scale / 2 + this.textMetrics.rubySpace}px`,
    );
    if (this.messageTextSize > 0) this.alignDomText();
    this.paintMessageText();
  }

  private alignDomText(): void {
    if (this.textMode !== 'dom' || !this.text.style.fontSize || this.messageTextSize <= 0) return;
    const context = this.nativeText.getContext('2d')!;
    context.save();
    context.textBaseline = 'top';
    for (const [element, y] of [
      [this.text, this.textMetrics.y],
      [this.speaker, this.speakerMetrics.y],
    ] as const) {
      if (element === this.text && this.mwndLayout?.vertical) continue;
      const {fontSize, fontWeight, fontFamily, lineHeight} = getComputedStyle(element);
      if (Number.parseFloat(fontSize) <= 0) continue;
      const font = `${fontWeight} ${fontSize} ${fontFamily}`;
      const key = `${font} / ${lineHeight}`;
      let offset = this.domBaselineOffsets.get(key);
      if (offset === undefined) {
        const line = document.createElement('div');
        const baseline = document.createElement('span');
        line.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;white-space:pre';
        line.style.font = font;
        line.style.lineHeight = lineHeight;
        baseline.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        line.append('国', baseline);
        this.stage.append(line);
        const cssBaseline = baseline.offsetTop;
        line.remove();
        context.font = font;
        // A top-aligned canvas run starts above its alphabetic baseline.
        offset = -context.measureText('国').alphabeticBaseline - cssBaseline;
        if (this.stage.getClientRects().length) this.domBaselineOffsets.set(key, offset);
      }
      element.style.top = `${y + offset}px`;
    }
    context.restore();
  }

  private paintMessageText(): void {
    if (this.textMode === 'dom') {
      if (this.slideTime === undefined) return;
      const vertical = this.mwndLayout?.vertical;
      const overflow = vertical ? this.text.scrollWidth - this.text.clientWidth : this.text.scrollHeight - this.text.clientHeight;
      const offset = this.updateSlide(overflow);
      this.text.style.translate = vertical ? `${offset}px 0` : `0 ${-offset}px`;
      const rubyRoom = this.textMetrics.rubySize + this.textMetrics.rubySpace + 2;
      this.text.style.clipPath = vertical
        ? `inset(-8px ${offset - rubyRoom}px -8px ${-offset}px)`
        : `inset(${offset - rubyRoom}px -8px ${-offset}px -8px)`;
      return;
    }
    this.drawNativeMessage(this.nativeText);
  }

  private drawNativeMessage(canvas: HTMLCanvasElement, slideOffset?: number): void {
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const family = this.message.style.fontFamily || 'sans-serif';
    const weight = this.message.style.fontWeight || 'normal';
    context.fillStyle = this.messageColors.text;
    context.strokeStyle = this.messageColors.fuchi;
    context.lineJoin = 'round';
    context.lineWidth = 2;
    context.shadowColor = this.messageShadow & 1 ? this.messageColors.shadow : 'transparent';
    context.shadowBlur = 3;
    context.shadowOffsetX = 1;
    context.shadowOffsetY = 2;
    context.textBaseline = 'top';
    const draw = (text: string, x: number, y: number) => {
      const canvasY = y - this.nativeTextTop;
      if (this.messageShadow & 2) context.strokeText(text, x, canvasY);
      context.fillText(text, x, canvasY);
    };
    const speakerSize = this.speakerMetrics.size;
    if (this.currentName && speakerSize > 0 && this.mwndLayout?.nameDispMode !== 2) {
      context.font = `${weight} ${speakerSize}px ${family}`;
      if ('letterSpacing' in context) {
        (context as CanvasRenderingContext2D & {letterSpacing: string}).letterSpacing =
          `${this.speakerMetrics.spacing}px`;
      }
      const nameWidth = context.measureText(this.currentName).width;
      const nameX = computeAlignedNameLeft(
        this.speakerMetrics.x,
        this.speakerMetrics.align,
        nameWidth,
      );
      draw(this.currentName, nameX, this.speakerMetrics.y);
      if ('letterSpacing' in context) {
        (context as CanvasRenderingContext2D & {letterSpacing: string}).letterSpacing = '0px';
      }
    }
    const size = this.messageTextSize;
    if (!size || !this.currentText.length) return;
    const {x, y, width, rows, spacing, lineSpace, rubySize, rubySpace} = this.textMetrics;
    const vertical = Boolean(this.mwndLayout?.vertical);
    const advance = (character: string) => {
      const unit = character.codePointAt(0)!;
      return (unit <= 0x7f || (unit >= 0xff61 && unit <= 0xff9f) ? size / 2 : size) + spacing;
    };
    const lines: {cells: {character: string; ruby?: string; color?: number; width: number}[]; width: number}[] = [];
    let line: (typeof lines)[number] = {cells: [], width: 0};
    const nextLine = () => {
      lines.push(line);
      line = {cells: [], width: 0};
    };
    const add = (character: string, ruby: string | undefined, color: number | undefined) => {
      const cellWidth = Array.from(character).reduce((total, unit) => total + advance(unit), 0);
      if (line.width && line.width + cellWidth > width) nextLine();
      line.cells.push({character, ruby, color, width: cellWidth});
      line.width += cellWidth;
    };
    for (const {text, ruby, color} of this.currentText) {
      if (ruby) add(text, ruby, color);
      else
        for (const character of text) {
          if (character === '\n') nextLine();
          else add(character, undefined, color);
        }
    }
    nextLine();
    const pitch = size + lineSpace;
    const offset = slideOffset ?? this.updateSlide((lines.length - rows) * pitch);
    if (this.slideTime !== undefined) {
      context.save();
      context.beginPath();
      if (vertical) context.rect(x, 0, pitch * rows + rubySize + rubySpace + 2, canvas.height);
      else context.rect(0, y - this.nativeTextTop - rubySize - rubySpace - 2,
        canvas.width, pitch * rows + rubySize + rubySpace + 2);
      context.clip();
    }
    let previousColor: number | undefined;
    for (const [index, row] of lines.entries()) {
      const block = index * pitch - offset;
      const firstColumnX = x + pitch * (rows - 1);
      const columnX = firstColumnX - block;
      const rowY = y + block;
      const indent = this.text.style.textAlign === 'center' ? (width - row.width) / 2 : 0;
      let inline = indent;
      for (const cell of row.cells) {
        if (cell.color !== previousColor) {
          context.fillStyle = this.tableColor(cell.color ?? -1) ?? this.messageColors.text;
          previousColor = cell.color;
        }
        context.font = `${weight} ${size}px ${family}`;
        let glyph = inline;
        for (const character of cell.character) {
          if (vertical) draw(character, columnX, y + glyph);
          else draw(character, x + glyph, rowY);
          glyph += advance(character);
        }
        if (cell.ruby) {
          context.font = `${weight} ${rubySize}px ${family}`;
          if (vertical) {
            const characters = Array.from(cell.ruby);
            let top = y + inline + (cell.width - characters.length * rubySize) / 2;
            for (const character of characters) {
              draw(character, columnX + rubySize + rubySpace, top);
              top += rubySize;
            }
          } else {
            context.textAlign = 'center';
            draw(cell.ruby, x + inline + cell.width / 2, rowY - rubySize - rubySpace);
            context.textAlign = 'start';
          }
        }
        inline += cell.width;
      }
    }
    if (this.slideTime !== undefined) context.restore();
  }

  selectMessageWindow(index: number): void {
    this.windowIndex = index;
    const layout = parseMwndLayout(this.config, index);
    this.mwndLayout = layout;
    const place = (element: HTMLElement, position: readonly number[], size: readonly number[]): void => {
      const [x, y] = position;
      const [w, h] = size;
      Object.assign(element.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
    };
    place(this.message, layout.windowPos, layout.windowSize);
    this.defaultTextSize = layout.mojiSize;
    this.textMetrics = {
      x: layout.textX,
      y: layout.textY,
      width: layout.vertical ? layout.textHeight : layout.textWidth,
      rows: layout.rows,
      spacing: layout.mojiSpace[0],
      lineSpace: layout.mojiSpace[1],
      rubySize: layout.rubySize,
      rubySpace: layout.rubySpace,
    };
    this.nativeText.width = layout.windowSize[0];
    // A separate speaker name and ruby can extend above the window's origin.
    const nameTop = layout.nameDispMode === 2 ? 0 : layout.nameAnchorY;
    this.nativeTextTop = Math.min(0, nameTop, layout.textY - layout.rubySize - layout.rubySpace);
    this.nativeText.style.top = `${this.nativeTextTop}px`;
    this.nativeText.height = layout.windowSize[1] - this.nativeTextTop;
    place(this.text, [layout.textX, layout.textY], [layout.textWidth, layout.textHeight]);
    this.text.style.writingMode = layout.vertical ? 'vertical-rl' : '';
    this.text.style.letterSpacing = `${layout.mojiSpace[0]}px`;
    this.text.dataset.siglusDialogue = '';
    this.speaker.dataset.siglusSpeaker = '';
    Object.assign(this.speaker.style, {
      left: `${layout.nameAnchorX}px`,
      top: `${layout.nameAnchorY}px`,
      width: 'auto',
      height: 'auto',
      letterSpacing: `${layout.nameMojiSpace[0]}px`,
      transform:
        layout.nameAlign === 1
          ? 'translateX(-50%)'
          : layout.nameAlign === 2
            ? 'translateX(-100%)'
            : '',
    });
    this.speakerMetrics = {
      x: layout.nameAnchorX,
      y: layout.nameAnchorY,
      align: layout.nameAlign,
      spacing: layout.nameMojiSpace[0],
      size: layout.nameMojiSize,
    };
    this.applyMessageFrame(layout.wakuNo);
    const mwColors = parseMwndColors(this.config, index);
    this.messageColors = {
      text: this.tableColor(mwColors.mojiColor) ?? 'white',
      shadow: this.tableColor(mwColors.shadowColor) ?? 'black',
      fuchi: this.tableColor(mwColors.fuchiColor) ?? 'black',
    };
    this.text.style.color = this.messageColors.text;
    this.speaker.style.color = this.messageColors.text;
    this.positionMessageButtons();
    this.setTextSize();
  }

  get messageWindow(): number {
    return this.windowIndex;
  }

  setMessageFrame(index: number): void {
    this.applyMessageFrame(index);
  }

  messageButtonCount(window: number): number {
    const {wakuNo} = parseMwndLayout(this.config, window);
    if (wakuNo < 0) return 0;
    const loaded = this.frameActionsByWaku.get(wakuNo);
    if (loaded) return loaded.length;
    const wakuTag = String(wakuNo).padStart(3, '0');
    const patternRe = new RegExp(`^WAKU\\.${wakuTag}\\.BTN\\.(\\d+)\\.TYPE$`);
    let count = 0;
    for (const key of this.config.keys()) if (patternRe.test(key)) count++;
    return count;
  }

  messageButtonPointerState(window: number, buttonId: number): number {
    const {wakuNo} = parseMwndLayout(this.config, window);
    const entry = this.frameActionsByWaku.get(wakuNo)?.find((item) => item.action.id === buttonId);
    if (!entry) return 0;
    const state = this.messageButtonStates.get(`${window}.${buttonId}`);
    if (state?.visible === false) return 0;
    const resolved = entry.decorative ? 'normal' : this.frameActionStateResolver?.(entry.action);
    if (resolved === 'hidden') return 0;
    if (entry.button?.disabled || resolved === 'disabled') return 4;
    if (entry.action.state === 1) return 3;
    if (entry.pointerState === 'push') return 2;
    if (entry.pointerState === 'hit') return 1;
    return 0;
  }

  private messageButtonState(window: number, id: number) {
    const key = `${window}.${id}`;
    let state = this.messageButtonStates.get(key);
    if (!state) {
      state = {visible: true, posX: 0, posY: 0, repX: 0, repY: 0, patno: 0};
      this.messageButtonStates.set(key, state);
    }
    return state;
  }

  offsetMessageButton(
    window: number,
    id: number,
    axis: 'x' | 'y',
    value: number,
    timing?: KeyframeAnimationOptions,
    kind: 'pos' | 'rep' = 'pos',
  ): void {
    const state = this.messageButtonState(window, id);
    if (kind === 'pos') {
      const ends = (state.positionEventEnds ??= {});
      if (timing) ends[axis] = performance.now() + Number(timing.duration ?? 0) + Number(timing.delay ?? 0);
      else delete ends[axis];
    }
    const field =
      kind === 'rep' ? (axis === 'x' ? 'repX' : 'repY') : axis === 'x' ? 'posX' : 'posY';
    if (state[field] === value) return;
    state[field] = value;
    if (window !== this.windowIndex) return;
    const entry = this.activeFrameActions.find(({action}) => action.id === id);
    if (!entry) return;
    const {element} = entry;
    const from = timing ? getComputedStyle(element).translate : '';
    entry.motion?.cancel();
    element.style.translate = `${state.posX + state.repX}px ${state.posY + state.repY}px`;
    entry.motion = timing
      ? element.animate([{translate: from}, {translate: element.style.translate}], timing)
      : undefined;
  }

  messageButtonPositionEventActive(window: number, id: number, axis: 'x' | 'y'): boolean {
    return (this.messageButtonStates.get(`${window}.${id}`)?.positionEventEnds?.[axis] ?? 0) > performance.now();
  }

  setMessageButtonProperty(window: number, id: number, prop: 0 | 1 | 3 | 4, value?: number): number {
    const state = this.messageButtonState(window, id);
    if (value !== undefined) {
      const next = value | 0;
      if (prop === 0) state.visible = Boolean(next);
      else if (prop === 1) state.patno = next;
      else if (prop === 3) state.posX = next;
      else state.posY = next;
      if (state.positionEventEnds) {
        if (prop === 3) delete state.positionEventEnds.x;
        if (prop === 4) delete state.positionEventEnds.y;
      }
      if (window === this.windowIndex) {
        const entry = this.activeFrameActions.find(({action}) => action.id === id);
        if (entry) {
          if (prop === 3 || prop === 4) {
            entry.motion?.cancel();
            entry.motion = undefined;
            entry.element.style.translate = `${state.posX + state.repX}px ${state.posY + state.repY}px`;
          } else {
            if (prop === 1) entry.element.dataset.patno = String(state.patno);
            entry.refresh();
          }
        }
      }
    }
    if (prop === 0) return Number(state.visible);
    if (prop === 1) return state.patno;
    return prop === 3 ? state.posX : state.posY;
  }

  private positionMessageButtons(): void {
    const windowPos = this.mwndLayout?.windowPos ?? [
      Number.parseFloat(this.message.style.left) || 0,
      Number.parseFloat(this.message.style.top) || 0,
    ];
    const windowSize = this.mwndLayout?.windowSize ?? [
      Number.parseFloat(this.message.style.width) || this.width,
      Number.parseFloat(this.message.style.height) || this.height,
    ];
    for (const entry of this.activeFrameActions) {
      const {action, element} = entry;
      entry.motion?.cancel();
      entry.motion = undefined;
      const origin = computeWakuButtonOrigin(
        entry.anchor,
        windowPos,
        windowSize,
        entry.posX,
        entry.posY,
        entry.frameOrigin,
      );
      element.style.left = `${origin.left}px`;
      element.style.top = `${origin.top}px`;
      const state = this.messageButtonStates.get(`${this.windowIndex}.${action.id}`);
      const tx = (state?.posX ?? 0) + (state?.repX ?? 0);
      const ty = (state?.posY ?? 0) + (state?.repY ?? 0);
      element.style.translate = `${tx}px ${ty}px`;
      if (state) element.dataset.patno = String(state.patno);
      entry.refresh();
    }
  }

  async showMessageObjects(objects: Iterable<DrawObject>): Promise<void> {
    const layer = await this.drawObjects(objects, () => {}, false);
    this.messageObjects.replaceChildren(layer);
  }

  async showMessageFaces(objects: Iterable<DrawObject>): Promise<void> {
    const layer = await this.drawObjects(objects, () => {}, false);
    this.portrait.replaceChildren(layer);
  }
  private readonly loadedFonts: FontFace[] = [];
  private readonly fontNames = new Map<string, string>();
  readonly fontChoices: SiglusFontChoice[] = [];

  private tableColor(index: number): string | undefined {
    if (index < 0) return undefined;
    const raw =
      this.config.get(`COLOR_TABLE.${String(index).padStart(3, '0')}`) ??
      this.config.get(`COLOR_TABLE.${index}`);
    if (!raw) return undefined;
    const m = raw.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? `rgb(${m[1]},${m[2]},${m[3]})` : undefined;
  }

  private fontFamily(name?: string): string {
    const family = name && this.fontNames.get(name.toLowerCase());
    return family ? family + ', sans-serif' : (this.loadedFonts[0]?.family ?? 'sans-serif');
  }

  setMessageFont(name?: string, bold = false, shadow = 2): void {
    this.message.style.fontFamily = this.fontFamily(name);
    this.message.style.fontWeight = bold ? 'bold' : 'normal';
    this.messageShadow = shadow;
    this.styleMessageText();
  }

  private async resource(name: string): Promise<G00Image> {
    const path = `g00/${name.toLowerCase()}.g00`;
    let pending = this.media.get(path);
    if (pending) {
      this.media.delete(path);
      this.media.set(path, pending);
    } else {
      const file = this.files.get(path);
      if (!file) throw new Error(`Missing Siglus image ${name}`);
      pending = this.readG00(file);
      this.media.set(path, pending);
      void pending.catch(() => {
        if (this.media.get(path) === pending) this.media.delete(path);
      });
      if (this.media.size > 24) this.media.delete(this.media.keys().next().value!);
    }
    return pending;
  }

  private async readG00(file: ByteSource): Promise<G00Image> {
    const signal = this.signal;
    signal.throwIfAborted();
    const pool = (this.g00Worker ??= new WorkerPool<WorkerSource, G00Resource>(
      () => new Worker(new URL('./g00-worker.js', import.meta.url), {type: 'module'}),
    ));
    if (pool.available) {
      const source = await workerSourceOf(file, signal);
      signal.throwIfAborted();
      const decoded = await pool.run(source);
      signal.throwIfAborted();
      if (decoded) return new G00Image(decoded);
    }
    const bytes = await file.read(0, file.size, signal);
    signal.throwIfAborted();
    return new G00Image(bytes);
  }

  private rememberGraphic(key: string, graphic: Graphic): void {
    const existing = this.graphicCache.get(key);
    if (existing) {
      this.graphicCacheBytes -= existing.bytes;
      this.graphicCache.delete(key);
    }
    const bytes = Math.max(4, graphic.width * graphic.height * (graphic.pixels ? 8 : 4));
    this.graphicCache.set(key, {graphic, bytes});
    this.graphicCacheBytes += bytes;
    while (
      this.graphicCache.size > GRAPHIC_CACHE_MAX_ENTRIES ||
      (this.graphicCacheBytes > GRAPHIC_CACHE_MAX_BYTES && this.graphicCache.size > 1)
    ) {
      const oldestKey = this.graphicCache.keys().next().value!;
      const oldest = this.graphicCache.get(oldestKey)!;
      this.graphicCache.delete(oldestKey);
      this.graphicCacheBytes -= oldest.bytes;
      // An active draw object can still own this cel after cache eviction.
    }
  }

  private rememberComposite(key: string, graphic: Graphic): void {
    const existing = this.compositeCache.get(key);
    if (existing) {
      this.compositeCacheBytes -= existing.bytes;
      this.compositeCache.delete(key);
    }
    const bytes = Math.max(4, graphic.width * graphic.height * (graphic.pixels ? 8 : 4));
    this.compositeCache.set(key, {graphic, bytes});
    this.compositeCacheBytes += bytes;
    while (
      this.compositeCache.size > COMPOSITE_CACHE_MAX_ENTRIES ||
      (this.compositeCacheBytes > COMPOSITE_CACHE_MAX_BYTES && this.compositeCache.size > 1)
    ) {
      const oldestKey = this.compositeCache.keys().next().value!;
      const oldest = this.compositeCache.get(oldestKey)!;
      this.compositeCache.delete(oldestKey);
      this.compositeCacheBytes -= oldest.bytes;
    }
  }

  async objectGraphic(name: string, pattern: number, compositeLayer = false): Promise<Graphic | undefined> {
    if (pattern < 0 && !compositeLayer) return;
    if (isCompositeGraphic(name))
      return pattern === 0 ? this.compositeGraphic(name) : undefined;
    const split = `${name}___${String(pattern).padStart(3, '0')}`;
    if (this.files.has(`g00/${split.toLowerCase()}.g00`)) return this.graphic(split);
    const cut = embeddedCut(this.files, name);
    if (cut) [name, pattern] = cut;
    const resource = await this.resource(name);
    // 1.1.102.1 (0x6c4bae) clamps a composite layer's cut before drawing it.
    if (compositeLayer && resource.count > 0) pattern = Math.max(0, Math.min(pattern, resource.count - 1));
    if (pattern >= resource.count) return;
    return this.graphic(name, pattern);
  }

  async graphicCutCount(name: string): Promise<number> {
    if (!name) return 0;
    if (isCompositeGraphic(name)) return 1;
    return (await this.resource(embeddedCut(this.files, name)?.[0] ?? name)).count;
  }

  private async compositeGraphic(specification: string): Promise<Graphic> {
    const cached = this.compositeCache.get(specification);
    if (cached) {
      this.compositeCache.delete(specification);
      this.compositeCache.set(specification, cached);
      return cached.graphic;
    }
    const inflight = this.inFlightComposites.get(specification);
    if (inflight) return inflight;
    const job = (async () => {
      const {explicitDim, layers: parsed} = parseSiglusCompositeSpec(specification);
      const frames = await Promise.all(parsed.map((p) => this.objectGraphic(p.name, p.pattern, true)));
      const loaded = parsed.map((p, idx) => {
        const frame = frames[idx];
        if (!frame) throw new Error('Missing Siglus composite image component ' + p.part);
        return {frame, dx: p.dx, dy: p.dy, blend: p.blend};
      });
      const {width, height, baseX, baseY, baseCenterX, baseCenterY, placements} = layoutSiglusCompositeLayers(
        loaded,
        explicitDim,
      );
      if (width <= 0 || height <= 0 || width * height > 16_777_216)
        throw new Error('Invalid Siglus composite image dimensions');
      // Only the composition needs a drawing context. Retain its immutable
      // bitmap so a long route cannot lose the cached cel's Canvas2D context.
      const composition = new OffscreenCanvas(width, height);
      const context = composition.getContext('2d', {willReadFrequently: true})!;
      for (const [idx, {frame, blend}] of loaded.entries()) {
        if (frame.width <= 0 || frame.height <= 0) continue;
        context.globalCompositeOperation =
          blend === '3' ? 'multiply' : blend === '1' ? 'lighter' : 'source-over';
        const {drawX, drawY} = placements[idx]!;
        context.drawImage(frame.image, drawX, drawY);
      }
      const result: Graphic = {
        image: composition.transferToImageBitmap(),
        width,
        height,
        x: baseX,
        y: baseY,
        centerX: baseCenterX,
        centerY: baseCenterY,
      };
      this.rememberComposite(specification, result);
      return result;
    })();
    this.inFlightComposites.set(specification, job);
    try {
      return await job;
    } finally {
      if (this.inFlightComposites.get(specification) === job) {
        this.inFlightComposites.delete(specification);
      }
    }
  }

  async setObjectMask(slot: number, name?: string): Promise<void> {
    this.pendingObjectMasks.delete(slot);
    if (name === undefined) {
      this.objectMasks.delete(slot);
      return;
    }
    const existing = this.objectMasks.get(slot);
    if (existing?.name === name && existing.url) return;
    const update = {};
    this.pendingObjectMasks.set(slot, update);
    const key = name.toLowerCase();
    try {
      let url = this.maskUrlCache.get(key);
      if (url) {
        this.maskUrlCache.delete(key);
        this.maskUrlCache.set(key, url);
      } else {
        const graphic = await this.graphic(name);
        if (this.pendingObjectMasks.get(slot) !== update) return;
        const canvas =
          graphic.image instanceof HTMLCanvasElement ? graphic.image : this.node(graphic);
        url = canvas.toDataURL();
        this.maskUrlCache.set(key, url);
        if (this.maskUrlCache.size > 32) {
          this.maskUrlCache.delete(this.maskUrlCache.keys().next().value!);
        }
      }
      const {x = 0, y = 0} = this.objectMasks.get(slot) ?? {};
      this.objectMasks.set(slot, {name, url, x, y});
    } finally {
      if (this.pendingObjectMasks.get(slot) === update) this.pendingObjectMasks.delete(slot);
    }
  }

  setObjectMaskOffset(slot: number, axis: 'x' | 'y', value: number): number {
    let entry = this.objectMasks.get(slot);
    if (!entry) {
      entry = {x: 0, y: 0};
      this.objectMasks.set(slot, entry);
    }
    entry[axis] = value | 0;
    return entry[axis];
  }

  getObjectMaskOffset(slot: number, axis: 'x' | 'y'): number {
    return this.objectMasks.get(slot)?.[axis] ?? 0;
  }

  saveObjectMasks(): [number, {name?: string; x: number; y: number}][] {
    return [...this.objectMasks].map(([slot, m]) => [slot, {name: m.name, x: m.x, y: m.y}]);
  }

  async restoreObjectMasks(
    saved?: readonly [number, {name?: string; x: number; y: number}][],
  ): Promise<void> {
    const generation = ++this.objectMaskRestoreGeneration;
    this.pendingObjectMasks.clear();
    this.objectMasks.clear();
    for (const [slot, m] of saved ?? []) {
      if (generation !== this.objectMaskRestoreGeneration) return;
      this.objectMasks.set(slot, {x: m.x, y: m.y});
      if (m.name) await this.setObjectMask(slot, m.name);
    }
  }

  async graphic(name: string, pattern = 0): Promise<Graphic> {
    const cacheKey = `${name.toLowerCase()}#${pattern}`;
    const cached = this.graphicCache.get(cacheKey);
    if (cached) {
      this.graphicCache.delete(cacheKey);
      this.graphicCache.set(cacheKey, cached);
      return cached.graphic;
    }
    const inflight = this.inFlightGraphics.get(cacheKey);
    if (inflight) return inflight;
    const job = (async (): Promise<Graphic> => {
      const resource = await this.resource(name);
      this.signal.throwIfAborted();
      let result: Graphic;
      if (resource.type === 3) {
        const image = await createImageBitmap(new Blob([resource.jpeg()], {type: 'image/jpeg'}));
        result = {
          image,
          width: image.width,
          height: image.height,
          x: 0,
          y: 0,
          centerX: 0,
          centerY: 0,
        };
      } else {
        const {width, height, x, y, centerX, centerY, contentBounds, bgra} =
          resource.frame(pattern);
        const imageData = new ImageData(width, height);
        const rgba = imageData.data;
        if (isLittleEndian && (bgra.byteOffset & 3) === 0 && (bgra.byteLength & 3) === 0) {
          const src32 = new Uint32Array(bgra.buffer, bgra.byteOffset, bgra.byteLength >>> 2);
          const dst32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >>> 2);
          const count = src32.length;
          for (let i = 0; i < count; i++) {
            const px = src32[i]!;
            dst32[i] = (px & 0xff00ff00) | ((px & 0xff) << 16) | ((px >>> 16) & 0xff);
          }
        } else {
          for (let i = 0; i < bgra.length; i += 4) {
            rgba[i] = bgra[i + 2]!;
            rgba[i + 1] = bgra[i + 1]!;
            rgba[i + 2] = bgra[i]!;
            rgba[i + 3] = bgra[i + 3]!;
          }
        }
        const image = await createImageBitmap(imageData, {colorSpaceConversion: 'none'});
        if (this.signal.aborted) {
          image.close();
          this.signal.throwIfAborted();
        }
        result = {image, width, height, x, y, centerX, centerY, contentBounds, pixels: rgba};
      }
      this.rememberGraphic(cacheKey, result);
      return result;
    })();
    this.inFlightGraphics.set(cacheKey, job);
    try {
      return await job;
    } finally {
      if (this.inFlightGraphics.get(cacheKey) === job) {
        this.inFlightGraphics.delete(cacheKey);
      }
    }
  }

  async numberGraphic(
    name: string,
    spec: NonNullable<DrawObject['number']>,
  ): Promise<Graphic | undefined> {
    if (!name) return undefined;
    const baseDigit = await this.objectGraphic(name, 0);
    if (!baseDigit) return undefined;
    const abs = Math.abs(Math.trunc(spec.value));
    const digits = String(abs);
    const signIndex = spec.value < 0 ? 10 : spec.dispSign ? 11 : -1;
    const keta = Math.max(spec.ketaMax || 0, digits.length);
    const padCount = Math.max(0, keta - digits.length);
    const slots: number[] = [];
    if (signIndex >= 0 && !spec.tumeruSign) slots.push(signIndex);
    for (let i = 0; i < padCount; i++) slots.push(spec.dispZero ? 0 : -1);
    if (signIndex >= 0 && spec.tumeruSign) slots.push(signIndex);
    for (const ch of digits) slots.push(ch.charCodeAt(0) - 48);
    const glyphs = await Promise.all(
      slots.map((idx) => (idx >= 0 ? this.objectGraphic(name, idx) : Promise.resolve(undefined))),
    );
    const cellW = baseDigit.width;
    const cellH = Math.max(baseDigit.height, ...glyphs.map((g) => g?.height ?? 0));
    const step = spec.spaceMod ? spec.space || cellW : cellW + spec.space;
    const stride = step > 0 ? step : cellW;
    const width = Math.max(1, (slots.length - 1) * stride + cellW);
    const height = Math.max(1, cellH);
    const image = document.createElement('canvas');
    image.width = width;
    image.height = height;
    const context = image.getContext('2d')!;
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      if (g) context.drawImage(g.image, i * stride, 0);
    }
    return {
      image,
      width,
      height,
      x: baseDigit.x,
      y: baseDigit.y,
      centerX: baseDigit.centerX,
      centerY: baseDigit.centerY,
    };
  }

  rectangle(
    width: number,
    height: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    x = 0,
    y = 0,
  ): Graphic {
    const image = document.createElement('canvas');
    image.width = width;
    image.height = height;
    const context = image.getContext('2d')!;
    if (width > 0 && height > 0) {
      context.fillStyle = `rgba(${r},${g},${b},${alpha / 255})`;
      context.fillRect(0, 0, width, height);
    }
    return {image, width, height, x, y, centerX: 0, centerY: 0};
  }

  captureThumbnail(): string | undefined {
    if (this.config.get('SAVE_THUMB.USE') !== '1') return;
    const [width, height] = (this.config.get('SAVE_THUMB.SIZE') ?? '').split(',').map(Number);
    if (!width || !height || width > this.width || height > this.height) return;
    const stage = this.captureStage();
    if (!stage) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(stage, 0, 0, width, height);
    return this.config.get('SAVE_THUMB.TYPE') === '1'
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', 0.8);
  }

  private captureStage(x = 0, y = 0, limit?: readonly [number, number]): HTMLCanvasElement | undefined {
    const bounds = this.stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    let substitute: Parameters<typeof captureLayers>[4];
    if (
      this.textMode === 'dom' &&
      !this.message.hidden &&
      getComputedStyle(this.message).visibility !== 'hidden'
    ) {
      const image = document.createElement('canvas');
      image.width = this.nativeText.width;
      image.height = this.nativeText.height;
      this.drawNativeMessage(image, this.slideOffset);
      const message = this.message.getBoundingClientRect();
      const scale = message.height / (image.height + this.nativeTextTop);
      substitute = {
        target: this.nativeText,
        image,
        bounds: new DOMRect(message.left, message.top + this.nativeTextTop * scale, message.width, image.height * scale),
      };
    }
    const layers = [this.layers, this.cast, this.effect, this.message, this.controls].filter(
      (layer) => layer.parentElement === this.sceneLayers,
    );
    const include = limit && ((element: HTMLElement) => {
      const value = element === this.message || element === this.controls
        ? this.config.get('MWND.ORDER') ?? '200'
        : element.dataset.siglusDrawOrder;
      if (value === undefined) return true;
      const order = Number(value);
      const layer = Number(element.dataset.siglusDrawLayer ?? 0);
      return order < limit[0] || (order === limit[0] && layer <= limit[1]);
    });
    return captureLayers(this.width, this.height, bounds, layers, substitute, x, y, include);
  }

  async capturePng(
    x: number,
    y: number,
    {limit, overlay, size}: SiglusCaptureOptions = {},
  ): Promise<Uint8Array | undefined> {
    let stage = this.captureStage(x, y, limit);
    if (!stage) return;
    if (overlay && this.files.has(`g00/${overlay.toLowerCase()}.g00`)) {
      const graphic = await this.graphic(overlay);
      stage.getContext('2d')!.drawImage(graphic.image, 0, 0);
    }
    if (size && (size[0] !== stage.width || size[1] !== stage.height)) {
      const result = document.createElement('canvas');
      [result.width, result.height] = size;
      const context = result.getContext('2d')!;
      context.fillStyle = 'black';
      context.fillRect(0, 0, result.width, result.height);
      context.drawImage(stage, 0, 0);
      stage = result;
    }
    const blob = await new Promise<Blob | null>((resolve) => stage.toBlob(resolve, 'image/png'));
    if (blob) return new Uint8Array(await blob.arrayBuffer());
  }

  async capturedGraphic(png: Uint8Array): Promise<Graphic> {
    const image = await createImageBitmap(new Blob([new Uint8Array(png)], {type: 'image/png'}));
    return {image, width: image.width, height: image.height, x: 0, y: 0, centerX: 0, centerY: 0};
  }

  async captureBmp(png: Uint8Array, flags: readonly number[]): Promise<Uint8Array> {
    const image = await createImageBitmap(new Blob([new Uint8Array(png)], {type: 'image/png'}));
    try {
      const surface = this.stage.ownerDocument.createElement('canvas');
      surface.width = image.width;
      surface.height = image.height;
      const context = surface.getContext('2d', {willReadFrequently: true})!;
      context.drawImage(image, 0, 0);
      return encodeCaptureBmp(context.getImageData(0, 0, image.width, image.height), flags);
    } finally {
      image.close();
    }
  }

  async savedThumbnail(url: string): Promise<Graphic> {
    const image = new Image();
    image.src = url;
    await image.decode();
    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      x: 0,
      y: 0,
      centerX: 0,
      centerY: 0,
    };
  }

  graphicPixelChannel(graphic: Graphic, x: number, y: number, channel: 0 | 1 | 2 | 3): number {
    const ix = Math.trunc(x);
    const iy = Math.trunc(y);
    if (ix < 0 || iy < 0 || ix >= graphic.width || iy >= graphic.height) return 0;
    if (graphic.pixels) {
      return graphic.pixels[(iy * graphic.width + ix) * 4 + channel]!;
    }
    const canvas = graphic.image instanceof HTMLCanvasElement ? graphic.image : this.node(graphic);
    return canvas.getContext('2d')!.getImageData(ix, iy, 1, 1).data[channel]!;
  }

  graphicAlpha(graphic: Graphic, x: number, y: number): number {
    return this.graphicPixelChannel(graphic, x, y, 3);
  }

  private node(graphic: Graphic): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = graphic.width;
    canvas.height = graphic.height;
    canvas.style.cssText = `position:absolute;left:${graphic.x}px;top:${graphic.y}px`;
    if (graphic.width > 0 && graphic.height > 0) {
      canvas.getContext('2d', {willReadFrequently: true})!.drawImage(graphic.image, 0, 0);
    }
    return canvas;
  }

  private buttonHitPath(
    frame: Graphic,
    canvas: HTMLCanvasElement,
    object: DrawObject,
  ): string {
    const {width, height} = frame;
    const cached = object.alphaTest ? this.hitPaths.get(frame) : undefined;
    if (cached !== undefined) return cached;
    const [cutLeft, cutTop, cutRight, cutBottom] = frame.contentBounds ?? [0, 0, width, height];
    const left = Math.max(0, cutLeft);
    const top = Math.max(0, cutTop);
    const right = Math.min(width, cutRight);
    const bottom = Math.min(height, cutBottom);
    if (right <= left || bottom <= top) return 'inset(100%)';
    if (!object.alphaTest)
      return `inset(${top}px ${width - right}px ${height - bottom}px ${left}px)`;
    const data = frame.pixels ?? canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
    const runs: string[] = [];
    for (let row = top; row < bottom; row++) {
      let column = left;
      while (column < right) {
        while (column < right && data[(row * width + column) * 4 + 3] === 0) column++;
        const start = column;
        while (column < right && data[(row * width + column) * 4 + 3] !== 0) column++;
        const length = column - start;
        if (length) runs.push(`M${start} ${row}h${length}v1h${-length}z`);
      }
    }
    const path = runs.length ? `path("${runs.join('')}")` : 'inset(100%)';
    this.hitPaths.set(frame, path);
    return path;
  }

  private selectionLayer?: HTMLElement;

  async loadMaskWipe(
    name: string,
    softness: number,
    reverse = false,
  ): Promise<CustomMaskWipe | undefined> {
    const key = `${name.toLowerCase()}|${softness}|${reverse ? 1 : 0}`;
    const cached = this.maskWipeCache.get(key);
    if (cached) {
      this.maskWipeCache.delete(key);
      this.maskWipeCache.set(key, cached);
      return cached;
    }
    const path = `g00/${name.toLowerCase()}.g00`;
    if (!this.files.has(path)) return undefined;
    const image = await this.resource(name);
    const frame = image.frame(0);
    const result: CustomMaskWipe = {
      softness,
      width: frame.width,
      height: frame.height,
      values: g00MaskValues(frame.bgra, frame.width, frame.height, reverse),
    };
    this.maskWipeCache.set(key, result);
    if (this.maskWipeCache.size > 32) {
      this.maskWipeCache.delete(this.maskWipeCache.keys().next().value!);
    }
    return result;
  }

  clearSelectionButtons(): void {
    const hadLayer = this.selectionLayer !== undefined;
    this.selectionLayer?.remove();
    this.selectionLayer = undefined;
    this.selectionTemplate = undefined;
    if (hadLayer) this.stage.focus({preventScroll: true});
  }

  async finishSelectionButtons(chosenIndex: number, animate = true): Promise<void> {
    const layer = this.selectionLayer;
    const template = this.selectionTemplate;
    if (!layer || !animate || !template || typeof layer.animate !== 'function') {
      this.clearSelectionButtons();
      return;
    }
    const buttons = [...layer.querySelectorAll('button')];
    for (const button of buttons) button.disabled = true;
    const animations: Animation[] = [];
    if (chosenIndex >= 0 && template.decideAnime[0] > 0 && template.decideAnime[1] > 0) {
      const duration = template.decideAnime[1];
      const chosenSelector = String(chosenIndex);
      for (const child of [...layer.children]) {
        const element = child as HTMLElement;
        if (element.dataset.siglusChoice === chosenSelector) {
          const keyframes =
            template.decideAnime[0] === 2
              ? [
                  {filter: 'brightness(1.35)', opacity: 1},
                  {filter: 'brightness(1)', opacity: 1, offset: 0.45},
                  {filter: 'brightness(1)', opacity: 0},
                ]
              : [{opacity: 1}, {opacity: 0}];
          animations.push(element.animate(keyframes, {duration, easing: 'ease-out', fill: 'forwards'}));
        } else {
          animations.push(
            element.animate([{opacity: 1}, {opacity: 0}], {
              duration: Math.max(80, Math.round(duration * 0.6)),
              easing: 'ease-out',
              fill: 'forwards',
            }),
          );
        }
      }
    } else if (chosenIndex < 0 && template.closeAnime[0] > 0 && template.closeAnime[1] > 0) {
      const duration = template.closeAnime[1];
      const keyframes =
        template.closeAnime[0] === 6
          ? [
              {opacity: 1, transform: 'translateY(0px)'},
              {opacity: 0, transform: 'translateY(10px)'},
            ]
          : [{opacity: 1}, {opacity: 0}];
      animations.push(layer.animate(keyframes, {duration, easing: 'ease-in', fill: 'forwards'}));
    }
    if (animations.length) {
      const cancel = () => {
        for (const anim of animations) anim.cancel();
      };
      this.signal.addEventListener('abort', cancel, {once: true});
      try {
        await Promise.all(animations.map((anim) => anim.finished.catch(() => {})));
      } finally {
        this.signal.removeEventListener('abort', cancel);
      }
    }
    if (this.selectionLayer === layer) this.clearSelectionButtons();
  }

  async showSelectionButtons(
    call: SelbtnCall,
    onChoose: (index: number) => void,
    onHover?: () => void,
    animate = true,
  ): Promise<void> {
    this.clearSelectionButtons();
    const template = readSelbtnTemplate(this.config, call.templateNo);
    this.selectionTemplate = template;
    const actionStates = parseButtonActionStates(this.config, template.btnAction);
    const loadCut = (cut: number) =>
      template.baseFile ? this.objectGraphic(template.baseFile, Math.max(0, cut)) : Promise.resolve(undefined);
    const normal = await loadCut(actionStates.normal.cutOffset);
    const hover = (await loadCut(actionStates.hit.cutOffset)) ?? normal;
    const pressed = (await loadCut(actionStates.push.cutOffset)) ?? hover ?? normal;
    const disabled = (await loadCut(actionStates.disable.cutOffset)) ?? normal;
    if (this.selectionTemplate !== template) return;
    const itemWidth = normal?.width ?? 640;
    const itemHeight = normal?.height ?? 80;
    const placements = layoutSelbtnItems(call.items, template, itemWidth, itemHeight);
    const layer = document.createElement('div');
    layer.dataset.siglusSelbtn = String(call.templateNo);
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:30';
    if (template.backFile && this.files.has(`g00/${template.backFile.toLowerCase()}.g00`)) {
      const back = await this.graphic(template.backFile);
      if (this.selectionTemplate !== template) return;
      const backOff = computeSpriteOffset(0, 0, back);
      const backCanvas = this.node(back);
      backCanvas.style.left = `${backOff.left}px`;
      backCanvas.style.top = `${backOff.top}px`;
      backCanvas.style.pointerEvents = 'none';
      layer.append(backCanvas);
    }
    const originX = normal?.centerX ?? 0;
    const originY = normal?.centerY ?? 0;
    const normalColor = this.tableColor(template.textColor) ?? 'white';
    const hitColor = this.tableColor(template.textHitColor) ?? normalColor;
    const labelAnchorX = originX + template.textX;
    const labelAnchorY = originY + template.textY;
    const labelTx =
      template.textAlignX === 1 ? '-50%' : template.textAlignX === 2 ? '-100%' : '0%';
    const labelTy =
      template.textAlignY === 1 ? '-50%' : template.textAlignY === 2 ? '-100%' : '0%';
    const usePositionedLabel = Boolean(normal);
    for (const {item, x, y} of placements) {
      const presentation = selbtnPresentation(item.dispFlag);
      if (presentation === 'hidden') continue;
      const isDisabled = presentation === 'disabled';
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = isDisabled;
      button.dataset.siglusChoice = String(item.index);
      button.style.cssText = `position:absolute;left:${x - originX}px;top:${y - originY}px;width:${itemWidth}px;height:${itemHeight}px;padding:0;border:0;background:transparent;cursor:${isDisabled ? 'default' : 'pointer'};pointer-events:auto;overflow:hidden`;
      let bgCanvas: HTMLCanvasElement | undefined;
      const paintState = (graphic: Graphic | undefined, spec: ButtonActionState) => {
        if (!bgCanvas || !graphic) return;
        const ctx = bgCanvas.getContext('2d');
        ctx?.clearRect(0, 0, itemWidth, itemHeight);
        ctx?.drawImage(graphic.image, 0, 0);
        bgCanvas.style.translate = spec.dx || spec.dy ? `${spec.dx}px ${spec.dy}px` : '';
        bgCanvas.style.opacity = spec.alpha < 255 ? String(spec.alpha / 255) : '';
        const b = 1 + spec.bright / 255 - spec.dark / 255;
        bgCanvas.style.filter = Math.abs(b - 1) > 0.005 ? `brightness(${Math.max(0, b).toFixed(3)})` : '';
      };
      if (normal) {
        bgCanvas = document.createElement('canvas');
        bgCanvas.width = itemWidth;
        bgCanvas.height = itemHeight;
        bgCanvas.style.cssText = 'position:absolute;inset:0;pointer-events:none';
        paintState(isDisabled ? disabled : normal, isDisabled ? actionStates.disable : actionStates.normal);
        button.append(bgCanvas);
      } else {
        button.style.background = 'rgba(20, 28, 48, 0.88)';
        button.style.border = '2px solid rgba(255, 255, 255, 0.65)';
        button.style.borderRadius = '8px';
      }
      const label = document.createElement('span');
      label.textContent = item.text;
      label.style.cssText = usePositionedLabel
        ? `position:absolute;left:${labelAnchorX}px;top:${labelAnchorY}px;transform:translate(${labelTx},${labelTy});font-size:${template.fontSize}px;line-height:1;color:${normalColor};pointer-events:none;white-space:nowrap`
        : `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:${template.fontSize}px;color:${normalColor};text-shadow:0 2px 4px rgba(0,0,0,0.85);pointer-events:none;white-space:nowrap`;
      label.style.fontFamily = this.message.style.fontFamily;
      button.append(label);
      if (!isDisabled) {
        button.addEventListener('pointerenter', () => {
          onHover?.();
          paintState(hover, actionStates.hit);
          label.style.color = hitColor;
        });
        button.addEventListener('pointerleave', () => {
          paintState(normal, actionStates.normal);
          label.style.color = normalColor;
        });
        button.addEventListener('pointerdown', () => {
          paintState(pressed, actionStates.push);
          label.style.color = hitColor;
        });
        button.addEventListener('pointerup', () => {
          paintState(hover, actionStates.hit);
          label.style.color = hitColor;
        });
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          onChoose(item.index);
        });
      }
      layer.append(button);
    }
    this.selectionLayer = layer;
    this.stage.append(layer);
    if (
      animate &&
      template.openAnime[0] > 0 &&
      template.openAnime[1] > 0 &&
      typeof layer.animate === 'function'
    ) {
      const [openType, openDuration] = template.openAnime;
      const buttons = [...layer.querySelectorAll('button')];
      const stagger = openType === 6 && buttons.length > 1 ? Math.min(40, Math.floor(openDuration / (buttons.length * 3))) : 0;
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i]!;
        const keyframes =
          openType === 6
            ? [
                {opacity: 0, transform: 'translateY(10px)'},
                {opacity: 1, transform: 'translateY(0px)'},
              ]
            : [{opacity: 0}, {opacity: 1}];
        btn.animate(keyframes, {
          duration: Math.max(50, openDuration - stagger * (buttons.length - 1)),
          delay: i * stagger,
          easing: 'ease-out',
          fill: 'backwards',
        });
      }
      const back = layer.firstElementChild as HTMLElement | null;
      if (back && back.tagName === 'CANVAS') {
        back.animate([{opacity: 0}, {opacity: 1}], {
          duration: openDuration,
          easing: 'ease-out',
        });
      }
    }
  }

  async show(
    objects: Iterable<DrawObject>,
    duration: number,
    button: (target: NonNullable<DrawObject['button']>) => void,
    fan?: WipeSpec,
    speedMode = 0,
  ): Promise<void> {
    const generation = ++this.stageGeneration;
    await this.finishCastTransition();
    if (generation !== this.stageGeneration) return;
    const next = await this.drawObjects(objects, button);
    if (generation !== this.stageGeneration) return;
    const title = next.querySelector('[aria-label="New Game"]');
    if (title) this.clearStageEffects();
    if (this.pendingEffects.size) {
      await this.presentStage(next, [], duration, fan, speedMode);
    } else {
      this.placeStageRectangles(next);
      if (fan && duration > 0) this.layers.append(this.cast);
      try {
        await this.replaceLayer(next, duration, fan, speedMode);
      } finally {
        if (fan && duration > 0 && generation === this.stageGeneration) {
          this.cast.inert = false;
          this.layers.after(this.cast);
        }
      }
    }
    if (generation !== this.stageGeneration) return;
    this.objectLayer = next;
    this.cast.replaceChildren();
    delete this.root.dataset.cast;
    delete this.root.dataset.background;
    this.root.dataset.phase = title ? 'title' : 'scene';
  }

  async refreshObjects(
    objects: Iterable<DrawObject>,
    button: (target: NonNullable<DrawObject['button']>) => void,
  ): Promise<void> {
    const wipingLayer =
      this.wipe?.playState === 'running' && this.activeWipeLayer?.isConnected
        ? this.activeWipeLayer
        : undefined;
    if (wipingLayer) {
      // Update the incoming wipe layer in place so non-blocking (wait=0) wipes
      // keep running smoothly while front-stage objects animate.
      const rGen = ++this.refreshGeneration;
      const next = await this.drawObjects(objects, button, false);
      if (rGen !== this.refreshGeneration || !wipingLayer.isConnected) return;
      this.preserveStageFocus(() => {
        for (const child of wipingLayer.children) (child as HTMLElement).inert = true;
        wipingLayer.replaceChildren(...next.children);
      });
      this.objectLayer = wipingLayer;
      this.syncHoverAfterDomUpdate();
      return;
    }
    const layer = this.objectLayer;
    if (!layer?.isConnected) return;
    const generation = ++this.stageGeneration;
    const next = await this.drawObjects(objects, button, false);
    if (generation !== this.stageGeneration) return;
    await this.replaceLayer(next, 0);
    if (generation !== this.stageGeneration) return;
    this.objectLayer = next;
  }

  updateStageObjectPositions(moved: ReadonlySet<DrawObject>): boolean {
    const layer = this.objectLayer;
    if (!layer?.isConnected || this.wipe || this.castTransition || !this.positionTargets) return false;
    const unmatched = new Set<DrawObject>();
    for (const object of moved) {
      if (
        object.mask !== undefined || object.positionEvents?.x || object.positionEvents?.y ||
        object.offsetEvents?.x?.size || object.offsetEvents?.y?.size || object.horizontalMotion
      )
        return false;
      if (object.visible) unmatched.add(object);
    }
    const changes = [];
    for (const element of layer.querySelectorAll<HTMLElement>('[data-siglus-positioned]')) {
      const target = this.positionTargets.get(element);
      if (!target || !moved.has(target.object)) continue;
      // A descendant's destination crop is positioned in stage coordinates.
      if (element.querySelector('[data-siglus-dst-clip]')) return false;
      changes.push({element, ...target});
      unmatched.delete(target.object);
    }
    if (unmatched.size) return false;
    for (const {element, object, originX, originY} of changes)
      this.applyObjectPosition(element, object, originX, originY);
    return true;
  }

  private async preloadObjectGraphics(objects: Iterable<DrawObject>): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    const now = performance.now();
    const visit = (list: Iterable<DrawObject>) => {
      for (const object of list) {
        if (!object.visible) continue;
        if (
          !object.text &&
          !(object.weather && object.weather.mode > 0) &&
          object.gan?.sequence === undefined &&
          !object.movie &&
          object.name &&
          object.type !== 11 &&
          object.pattern >= 0
        ) {
          if (!object.frames[object.pattern]) {
            const pat = object.pattern;
            jobs.push(
              this.objectGraphic(object.name, pat)
                .then((g) => {
                  if (g) object.frames[pat] = g;
                })
                .catch(() => {}),
            );
          }
          const patEv = object.intEvents?.get('ch:90');
          if (
            patEv &&
            patEv.duration > 0 &&
            patEv.from !== patEv.target &&
            (patEv.mode !== 0 || now < patEv.endAt)
          ) {
            const lo = Math.max(0, Math.min(patEv.from, patEv.target));
            const hi = Math.min(lo + 64, Math.max(patEv.from, patEv.target));
            for (let p = lo; p <= hi; p++) {
              if (!object.frames[p]) {
                jobs.push(
                  this.objectGraphic(object.name, p)
                    .then((g) => {
                      if (g) object.frames[p] = g;
                    })
                    .catch(() => {}),
                );
              }
            }
          }
        }
        if (object.children) visit(object.children.values());
      }
    };
    visit(objects);
    if (jobs.length > 1) await Promise.all(jobs);
  }

  private async drawObjects(
    objects: Iterable<DrawObject>,
    button: (target: NonNullable<DrawObject['button']>) => void,
    animate = true,
    layerScope: 'stage' | 'system' | 'systemFront' = 'stage',
  ): Promise<HTMLElement> {
    const list = Array.isArray(objects) ? objects : [...objects];
    await this.preloadObjectGraphics(list);
    const next = document.createElement('div');
    next.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    await this.appendObjects(next, list, button, animate, [], true, [0, 0], layerScope);
    return next;
  }

  private applyObjectClip(
    element: HTMLElement,
    object: DrawObject,
    key: 'dstClip' | 'sourceClip',
    [left, top, right, bottom]: readonly [number, number, number, number],
    width: number,
    height: number,
  ): void {
    const now = performance.now();
    const active = [0, 1, 2, 3].map((edge) => {
      const ev = object.intEvents?.get(`${key}:${edge}`);
      return ev && (ev.mode !== 0 || now - ev.started < ev.duration + ev.delay) ? ev : undefined;
    });
    if (active.every((ev) => !ev)) {
      if (right <= left || bottom <= top) {
        element.style.clipPath = 'inset(100%)';
        return;
      }
      element.style.clipPath = `inset(${Math.max(0, top)}px ${Math.max(0, width - right)}px ${Math.max(0, height - bottom)}px ${Math.max(0, left)}px)`;
      return;
    }
    const edgePx = (edge: 0 | 1 | 2 | 3, fallback: number): string => {
      const ev = active[edge];
      if (!ev) return `${fallback}px`;
      const property = `--siglus-${key === 'dstClip' ? 'dst' : 'source'}-clip-${edge}`;
      registerAnimatedNumber(property);
      element.style.setProperty(property, String(fallback));
      const animation = element.animate(
        {[property]: [String(ev.from), String(ev.target)]},
        {
          duration: ev.duration,
          delay: ev.delay,
          easing: eventEasing(ev.easing),
          fill: 'both',
          iterations: ev.mode === 0 ? 1 : Infinity,
          direction: ev.mode === 2 ? 'alternate' : 'normal',
        },
      );
      animation.currentTime = Math.max(0, now - ev.started);
      return `calc(var(${property}) * 1px)`;
    };
    const leftPx = edgePx(0, left);
    const topPx = edgePx(1, top);
    const rightPx = edgePx(2, right);
    const bottomPx = edgePx(3, bottom);
    element.style.clipPath = `inset(max(0px, ${topPx}) max(0px, ${width}px - ${rightPx}) max(0px, ${height}px - ${bottomPx}) max(0px, ${leftPx}))`;
  }

  private destinationClipLayer(
    object: DrawObject,
    [x, y]: readonly [number, number],
  ): {viewport: HTMLElement; content: HTMLElement} | undefined {
    if (!object.clip?.[0]) return;
    const [, left, top, right, bottom] = object.clip;
    // Native combines destination rectangles in stage coordinates before drawing the
    // transformed sprite. Keep the viewport outside the object's animated transform.
    const document = this.stage.ownerDocument;
    const viewport = document.createElement('div');
    viewport.dataset.siglusDstClip = '';
    viewport.style.cssText = `position:absolute;left:${-x}px;top:${-y}px;width:${this.width}px;height:${this.height}px;pointer-events:none`;
    this.applyObjectClip(viewport, object, 'dstClip', [left, top, right, bottom], this.width, this.height);
    if (!x && !y) return {viewport, content: viewport};
    const content = document.createElement('div');
    content.style.cssText = `position:absolute;left:${x}px;top:${y}px;pointer-events:none`;
    viewport.append(content);
    return {viewport, content};
  }

  private async appendObjects(
    parent: HTMLElement,
    objects: Iterable<DrawObject>,
    button: (target: NonNullable<DrawObject['button']>) => void,
    animate: boolean,
    parentOpacity: readonly string[] = [],
    isRootStage = false,
    parentOrigin: readonly [number, number] = [0, 0],
    layerScope: 'stage' | 'system' | 'systemFront' = 'stage',
  ): Promise<void> {
    const tagStageSlot = (el: HTMLElement, object: DrawObject) => {
      if (!isRootStage || object.slotId === undefined) return;
      el.dataset.siglusObjectId = String(object.slotId);
      el.dataset.siglusDrawOrder = String(object.order ?? 0);
      el.dataset.siglusDrawLayer = String(object.layer ?? 0);
      if (this.spaceHideIds.has(object.slotId)) {
        el.dataset.siglusSpaceHide = '1';
        if (!this.messageDisplayed) el.style.visibility = 'hidden';
      }
    };
    for (const object of objects) {
      if (!object.visible) continue;
      const clip = this.destinationClipLayer(object, parentOrigin);
      if (clip) parent.append(clip.viewport);
      const targetParent = clip?.content ?? parent;
      if (object.text) {
        const text = document.createElement('div');
        const {
          value,
          font,
          size,
          bold,
          shadow,
          spaceX,
          maxChars,
          color,
          shadowColor,
          outlineColor,
          shadowMode,
        } = object.text;
        const fillCss = color !== undefined ? (this.tableColor(color) ?? 'white') : 'white';
        const textPlacement = computeObjectPlacement(object);
        const maxWidth =
          maxChars && maxChars > 0 ? Math.max(size, maxChars * (size + (spaceX ?? 0))) : this.width;
        text.style.cssText = `position:absolute;left:${textPlacement.placedX}px;top:${textPlacement.placedY}px;width:${maxWidth}px;height:${this.height}px;font-size:${size}px;color:${fillCss};white-space:pre;pointer-events:none`;
        text.dataset.siglusObjectText = '';
        text.style.fontFamily = this.fontFamily(font);
        text.style.fontWeight = bold ? 'bold' : 'normal';
        if (spaceX) text.style.letterSpacing = `${spaceX}px`;
        for (const run of layoutObjectText(value, object.text)) {
          const span = document.createElement('span');
          span.textContent = run.text;
          span.style.cssText = `position:absolute;left:${run.x}px;top:${run.y}px;font-size:${run.size}px;line-height:1`;
          if (run.color !== color) span.style.color = this.tableColor(run.color ?? -1) ?? fillCss;
          text.append(span);
        }
        const shadowCss =
          shadowColor !== undefined && shadowColor >= 0
            ? (this.tableColor(shadowColor) ?? 'black')
            : 'black';
        const outlineCss =
          outlineColor !== undefined && outlineColor >= 0
            ? (this.tableColor(outlineColor) ?? 'black')
            : 'black';
        if (
          shadowMode === 2 ||
          (shadowMode === undefined && outlineColor !== undefined && outlineColor >= 0)
        ) {
          text.style.textShadow = `1px 0 0 ${outlineCss},-1px 0 0 ${outlineCss},0 1px 0 ${outlineCss},0 -1px 0 ${outlineCss}`;
        } else if (shadowMode === 1 || (shadowMode === undefined && shadow)) {
          text.style.textShadow = `1px 1px 2px ${shadowCss}`;
        }
        this.applyObjectScale(text, object, [textPlacement.pivotX, textPlacement.pivotY]);
        this.applyObjectPosition(text, object, textPlacement.originX, textPlacement.originY);
        this.applyLeafOpacity(text, object, animate, parentOpacity);
        tagStageSlot(clip?.viewport ?? text, object);
        targetParent.append(text);
        if (object.children)
          await this.appendChildren(
            targetParent,
            object,
            button,
            animate,
            parentOpacity,
            parentOrigin,
            layerScope,
          );
        continue;
      }
      if (object.weather && object.weather.mode > 0) {
        const layer = await this.weatherLayer(object);
        if (layer) {
          this.applyLeafOpacity(layer, object, animate, parentOpacity);
          tagStageSlot(clip?.viewport ?? layer, object);
          targetParent.append(layer);
        }
        if (object.children)
          await this.appendChildren(
            targetParent,
            object,
            button,
            animate,
            parentOpacity,
            parentOrigin,
            layerScope,
          );
        continue;
      }
      if (object.gan?.sequence !== undefined) {
        const ganLayer = await this.objectGanLayer(object);
        if (ganLayer) {
          this.applyObjectScale(ganLayer, object, [0, 0]);
          this.applyObjectPosition(ganLayer, object);
          this.applyLeafOpacity(ganLayer, object, animate, parentOpacity);
          tagStageSlot(clip?.viewport ?? ganLayer, object);
          targetParent.append(ganLayer);
          if (object.children)
            await this.appendChildren(
              targetParent,
              object,
              button,
              animate,
              parentOpacity,
              parentOrigin,
              layerScope,
            );
          continue;
        }
      }
      if (!object.movie && !object.name && !object.frames.length) {
        if (object.children) {
          const wrapper = await this.appendChildren(
            targetParent,
            object,
            button,
            animate,
            parentOpacity,
            parentOrigin,
            layerScope,
          );
          tagStageSlot(clip?.viewport ?? wrapper, object);
        }
        continue;
      }
      if (object.pattern < 0) continue;
      const frame = object.movie
        ? {
            width: object.movie.width,
            height: object.movie.height,
            x: 0,
            y: 0,
            centerX: 0,
            centerY: 0,
            contentBounds: undefined,
          }
        : (object.frames[object.pattern] ?? (
            object.type === 11 ? undefined :
              (object.frames[object.pattern] = await this.objectGraphic(object.name, object.pattern))
          ));
      if (!frame) continue;
      const sourceBounds = object.sourceClipEnabled ? object.sourceClipBounds : undefined;
      const content =
        object.button === undefined
          ? document.createElement('div')
          : document.createElement('button');
      // The outer crop applies to every pattern and intersects the button's alpha hit path.
      const element = sourceBounds && object.button ? document.createElement('div') : content;
      if (element !== content) {
        content.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;padding:0;background:none;pointer-events:none';
        element.append(content);
      }
      let canvas: HTMLCanvasElement;
      if ('image' in frame) canvas = this.node(frame);
      else {
        canvas = document.createElement('canvas');
        canvas.width = frame.width;
        canvas.height = frame.height;
        canvas.style.position = 'absolute';
        object.movie!.connect(canvas);
      }
      canvas.style.left = '0';
      canvas.style.top = '0';
      canvas.style.pointerEvents = 'none';
      const placement = computeObjectPlacement(object, frame);
      element.style.cssText = `position:absolute;left:${placement.placedX}px;top:${placement.placedY}px;width:${frame.width}px;height:${frame.height}px;border:0;padding:0;background:none;pointer-events:none`;
      this.applyObjectScale(element, object, [placement.pivotX, placement.pivotY]);
      if (object.name) content.dataset.siglusObject = object.name;
      tagStageSlot(clip?.viewport ?? element, object);
      const mask = object.mask === undefined ? undefined : this.objectMasks.get(object.mask);
      if (mask?.url) {
        element.style.maskImage = `url("${mask.url}")`;
        element.style.maskMode = 'luminance';
        element.style.maskRepeat = 'no-repeat';
        if (mask.x || mask.y) {
          element.style.maskPosition = `${mask.x - placement.placedX}px ${mask.y - placement.placedY}px`;
        }
      }
      const blendTarget = clip && !object.children ? clip.viewport : element;
      if (object.blend === 1) blendTarget.style.mixBlendMode = 'plus-lighter';
      if (object.blend === 3) blendTarget.style.mixBlendMode = 'multiply';
      if (object.blend === 4) blendTarget.style.mixBlendMode = 'screen';
      this.applyObjectPosition(element, object, placement.originX, placement.originY);
      content.append(canvas);
      if (object.patternCycle) {
        const {count, duration, started} = object.patternCycle;
        const elapsed = performance.now() - started;
        for (let index = 0; index < count; index++) {
          const graphic = (object.frames[index] ??= await this.graphic(object.name, index));
          const image = index === object.pattern ? canvas : this.node(graphic);
          if (image !== canvas) content.append(image);
          image.style.left = '0';
          image.style.top = '0';
          image.style.opacity = '0';
          const animation = image.animate(
            [
              {opacity: 1, easing: 'steps(1, jump-end)'},
              {opacity: 0, offset: 1 / count},
              {opacity: 0},
            ],
            {duration, delay: (index * duration) / count, iterations: Infinity},
          );
          animation.currentTime = elapsed + duration;
        }
      } else if (!object.movie && object.name && object.intEvents?.has('ch:90')) {
        const patEv = object.intEvents.get('ch:90')!;
        const now = performance.now();
        if (patEv.duration > 0 && patEv.from !== patEv.target && (patEv.mode !== 0 || now < patEv.endAt)) {
          const step = patEv.target >= patEv.from ? 1 : -1;
          const seq: number[] = [];
          for (let p = patEv.from; seq.length < 64; p += step) {
            if (p >= 0) seq.push(p);
            if (p === patEv.target) break;
          }
          if (patEv.mode === 2 && seq.length > 2) {
            for (let i = seq.length - 2; i >= 1; i--) seq.push(seq[i]!);
          }
          const totalDur = patEv.mode === 2 ? patEv.duration * 2 : patEv.duration;
          const count = seq.length;
          if (count > 1 && totalDur > 0) {
            const elapsed = Math.max(0, now - patEv.started);
            const seen = new Map<number, HTMLCanvasElement>();
            for (const p of seq) {
              if (seen.has(p)) continue;
              const g = object.frames[p] ?? (await this.objectGraphic(object.name, p).catch(() => undefined));
              if (!g) continue;
              object.frames[p] = g;
              const img = p === object.pattern ? canvas : this.node(g);
              if (img !== canvas) {
                img.style.left = '0';
                img.style.top = '0';
                img.style.pointerEvents = 'none';
                content.append(img);
              }
              seen.set(p, img);
            }
            for (const [pat, img] of seen) {
              const frames: Keyframe[] = [];
              for (let idx = 0; idx < count; idx++) {
                frames.push({
                  offset: idx / count,
                  opacity: seq[idx] === pat ? 1 : 0,
                  easing: 'steps(1, end)',
                });
              }
              frames.push({offset: 1, opacity: seq[count - 1] === pat ? 1 : 0});
              const animation = img.animate(frames, {
                duration: totalDur,
                delay: patEv.delay,
                iterations: patEv.mode === 0 ? 1 : Infinity,
                fill: 'both',
              });
              animation.currentTime = elapsed;
            }
          }
        }
      }
      targetParent.append(element);
      if (sourceBounds)
        this.applyObjectClip(element, object, 'sourceClip', sourceBounds, frame.width, frame.height);
      if (content instanceof HTMLButtonElement) {
        const target = object.buttonCall
          ? {...object.button!, buttonCall: object.buttonCall}
          : object.button!;
        if ('image' in frame)
          content.style.clipPath = this.buttonHitPath(frame, canvas, object);
        const role = object.name.split('_').at(-1);
        const supported =
          !object.name.startsWith('__sys_title_btn_') ||
          role === 'start' ||
          role === 'prol' ||
          role === 'exit' ||
          role === 'load' ||
          role === 'music' ||
          role === 'config';
        content.disabled = !supported || Boolean(object.disabled);
        content.style.pointerEvents = supported ? 'auto' : 'none';
        content.style.cursor = 'pointer';
        content.setAttribute(
          'aria-label',
          role === 'start'
            ? 'New Game'
            : role === 'prol'
              ? 'Prologue'
              : role === 'load'
                ? 'Load Game'
                : role === 'exit'
                  ? 'Exit'
                  : role === 'music'
                    ? 'Music'
                    : role === 'config'
                      ? 'Configuration'
                      : object.name,
        );
        content.dataset.siglusButton = String(target.id);
        content.dataset.siglusGroup = String(target.group);
        const hoverKey = `obj:${layerScope}:${target.group}:${target.id}`;
        content.dataset.siglusHoverKey = hoverKey;
        content.inert = this.objectButtonGroups?.has(target.group) === false;
        if (object.buttonState) content.dataset.siglusButtonState = object.buttonState;
        const isSelectState = object.buttonState === 'select';
        const isHovered =
          !content.disabled &&
          !content.inert &&
          this.hovered?.group === target.group &&
          this.hovered?.id === target.id;
        const isPressed =
          isHovered &&
          this.pressed?.group === target.group &&
          this.pressed?.id === target.id;
        const onEnter = () => {
          if (content.disabled) return;
          this.hovered = {id: target.id, group: target.group};
          this.enterButtonHover(hoverKey, target.seNo);
        };
        const onLeave = () => {
          this.leaveButtonHover(hoverKey, content);
          if (
            content.isConnected &&
            !content.closest('[inert]') &&
            this.hovered?.group === target.group &&
            this.hovered?.id === target.id
          ) {
            this.hovered = undefined;
          }
        };
        if (target.actionNo !== undefined && target.actionNo >= 0 && object.name && 'image' in frame) {
          const actionStates = parseButtonActionStates(this.config, target.actionNo);
          const changesGraphic = ({cutOffset, dx, dy, alpha, bright, dark}: ButtonActionState) =>
            cutOffset !== 0 || dx !== 0 || dy !== 0 || alpha !== 255 || bright !== 0 || dark !== 0;
          if (Object.values(actionStates).some(changesGraphic)) {
            let paintGen = 0;
            const applyBtnState = async (spec: ButtonActionState): Promise<void> => {
              const gen = ++paintGen;
              const cut = Math.max(0, object.pattern + spec.cutOffset);
              let graphic = object.frames[cut];
              if (!graphic) {
                graphic = await this.objectGraphic(object.name, cut).catch(() => undefined);
                if (graphic) object.frames[cut] = graphic;
              }
              if (gen !== paintGen) return;
              graphic ??= frame;
              const ctx = canvas.getContext('2d');
              ctx?.clearRect(0, 0, canvas.width, canvas.height);
              if (graphic.width > 0 && graphic.height > 0) ctx?.drawImage(graphic.image, 0, 0);
              canvas.style.translate = spec.dx || spec.dy ? `${spec.dx}px ${spec.dy}px` : '';
              canvas.style.opacity = spec.alpha < 255 ? String(spec.alpha / 255) : '';
              const br = 1 + spec.bright / 255 - spec.dark / 255;
              canvas.style.filter =
                Math.abs(br - 1) > 0.005 ? `brightness(${Math.max(0, br).toFixed(3)})` : '';
            };
            const restingState = () =>
              content.disabled
                ? actionStates.disable
                : isSelectState
                  ? actionStates.select
                  : actionStates.normal;
            const initial = isPressed
              ? actionStates.push
              : isHovered
                ? actionStates.hit
                : restingState();
            if (changesGraphic(initial)) await applyBtnState(initial);
            content.addEventListener('pointerenter', () => {
              onEnter();
              if (!content.disabled) void applyBtnState(actionStates.hit);
            });
            content.addEventListener('pointerleave', () => {
              onLeave();
              if (content.isConnected && !content.closest('[inert]')) {
                void applyBtnState(restingState());
              }
            });
            content.addEventListener('pointerdown', (event) => {
              if (event.button === 0 && !content.disabled) {
                if (target.seNo !== undefined && target.seNo >= 0) {
                  this.onButtonSound?.(target.seNo, 'push');
                }
                void applyBtnState(actionStates.push);
              }
            });
            content.addEventListener('pointerup', () => {
              if (!content.disabled) void applyBtnState(actionStates.hit);
            });
          } else {
            content.addEventListener('pointerenter', onEnter);
            content.addEventListener('pointerleave', onLeave);
            if (target.seNo !== undefined && target.seNo >= 0) {
              content.addEventListener('pointerdown', (event) => {
                if (event.button === 0 && !content.disabled) this.onButtonSound?.(target.seNo!, 'push');
              });
            }
          }
        } else {
          content.addEventListener('pointerenter', onEnter);
          content.addEventListener('pointerleave', onLeave);
          if (target.seNo !== undefined && target.seNo >= 0) {
            content.addEventListener('pointerdown', (event) => {
              if (event.button === 0 && !content.disabled) this.onButtonSound?.(target.seNo!, 'push');
            });
          }
        }
        content.addEventListener('click', (event) => {
          event.stopPropagation();
          this.stage.focus({preventScroll: true});
          if (!object.pushKeep || event.detail === 0) button(target);
        });
        content.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          this.pressed = target;
          this.heldButton = {
            pointerId: event.pointerId,
            pushKeep: Boolean(object.pushKeep),
            element: content,
            target,
            release: () => button(target),
          };
          if (object.pushKeep) {
            this.stage.setPointerCapture(event.pointerId);
          }
        });
      }
      if (object.horizontalMotion) {
        const {from, duration, delay, easing, started} = object.horizontalMotion;
        const elapsed = performance.now() - started;
        if (elapsed < duration + delay) {
          const animation = element.animate(
            [
              {translate: `${from - object.x}px 0px`, composite: 'add'},
              {translate: '0px 0px', composite: 'add'},
            ],
            {duration, delay, easing: eventEasing(easing), fill: 'both'},
          );
          animation.currentTime = elapsed;
        }
      }
      this.applyLeafOpacity(element, object, animate, parentOpacity);
      if (object.movement) {
        const [target, time, delay, mode, start] = object.movement;
        const elapsed =
          object.movementStarted === undefined ? 0 : Math.max(0, performance.now() - object.movementStarted);
        if ((animate || object.movementStarted !== undefined) && elapsed < time + delay) {
          const animation = element.animate(
            [
              {translate: `0px ${start}px`, composite: 'add'},
              {translate: `0px ${target}px`, composite: 'add'},
            ],
            {duration: time, delay, easing: eventEasing(mode), fill: 'both'},
          );
          animation.currentTime = elapsed;
        }
      }
      if (object.children)
        await this.appendChildren(
          targetParent,
          object,
          button,
          animate,
          parentOpacity,
          parentOrigin,
          layerScope,
        );
    }
  }

  private applyLeafOpacity(
    element: HTMLElement,
    object: DrawObject,
    animate: boolean,
    parentOpacity: readonly string[],
  ): void {
    let property = 'opacity';
    if (parentOpacity.length) {
      property = '--siglus-object-opacity';
      registerAnimatedNumber(property);
      const factor = [property, ...parentOpacity].map((name) => `var(${name})`).join(' * ');
      element.style.opacity = `calc(${factor})`;
    }
    this.applyObjectOpacity(element, object, animate, property);
  }

  private applyObjectOpacity(
    element: HTMLElement,
    object: DrawObject,
    animate: boolean,
    property: string,
  ): void {
    const now = performance.now();
    if (object.opacityElapsed !== undefined) {
      object.opacityStarted = now - object.opacityElapsed;
      object.opacityElapsed = undefined;
    }
    let staticRepScale = 1;
    const animatedFactors: string[] = [];
    for (const [slot, factor] of (object.trOffsets ?? []).entries()) {
      const clamped = Math.max(0, Math.min(255, factor)) / 255;
      const ev = object.intEvents?.get(`tr_rep:${slot}`);
      if (ev && (ev.mode !== 0 || now - ev.started < ev.duration + ev.delay)) {
        const trProp = `--siglus-tr-rep-${slot}`;
        registerAnimatedNumber(trProp);
        element.style.setProperty(trProp, String(clamped));
        const animation = element.animate(
          {
            [trProp]: [
              String(Math.max(0, Math.min(255, ev.from)) / 255),
              String(Math.max(0, Math.min(255, ev.target)) / 255),
            ],
          },
          {
            duration: ev.duration,
            delay: ev.delay,
            easing: eventEasing(ev.easing),
            fill: 'both',
            iterations: ev.mode === 0 ? 1 : Infinity,
            direction: ev.mode === 2 ? 'alternate' : 'normal',
          },
        );
        animation.currentTime = Math.max(0, now - ev.started);
        animatedFactors.push(`var(${trProp})`);
      } else {
        staticRepScale *= clamped;
      }
    }
    const baseOpacity = ((object.transparency ?? 255) / 255) * staticRepScale;
    const trLoopEv = object.intEvents?.get('ch:72');
    const hasTrLoop = Boolean(trLoopEv && trLoopEv.mode !== 0 && trLoopEv.duration > 0);
    const fadeElapsed =
      object.opacityStarted === undefined ? 0 : Math.max(0, now - object.opacityStarted);
    const hasFade = Boolean(
      !hasTrLoop &&
        object.opacity &&
        (animate || object.opacityStarted !== undefined) &&
        object.opacity[1] + object.opacity[2] > fadeElapsed,
    );
    if (animatedFactors.length) {
      if (hasTrLoop && trLoopEv) {
        const fadeProp = '--siglus-fade-opacity';
        registerAnimatedNumber(fadeProp);
        element.style.setProperty(fadeProp, String(Math.max(0, Math.min(255, trLoopEv.target)) / 255));
        const animation = element.animate(
          {
            [fadeProp]: [
              String(Math.max(0, Math.min(255, trLoopEv.from)) / 255),
              String(Math.max(0, Math.min(255, trLoopEv.target)) / 255),
            ],
          },
          {
            duration: trLoopEv.duration,
            delay: trLoopEv.delay,
            easing: eventEasing(trLoopEv.easing),
            fill: 'both',
            iterations: Infinity,
            direction: trLoopEv.mode === 2 ? 'alternate' : 'normal',
          },
        );
        animation.currentTime = Math.max(0, now - trLoopEv.started);
        animatedFactors.push(`var(${fadeProp})`);
        if (staticRepScale !== 1) animatedFactors.push(String(staticRepScale));
      } else if (hasFade && object.opacity) {
        const [target, duration, delay, mode, start] = object.opacity;
        const fadeProp = '--siglus-fade-opacity';
        registerAnimatedNumber(fadeProp);
        element.style.setProperty(fadeProp, String(target / 255));
        const animation = element.animate(
          {[fadeProp]: [String(start / 255), String(target / 255)]},
          {duration, delay, easing: eventEasing(mode), fill: 'both'},
        );
        animation.currentTime = Math.max(0, fadeElapsed);
        animatedFactors.push(`var(${fadeProp})`);
        if (staticRepScale !== 1) animatedFactors.push(String(staticRepScale));
      } else if (baseOpacity !== 1) {
        animatedFactors.push(String(baseOpacity));
      }
      element.style.setProperty(
        property,
        animatedFactors.length === 1 ? animatedFactors[0]! : `calc(${animatedFactors.join(' * ')})`,
      );
      return;
    }
    if (object.transparency !== undefined || object.trOffsets?.length)
      element.style.setProperty(property, String(baseOpacity));
    if (hasTrLoop && trLoopEv) {
      const animation = element.animate(
        {
          [property]: [
            String((Math.max(0, Math.min(255, trLoopEv.from)) / 255) * staticRepScale),
            String((Math.max(0, Math.min(255, trLoopEv.target)) / 255) * staticRepScale),
          ],
        },
        {
          duration: trLoopEv.duration,
          delay: trLoopEv.delay,
          easing: eventEasing(trLoopEv.easing),
          fill: 'both',
          iterations: Infinity,
          direction: trLoopEv.mode === 2 ? 'alternate' : 'normal',
        },
      );
      animation.currentTime = Math.max(0, now - trLoopEv.started);
      return;
    }
    if (!hasFade || !object.opacity) return;
    const [target, duration, delay, mode, start] = object.opacity;
    const animation = element.animate(
      {
        [property]: [
          String((start / 255) * staticRepScale),
          String((target / 255) * staticRepScale),
        ],
      },
      {duration, delay, easing: eventEasing(mode), fill: 'both'},
    );
    animation.currentTime = Math.max(0, fadeElapsed);
  }

  private async appendChildren(
    parent: HTMLElement,
    object: DrawObject,
    button: (target: NonNullable<DrawObject['button']>) => void,
    animate: boolean,
    parentOpacity: readonly string[],
    parentOrigin: readonly [number, number] = [0, 0],
    layerScope: 'stage' | 'system' | 'systemFront' = 'stage',
  ): Promise<HTMLElement> {
    // Applying the group alpha to its leaves keeps blending in the stage's backdrop.
    const children = document.createElement('div');
    children.style.cssText = 'position:absolute;pointer-events:none';
    this.applyObjectPosition(children, object);
    const childPivot: [number, number] = [object.centerRep?.[0] ?? 0, object.centerRep?.[1] ?? 0];
    this.applyObjectScale(children, object, childPivot);
    if (
      (object.transparency ?? 255) !== 255 ||
      object.opacity ||
      object.trOffsets?.length ||
      object.intEvents?.has('ch:72')
    ) {
      const property = '--siglus-group-opacity-' + parentOpacity.length;
      registerAnimatedNumber(property);
      this.applyObjectOpacity(children, object, animate, property);
      parentOpacity = [...parentOpacity, property];
    }
    parent.append(children);
    const childOffsetX = object.positionOffsets?.x?.reduce((sum, value) => sum + value, 0) ?? 0;
    const childOffsetY = object.positionOffsets?.y?.reduce((sum, value) => sum + value, 0) ?? 0;
    const childOrigin: readonly [number, number] = [
      parentOrigin[0] + object.x + childOffsetX,
      parentOrigin[1] + object.y + childOffsetY,
    ];
    await this.appendObjects(
      children,
      orderedObjects(object.children!),
      button,
      animate,
      parentOpacity,
      false,
      childOrigin,
      layerScope,
    );
    return children;
  }

  private applyObjectPosition(
    element: HTMLElement,
    object: DrawObject,
    originX = 0,
    originY = 0,
  ): void {
    const targets = (this.positionTargets ??= new WeakMap());
    if (!targets.has(element)) {
      targets.set(element, {object, originX, originY});
      element.dataset.siglusPositioned = '';
    }
    const now = performance.now();
    for (const axis of ['x', 'y'] as const) {
      const property = axis === 'x' ? 'left' : 'top';
      const offsets = object.positionOffsets?.[axis];
      const baseOrigin = axis === 'x' ? originX : originY;
      const origin = baseOrigin + (offsets?.reduce((sum, value) => sum + value, 0) ?? 0);
      element.style[property] = `${object[axis] + origin}px`;
      const loopEv = object.intEvents?.get(axis === 'x' ? 'ch:51' : 'ch:64');
      if (loopEv && loopEv.mode !== 0 && loopEv.duration > 0) {
        const animation = element.animate(
          {[property]: [`${loopEv.from + origin}px`, `${loopEv.target + origin}px`]},
          {
            duration: loopEv.duration,
            delay: loopEv.delay,
            easing: eventEasing(loopEv.easing),
            fill: 'both',
            iterations: Infinity,
            direction: loopEv.mode === 2 ? 'alternate' : 'normal',
          },
        );
        animation.currentTime = Math.max(0, now - loopEv.started);
      } else {
        const event = object.positionEvents?.[axis];
        if (event) {
          const elapsed = Math.max(0, now - event.started);
          const total = Number(event.time.duration ?? 0) + Number(event.time.delay ?? 0);
          if (elapsed < total) {
            const animation = element.animate(
              {[property]: [`${event.from + origin}px`, element.style[property]]},
              event.time,
            );
            animation.currentTime = elapsed;
          }
        }
      }
      for (const [index, offset] of object.offsetEvents?.[axis] ?? []) {
        const elapsed = Math.max(0, now - offset.started);
        const total = Number(offset.time.duration ?? 0) + Number(offset.time.delay ?? 0);
        if (elapsed >= total) continue;
        const delta = offset.from - (offsets?.[index] ?? 0);
        const start = axis === 'x' ? `${delta}px 0px` : `0px ${delta}px`;
        const animation = element.animate(
          [
            {translate: start, composite: 'add'},
            {translate: '0px 0px', composite: 'add'},
          ],
          offset.time,
        );
        animation.currentTime = elapsed;
      }
    }
  }

  private colorFilterUrl(key: string, setup: (filter: SVGFilterElement) => void): string {
    const cached = this.colorFilterCache.get(key);
    if (cached) return cached;
    if (!this.colorFilterSvg) {
      const svg = document.createElementNS(svgNamespace, 'svg');
      svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
      const defs = document.createElementNS(svgNamespace, 'defs');
      svg.append(defs);
      this.stage.append(svg);
      this.colorFilterSvg = svg;
    }
    const id = 'siglus-cm-' + this.colorFilterCache.size;
    const filter = document.createElementNS(svgNamespace, 'filter');
    filter.id = id;
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    setup(filter);
    this.colorFilterSvg.firstChild!.appendChild(filter);
    const url = `url(#${id})`;
    this.colorFilterCache.set(key, url);
    return url;
  }

  private appendColorMatrix(filter: SVGFilterElement, matrix: string): void {
    const transform = document.createElementNS(svgNamespace, 'feColorMatrix');
    transform.setAttribute('type', 'matrix');
    transform.setAttribute('values', matrix);
    filter.append(transform);
  }

  private toneCurveFilterUrl(index: number): string | undefined {
    const curve = this.toneCurves?.get(index);
    if (!curve) return;
    return this.colorFilterUrl(`tone:${index}`, (filter) => {
      // The 2D pixel shader at file offset 0x7920a0 mixes luminance before
      // looking up the three channels, and retains the sprite's alpha.
      if (curve.monochrome) {
        const weights = [0.2989, 0.5886, 0.1145];
        const rows = weights.map((_, channel) => [...weights.map((weight, component) =>
          curve.monochrome * weight + (component === channel ? 1 - curve.monochrome : 0)), 0, 0]);
        this.appendColorMatrix(filter, [...rows.flat(), 0, 0, 0, 1, 0].join(' '));
      }
      const transfer = document.createElementNS(svgNamespace, 'feComponentTransfer');
      for (const [channel, name] of ['feFuncR', 'feFuncG', 'feFuncB'].entries()) {
        const component = document.createElementNS(svgNamespace, name);
        component.setAttribute('type', 'table');
        component.setAttribute('tableValues', Array.from(curve.channels[channel]!, (byte) => byte / 255).join(' '));
        transfer.append(component);
      }
      filter.append(transfer);
    });
  }

  private applyObjectScale(
    element: HTMLElement,
    object: DrawObject,
    origin: readonly [number, number],
  ): void {
    const now = performance.now();
    const activeEvent = (key: string): ObjectIntEvent | undefined => {
      const ev = object.intEvents?.get(key);
      return ev && ev.duration > 0 && (ev.mode !== 0 || now < ev.endAt) ? ev : undefined;
    };
    const rotXEv = activeEvent('ch:69');
    const rotYEv = activeEvent('ch:70');
    const rotZEv = activeEvent('ch:71');
    const scaleXLoop = activeEvent('ch:67');
    const scaleYLoop = activeEvent('ch:68');
    const hasTransform =
      Boolean(object.scale) ||
      Boolean(object.rotateX) ||
      Boolean(object.rotateY) ||
      Boolean(object.rotateZ) ||
      Boolean(rotXEv || rotYEv || rotZEv || scaleXLoop || scaleYLoop);
    if (hasTransform) element.style.transformOrigin = `${origin[0]}px ${origin[1]}px`;
    if (rotZEv) {
      element.style.rotate = `${rotZEv.target / 10}deg`;
      const anim = element.animate(
        {rotate: [`${rotZEv.from / 10}deg`, `${rotZEv.target / 10}deg`]},
        {
          duration: rotZEv.duration,
          delay: rotZEv.delay,
          easing: eventEasing(rotZEv.easing),
          fill: 'both',
          iterations: rotZEv.mode === 0 ? 1 : Infinity,
          direction: rotZEv.mode === 2 ? 'alternate' : 'normal',
        },
      );
      anim.currentTime = Math.max(0, now - rotZEv.started);
    } else if (object.rotateZ) {
      element.style.rotate = `${object.rotateZ / 10}deg`;
    }
    if (rotXEv || rotYEv) {
      const parts: string[] = [];
      for (const [ev, prop, fn, fallback] of [
        [rotXEv, '--siglus-rot-x', 'rotateX', object.rotateX ?? 0],
        [rotYEv, '--siglus-rot-y', 'rotateY', object.rotateY ?? 0],
      ] as const) {
        if (ev) {
          registerAnimatedNumber(prop);
          element.style.setProperty(prop, String(ev.target / 10));
          const anim = element.animate(
            {[prop]: [String(ev.from / 10), String(ev.target / 10)]},
            {
              duration: ev.duration,
              delay: ev.delay,
              easing: eventEasing(ev.easing),
              fill: 'both',
              iterations: ev.mode === 0 ? 1 : Infinity,
              direction: ev.mode === 2 ? 'alternate' : 'normal',
            },
          );
          anim.currentTime = Math.max(0, now - ev.started);
          parts.push(`${fn}(calc(var(${prop}) * 1deg))`);
        } else if (fallback) {
          parts.push(`${fn}(${fallback / 10}deg)`);
        }
      }
      if (parts.length) element.style.transform = parts.join(' ');
    } else if (object.rotateX || object.rotateY) {
      const parts: string[] = [];
      if (object.rotateX) parts.push(`rotateX(${object.rotateX / 10}deg)`);
      if (object.rotateY) parts.push(`rotateY(${object.rotateY / 10}deg)`);
      element.style.transform = parts.join(' ');
    }
    const toneFilter =
      object.tonecurveNo !== undefined ? this.toneCurveFilterUrl(object.tonecurveNo) : undefined;
    const staticColorFilter = (cp: DrawObject['colorProps']): string => {
      if (!cp) return '';
      const needsMatrix =
        Boolean(cp.colorRate && cp.colorRate > 0) ||
        Boolean(cp.bright && cp.bright > 0) ||
        Boolean(cp.addR || cp.addG || cp.addB);
      if (needsMatrix) {
        const matrix = computeColorMatrix(cp);
        return matrix
          ? this.colorFilterUrl(matrix, (filter) => this.appendColorMatrix(filter, matrix))
          : '';
      }
      const filters: string[] = [];
      if (cp.mono && cp.mono > 0)
        filters.push(`grayscale(${Math.min(1, cp.mono / 255).toFixed(3)})`);
      if (cp.reverse && cp.reverse > 0)
        filters.push(`invert(${Math.min(1, cp.reverse / 255).toFixed(3)})`);
      if (cp.dark && cp.dark > 0)
        filters.push(`brightness(${Math.max(0, 1 - cp.dark / 255).toFixed(3)})`);
      return filters.join(' ');
    };
    const colorChannelMap: ReadonlyArray<[string, keyof NonNullable<DrawObject['colorProps']>]> = [
      ['ch:73', 'mono'],
      ['ch:74', 'reverse'],
      ['ch:75', 'bright'],
      ['ch:76', 'dark'],
      ['ch:83', 'colorRate'],
      ['ch:84', 'addR'],
      ['ch:85', 'addG'],
      ['ch:86', 'addB'],
      ['ch:87', 'colorR'],
      ['ch:88', 'colorG'],
      ['ch:89', 'colorB'],
    ];
    const activeColorEvents = colorChannelMap.flatMap(([ch, prop]) => {
      const ev = activeEvent(ch);
      return ev ? [[prop, ev] as const] : [];
    });
    if (activeColorEvents.length) {
      const baseCp = {...(object.colorProps ?? {})};
      const needsAnimatedMatrix =
        Boolean(baseCp.colorRate && baseCp.colorRate > 0) ||
        Boolean(baseCp.bright && baseCp.bright > 0) ||
        Boolean(baseCp.addR || baseCp.addG || baseCp.addB) ||
        activeColorEvents.some(
          ([prop]) =>
            prop === 'bright' ||
            prop === 'colorRate' ||
            prop === 'addR' ||
            prop === 'addG' ||
            prop === 'addB' ||
            prop === 'colorR' ||
            prop === 'colorG' ||
            prop === 'colorB',
        );
      if (needsAnimatedMatrix) {
        if (!this.colorFilterSvg) {
          const svg = document.createElementNS(svgNamespace, 'svg');
          svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
          svg.append(document.createElementNS(svgNamespace, 'defs'));
          this.stage.append(svg);
          this.colorFilterSvg = svg;
        }
        const filterId = `siglus-cm-dyn-${++this.dynamicColorFilterId}`;
        const filterEl = document.createElementNS(svgNamespace, 'filter');
        filterEl.id = filterId;
        filterEl.setAttribute('color-interpolation-filters', 'sRGB');
        const matrixEl = document.createElementNS(svgNamespace, 'feColorMatrix');
        matrixEl.setAttribute('type', 'matrix');
        filterEl.append(matrixEl);
        this.colorFilterSvg.firstElementChild!.append(filterEl);
        const dynUrl = `url(#${filterId})`;
        element.style.filter = [dynUrl, toneFilter].filter(Boolean).join(' ');
        const identityMatrix = '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0';
        const sample = (t: number): boolean => {
          let running = false;
          const cur = {...baseCp};
          for (const [prop, ev] of activeColorEvents) {
            const v = evalObjectIntEvent(ev, t);
            if (v !== undefined) {
              cur[prop] = v;
              running = true;
            }
          }
          matrixEl.setAttribute('values', computeColorMatrix(cur) ?? identityMatrix);
          return running;
        };
        const stillRunning = sample(now);
        if (!stillRunning) {
          filterEl.remove();
          element.style.filter = [staticColorFilter(object.colorProps), toneFilter].filter(Boolean).join(' ');
        } else {
          let mounted = false;
          const cleanup = () => filterEl.remove();
          const tick = () => {
            if (this.signal.aborted) {
              cleanup();
              return;
            }
            if (element.isConnected) mounted = true;
            else if (mounted) {
              cleanup();
              return;
            }
            if (!sample(performance.now())) {
              cleanup();
              element.style.filter = [staticColorFilter(object.colorProps), toneFilter]
                .filter(Boolean)
                .join(' ');
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      } else {
        // Pure CSS-filter-only color animation (dark / mono / reverse) via GPU-composited WAAPI.
        const [prop, ev] = activeColorEvents[0]!;
        const buildFilter = (val: number) => {
          const cur = {...baseCp, [prop]: val};
          return [staticColorFilter(cur), toneFilter].filter(Boolean).join(' ') || 'none';
        };
        const endFilter = buildFilter(ev.target);
        element.style.filter = endFilter === 'none' ? '' : endFilter;
        const anim = element.animate(
          {filter: [buildFilter(ev.from), endFilter]},
          {
            duration: ev.duration,
            delay: ev.delay,
            easing: eventEasing(ev.easing),
            fill: 'both',
            iterations: ev.mode === 0 ? 1 : Infinity,
            direction: ev.mode === 2 ? 'alternate' : 'normal',
          },
        );
        anim.currentTime = Math.max(0, now - ev.started);
      }
    } else {
      const staticFilter = [staticColorFilter(object.colorProps), toneFilter].filter(Boolean).join(' ');
      if (staticFilter) element.style.filter = staticFilter;
    }
    const hasLoopScale = Boolean(
      (scaleXLoop && scaleXLoop.mode !== 0) || (scaleYLoop && scaleYLoop.mode !== 0),
    );
    if (!object.scale && !hasLoopScale) return;
    if (!object.scaleEvents && !hasLoopScale) {
      element.style.scale = object.scale!.map((value) => value / 1000).join(' ');
      return;
    }
    const scaleBase = object.scale ?? ([1000, 1000] as const);
    const properties = ['--siglus-scale-x', '--siglus-scale-y'] as const;
    element.style.scale = properties.map((property) => `var(${property})`).join(' ');
    for (const [index, axis] of (['x', 'y'] as const).entries()) {
      const property = properties[index]!;
      registerAnimatedNumber(property);
      const to = String(scaleBase[index]! / 1000);
      element.style.setProperty(property, to);
      const loopEv = axis === 'x' ? scaleXLoop : scaleYLoop;
      if (loopEv && loopEv.mode !== 0) {
        const anim = element.animate(
          {[property]: [String(loopEv.from / 1000), String(loopEv.target / 1000)]},
          {
            duration: loopEv.duration,
            delay: loopEv.delay,
            easing: eventEasing(loopEv.easing),
            fill: 'both',
            iterations: Infinity,
            direction: loopEv.mode === 2 ? 'alternate' : 'normal',
          },
        );
        anim.currentTime = Math.max(0, now - loopEv.started);
        continue;
      }
      const event = object.scaleEvents?.[axis];
      if (event) {
        const elapsed = Math.max(0, now - event.started);
        const total = Number(event.time.duration ?? 0) + Number(event.time.delay ?? 0);
        if (elapsed < total) {
          const animation = element.animate(
            {[property]: [String(event.from / 1000), to]},
            event.time,
          );
          animation.currentTime = elapsed;
        }
      }
    }
  }

  finishWipe(): boolean {
    if (this.wipe?.playState !== 'running') return false;
    this.wipe.finish();
    return true;
  }

  private async replaceLayer(
    next: HTMLElement,
    duration: number,
    fan?: WipeSpec,
    speedMode = 0,
  ): Promise<void> {
    this.signal.throwIfAborted();
    this.finishWipe();
    const previous = [...this.layers.children];
    this.preserveStageFocus(() => {
      for (const child of previous) (child as HTMLElement).inert = true;
      this.layers.append(next);
    });
    this.background = next;
    if (duration > 0) {
      this.activeWipeLayer = next;
      try {
        if (fan) await this.animateFanWipe(next, duration, fan, speedMode);
        else {
          // Composite an opaque backdrop behind the incoming stage during crossfade so
          // fading to black or removing sprites smoothly blends instead of popping at t=duration.
          const hadBg = next.style.backgroundColor;
          next.style.backgroundColor = hadBg || 'black';
          next.style.isolation = 'isolate';
          const animation = next.animate(
            {opacity: [0, 1]},
            {duration, easing: eventEasing(speedMode)},
          );
          this.wipe = animation;
          try {
            await animation.finished;
          } finally {
            if (this.wipe === animation) this.wipe = undefined;
            if (!hadBg) next.style.removeProperty('background-color');
          }
        }
      } finally {
        if (this.activeWipeLayer === next) this.activeWipeLayer = undefined;
      }
    }
    this.preserveStageFocus(() => {
      for (const child of previous) child.remove();
    });
    this.syncHoverAfterDomUpdate();
  }

  private async animateFanWipe(
    layer: HTMLElement,
    duration: number,
    fan: WipeSpec,
    speedMode = 0,
  ): Promise<void> {
    const {width, height} = this;
    let maskHref = this.wipeMaskUrlCache.get(fan);
    if (!maskHref) {
      const maskWidth = 'values' in fan ? fan.width : width;
      const maskHeight = 'values' in fan ? fan.height : height;
      const values = 'values' in fan ? fan.values : fanWipeMask(width, height, fan);
      const canvas = document.createElement('canvas');
      canvas.width = maskWidth;
      canvas.height = maskHeight;
      const context = canvas.getContext('2d')!;
      const pixels = context.createImageData(maskWidth, maskHeight);
      for (let index = 0; index < values.length; index++) {
        pixels.data[index * 4 + 3] = values[index]!;
      }
      context.putImageData(pixels, 0, 0);
      maskHref = canvas.toDataURL();
      this.wipeMaskUrlCache.set(fan, maskHref);
    }
    const svg = document.createElementNS(svgNamespace, 'svg');
    svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none';
    const mask = document.createElementNS(svgNamespace, 'mask');
    const filter = document.createElementNS(svgNamespace, 'filter');
    const image = document.createElementNS(svgNamespace, 'image');
    const transfer = document.createElementNS(svgNamespace, 'feComponentTransfer');
    const alpha = document.createElementNS(svgNamespace, 'feFuncA');
    mask.id = 'siglus-wipe-mask-' + nextWipeMaskId++;
    filter.id = mask.id + '-filter';
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('mask-type', 'alpha');
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    for (const node of [mask, filter, image]) {
      node.setAttribute('x', '0');
      node.setAttribute('y', '0');
      node.setAttribute('width', String(width));
      node.setAttribute('height', String(height));
    }
    alpha.setAttribute('type', 'linear');
    // The embedded tex2_mask preshader derives the coefficient and offset
    // from the softness and 16.16 time progress.
    const slope = 255 - 254 * fan.softness;
    alpha.setAttribute('slope', String(slope));
    image.setAttribute('href', maskHref);
    image.setAttribute('filter', `url(#${filter.id})`);
    transfer.append(alpha);
    filter.append(transfer);
    mask.append(image);
    svg.append(filter, mask);
    this.stage.append(svg);
    const hadBg = layer.style.backgroundColor;
    layer.style.backgroundColor = hadBg || 'black';
    layer.style.maskImage = `url(#${mask.id})`;
    const animation = layer.animate([], {duration, fill: 'both'});
    this.wipe = animation;
    const stop = () => animation.cancel();
    this.signal.addEventListener('abort', stop, {once: true});
    let frame = 0;
    const render = () => {
      const time = Number(animation.currentTime ?? 0);
      const raw = Math.max(0, Math.min(1, Math.min(65536, Math.floor((time * 65536) / duration)) / 65536));
      const progress =
        speedMode === 1 ? raw * raw : speedMode === 2 ? 1 - (1 - raw) * (1 - raw) : raw;
      alpha.setAttribute('intercept', String((slope + 1) * progress - slope));
      frame = requestAnimationFrame(render);
    };
    render();
    try {
      await animation.finished;
    } finally {
      cancelAnimationFrame(frame);
      this.signal.removeEventListener('abort', stop);
      layer.style.removeProperty('mask-image');
      if (!hadBg) layer.style.removeProperty('background-color');
      svg.remove();
      if (this.wipe === animation) this.wipe = undefined;
    }
  }

  async setBackground(
    name: string,
    duration: number,
    pan?: BackgroundPan,
    clearCast = false,
    coversScene = false,
  ): Promise<void> {
    const generation = ++this.stageGeneration;
    await this.finishCastTransition();
    if (generation !== this.stageGeneration) return;
    const next = await this.backgroundLayer({name, pan}, duration);
    if (generation !== this.stageGeneration) return;
    if (coversScene) next.dataset.siglusSceneCover = '';
    if (this.pendingEffects.size) {
      const cast = clearCast ? [] : [...this.copyStageLayer(this.cast).children];
      await this.presentStage(next, cast, duration);
    } else {
      this.placeStageRectangles(next);
      await this.replaceLayer(next, duration);
    }
    if (generation !== this.stageGeneration) return;
    this.root.dataset.background = name;
    this.root.dataset.phase = 'scene';
  }

  private async backgroundLayer(
    {name, pan}: SiglusBackground,
    duration: number,
  ): Promise<HTMLElement> {
    const graphic = await this.graphic(name);
    const next = document.createElement('div');
    next.style.cssText = 'position:absolute;inset:0';
    const layer = this.node(graphic);
    layer.style.width = `${this.width}px`;
    layer.style.height = `${this.height}px`;
    layer.style.left = '0';
    layer.style.top = '0';
    next.append(layer);
    if (pan)
      layer.animate(
        {
          transform: [pan.from, pan.to].map(
            ([x, y], i) => `translate(${x}px,${y}px) scale(${(pan.scale?.[i] ?? 150) / 100})`,
          ),
        },
        {duration: pan.time, fill: 'both', delay: duration},
      );
    return next;
  }

  async showCast(
    sprites: readonly ({name: string; costume: string} & Partial<SiglusCastPlacement>)[],
    duration: number,
    publish = false,
    backdrop?: SiglusBackground,
  ): Promise<void> {
    await this.finishCastTransition();
    const characters = await Promise.all(
      sprites.map(async ({name, costume, position, drawOrder}, index) => {
        const match = /^(bs\d_)?([a-z][a-z0-9])(\d\d)(\d\d)/i.exec(name);
        if (!match) throw new Error(`Invalid Siglus sprite ${name}`);
        const [, prefix = 'bs2_', actor, pose, expression] = match;
        const [x, y] = position ?? [
          (this.width * (index + 1)) / (sprites.length + 1),
          Math.round(this.height * 0.32),
        ];
        const bodyCode = `${actor}${costume}${pose}01`;
        const requested = prefix + bodyCode;
        const medium = 'bs2_' + bodyCode;
        const useMedium =
          !this.files.has(`g00/${requested.toLowerCase()}.g00`) &&
          this.files.has(`g00/${medium.toLowerCase()}.g00`);
        const bodyName = useMedium ? medium : requested;
        const body = await this.graphic(bodyName);
        const face = await this.spriteFace(useMedium ? 'bs2_' : prefix, actor!, pose!, expression!);
        const layer = document.createElement('div');
        layer.dataset.siglusCastBody = bodyName;
        if (drawOrder) layer.dataset.siglusCastLayer = String(drawOrder[0]);
        layer.style.cssText = `position:absolute;left:${x}px;top:${y}px`;
        for (const graphic of [body, face])
          layer.append(this.node({...graphic, x: -graphic.centerX, y: -graphic.centerY}));
        return {layer, drawOrder: drawOrder ?? [0, index]};
      }),
    ).then((layers) =>
      layers
        .sort((a, b) => a.drawOrder[0]! - b.drawOrder[0]! || a.drawOrder[1]! - b.drawOrder[1]!)
        .map(({layer}) => layer),
    );
    this.signal.throwIfAborted();
    if (publish && this.pendingEffects.size) {
      const next = backdrop
        ? await this.backgroundLayer(backdrop, duration)
        : this.background
          ? this.copyStageLayer(this.background)
          : document.createElement('div');
      const transition = this.presentStage(next, characters, duration);
      this.castTransition = transition;
      void transition
        .catch((error) => {
          if (!this.signal.aborted) console.error(error);
        })
        .finally(() => {
          if (this.castTransition === transition) this.castTransition = undefined;
        });
      if (backdrop) this.root.dataset.background = backdrop.name;
    } else if (duration > 0 && this.cast.childElementCount > 0) {
      const outgoing = document.createElement('div');
      outgoing.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      outgoing.append(...this.cast.children);
      const incoming = document.createElement('div');
      incoming.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      incoming.append(...characters);
      this.cast.replaceChildren(outgoing, incoming);
      const outAnim = outgoing.animate({opacity: [1, 0]}, {duration, fill: 'forwards'});
      const inAnim = characters.length
        ? incoming.animate({opacity: [0, 1]}, {duration})
        : undefined;
      void Promise.all([outAnim.finished, inAnim?.finished].filter(Boolean))
        .then(
          () => {
            if (outgoing.parentElement === this.cast) outgoing.remove();
            if (incoming.parentElement === this.cast) {
              this.cast.replaceChildren(...incoming.children);
            }
          },
          () => {
            if (outgoing.parentElement === this.cast) outgoing.remove();
          },
        );
    } else {
      this.cast.replaceChildren(...characters);
      if (duration > 0 && characters.length) this.cast.animate({opacity: [0, 1]}, {duration});
    }
    this.root.dataset.cast = sprites.map(({name}) => name).join(',');
  }

  setTextSize(size?: number): void {
    this.messageTextSize = size ?? this.defaultTextSize;
    this.styleMessageText();
  }

  centerText(center: boolean): void {
    this.text.style.textAlign = center ? 'center' : '';
    this.paintMessageText();
  }

  setMessageSlide(time?: number): void {
    this.slideTime = time;
    if (time === undefined) this.resetSlide();
    this.text.toggleAttribute('data-siglus-slide', time !== undefined);
    this.styleMessageText();
  }

  finishMessageSlide(): void {
    if (this.slideTime === undefined || this.slideOffset === this.slideTarget) return;
    this.slideStarted = -Infinity;
    this.paintMessageText();
  }

  private updateSlide(overflow: number): number {
    if (this.slideTime === undefined) return 0;
    const now = performance.now();
    const target = Math.max(0, overflow);
    if (target !== this.slideTarget) {
      this.slideOrigin = this.slideOffset;
      this.slideTarget = target;
      this.slideStarted = now;
    }
    const progress =
      this.slideTime > 0 ? Math.min(1, (now - this.slideStarted) / this.slideTime) : 1;
    this.slideOffset = this.slideOrigin + (target - this.slideOrigin) * progress;
    if (progress < 1 && this.slideOffset !== target && !this.slideFrame)
      this.slideFrame = requestAnimationFrame(() => {
        this.slideFrame = 0;
        this.paintMessageText();
      });
    return this.slideOffset;
  }

  private resetSlide(): void {
    cancelAnimationFrame(this.slideFrame);
    this.slideFrame = this.slideOffset = this.slideTarget = this.slideOrigin = 0;
    this.text.style.translate = '';
    this.text.style.clipPath = '';
  }

  async autosaveNotice(): Promise<void> {
    const graphic = await this.graphic('__sys_mw_info00', 1);
    const node = this.node(graphic);
    node.style.left = `${1678 + graphic.x}px`;
    node.style.top = `${783 + graphic.y}px`;
    this.stage.append(node);
    node.animate(
      [
        {opacity: 0, offset: 0, easing: eventEasing(2)},
        {opacity: 1, offset: 0.12},
        {opacity: 1, offset: 0.32, easing: eventEasing(2)},
        {opacity: 0, offset: 0.44},
        {opacity: 0, offset: 1},
      ],
      {duration: 2500, fill: 'both'},
    );
    const animation = node.animate(
      [
        {translate: '0px', offset: 0, easing: eventEasing(2)},
        {translate: '-50px', offset: 0.2},
        {translate: '-50px', offset: 0.8, easing: eventEasing(2)},
        {translate: '0px', offset: 1},
      ],
      {duration: 2500},
    );
    void animation.finished.then(
      () => node.remove(),
      () => node.remove(),
    );
  }

  private async weatherLayer(object: DrawObject): Promise<HTMLElement | undefined> {
    const weather = object.weather;
    if (!weather || weather.mode === 0) return undefined;
    const graphic = object.name ? await this.objectGraphic(object.name, 0) : undefined;
    if (!graphic) return undefined;
    const params = weather.params;
    const count = Math.max(1, Math.min(48, params[0] ?? 16));
    const layer = document.createElement('div');
    layer.dataset.siglusWeather = object.name;
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    const elapsed = Math.max(0, performance.now() - weather.started);
    const speedX = weather.mode === 1 ? (params[1] ?? 0) : (params[5] ?? 0);
    const speedY = weather.mode === 1 ? (params[2] ?? 120) : (params[7] ?? 60);
    const baseDuration = Math.max(1200, Math.min(18000, Math.round(1200000 / Math.max(40, Math.hypot(speedX, speedY)))));
    for (let i = 0; i < count; i++) {
      // Deterministic pseudo-random spread per particle index (no layout thrash on re-render)
      const h1 = ((i * 2654435761) >>> 0) / 4294967296;
      const h2 = (((i + 17) * 2246822519) >>> 0) / 4294967296;
      const startX = Math.round(h1 * this.width);
      const startY = weather.mode === 1 ? -graphic.height : Math.round(h2 * this.height);
      const dx = weather.mode === 1 ? Math.round((speedX / Math.max(1, Math.abs(speedY) || 100)) * this.height) : Math.round((h2 - 0.5) * 240);
      const dy = weather.mode === 1 ? this.height + graphic.height * 2 : Math.round((h1 - 0.5) * 180);
      const dur = Math.round(baseDuration * (0.7 + h2 * 0.6));
      const node = this.node({...graphic, x: startX, y: startY});
      node.style.pointerEvents = 'none';
      const anim = node.animate(
        [
          {transform: 'translate(0px, 0px)', opacity: 0},
          {transform: `translate(${Math.round(dx * 0.15)}px, ${Math.round(dy * 0.15)}px)`, opacity: 1, offset: 0.15},
          {transform: `translate(${Math.round(dx * 0.85)}px, ${Math.round(dy * 0.85)}px)`, opacity: 1, offset: 0.85},
          {transform: `translate(${dx}px, ${dy}px)`, opacity: 0},
        ],
        {duration: dur, iterations: Infinity},
      );
      anim.currentTime = (elapsed + Math.round(h1 * dur)) % dur;
      layer.append(node);
    }
    return layer;
  }

  private async objectGanLayer(object: DrawObject): Promise<HTMLElement | undefined> {
    const gan = object.gan;
    if (!gan || gan.sequence === undefined) return undefined;
    const ganKey = `gan/${gan.file.toLowerCase()}.gan`;
    const source = this.files.get(ganKey);
    if (!source) return undefined;
    const sequences = readGan(await source.read(0, source.size, this.signal));
    const frames = sequences[gan.sequence];
    const duration = frames?.reduce((sum, f) => sum + f.duration, 0) ?? 0;
    if (!frames?.length || duration <= 0) return undefined;
    const graphicName = object.name || gan.file;
    const loop = Boolean(gan.loop);
    const layer = document.createElement('div');
    layer.dataset.siglusGan = gan.file;
    layer.style.cssText = `position:absolute;left:${object.x}px;top:${object.y}px;pointer-events:none`;
    const patterns = new Map<number, Graphic | undefined>();
    const animations: Animation[] = [];
    let elapsed = 0;
    for (const [index, frame] of frames.entries()) {
      const start = elapsed === 0 && index === 0 ? 0 : Math.min(duration, elapsed + 1);
      elapsed += frame.duration;
      const end = Math.min(duration, elapsed + 1);
      if (frame.pattern < 0 || (end <= start && (loop || index + 1 < frames.length))) continue;
      if (!patterns.has(frame.pattern))
        patterns.set(frame.pattern, await this.objectGraphic(graphicName, frame.pattern));
      const graphic = patterns.get(frame.pattern);
      if (!graphic) continue;
      const objCenterX = object.center?.[0] ?? 0;
      const objCenterY = object.center?.[1] ?? 0;
      const node = this.node({
        ...graphic,
        x: frame.x + graphic.x - graphic.centerX - objCenterX,
        y: frame.y + graphic.y - graphic.centerY - objCenterY,
      });
      node.style.opacity = '0';
      const keyframes: Keyframe[] = [{opacity: start ? 0 : frame.alpha / 255, offset: 0}];
      const offset = (time: number) => (time < duration ? (time - 0.001) / duration : 1);
      if (start > 0 && start < duration)
        keyframes.push({opacity: frame.alpha / 255, offset: offset(start)});
      keyframes.push({
        opacity: !loop && index + 1 === frames.length ? frame.alpha / 255 : 0,
        offset: !loop && index + 1 === frames.length ? 1 : offset(end),
      });
      animations.push(
        node.animate(keyframes.map((k) => ({...k, easing: 'steps(1, end)'})), {
          duration,
          iterations: loop ? Infinity : 1,
          fill: 'both',
        }),
      );
      layer.append(node);
    }
    const now = performance.now();
    gan.started ??= now;
    const position = objectGanElapsed(gan, now);
    const phase = loop ? position % duration : Math.min(duration, position);
    for (const animation of animations) animation.currentTime = phase;
    return layer;
  }

  private async ganAnimation(checkpoint: SiglusGanCheckpoint): Promise<GanLayer> {
    const {name, sequence, loop, x, y} = checkpoint;
    const source = this.files.get(`gan/${name.toLowerCase()}.gan`);
    if (!source) throw new Error(`Missing Siglus GAN ${name}`);
    const frames = readGan(await source.read(0, source.size, this.signal))[sequence];
    const duration = frames?.reduce((time, frame) => time + frame.duration, 0) ?? 0;
    if (!frames?.length || duration <= 0)
      throw new Error(`Invalid Siglus GAN sequence ${sequence}`);
    const layer = document.createElement('div');
    layer.dataset.siglusGan = name;
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    const patterns = new Map<number, Graphic | undefined>();
    const animations: Animation[] = [];
    let elapsed = 0;
    for (const [index, frame] of frames.entries()) {
      // The native lookup selects the first cumulative end >= its integer clock.
      // Looping reduces that clock modulo the total before looking up the frame.
      const start = elapsed === 0 && index === 0 ? 0 : Math.min(duration, elapsed + 1);
      elapsed += frame.duration;
      const end = Math.min(duration, elapsed + 1);
      if (frame.pattern < 0 || (end <= start && (loop || index + 1 < frames.length))) continue;
      if (!patterns.has(frame.pattern))
        patterns.set(frame.pattern, await this.objectGraphic(name, frame.pattern));
      const graphic = patterns.get(frame.pattern);
      if (!graphic) continue;
      const node = this.node({
        ...graphic,
        x: x + frame.x + graphic.x - graphic.centerX,
        y: y + frame.y + graphic.y - graphic.centerY,
      });
      node.dataset.siglusGanPattern = String(frame.pattern);
      node.style.opacity = '0';
      const keyframes: Keyframe[] = [{opacity: start ? 0 : frame.alpha / 255, offset: 0}];
      // Keep an exact integer sample on the new side of a boundary even
      // when the browser computes iteration progress just below the keyframe.
      const offset = (time: number) => (time < duration ? (time - 0.001) / duration : 1);
      if (start > 0 && start < duration)
        keyframes.push({opacity: frame.alpha / 255, offset: offset(start)});
      keyframes.push({
        opacity: !loop && index + 1 === frames.length ? frame.alpha / 255 : 0,
        offset: !loop && index + 1 === frames.length ? 1 : offset(end),
      });
      animations.push(
        node.animate(
          keyframes.map((keyframe) => ({...keyframe, easing: 'steps(1, end)'})),
          {duration, iterations: loop ? Infinity : 1, fill: 'both'},
        ),
      );
      layer.append(node);
    }
    return {checkpoint, layer, animations};
  }

  get hasStageEffectChanges(): boolean {
    return this.pendingEffects.size > 0;
  }

  async stageGan(checkpoint: SiglusGanCheckpoint): Promise<void> {
    const slot = checkpoint.slot ?? 200;
    const gan = await this.ganAnimation(checkpoint);
    this.signal.throwIfAborted();
    const previous = this.pendingEffects.get(slot);
    if (previous) this.removeStageEffect(previous);
    this.pendingEffects.set(slot, gan);
    const now = document.timeline.currentTime as number;
    for (const animation of gan.animations) {
      animation.startTime = now;
      animation.currentTime = checkpoint.elapsed;
    }
  }

  async stageMovieEffect(checkpoint: SiglusMovieEffectCheckpoint): Promise<void> {
    const basename = 'mov/' + checkpoint.name.toLowerCase();
    const source = this.files.get(basename + '.omv') ?? this.files.get(basename);
    if (!source) throw new Error('Missing Siglus OMV ' + checkpoint.name);
    const movie = await SiglusOmvPlayback.open(source, this.signal, checkpoint.loop);
    const layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    // All stage effects are above the cast, and offset layer numbers preserve their order.
    layer.style.zIndex = String(Math.max(0, checkpoint.layer));
    const canvas = document.createElement('canvas');
    canvas.dataset.siglusMovieEffect = checkpoint.name;
    canvas.dataset.siglusMovieEffectSlot = String(checkpoint.slot);
    canvas.width = movie.width;
    canvas.height = movie.height;
    canvas.style.cssText =
      `width:${(movie.width * checkpoint.scale[0]) / 1000}px;` +
      `height:${(movie.height * checkpoint.scale[1]) / 1000}px;display:block`;
    layer.append(canvas);
    try {
      await movie.restoreFrame(checkpoint.elapsed);
      this.signal.throwIfAborted();
      movie.connect(canvas);
      movie.play();
    } catch (error) {
      movie.close();
      throw error;
    }
    const previous = this.pendingEffects.get(checkpoint.slot);
    if (previous) this.removeStageEffect(previous);
    this.pendingEffects.set(checkpoint.slot, {checkpoint, layer, movie});
  }

  stageRectangleEffect(checkpoint: SiglusRectangleEffectCheckpoint): void {
    const previous = this.pendingEffects.get(checkpoint.slot);
    if (previous) this.removeStageEffect(previous);
    this.pendingEffects.set(checkpoint.slot, {geometry: checkpoint});
  }

  fadeStageEffects(): void {
    this.endLayerEffects();
    for (const [slot, effect] of this.activeEffects) {
      if (!('geometry' in effect) && !this.pendingEffects.has(slot))
        this.pendingEffects.set(slot, null);
    }
  }

  retireStageEffects(first: number, count: number): void {
    for (const slot of this.activeEffects.keys())
      if (slot >= first && slot < first + count && !this.pendingEffects.has(slot))
        this.pendingEffects.set(slot, null);
  }

  async loadStageEffects(
    gans: readonly SiglusGanCheckpoint[],
    movies: readonly SiglusMovieEffectCheckpoint[],
    rectangles: readonly SiglusRectangleEffectCheckpoint[],
  ): Promise<void> {
    for (const checkpoint of gans) await this.stageGan(checkpoint);
    for (const checkpoint of movies) await this.stageMovieEffect(checkpoint);
    for (const checkpoint of rectangles) this.stageRectangleEffect(checkpoint);
    this.applyStageEffectChanges(this.effect);
    if (this.background) this.placeStageRectangles(this.background);
    for (const {slot, retire} of rectangles) if (retire) this.retireStageEffects(slot, 1);
  }

  get sceneCovered(): boolean {
    return this.background?.hasAttribute('data-siglus-scene-cover') ?? false;
  }

  saveRectangleEffects(): SiglusRectangleEffectCheckpoint[] | undefined {
    const effects = [...this.activeEffects.values()].filter((effect) => 'geometry' in effect);
    if (!effects.length) return;
    return effects.map(({geometry}) => ({
      ...geometry,
      retire: this.pendingEffects.get(geometry.slot) === null || undefined,
    }));
  }

  saveMovieEffects(): SiglusMovieEffectCheckpoint[] | undefined {
    const movies = [...this.activeEffects.values()].flatMap((effect) =>
      'movie' in effect ? [{...effect.checkpoint, elapsed: effect.movie.elapsed}] : [],
    );
    return movies.length ? movies : undefined;
  }

  saveGans(): SiglusGanCheckpoint[] | undefined {
    if (!this.activeEffects.size) return;
    const gans = [...this.activeEffects.values()].filter((effect) => 'animations' in effect);
    if (!gans.length) return;
    return gans.map(({checkpoint, animations}) => {
      const animation = animations[0];
      const time = Math.max(0, Math.floor(Number(animation?.currentTime ?? 0)));
      const duration = Number(animation?.effect?.getTiming().duration ?? 0);
      const elapsed = duration && checkpoint.loop ? time % duration : time;
      return {...checkpoint, elapsed};
    });
  }

  private applyStageEffectChanges(incoming: HTMLElement, outgoing?: HTMLElement): void {
    for (const [slot, next] of this.pendingEffects) {
      const previous = this.activeEffects.get(slot);
      if (previous) {
        if (outgoing && 'layer' in previous) outgoing.append(previous.layer);
        else this.removeStageEffect(previous);
        this.activeEffects.delete(slot);
      }
      if (next) {
        if ('layer' in next) incoming.append(next.layer);
        this.activeEffects.set(slot, next);
      }
    }
    this.pendingEffects.clear();
  }

  private removeStageEffect(effect: StageEffect): void {
    if ('movie' in effect) effect.movie.close();
    else if ('animations' in effect)
      for (const animation of effect.animations) animation.cancel();
    if ('layer' in effect) effect.layer.remove();
  }

  private clearStageEffects(): void {
    for (const gan of this.activeEffects.values()) this.removeStageEffect(gan);
    for (const gan of this.pendingEffects.values()) if (gan) this.removeStageEffect(gan);
    this.activeEffects.clear();
    this.pendingEffects.clear();
    for (const group of this.layers.querySelectorAll('[data-siglus-stage-rects]')) group.remove();
  }

  private placeStageRectangles(page: HTMLElement, cast?: HTMLElement): void {
    for (const old of page.querySelectorAll(':scope > [data-siglus-stage-rects]')) old.remove();
    const effects = [...this.activeEffects.values()]
      .filter((effect) => 'geometry' in effect)
      .sort((a, b) => a.geometry.layer - b.geometry.layer || a.geometry.slot - b.geometry.slot);
    const groups = document.createDocumentFragment();
    for (const {geometry} of effects) {
      const group = document.createElement('div');
      group.dataset.siglusStageRects = String(geometry.slot);
      group.style.cssText = 'position:absolute;inset:0;pointer-events:none';
      const [r, g, b, a] = geometry.rgba;
      for (const [x, y, width, height] of geometry.rectangles) {
        const rect = document.createElement('div');
        rect.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px`;
        rect.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
        group.append(rect);
      }
      groups.append(group);
    }
    if (page.hasAttribute('data-siglus-scene-cover')) page.prepend(groups);
    else page.insertBefore(groups, cast ?? null);
  }

  private copyStageLayer(layer: HTMLElement): HTMLElement {
    const copy = layer.cloneNode(true) as HTMLElement;
    const originals = layer.querySelectorAll('canvas');
    for (const [index, canvas] of [...copy.querySelectorAll('canvas')].entries()) {
      const original = originals[index]!;
      canvas.getContext('2d')!.drawImage(original, 0, 0);
      canvas.style.transform = getComputedStyle(original).transform;
    }
    return copy;
  }

  private async finishCastTransition(): Promise<void> {
    if (!this.castTransition) return;
    this.finishWipe();
    await this.castTransition;
  }

  private async presentStage(
    next: HTMLElement,
    characters: readonly Element[],
    duration: number,
    fan?: WipeSpec,
    speedMode = 0,
  ): Promise<void> {
    const previous = this.background;
    const retired = [...this.pendingEffects.keys()].flatMap((slot) => this.activeEffects.get(slot) ?? []);
    next.style.position = 'absolute';
    next.style.inset = '0';
    next.style.backgroundColor = 'black';
    next.style.pointerEvents ||= 'none';
    if (previous && duration > 0) {
      previous.style.isolation = 'isolate';
      previous.append(this.cast);
    }
    // Keep the effect's internal layer order local to the scene page during the wipe.
    next.style.isolation = 'isolate';
    const cast = document.createElement('div');
    cast.style.cssText = this.cast.style.cssText;
    cast.append(...characters);
    next.append(cast);
    this.applyStageEffectChanges(next, duration > 0 ? previous : undefined);
    this.placeStageRectangles(next, cast);
    try {
      await this.replaceLayer(next, duration, fan, speedMode);
    } finally {
      for (const gan of retired) this.removeStageEffect(gan);
      this.cast.replaceChildren(...cast.children);
      if (this.cast.parentElement !== this.sceneLayers) this.layers.after(this.cast);
      this.cast.inert = false;
      cast.remove();
      for (const effect of this.activeEffects.values())
        if ('layer' in effect && effect.layer.parentElement === next) this.effect.append(effect.layer);
    }
  }

  private shakeAnimation?: Animation;

  private readonly quakes = new Map<
    number,
    {
      animation: Animation;
      duration: number;
      displacement: (elapsed: number) => readonly [number, number];
    }
  >();

  private animateQuake(
    slot: number,
    duration: number,
    displacement: (elapsed: number) => readonly [number, number],
  ): void {
    // Sample integer milliseconds for short effects without allocating
    // a frame per millisecond for an arbitrarily long script duration.
    const samples = Math.min(duration, 2000);
    const keyframes = Array.from({length: samples + 1}, (_, index) => {
      const offset = index / samples;
      const [x, y] = displacement(Math.round(duration * offset));
      return {offset, translate: `${x}px ${y}px`, easing: 'steps(1, end)'};
    });
    const animation = this.sceneLayers.animate(keyframes, {duration, composite: 'add'});
    this.quakes.set(slot, {animation, duration, displacement});
    animation.onfinish = () => {
      if (this.quakes.get(slot)?.animation === animation) this.quakes.delete(slot);
    };
  }

  startQuake(
    slot: number,
    period: number,
    cycles: number,
    decayCycles: number,
    power: number,
    direction: readonly [number, number],
  ): number {
    this.quakes.get(slot)?.animation.cancel();
    this.quakes.delete(slot);
    const infinite = cycles <= 0 && decayCycles <= 0;
    const effectiveCycles = infinite ? 1 : cycles;
    const duration = period * (effectiveCycles + decayCycles);
    if (period <= 0 || duration <= 0) return 0;
    // Four quadratic quarters. The last cycles decay linearly in amplitude.
    const quarter = Math.trunc(period / 4);
    const half = Math.trunc(period / 2);
    const lastQuarter = Math.trunc((period * 3) / 4);
    const halfPower = Math.trunc(power / 2);
    const easeIn = (from: number, to: number, time: number) => {
      const elapsed = Math.max(0, Math.min(quarter, time));
      return quarter ? Math.trunc(from + ((to - from) * elapsed ** 2) / quarter ** 2) : to;
    };
    const easeOut = (from: number, to: number, time: number) => easeIn(to, from, quarter - time);
    const displacement = (elapsed: number): readonly [number, number] => {
      const phase = elapsed % period;
      let amplitude = 0;
      if (phase < quarter) amplitude = easeIn(0, halfPower, phase);
      else if (phase < half) amplitude = easeOut(halfPower, power, phase - quarter);
      else if (phase < lastQuarter) amplitude = easeIn(power, halfPower, phase - half);
      else amplitude = easeOut(halfPower, 0, phase - lastQuarter);
      if (!infinite && decayCycles > 0 && elapsed >= period * effectiveCycles) {
        const remaining = 1 - (elapsed - period * effectiveCycles) / (period * decayCycles);
        amplitude = Math.trunc(amplitude * remaining);
      }
      return [Math.round(direction[0] * amplitude), Math.round(direction[1] * amplitude)];
    };
    const samples = Math.min(duration, 2000);
    const keyframes = Array.from({length: samples + 1}, (_, index) => {
      const offset = index / samples;
      const [x, y] = displacement(Math.round(duration * offset));
      return {offset, translate: `${x}px ${y}px`, easing: 'steps(1, end)'};
    });
    const animation = this.sceneLayers.animate(keyframes, {
      duration,
      iterations: infinite ? Infinity : 1,
      composite: 'add',
    });
    this.quakes.set(slot, {animation, duration, displacement});
    animation.onfinish = () => {
      if (this.quakes.get(slot)?.animation === animation) this.quakes.delete(slot);
    };
    return infinite ? 0 : duration;
  }

  startZoomQuake(
    slot: number,
    period: number,
    cycles: number,
    decayCycles: number,
    power: number,
    centerX: number,
    centerY: number,
  ): number {
    this.quakes.get(slot)?.animation.cancel();
    this.quakes.delete(slot);
    const infinite = cycles <= 0 && decayCycles <= 0;
    const effectiveCycles = infinite ? 1 : cycles;
    const duration = period * (effectiveCycles + decayCycles);
    if (period <= 0 || duration <= 0) return 0;
    const originX = this.width / 2 + centerX;
    const originY = this.height / 2 + centerY;
    this.sceneLayers.style.transformOrigin = `${originX}px ${originY}px`;
    const samples = Math.min(duration, 1000);
    const keyframes = Array.from({length: samples + 1}, (_, index) => {
      const offset = index / samples;
      const elapsed = Math.round(duration * offset);
      const phase = (elapsed % period) / period;
      let amp = Math.sin(phase * Math.PI * 2) * (power / 1000);
      if (!infinite && decayCycles > 0 && elapsed >= period * effectiveCycles) {
        amp *= 1 - (elapsed - period * effectiveCycles) / (period * decayCycles);
      }
      const scale = Math.max(0.1, 1 + amp);
      return {offset, transform: `scale(${scale.toFixed(4)})`};
    });
    const animation = this.sceneLayers.animate(keyframes, {
      duration,
      iterations: infinite ? Infinity : 1,
    });
    this.quakes.set(slot, {animation, duration, displacement: () => [0, 0]});
    animation.onfinish = () => {
      if (this.quakes.get(slot)?.animation === animation) this.quakes.delete(slot);
    };
    return infinite ? 0 : duration;
  }

  /** Plays a `SHAKE.NNN` step pattern `(dx, dy, ms)` via the stage quake channel. */
  startShakeSteps(slot: number, steps: readonly (readonly [number, number, number])[]): number {
    this.quakes.get(slot)?.animation.cancel();
    this.quakes.delete(slot);
    const duration = steps.reduce((sum, [, , ms]) => sum + Math.max(0, ms), 0);
    if (duration <= 0) return 0;
    const keyframes: Keyframe[] = [];
    let elapsed = 0;
    for (const [dx, dy, ms] of steps) {
      if (ms <= 0) continue;
      keyframes.push({offset: elapsed / duration, translate: `${dx}px ${dy}px`, easing: 'steps(1, end)'});
      elapsed += ms;
    }
    keyframes.push({offset: 1, translate: '0px 0px', easing: 'steps(1, end)'});
    const animation = this.sceneLayers.animate(keyframes, {duration, iterations: 1, composite: 'add'});
    this.quakes.set(slot, {animation, duration, displacement: () => [0, 0]});
    animation.onfinish = () => {
      if (this.quakes.get(slot)?.animation === animation) this.quakes.delete(slot);
    };
    return duration;
  }

  isQuakeActive(slot: number): boolean {
    const q = this.quakes.get(slot);
    return Boolean(q && q.animation.playState === 'running');
  }

  quakeRemainingMs(slot: number): number {
    const q = this.quakes.get(slot);
    if (!q || q.animation.playState !== 'running') return 0;
    const elapsed = Number(q.animation.currentTime ?? 0);
    return Math.max(0, Math.ceil(q.duration - elapsed));
  }

  endShake(slot: number, duration: number): void {
    const quake = this.quakes.get(slot);
    if (quake) {
      const {animation, displacement} = quake;
      const elapsed = Math.floor(Number(animation.currentTime ?? 0));
      const remaining = Math.min(quake.duration - elapsed, duration);
      const paused = animation.playState === 'paused';
      animation.cancel();
      this.quakes.delete(slot);
      if (remaining > 0) {
        this.animateQuake(slot, remaining, (time) => {
          const [x, y] = displacement(elapsed + time);
          const factor = 1 - time / duration;
          return [Math.trunc(x * factor), Math.trunc(y * factor)];
        });
        if (paused) this.quakes.get(slot)?.animation.pause();
      }
      return;
    }
    const animation = this.shakeAnimation;
    if (!animation || animation.playState !== 'running') return;
    if (duration <= 0) animation.cancel();
    else {
      const transform = getComputedStyle(this.layers).transform;
      animation.cancel();
      this.shakeAnimation = this.layers.animate({transform: [transform, 'none']}, {duration});
    }
  }

  shake(strength: number): void {
    const delta = 8 + Math.max(0, strength) * 2;
    this.shakeAnimation?.cancel();
    this.shakeAnimation = this.layers.animate(
      {transform: [0, -delta, delta, -delta / 2, 0].map((x) => `translateX(${x}px)`)},
      {duration: 350},
    );
  }

  dizzy(delay: number, strength: number): void {
    this.layers.animate(
      {filter: ['blur(0)', `blur(${Math.max(2, strength)}px)`, 'blur(0)']},
      {duration: 1800, delay, iterations: Infinity},
    );
  }

  endEffect(): void {
    this.clearStageEffects();
    this.endLayerEffects();
  }

  endLayerEffects(): void {
    for (const animation of this.layers.getAnimations()) animation.cancel();
    this.layers.style.filter = '';
  }

  repPosition(x: number, y: number): void {
    this.messagePosition = x || y ? [x, y] : undefined;
    this.message.style.translate = `${x}px ${y}px`;
  }

  async face(code: string, costume = '01'): Promise<void> {
    const [actor, pose, expression] = code.match(/../g) ?? [];
    const body = await this.graphic(`bs2_${actor}${costume}${pose}01`);
    const face = await this.spriteFace('bs2_', actor!, pose!, expression!);
    const composite = document.createElement('div');
    composite.style.cssText =
      'position:absolute;left:100px;top:100px;transform:scale(.7);transform-origin:0 0';
    for (const graphic of [body, face])
      composite.append(this.node({...graphic, x: -graphic.centerX, y: -graphic.centerY}));
    this.portrait.replaceChildren(composite);
    this.currentFace = code;
    this.currentFaceCostume = costume;
  }

  private spriteFace(prefix: string, actor: string, pose: string, expression: string) {
    const specific = `${prefix}${actor}_f${pose.charAt(0)}1_${expression}`;
    const generic = `${prefix}${actor}_f01_${expression}`;
    return this.graphic(this.files.has(`g00/${specific}.g00`) ? specific : generic);
  }

  name(value: string, emitInline = true): void {
    this.currentName = value;
    if (this.mwndLayout?.nameDispMode === 2) {
      this.speaker.textContent = '';
      if (emitInline && value) {
        const formatted = this.mwndLayout.nameBracket ? `【${value}】` : value;
        this.append(this.mwndLayout.nameNewline ? `${formatted}\n` : formatted);
      } else {
        this.paintMessageText();
      }
      return;
    }
    this.speaker.textContent = value;
    this.paintMessageText();
  }

  append(value: string): void {
    this.appendRun(value);
  }

  setMessageTextColor(color: number, windowIndex = this.windowIndex): void {
    if (color < 0) this.messageTextColors.delete(windowIndex);
    else this.messageTextColors.set(windowIndex, color);
  }

  restoreMessageTextColors(colors: SiglusMessageSnapshot['textColors']): void {
    this.messageTextColors = new Map(colors);
  }

  appendRun(value: string, color = this.messageTextColors.get(this.windowIndex) ?? -1) {
    const fragment: SiglusTextFragment = {text: value, ruby: this.ruby || undefined};
    if (color >= 0) fragment.color = color;
    const colorCss = color >= 0 ? this.tableColor(color) : undefined;
    const node = document.createTextNode(value);
    let annotation: HTMLElement | undefined;
    this.currentText.push(fragment);
    if (fragment.ruby) {
      const ruby = document.createElement('ruby');
      // Place the reading outside its base without increasing the line box.
      ruby.style.cssText = 'position:relative;display:inline-block;white-space:nowrap';
      if (colorCss) ruby.style.color = colorCss;
      annotation = document.createElement('rt');
      annotation.style.cssText = this.mwndLayout?.vertical
        ? 'position:absolute;top:50%;left:calc(50% + var(--siglus-ruby-offset));transform:translateY(-50%);line-height:1;user-select:none'
        : 'position:absolute;bottom:calc(50% + var(--siglus-ruby-offset));left:50%;transform:translateX(-50%);line-height:1;user-select:none';
      annotation.style.fontSize = 'var(--siglus-ruby-size)';
      annotation.textContent = value ? fragment.ruby : '';
      ruby.append(node, annotation);
      this.text.append(ruby);
      this.ruby = '';
    } else if (colorCss) {
      const span = document.createElement('span');
      span.style.color = colorCss;
      span.append(node);
      this.text.append(span);
    } else this.text.append(node);
    const wasHidden = this.message.hidden;
    this.message.hidden = false;
    if (wasHidden) {
      const openAnime = this.pendingOpenAnimation;
      this.pendingOpenAnimation = undefined;
      if (openAnime) this.playMessageOpenAnimation(openAnime);
    } else {
      this.pendingOpenAnimation = undefined;
    }
    if (this.currentFace) this.root.dataset.sprite = this.currentFace;
    this.paintMessageText();
    return {
      ruby: Boolean(fragment.ruby),
      reveal: (visible: string) => {
        fragment.text = node.data = visible;
        if (annotation) annotation.textContent = visible ? fragment.ruby! : '';
        this.paintMessageText();
      },
    };
  }

  get hasPendingRuby(): boolean {
    return Boolean(this.ruby);
  }

  annotate(value: string): void {
    this.ruby = value;
  }

  newline(): void {
    this.text.append('\n');
    this.currentText.push({text: '\n'});
    this.paintMessageText();
  }

  clearText(): void {
    this.currentName = '';
    this.currentText = [];
    this.ruby = '';
    this.speaker.textContent = '';
    this.text.textContent = '';
    this.resetSlide();
    this.paintMessageText();
    this.clearFace();
    delete this.root.dataset.sprite;
  }

  clearFace(): void {
    this.portrait.replaceChildren();
    this.currentFace = undefined;
    this.currentFaceCostume = undefined;
  }

  private cancelMessageVisibilityAnimation(): void {
    if (!this.messageVisibilityAnimation) return;
    this.messageVisibilityAnimation.cancel();
    this.messageVisibilityAnimation = undefined;
  }

  private messageAnimationKeyframes(type: number, closing: boolean): Keyframe[] {
    const start =
      type === 2
        ? {opacity: 0, transform: 'scale(0.94)'}
        : type === 3
          ? {opacity: 0, transform: 'translateY(14px)'}
          : {opacity: 0};
    const end =
      type === 2
        ? {opacity: 1, transform: 'scale(1)'}
        : type === 3
          ? {opacity: 1, transform: 'translateY(0px)'}
          : {opacity: 1};
    return closing ? [end, start] : [start, end];
  }

  private playMessageOpenAnimation(anime: MwndAnimation): void {
    this.cancelMessageVisibilityAnimation();
    if (
      anime.type <= 0 ||
      anime.time <= 0 ||
      typeof this.message.animate !== 'function'
    )
      return;
    const animation = this.message.animate(this.messageAnimationKeyframes(anime.type, false), {
      duration: anime.time,
      easing: 'ease-out',
    });
    this.messageVisibilityAnimation = animation;
    void animation.finished.then(
      () => {
        if (this.messageVisibilityAnimation === animation) {
          this.messageVisibilityAnimation = undefined;
        }
      },
      () => {},
    );
  }

  prepareOpenAnimation(anime?: MwndAnimation): void {
    this.pendingOpenAnimation = anime && anime.type > 0 && anime.time > 0 ? anime : undefined;
  }

  openMessage(anime?: MwndAnimation): void {
    const wasHidden = this.message.hidden || this.message.style.display === 'none';
    this.message.hidden = false;
    this.message.style.display = '';
    this.pendingOpenAnimation = undefined;
    if (wasHidden && anime && anime.type > 0 && anime.time > 0) {
      this.playMessageOpenAnimation(anime);
    } else {
      this.cancelMessageVisibilityAnimation();
    }
  }

  setScreenEffect(state: {
    mono: number;
    reverse: number;
    bright: number;
    dark: number;
    colorR: number;
    colorG: number;
    colorB: number;
    colorRate: number;
    addR: number;
    addG: number;
    addB: number;
  }): void {
    const filters: string[] = [];
    if (state.mono > 0) filters.push(`grayscale(${Math.min(1, state.mono / 255).toFixed(3)})`);
    if (state.reverse > 0) filters.push(`invert(${Math.min(1, state.reverse / 255).toFixed(3)})`);
    const brightness = Math.max(0, 1 + state.bright / 255 - state.dark / 255);
    if (Math.abs(brightness - 1) > 0.002) filters.push(`brightness(${brightness.toFixed(3)})`);
    this.sceneLayers.style.filter = filters.join(' ');
    if (state.colorRate > 0) {
      const alpha = Math.min(1, state.colorRate / 255);
      this.effectTint.style.display = '';
      this.effectTint.style.mixBlendMode = 'normal';
      this.effectTint.style.background = `rgba(${state.colorR & 255}, ${state.colorG & 255}, ${state.colorB & 255}, ${alpha.toFixed(3)})`;
    } else if (state.addR > 0 || state.addG > 0 || state.addB > 0) {
      this.effectTint.style.display = '';
      this.effectTint.style.mixBlendMode = 'screen';
      this.effectTint.style.background = `rgb(${Math.min(255, state.addR)}, ${Math.min(255, state.addG)}, ${Math.min(255, state.addB)})`;
    } else {
      this.effectTint.style.display = 'none';
    }
  }

  closeMessage(): void {
    this.cancelMessageVisibilityAnimation();
    this.pendingOpenAnimation = undefined;
    this.clearText();
    this.message.hidden = true;
    this.pageControls();
  }

  async closeMessageWithAnimation(anime: MwndAnimation): Promise<void> {
    this.pageControls();
    if (
      anime.type > 0 &&
      anime.time > 0 &&
      !this.message.hidden &&
      typeof this.message.animate === 'function'
    ) {
      this.cancelMessageVisibilityAnimation();
      const animation = this.message.animate(this.messageAnimationKeyframes(anime.type, true), {
        duration: anime.time,
        easing: 'ease-in',
        fill: 'forwards',
      });
      this.messageVisibilityAnimation = animation;
      const cancel = () => animation.cancel();
      this.signal.addEventListener('abort', cancel, {once: true});
      try {
        await animation.finished;
      } catch {
        // Cancelled by abort or a subsequent open/close call.
      } finally {
        this.signal.removeEventListener('abort', cancel);
        if (this.messageVisibilityAnimation === animation) {
          animation.cancel();
          this.messageVisibilityAnimation = undefined;
        }
      }
    }
    this.closeMessage();
  }

  async closeMessageWithFade(duration: number): Promise<void> {
    await this.closeMessageWithAnimation({type: duration > 0 ? 1 : 0, time: duration});
  }

  saveMessage(): SiglusMessageSnapshot {
    return {
      name: this.currentName,
      text: this.currentText.map((fragment) => ({...fragment})),
      face: this.currentFace,
      faceCostume: this.currentFaceCostume,
      index: this.windowIndex,
      size: this.messageTextSize,
      slideTime: this.slideTime,
      position: this.messagePosition,
      textColors: this.messageTextColors.size ? [...this.messageTextColors] : undefined,
    };
  }

  async loadMessage(message: SiglusMessageSnapshot): Promise<void> {
    this.clearText();
    this.restoreMessageTextColors(message.textColors);
    this.repPosition(...(message.position ?? [0, 0]));
    this.setMessageSlide(message.slideTime);
    this.selectMessageWindow(message.index);
    this.setTextSize(message.size);
    this.name(message.name, false);
    if (message.face) await this.face(message.face, message.faceCostume);
    for (const {text, ruby, color} of message.text) {
      if (ruby) this.annotate(ruby);
      this.appendRun(text, color ?? -1);
    }
    this.finishMessageSlide();
  }

  private async prepareFrameActions(wakuIndex = 0): Promise<void> {
    if (this.frameActionsByWaku.has(wakuIndex)) return;
    const labels: Readonly<Record<string, string>> = {
      save: 'Save',
      load: 'Load',
      qsave: 'Quick save',
      qload: 'Quick load',
      return_sel: 'Return to selection',
      global_switch: 'Message frame lock',
      auto_mode: 'Auto',
      read_skip: 'Read Skip',
      config: 'Configuration',
      none: 'Message frame action',
      msg_log: 'Message history',
      close_mwnd: 'Hide message',
      koe_play: 'Replay voice',
    };
    const wakuTag = String(wakuIndex).padStart(3, '0');
    const patternRe = new RegExp(`^WAKU\\.${wakuTag}\\.BTN\\.(\\d+)\\.TYPE$`);
    const buttonConfigs: {id: number; key: string; value: string}[] = [];
    for (const [key, value] of this.config) {
      const match = patternRe.exec(key);
      if (!match) continue;
      buttonConfigs.push({id: Number(match[1]), key, value});
    }
    // Ascending BTN id order keeps decorative BTN.000 (_mw00_frame) behind interactive BTN.001..018.
    buttonConfigs.sort((a, b) => a.id - b.id);
    const entries: NonNullable<ReturnType<SiglusDisplay['frameActionsByWaku']['get']>> = [];
    for (const {id, key, value} of buttonConfigs) {
      const [, type, parameters] = value.split('"');
      if (!type || !Object.hasOwn(labels, type)) continue;
      const prefix = key.slice(0, -4);
      const call = this.config.get(prefix + 'CALL');
      const decorative = type === 'none' && !call;
      const [, argument, expected] = parameters?.split(',') ?? [];
      const slot = type === 'global_switch' ? Number(argument) : undefined;
      const state = type === 'global_switch' ? expected : argument;
      const action: SiglusFrameAction = {
        id,
        type,
        slot,
        state: state === undefined ? undefined : Number(state),
        sound: Number(this.config.get(prefix + 'SE') ?? -1),
        call: call ? prefix + 'CALL' : undefined,
      };
      const file = this.config.get(prefix + 'FILE')?.split('"')[1];
      const [anchor, x, y] = (this.config.get(prefix + 'POS') ?? '').split(',').map(Number);
      if (
        !file ||
        anchor === undefined ||
        anchor < 0 ||
        anchor > 3 ||
        x === undefined ||
        y === undefined ||
        !this.files.has(`g00/${file.toLowerCase()}.g00`)
      )
        continue;
      const baseCut = Number(this.config.get(prefix + 'CUT_NO') ?? 0);
      const actionIdRaw = this.config.get(prefix + 'ACTION');
      const actionStates = parseButtonActionStates(
        this.config,
        actionIdRaw !== undefined ? Number(actionIdRaw) : undefined,
      );
      const resource = await this.resource(file);
      const cutCount = Math.max(1, Math.min(resource.count, 32));
      const frames: Graphic[] = [];
      for (let cut = 0; cut < cutCount; cut++) {
        frames.push(await this.graphic(file, cut));
      }
      const primaryFrame = frames[Math.min(Math.max(0, baseCut), frames.length - 1)]!;
      const canvas = this.node(primaryFrame);
      canvas.style.left = '0';
      canvas.style.top = '0';
      canvas.style.pointerEvents = 'none';
      const applyState = (spec: ButtonActionState, patno: number) => {
        const cutIndex = Math.max(
          0,
          Math.min(frames.length - 1, baseCut + patno + spec.cutOffset),
        );
        const graphic = frames[cutIndex] ?? primaryFrame;
        const context = canvas.getContext('2d')!;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(graphic.image, 0, 0);
        canvas.style.translate = spec.dx || spec.dy ? `${spec.dx}px ${spec.dy}px` : '';
        canvas.style.opacity = spec.alpha < 255 ? String(spec.alpha / 255) : '';
        const brightness = 1 + spec.bright / 255 - spec.dark / 255;
        canvas.style.filter =
          Math.abs(brightness - 1) > 0.005 ? `brightness(${Math.max(0, brightness).toFixed(3)})` : '';
      };

      let element: HTMLElement;
      let button: HTMLButtonElement | undefined;
      if (decorative) {
        const decor = document.createElement('div');
        decor.dataset.siglusFrameDecor = '';
        decor.dataset.siglusBtnId = String(id);
        decor.style.cssText = `position:absolute;width:${primaryFrame.width}px;height:${primaryFrame.height}px;pointer-events:none`;
        decor.append(canvas);
        element = decor;
      } else {
        button = document.createElement('button');
        button.type = 'button';
        button.dataset.siglusAction = type;
        button.dataset.siglusBtnId = String(id);
        const commandName = call?.split('"')[3];
        const label =
          commandName === '$sys_returnmenu_btn'
            ? 'Return to title'
            : commandName === '$sys_gameend_btn'
              ? 'Exit game'
              : type === 'global_switch'
                ? `${labels[type]} ${slot}`
                : labels[type]!;
        button.setAttribute('aria-label', label);
        if (slot !== undefined) button.dataset.siglusSwitch = String(slot);
        if (type === 'auto_mode' || type === 'read_skip' || type === 'global_switch')
          button.setAttribute('aria-pressed', String(action.state === 1));
        button.style.cssText = `position:absolute;width:${primaryFrame.width}px;height:${primaryFrame.height}px;border:0;padding:0;background:none;pointer-events:auto`;
        button.append(canvas);
        element = button;
      }

      const entry: NonNullable<ReturnType<SiglusDisplay['frameActionsByWaku']['get']>>[number] = {
        action,
        decorative,
        element,
        button,
        canvas,
        frames,
        baseCut,
        actionStates,
        anchor,
        posX: x,
        posY: y,
        frameOrigin: {
          x: primaryFrame.x,
          y: primaryFrame.y,
          centerX: primaryFrame.centerX,
          centerY: primaryFrame.centerY,
        },
        pointerState: 'normal',
        refresh: () => {
          const state = this.messageButtonStates.get(`${this.windowIndex}.${id}`);
          const patno = state?.patno ?? 0;
          element.hidden = state?.visible === false ||
            (!decorative && this.frameActionStateResolver?.(action) === 'hidden');
          if (element.hidden) return;
          if (decorative) {
            applyState(actionStates.normal, patno);
            return;
          }
          const spec = button!.disabled
            ? actionStates.disable
            : entry.pointerState === 'push'
              ? actionStates.push
              : entry.pointerState === 'hit'
                ? actionStates.hit
                : actionStates.normal;
          applyState(spec, patno);
        },
      };

      if (button) {
        const hoverKey = `waku:${wakuIndex}:${action.id}`;
        button.dataset.siglusWakuButton = `${wakuIndex}:${action.id}`;
        button.dataset.siglusHoverKey = hoverKey;
        button.addEventListener('pointerenter', () => {
          entry.pointerState = 'hit';
          entry.refresh();
          if (!button.disabled) this.enterButtonHover(hoverKey, action.sound);
        });
        button.addEventListener('pointerleave', () => {
          this.leaveButtonHover(hoverKey, button);
          if (button.isConnected && !button.closest('[inert]')) {
            entry.pointerState = 'normal';
            entry.refresh();
          }
        });
        button.addEventListener('pointerdown', (event) => {
          entry.pointerState = 'push';
          entry.refresh();
          if (event.button === 0 && !button.disabled && action.sound >= 0) {
            this.onButtonSound?.(action.sound, 'push');
          }
        });
        button.addEventListener('pointerup', () => {
          entry.pointerState = 'hit';
          entry.refresh();
        });
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          this.stage.focus({preventScroll: true});
          this.activateFrameAction?.(action);
        });
      }
      entries.push(entry);
    }
    this.frameActionsByWaku.set(wakuIndex, entries);
  }

  async showHistory(
    entries: readonly SiglusHistoryEntry[],
    play: (entry?: SiglusHistoryEntry, sound?: number) => void,
    canJump: (entry: SiglusHistoryEntry) => boolean,
    focus?: SiglusHistoryEntry,
  ): Promise<SiglusHistoryEntry | undefined> {
    const quoted = (key: string) => this.config.get(key)?.split('"')[1];
    const numbers = (key: string, fallback: number[]) =>
      this.config.get(key)?.split(',').map(Number) ?? fallback;
    const backdrop = quoted('MSGBK.BACK_FILE');
    if (!backdrop) return;
    const overlay = document.createElement('div');
    overlay.dataset.siglusHistory = '';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Message history');
    const [x, y] = numbers('MSGBK.WINDOW_POS', [0, 0]);
    const [width, height] = numbers('MSGBK.WINDOW_SIZE', [this.width, this.height]);
    // Overlay covers the full stage so full-screen BACK_FILE/FILTER_FILE and
    // bottom-edge CLOSE_BTN are never clipped by MSGBK.WINDOW_SIZE (e.g. 1920x980).
    overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:auto';
    const filterFile = quoted('MSGBK.FILTER_FILE');
    if (filterFile && this.files.has(`g00/${filterFile.toLowerCase()}.g00`)) {
      const filterFrame = await this.graphic(filterFile);
      const filterOff = computeSpriteOffset(0, 0, filterFrame);
      const filterCanvas = this.node(filterFrame);
      filterCanvas.dataset.siglusHistoryFilter = '';
      filterCanvas.style.left = `${filterOff.left}px`;
      filterCanvas.style.top = `${filterOff.top}px`;
      filterCanvas.style.pointerEvents = 'none';
      const filterColor = numbers('MSGBK.FILTER_COLOR', [0, 0, 0, 255]);
      filterCanvas.style.opacity = String(Math.max(0, Math.min(255, filterColor[3] ?? 255)) / 255);
      overlay.append(filterCanvas);
    }
    const backFrame = await this.graphic(backdrop);
    const backOff = computeSpriteOffset(0, 0, backFrame);
    const backCanvas = this.node(backFrame);
    backCanvas.style.left = `${backOff.left}px`;
    backCanvas.style.top = `${backOff.top}px`;
    backCanvas.style.pointerEvents = 'none';
    overlay.append(backCanvas);
    const [left, top, right, bottom] = numbers('MSGBK.DISP_MARGIN', [0, 0, 0, 0]);
    const [columns] = numbers('MSGBK.MOJI_CNT', [34]);
    const [letterSpace, lineSpace] = numbers('MSGBK.MOJI_SPACE', [0, 0]);
    const fontSize = Number(this.config.get('MSGBK.MOJI_SIZE') ?? 34);
    const textLeft = Number(this.config.get('MSGBK.MESSAGE_POS') ?? 0);
    const textColor = this.tableColor(Number(this.config.get('MSGBK.MOJI_COLOR') ?? -1)) ?? 'white';
    const activeTextColor =
      this.tableColor(Number(this.config.get('MSGBK.ACTIVE_MOJI_COLOR') ?? -1)) ?? textColor;
    const fuchiColor =
      this.tableColor(Number(this.config.get('MSGBK.MOJI_FUCHI_COLOR') ?? -1)) ?? 'black';
    const scrollHeight = Math.max(100, height! - top! - bottom!);
    const scrollWidth = Math.min(
      Math.max(100, width! - left! - right!),
      textLeft + columns! * (fontSize + letterSpace!),
    );
    const scroll = document.createElement('div');
    scroll.style.cssText = `position:absolute;left:${x! + left!}px;top:${y! + top!}px;width:${scrollWidth}px;height:${scrollHeight}px;overflow:auto;scrollbar-width:none;user-select:text;color:${textColor};text-shadow:1px 0 0 ${fuchiColor},-1px 0 0 ${fuchiColor},0 1px 0 ${fuchiColor},0 -1px 0 ${fuchiColor};font-size:${fontSize}px;line-height:${fontSize + lineSpace!}px;letter-spacing:${letterSpace}px`;
    scroll.style.fontFamily = this.message.style.fontFamily;
    overlay.append(scroll);
    const loadButtonSpec = async (kind: string) => {
      const key = 'MSGBK_ITEM.' + kind + '.';
      const file = quoted(key + 'FILE');
      if (!file || !this.files.has(`g00/${file.toLowerCase()}.g00`)) return undefined;
      const [bx, by] = numbers(key + 'POS', [0, 0]);
      const actionRaw = this.config.get(key + 'ACTION');
      const actionStates = parseButtonActionStates(
        this.config,
        actionRaw !== undefined ? Number(actionRaw) : undefined,
      );
      const res = await this.resource(file);
      const cuts: Graphic[] = [];
      for (let c = 0; c < Math.min(res.count, 8); c++) cuts.push(await this.graphic(file, c));
      const frame = cuts[0]!;
      return {
        key,
        bx: bx!,
        by: by!,
        frame,
        cuts,
        actionStates,
        se: Number(this.config.get(key + 'SE') ?? -1),
      };
    };
    const buildHistoryButton = (
      spec: NonNullable<Awaited<ReturnType<typeof loadButtonSpec>>>,
      label: string,
      action: () => void,
    ) => {
      const offset = computeSpriteOffset(spec.bx, spec.by, spec.frame);
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.style.cssText = `position:absolute;left:${offset.left}px;top:${offset.top}px;width:${spec.frame.width}px;height:${spec.frame.height}px;padding:0;border:0;background:none;cursor:pointer`;
      const canvas = this.node(spec.frame);
      canvas.style.left = '0';
      canvas.style.top = '0';
      canvas.style.pointerEvents = 'none';
      const paint = (st: ButtonActionState) => {
        const g = spec.cuts[Math.max(0, Math.min(spec.cuts.length - 1, st.cutOffset))] ?? spec.frame;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(g.image, 0, 0);
        canvas.style.translate = st.dx || st.dy ? `${st.dx}px ${st.dy}px` : '';
      };
      button.addEventListener('pointerenter', () => {
        paint(spec.actionStates.hit);
        if (spec.se >= 0) this.onButtonSound?.(spec.se, 'hit');
      });
      button.addEventListener('pointerleave', () => paint(spec.actionStates.normal));
      button.addEventListener('pointerdown', (event) => {
        paint(spec.actionStates.push);
        if (event.button === 0 && spec.se >= 0) this.onButtonSound?.(spec.se, 'push');
      });
      button.addEventListener('pointerup', () => paint(spec.actionStates.hit));
      button.append(canvas);
      button.onclick = (event) => {
        event.stopPropagation();
        play(undefined, spec.se);
        action();
      };
      return button;
    };
    const makeButton = async (kind: string, label: string, action: () => void) => {
      const spec = await loadButtonSpec(kind);
      return spec ? buildHistoryButton(spec, label, action) : undefined;
    };
    const divider = quoted('MSGBK.SEPARATOR_FILE');
    const separator = divider && (await this.graphic(divider));
    const replaySpec = await loadButtonSpec('KOE_BTN');
    const jumpSpec = await loadButtonSpec('LOAD_BTN');
    // When LOAD_BTN occupies the left gutter (bx < -80, e.g. SSR POS=-260,0), placing
    // the speaker name inside the message column above the dialogue prevents button overlap.
    const inlineNameRow = Boolean(jumpSpec && jumpSpec.bx < -80);
    let closeHistory: (entry?: SiglusHistoryEntry) => void = () => {};
    let focusedRow: HTMLElement | undefined;
    for (const entry of entries) {
      const row = document.createElement('div');
      row.style.cssText =
        'position:relative;white-space:pre-wrap;overflow-wrap:anywhere;padding:6px 0';
      row.dataset.siglusHistoryEntry = '';
      if (activeTextColor !== textColor) {
        row.addEventListener('pointerenter', () => {
          row.style.color = activeTextColor;
        });
        row.addEventListener('pointerleave', () => {
          row.style.color = '';
        });
      }
      let name: HTMLElement | undefined;
      if (entry.name) {
        name = document.createElement(inlineNameRow ? 'div' : 'span');
        name.dataset.siglusHistorySpeaker = '';
        name.style.cssText = inlineNameRow
          ? `margin-left:${textLeft}px;font-weight:bold`
          : `position:absolute;left:0;width:${Math.max(0, textLeft - 64)}px;text-align:right`;
        name.textContent = entry.name;
      }
      const body = document.createElement('div');
      body.dataset.siglusHistoryText = '';
      body.style.cssText = `position:relative;margin-left:${textLeft}px;min-height:${fontSize + lineSpace!}px`;
      for (const {text, ruby} of entry.text) {
        if (!ruby) body.append(text);
        else {
          const annotation = document.createElement('ruby');
          const reading = document.createElement('rt');
          reading.textContent = ruby;
          annotation.append(text, reading);
          body.append(annotation);
        }
      }
      if (replaySpec && entry.voices.length) {
        const button = buildHistoryButton(replaySpec, 'Replay history voice', () => {});
        button.onclick = (event) => {
          event.stopPropagation();
          play(entry, replaySpec.se);
        };
        body.append(button);
      }
      if (jumpSpec && canJump(entry)) {
        const button = buildHistoryButton(jumpSpec, 'Resume from this message', () =>
          closeHistory(entry),
        );
        if (entry === focus) button.dataset.historySelected = '';
        body.append(button);
      }
      if (entry === focus) focusedRow = row;
      if (name) row.append(name, body);
      else row.append(body);
      if (separator) {
        const line = this.node(separator);
        line.style.position = 'relative';
        row.append(line);
      }
      scroll.append(row);
    }
    const step = (direction: number) => scroll.scrollBy(0, direction * (fontSize + lineSpace!));
    const sliderFile = quoted('MSGBK_ITEM.SLIDER.FILE');
    if (sliderFile && this.files.has(`g00/${sliderFile.toLowerCase()}.g00`)) {
      const [sx, from, to] = numbers('MSGBK_ITEM.SLIDER.POS', [0, 0, 0]);
      const thumb = await this.graphic(sliderFile);
      const track = document.createElement('div');
      track.style.cssText = `position:absolute;left:${sx! - thumb.centerX}px;top:${from! - thumb.centerY}px;width:${thumb.width}px;height:${to! - from! + thumb.height}px;touch-action:none`;
      const icon = this.node(thumb);
      icon.style.left = '0';
      icon.style.top = '0';
      const update = () => {
        const limit = scroll.scrollHeight - scroll.clientHeight;
        icon.style.top = `${limit > 0 ? (scroll.scrollTop / limit) * (to! - from!) : 0}px`;
      };
      const move = (event: PointerEvent) => {
        if (!track.hasPointerCapture(event.pointerId)) return;
        const bounds = track.getBoundingClientRect();
        const position = (event.clientY - bounds.top) / bounds.height;
        scroll.scrollTop =
          ((position * (to! - from! + thumb.height) - thumb.height / 2) /
            Math.max(1, to! - from!)) *
          (scroll.scrollHeight - scroll.clientHeight);
      };
      track.onpointerdown = (event) => {
        event.stopPropagation();
        track.setPointerCapture(event.pointerId);
        move(event);
      };
      track.onpointermove = move;
      scroll.addEventListener('scroll', update);
      track.append(icon);
      overlay.append(track);
      queueMicrotask(update);
    }
    const up = await makeButton('MSG_UP_BTN', 'Scroll history up', () => step(-1));
    const down = await makeButton('MSG_DOWN_BTN', 'Scroll history down', () => step(1));
    if (up) overlay.append(up);
    if (down) overlay.append(down);
    this.signal.throwIfAborted();
    const close = await makeButton('CLOSE_BTN', 'Close message history', () => closeHistory());
    if (close) overlay.append(close);
    return new Promise<SiglusHistoryEntry | undefined>((resolve, reject) => {
      const finish = (entry?: SiglusHistoryEntry) => {
        this.signal.removeEventListener('abort', abort);
        this.preserveStageFocus(() => overlay.remove());
        resolve(entry);
      };
      const abort = () => {
        overlay.remove();
        reject(this.signal.reason);
      };
      closeHistory = finish;
      this.signal.addEventListener('abort', abort, {once: true});
      overlay.tabIndex = -1;
      overlay.onkeydown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          finish();
        }
      };
      overlay.onpointerdown = (event) => event.stopPropagation();
      overlay.onclick = (event) => event.stopPropagation();
      overlay.onwheel = (event) => event.stopPropagation();
      overlay.oncontextmenu = (event) => {
        if (!this.stage.ownerDocument.getSelection()?.isCollapsed) return;
        event.preventDefault();
        event.stopPropagation();
        finish();
      };
      this.setSystemInput(true);
      this.systemLayer.append(overlay);
      overlay.focus({preventScroll: true});
      if (focusedRow) focusedRow.scrollIntoView({block: 'nearest'});
      else scroll.scrollTop = scroll.scrollHeight;
    }).finally(() => this.setSystemInput(false));
  }

  pageControls(
    activate?: (action: SiglusFrameAction) => void,
    state?: (action: SiglusFrameAction) => 'hidden' | 'disabled' | 'enabled',
  ): void {
    this.activateFrameAction = activate;
    this.frameActionStateResolver = state;
    this.updateWaitIcon(Boolean(activate) && !this.message.hidden);
    this.controls.hidden =
      !activate || this.frameIndex < 0 || !this.activeFrameActions.length || this.message.hidden;
    if (this.controls.hidden) return;
    for (const entry of this.activeFrameActions) {
      if (entry.decorative) {
        entry.refresh();
        continue;
      }
      const status = state?.(entry.action);
      entry.button!.disabled = status !== 'enabled';
      if (entry.button!.disabled) entry.pointerState = 'normal';
      entry.refresh();
    }
  }

  sepia(active: boolean): void {
    this.layers.style.filter = active ? 'sepia(1)' : '';
  }

  throb(time: number): void {
    this.background?.animate(
      {transform: ['scale(1.13)', 'scale(1)']},
      {duration: time, easing: 'ease-out'},
    );
  }

  dispose(): void {
    this.g00Worker?.terminate();
    this.systemLayerDraws.delete(this.systemLayer);
    this.systemLayerDraws.delete(this.systemFrontLayer);
    this.objectMaskRestoreGeneration++;
    this.pendingObjectMasks.clear();
    this.updateWaitIcon(false);
    this.colorFilterSvg?.remove();
    this.colorFilterSvg = undefined;
    this.colorFilterCache.clear();
    for (const entry of [...this.graphicCache.values(), ...this.compositeCache.values()]) {
      if (typeof ImageBitmap !== 'undefined' && entry.graphic.image instanceof ImageBitmap) {
        entry.graphic.image.close();
      }
    }
    this.graphicCache.clear();
    this.graphicCacheBytes = 0;
    this.inFlightGraphics.clear();
    this.compositeCache.clear();
    this.compositeCacheBytes = 0;
    this.inFlightComposites.clear();
    this.maskUrlCache.clear();
    this.maskWipeCache.clear();
    this.media.clear();
    this.clearSelectionButtons();
    this.clearStageEffects();
    this.resetSlide();
    this.windowDisplay.dispose();
    this.stage.removeEventListener('click', this.click);
    this.stage.removeEventListener('pointerdown', this.pointerDown);
    this.stage.removeEventListener('keydown', this.key);
    this.stage.removeEventListener('keyup', this.key);
    for (const font of this.loadedFonts) document.fonts.delete(font);
    this.stage.remove();
  }
}
