import type {ByteSource} from '../../core/source.js';
import {BrowserWindowDisplayHost} from '../../platform/browser-window-display.js';
import {readSfntFontMetadata} from '../../formats/sfnt.js';
import {readGan} from '../../formats/siglus/gan.js';
import {G00Image, type G00Frame} from '../../formats/siglus/g00.js';
import {captureLayers} from './capture.js';
import {siglusFontShadow, type SiglusFontChoice} from './configuration.js';
import {eventEasing} from './timing.js';
import {fanWipeMask, type FanWipe} from './wipe.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
let nextWipeMaskId = 0;

export interface SiglusHistoryEntry {
  name: string;
  text: readonly {text: string; ruby?: string}[];
  voices: readonly {id: number; character?: number}[];
}

interface SiglusMessageSnapshot extends Omit<SiglusHistoryEntry, 'voices'> {
  face?: string;
  faceCostume?: string;
  index: number;
  size?: number;
  slideTime?: number;
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
}

export interface DrawObject {
  name: string;
  frames: (Graphic | undefined)[];
  x: number;
  y: number;
  visible: boolean;
  layer?: number;
  transparency?: number;
  pattern: number;
  scale?: readonly [number, number];
  blend?: number;
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
  patternCycle?: {count: number; duration: number; started: number};
  button?: {id: number; group: number};
  children?: Map<number, DrawObject>;
  text?: {value: string; font?: string; size: number; bold: boolean; shadow: number};
  clip?: [number, number, number, number, number];
  sourceClip?: [number, number, number, number];
  pushKeep?: boolean;
  alphaTest?: boolean;
  disabled?: boolean;
  opacity?: [target: number, duration: number, delay: number, easing: number, start: number];
  opacityStarted?: number;
  horizontalMotion?: {
    from: number;
    duration: number;
    delay: number;
    easing: number;
    started: number;
  };
  movement?: [target: number, duration: number, delay: number, easing: number, start: number];
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

type GanLayer = {checkpoint: SiglusGanCheckpoint; layer: HTMLElement; animations: Animation[]};
type BackgroundPan = {
  from: [number, number];
  to: [number, number];
  time: number;
  scale?: [number, number];
};
export type SiglusBackground = {name: string; pan?: BackgroundPan};

export interface SiglusFrameAction {
  id: number;
  type: string;
  state: number | undefined;
  slot: number | undefined;
  sound: number;
  call: string | undefined;
}

export function orderedObjects(objects: ReadonlyMap<number, DrawObject>): DrawObject[] {
  return [...objects]
    .sort(([a, first], [b, second]) => (first.layer ?? 0) - (second.layer ?? 0) || a - b)
    .map(([, object]) => object);
}

const registeredOpacityProperties = new Set<string>();

function registerOpacityProperty(name: string): void {
  if (registeredOpacityProperties.has(name)) return;
  CSS.registerProperty({name, syntax: '<number>', inherits: true, initialValue: '1'});
  registeredOpacityProperties.add(name);
}

export class SiglusDisplay {
  readonly stage = document.createElement('div');
  private readonly layers = document.createElement('div');
  private readonly cast = document.createElement('div');
  private readonly effect = document.createElement('div');
  private readonly activeGans = new Map<number, GanLayer>();
  private readonly pendingGans = new Map<number, GanLayer | null>();
  private castTransition?: Promise<void>;
  private readonly controls = document.createElement('div');
  private readonly frameActions: {
    action: SiglusFrameAction;
    button: HTMLButtonElement;
    refresh: () => void;
    motion?: Animation;
  }[] = [];
  private readonly messageButtonPositions = new Map<
    number,
    Map<number, {x?: number; y?: number}>
  >();
  private activateFrameAction?: (action: SiglusFrameAction) => void;
  private readonly editLayer = document.createElement('div');
  private readonly edits = new Map<number, {input: HTMLInputElement; result: string}>();
  private readonly systemLayer = document.createElement('div');
  private readonly systemFrontLayer = document.createElement('div');
  private readonly message = document.createElement('div');
  private readonly messageObjects = document.createElement('div');
  private readonly speaker = document.createElement('div');
  private readonly text = document.createElement('div');
  private readonly nativeText = document.createElement('canvas');
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
  private speakerMetrics = {x: 0, y: 0};
  private readonly domBaselineOffsets = new Map<string, number>();
  private messageShadow = 2;
  private readonly portrait = document.createElement('div');
  private readonly media = new Map<string, Promise<G00Image>>();
  private readonly hitPaths = new WeakMap<Graphic, string>();
  private background?: HTMLElement;
  private objectLayer?: HTMLElement;
  private wipe?: Animation;
  private systemInput = false;
  private readonly keys = [this.inputKey(), this.inputKey()];
  private wheelDelta = 0;
  private sampledWheel = 0;
  private pressed?: {id: number; group: number};
  private heldButton?: {
    pointerId: number;
    release: () => void;
  };
  private hovered?: {id: number; group: number};
  private pointer = [0, 0];
  private currentFace?: string;
  private currentFaceCostume?: string;
  private currentName = '';
  private currentText: {text: string; ruby?: string}[] = [];
  private windowIndex = 0;
  private frameIndex = 0;
  private defaultTextSize = 38;
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
    private readonly width: number,
    private readonly height: number,
    private readonly signal: AbortSignal,
    private readonly advance: () => void,
    windowOptions: {root: HTMLElement; changed(): void; report(message: string): void},
    skip: (active: boolean) => void,
    cancel: () => boolean,
  ) {
    root.replaceChildren(this.stage);
    this.stage.dataset.textMode = this.textMode;
    this.stage.style.cssText =
      'position:absolute;overflow:hidden;isolation:isolate;background:#000;color:white';
    this.layers.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.message.style.cssText = 'position:absolute;isolation:isolate;pointer-events:none';
    this.messageObjects.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.speaker.style.cssText = 'position:absolute;white-space:pre;text-shadow:0 1px 4px #000';
    this.text.style.cssText =
      'position:absolute;white-space:pre-wrap;overflow-wrap:anywhere;text-shadow:0 1px 4px #000';
    for (const element of [this.speaker, this.text]) {
      element.style.pointerEvents = 'auto';
      element.style.userSelect = 'text';
      element.style.cursor = 'text';
    }
    this.portrait.style.cssText = 'position:absolute;overflow:hidden';
    this.cast.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.effect.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.controls.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.controls.hidden = true;
    this.systemLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.systemFrontLayer.style.cssText = this.systemLayer.style.cssText;
    this.editLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3';
    this.stage.append(
      this.layers,
      this.cast,
      this.effect,
      this.message,
      this.controls,
      this.systemFrontLayer,
      this.systemLayer,
      this.editLayer,
    );
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
    this.pointerDown = (event) => {
      if (this.systemInput && (event.button === 0 || event.button === 2)) {
        this.stage.setPointerCapture(event.pointerId);
        this.keys[event.button === 0 ? 0 : 1]!.pending.push(true);
      }
      if (event.button === 0 && this.hasTextSelection())
        this.stage.ownerDocument.getSelection()?.removeAllRanges();
    };
    this.key = (event) => {
      if (this.systemInput && event.target === this.stage) {
        const index =
          event.key === 'Escape' ? 1 : event.key === 'Enter' || event.key === ' ' ? 0 : -1;
        if (index !== -1) {
          event.preventDefault();
          if (!event.repeat) this.keys[index]!.pending.push(event.type === 'keydown');
          return;
        }
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
    this.stage.addEventListener('pointermove', (event) => this.trackPointer(event));
    this.stage.addEventListener('pointerdown', (event) => this.trackPointer(event));
    this.stage.addEventListener('pointerleave', () => {
      this.hovered = undefined;
      this.pointer = [-1, -1];
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
      this.stage.addEventListener(type, (event) => {
        if (this.systemInput && type === 'pointerup' && (event.button === 0 || event.button === 2))
          this.keys[event.button === 0 ? 0 : 1]!.pending.push(false);
        if (this.systemInput && type === 'pointercancel') this.clearInput(true);
        this.pressed = undefined;
        const held = this.heldButton;
        if (held?.pointerId !== event.pointerId) return;
        this.heldButton = undefined;
        if (type === 'pointerup') {
          this.trackPointer(event);
          held.release();
        }
      });
    this.stage.addEventListener('contextmenu', (event) => {
      if (this.systemInput || (!this.hasTextSelection() && cancel())) event.preventDefault();
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
    this.stage.addEventListener('focusout', () => {
      skip(false);
      this.clearInput(true);
    });
    this.stage.focus({preventScroll: true});
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
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-siglus-button]');
    this.hovered =
      button && !button.disabled
        ? {id: Number(button.dataset.siglusButton), group: Number(button.dataset.siglusGroup)}
        : undefined;
  }

  buttonState(group: number, pressed: boolean): number {
    const button = pressed ? this.pressed : this.hovered;
    return button?.group === group ? button.id : -1;
  }

  pointerPosition(axis: number): number {
    return this.pointer[axis]!;
  }

  setMessageDisplayed(displayed: boolean): void {
    this.message.style.visibility = displayed ? '' : 'hidden';
    this.controls.style.visibility = displayed ? '' : 'hidden';
  }

  setScenePaused(paused: boolean): void {
    for (const layer of [this.layers, this.cast, this.effect])
      for (const animation of layer.getAnimations({subtree: true})) {
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
      if (reset) {
        key.pending.length = 0;
        key.down = false;
      }
    }
    this.sampledWheel = 0;
    if (reset) this.wheelDelta = 0;
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
  }

  async showSystemObjects(
    objects: Iterable<DrawObject>,
    button: (target: NonNullable<DrawObject['button']>) => void,
    front = false,
  ): Promise<void> {
    const next = await this.drawObjects(objects, button);
    this.signal.throwIfAborted();
    (front ? this.systemFrontLayer : this.systemLayer).replaceChildren(next);
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
    if (command === 7) {
      if (edit) edit.result = '';
      return 0;
    }
    if (!edit) return undefined;
    switch (command) {
      case 1:
        edit.input.remove();
        this.edits.delete(id);
        this.stage.focus({preventScroll: true});
        return 0;
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
    this.editLayer.replaceChildren();
  }

  clearSystemObjects(): void {
    this.systemLayer.replaceChildren();
  }

  clearSystemFrontObjects(): void {
    this.systemFrontLayer.replaceChildren();
  }

  async prepare(): Promise<void> {
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
    await this.prepareFrameActions();
    this.selectMessageWindow(0);
    const filter = this.config.get('WAKU.000.FILTER_FILE')?.split('"')[1];
    if (filter) {
      const frame = await this.graphic(filter);
      const layer = this.node(frame);
      layer.style.zIndex = '-1';
      this.message.prepend(layer);
      this.filter = layer;
      this.filterFrame = frame;
    }
  }

  setMessageFilter([red, green, blue, alpha]: readonly number[]): void {
    const canvas = this.filter;
    const frame = this.filterFrame;
    if (!canvas || !frame) return;
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frame.image, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = image.data[i]! + red!;
      image.data[i + 1] = image.data[i + 1]! + green!;
      image.data[i + 2] = image.data[i + 2]! + blue!;
    }
    context.putImageData(image, 0, 0);
    canvas.style.opacity = String(alpha! / 255);
  }

  setTextMode(mode: 'native' | 'dom'): void {
    if (mode === this.textMode) return;
    const selection = this.stage.ownerDocument.getSelection();
    if (selection && this.message.contains(selection.anchorNode)) selection.removeAllRanges();
    this.textMode = mode;
    this.nativeText.hidden = mode !== 'native';
    this.text.hidden = this.speaker.hidden = mode === 'native';
    this.stage.dataset.textMode = mode;
    if (mode === 'dom') this.alignDomText();
    else {
      this.text.style.top = `${this.textMetrics.y}px`;
      this.speaker.style.top = `${this.speakerMetrics.y}px`;
    }
    this.paintMessageText();
    this.stage.focus({preventScroll: true});
  }

  private alignDomText(): void {
    if (this.textMode !== 'dom' || !this.text.style.fontSize) return;
    const family = this.message.style.fontFamily || 'sans-serif';
    const context = this.nativeText.getContext('2d')!;
    context.save();
    context.textBaseline = 'top';
    for (const [element, y] of [
      [this.text, this.textMetrics.y],
      [this.speaker, this.speakerMetrics.y],
    ] as const) {
      const {fontSize, fontWeight, lineHeight} = getComputedStyle(element);
      const font = `${fontWeight} ${fontSize} ${family}`;
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
      const offset = this.updateSlide(this.text.scrollHeight - this.text.clientHeight);
      this.text.style.translate = `0 ${-offset}px`;
      const rubyRoom = this.textMetrics.rubySize + this.textMetrics.rubySpace + 2;
      this.text.style.clipPath = `inset(${offset - rubyRoom}px -8px ${-offset}px -8px)`;
      return;
    }
    this.drawNativeMessage(this.nativeText);
  }

  private drawNativeMessage(canvas: HTMLCanvasElement, slideOffset?: number): void {
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const family = this.message.style.fontFamily || 'sans-serif';
    const weight = this.message.style.fontWeight || 'normal';
    context.fillStyle = 'white';
    context.strokeStyle = 'black';
    context.lineJoin = 'round';
    context.lineWidth = 2;
    context.shadowColor = this.messageShadow & 1 ? 'black' : 'transparent';
    context.shadowBlur = 3;
    context.shadowOffsetX = 1;
    context.shadowOffsetY = 2;
    context.textBaseline = 'top';
    const draw = (text: string, x: number, y: number) => {
      if (this.messageShadow & 2) context.strokeText(text, x, y);
      context.fillText(text, x, y);
    };
    const speakerSize = Number.parseFloat(this.speaker.style.fontSize);
    if (this.currentName && speakerSize > 0) {
      context.font = `${weight} ${speakerSize}px ${family}`;
      draw(this.currentName, this.speakerMetrics.x, this.speakerMetrics.y);
    }
    const size = Number.parseFloat(this.text.style.fontSize);
    if (!size || !this.currentText.length) return;
    const {x, y, width, rows, spacing, lineSpace, rubySize, rubySpace} = this.textMetrics;
    const advance = (character: string) => {
      const unit = character.codePointAt(0)!;
      return (unit <= 0x7f || (unit >= 0xff61 && unit <= 0xff9f) ? size / 2 : size) + spacing;
    };
    const lines: {cells: {character: string; ruby?: string; width: number}[]; width: number}[] = [];
    let line: (typeof lines)[number] = {cells: [], width: 0};
    const nextLine = () => {
      lines.push(line);
      line = {cells: [], width: 0};
    };
    const add = (character: string, ruby?: string) => {
      const cellWidth = Array.from(character).reduce((total, unit) => total + advance(unit), 0);
      if (line.width && line.width + cellWidth > width) nextLine();
      line.cells.push({character, ruby, width: cellWidth});
      line.width += cellWidth;
    };
    for (const {text, ruby} of this.currentText) {
      if (ruby) add(text, ruby);
      else
        for (const character of text) {
          if (character === '\n') nextLine();
          else add(character);
        }
    }
    nextLine();
    const pitch = size + lineSpace;
    const offset = slideOffset ?? this.updateSlide((lines.length - rows) * pitch);
    if (this.slideTime !== undefined) {
      context.save();
      context.beginPath();
      context.rect(
        0,
        y - rubySize - rubySpace - 2,
        canvas.width,
        pitch * rows + rubySize + rubySpace + 2,
      );
      context.clip();
    }
    for (const [index, row] of lines.entries()) {
      const rowY = y + index * pitch - offset;
      let left = x + (this.text.style.textAlign === 'center' ? (width - row.width) / 2 : 0);
      for (const cell of row.cells) {
        context.font = `${weight} ${size}px ${family}`;
        let glyphX = left;
        for (const character of cell.character) {
          draw(character, glyphX, rowY);
          glyphX += advance(character);
        }
        if (cell.ruby) {
          context.font = `${weight} ${rubySize}px ${family}`;
          context.textAlign = 'center';
          draw(cell.ruby, left + cell.width / 2, rowY - rubySize - rubySpace);
          context.textAlign = 'start';
        }
        left += cell.width;
      }
    }
    if (this.slideTime !== undefined) context.restore();
  }

  selectMessageWindow(index: number): void {
    this.windowIndex = index;
    const prefix = 'MWND.' + String(index).padStart(3, '0') + '.';
    const numbers = (key: string, defaults: number[]): number[] =>
      this.config.get(key)?.split(',').map(Number) ?? defaults;
    const place = (element: HTMLElement, position: number[], size: number[]): void => {
      const [x, y] = position;
      const [w, h] = size;
      Object.assign(element.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      });
    };
    const windowSize = numbers(prefix + 'WINDOW_SIZE', [1906, 353]);
    place(this.message, numbers(prefix + 'WINDOW_POS', [7, 727]), windowSize);
    const size = Number(this.config.get(prefix + 'MOJI_SIZE') ?? 38);
    this.defaultTextSize = size;
    const margin = numbers(prefix + 'MESSAGE_MARGIN', index === 0 ? [32, 32] : [0, 0]);
    const [x, y] = numbers(prefix + 'MESSAGE_POS', [362, 124]);
    const [columns, rows] = numbers(prefix + 'MOJI_CNT', [32, 3]);
    const [spacing, lineSpace] = numbers(prefix + 'MOJI_SPACE', [0, 18]);
    const textX = x! + margin[0]!;
    const textY = y! + margin[1]!;
    const textWidth = columns! * (size + spacing!);
    const textHeight = rows! * (size + lineSpace!);
    this.textMetrics = {
      x: textX,
      y: textY,
      width: textWidth,
      rows: rows!,
      spacing: spacing!,
      lineSpace: lineSpace!,
      rubySize: Number(this.config.get(prefix + 'RUBY_SIZE') ?? 13),
      rubySpace: Number(this.config.get(prefix + 'RUBY_SPACE') ?? 2),
    };
    this.nativeText.width = windowSize[0]!;
    this.nativeText.height = windowSize[1]!;
    place(this.text, [textX, textY], [textWidth, textHeight]);
    this.text.style.letterSpacing = `${spacing}px`;
    this.text.dataset.siglusDialogue = '';
    const namePos = numbers(prefix + 'NAME_MESSAGE_POS', [x!, y! - size]);
    place(this.speaker, namePos, [500, 80]);
    this.speakerMetrics = {x: namePos[0]!, y: namePos[1]!};
    this.speaker.style.fontSize = `${this.config.get(prefix + 'NAME_MOJI_SIZE') ?? 36}px`;
    place(this.portrait, numbers('WAKU.000.FACE.000.POS', [24, 24]), [340, windowSize[1]! - 24]);
    this.frameIndex = Number(this.config.get(prefix + 'WAKU_NO') ?? -1);
    if (this.filter) this.filter.hidden = this.frameIndex === -1;
    this.positionMessageButtons();
    this.setTextSize();
  }

  get messageWindow(): number {
    return this.windowIndex;
  }

  setMessageFrame(index: number): void {
    this.frameIndex = index;
    if (this.filter) this.filter.hidden = index !== 0;
  }

  offsetMessageButton(
    window: number,
    id: number,
    axis: 'x' | 'y',
    value: number,
    timing?: KeyframeAnimationOptions,
  ): void {
    let positions = this.messageButtonPositions.get(window);
    if (!positions) this.messageButtonPositions.set(window, (positions = new Map()));
    const position = positions.get(id) ?? {};
    if ((position[axis] ?? 0) === value) return;
    position[axis] = value;
    positions.set(id, position);
    if (window !== this.windowIndex) return;
    const entry = this.frameActions.find(({action}) => action.id === id);
    if (!entry) return;
    const {button} = entry;
    const from = timing ? getComputedStyle(button).translate : '';
    entry.motion?.cancel();
    button.style.translate = `${position.x ?? 0}px ${position.y ?? 0}px`;
    entry.motion = timing
      ? button.animate([{translate: from}, {translate: button.style.translate}], timing)
      : undefined;
  }

  private positionMessageButtons(): void {
    const positions = this.messageButtonPositions.get(this.windowIndex);
    for (const entry of this.frameActions) {
      const {action, button} = entry;
      entry.motion?.cancel();
      entry.motion = undefined;
      const {x = 0, y = 0} = positions?.get(action.id) ?? {};
      button.style.translate = `${x}px ${y}px`;
    }
  }

  async showMessageObjects(objects: Iterable<DrawObject>): Promise<void> {
    const layer = await this.drawObjects(objects, () => {}, false);
    this.messageObjects.replaceChildren(layer);
  }
  private readonly loadedFonts: FontFace[] = [];
  private readonly fontNames = new Map<string, string>();
  readonly fontChoices: SiglusFontChoice[] = [];

  private fontFamily(name?: string): string {
    const family = name && this.fontNames.get(name.toLowerCase());
    return family ? family + ', sans-serif' : (this.loadedFonts[0]?.family ?? 'sans-serif');
  }

  setMessageFont(name?: string, bold = false, shadow = 2): void {
    this.message.style.fontFamily = this.fontFamily(name);
    this.message.style.fontWeight = bold ? 'bold' : 'normal';
    this.messageShadow = shadow;
    this.text.style.textShadow = this.speaker.style.textShadow = siglusFontShadow(shadow);
    this.alignDomText();
    this.paintMessageText();
  }

  private async resource(name: string): Promise<G00Image> {
    const path = `g00/${name.toLowerCase()}.g00`;
    let pending = this.media.get(path);
    if (!pending) {
      const file = this.files.get(path);
      if (!file) throw new Error(`Missing Siglus image ${name}`);
      pending = file.read(0, file.size, this.signal).then((bytes) => new G00Image(bytes));
      this.media.set(path, pending);
      if (this.media.size > 6) this.media.delete(this.media.keys().next().value!);
    }
    return pending;
  }

  async objectGraphic(name: string, pattern: number): Promise<Graphic | undefined> {
    const resource = await this.resource(name);
    if (pattern < 0 || pattern >= resource.count) return;
    return this.graphic(name, pattern);
  }

  async graphic(name: string, pattern = 0): Promise<Graphic> {
    const resource = await this.resource(name);
    this.signal.throwIfAborted();
    if (resource.type === 3) {
      const image = await createImageBitmap(new Blob([resource.jpeg()], {type: 'image/jpeg'}));
      return {image, width: image.width, height: image.height, x: 0, y: 0, centerX: 0, centerY: 0};
    }
    const {width, height, x, y, centerX, centerY, contentBounds, bgra} = resource.frame(pattern);
    const rgba = new Uint8ClampedArray(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2]!;
      rgba[i + 1] = bgra[i + 1]!;
      rgba[i + 2] = bgra[i]!;
      rgba[i + 3] = bgra[i + 3]!;
    }
    const image = document.createElement('canvas');
    image.width = width;
    image.height = height;
    image.getContext('2d')!.putImageData(new ImageData(rgba, width, height), 0, 0);
    return {image, width, height, x, y, centerX, centerY, contentBounds};
  }

  rectangle(
    width: number,
    height: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
  ): Graphic {
    const image = document.createElement('canvas');
    image.width = width;
    image.height = height;
    const context = image.getContext('2d')!;
    context.fillStyle = `rgba(${r},${g},${b},${alpha / 255})`;
    context.fillRect(0, 0, width, height);
    return {image, width, height, x: 0, y: 0, centerX: 0, centerY: 0};
  }

  captureThumbnail(): string | undefined {
    if (this.config.get('SAVE_THUMB.USE') !== '1') return;
    const [width, height] = (this.config.get('SAVE_THUMB.SIZE') ?? '').split(',').map(Number);
    if (!width || !height || width > this.width || height > this.height) return;
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
      substitute = {target: this.nativeText, image, bounds: this.message.getBoundingClientRect()};
    }
    const layers = [this.layers, this.cast, this.effect, this.message, this.controls].filter(
      (layer) => layer.parentElement === this.stage,
    );
    const stage = captureLayers(this.width, this.height, bounds, layers, substitute);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(stage, 0, 0, width, height);
    return this.config.get('SAVE_THUMB.TYPE') === '1'
      ? canvas.toDataURL('image/png')
      : canvas.toDataURL('image/jpeg', 0.8);
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

  graphicAlpha(graphic: Graphic, x: number, y: number): number {
    if (x < 0 || y < 0 || x >= graphic.width || y >= graphic.height) return 0;
    const canvas = graphic.image instanceof HTMLCanvasElement ? graphic.image : this.node(graphic);
    return canvas.getContext('2d')!.getImageData(x, y, 1, 1).data[3]!;
  }

  private node(graphic: Graphic): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = graphic.width;
    canvas.height = graphic.height;
    canvas.style.cssText = `position:absolute;left:${graphic.x}px;top:${graphic.y}px`;
    canvas.getContext('2d')!.drawImage(graphic.image, 0, 0);
    return canvas;
  }

  private buttonHitPath(frame: Graphic, canvas: HTMLCanvasElement, object: DrawObject): string {
    const {width, height} = frame;
    const clip = object.clip?.[0] ? object.clip : undefined;
    const cached = object.alphaTest && !clip ? this.hitPaths.get(frame) : undefined;
    if (cached !== undefined) return cached;
    const [cutLeft, cutTop, cutRight, cutBottom] = frame.contentBounds ?? [0, 0, width, height];
    const x = object.x + frame.x;
    const y = object.y + frame.y;
    const left = Math.max(0, cutLeft, (clip?.[1] ?? x) - x);
    const top = Math.max(0, cutTop, (clip?.[2] ?? y) - y);
    const right = Math.min(width, cutRight, (clip?.[3] ?? x + width) - x);
    const bottom = Math.min(height, cutBottom, (clip?.[4] ?? y + height) - y);
    if (right <= left || bottom <= top) return 'inset(100%)';
    if (!object.alphaTest)
      return `inset(${top}px ${width - right}px ${height - bottom}px ${left}px)`;
    const {data} = canvas.getContext('2d')!.getImageData(0, 0, width, height);
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
    if (!clip) this.hitPaths.set(frame, path);
    return path;
  }

  async show(
    objects: Iterable<DrawObject>,
    duration: number,
    button: (target: NonNullable<DrawObject['button']>) => void,
    fan?: FanWipe,
  ): Promise<void> {
    await this.finishCastTransition();
    const next = await this.drawObjects(objects, button);
    const title = next.querySelector('[aria-label="New Game"]');
    if (title) this.clearGan();
    if (this.pendingGans.size) {
      await this.presentStage(next, [], duration, fan);
    } else {
      if (fan && duration > 0) this.layers.append(this.cast);
      try {
        await this.replaceLayer(next, duration, fan);
      } finally {
        if (fan && duration > 0) {
          this.cast.inert = false;
          this.layers.after(this.cast);
        }
      }
    }
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
    const layer = this.objectLayer;
    if (!layer?.isConnected) return;
    const next = await this.drawObjects(objects, button, false);
    await this.replaceLayer(next, 0);
    this.objectLayer = next;
  }

  private async drawObjects(
    objects: Iterable<DrawObject>,
    button: (target: NonNullable<DrawObject['button']>) => void,
    animate = true,
  ): Promise<HTMLElement> {
    const next = document.createElement('div');
    next.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    await this.appendObjects(next, objects, button, animate);
    return next;
  }

  private applyClip(
    element: HTMLElement,
    object: DrawObject,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    if (!object.clip?.[0]) return;
    const [, left, top, right, bottom] = object.clip;
    element.style.clipPath = `inset(${Math.max(0, top - y)}px ${Math.max(0, x + width - right)}px ${Math.max(0, y + height - bottom)}px ${Math.max(0, left - x)}px)`;
  }

  private async appendObjects(
    parent: HTMLElement,
    objects: Iterable<DrawObject>,
    button: (target: NonNullable<DrawObject['button']>) => void,
    animate: boolean,
    parentOpacity: readonly string[] = [],
  ): Promise<void> {
    for (const object of objects) {
      if (!object.visible) continue;
      if (object.text) {
        const text = document.createElement('div');
        const {value, font, size, bold, shadow} = object.text;
        text.textContent = value;
        text.style.cssText = `position:absolute;left:${object.x}px;top:${object.y}px;width:${this.width}px;height:${this.height}px;font-size:${size}px;color:white;white-space:pre`;
        text.style.fontFamily = this.fontFamily(font);
        text.style.fontWeight = bold ? 'bold' : 'normal';
        if (shadow) text.style.textShadow = '1px 1px 2px black';
        this.applyClip(text, object, object.x, object.y, this.width, this.height);
        this.applyLeafOpacity(text, object, animate, parentOpacity);
        parent.append(text);
        continue;
      }
      if (!object.name && !object.frames.length) {
        if (object.children)
          await this.appendChildren(parent, object, button, animate, parentOpacity);
        continue;
      }
      if (object.pattern < 0) continue;
      const frame =
        object.frames[object.pattern] ??
        (object.frames[object.pattern] = await this.objectGraphic(object.name, object.pattern));
      if (!frame) continue;
      const element =
        object.button === undefined
          ? document.createElement('div')
          : document.createElement('button');
      const canvas = this.node(frame);
      canvas.style.left = '0';
      canvas.style.top = '0';
      element.style.cssText = `position:absolute;left:${object.x + frame.x}px;top:${object.y + frame.y}px;width:${frame.width}px;height:${frame.height}px;border:0;padding:0;background:none`;
      if (object.scale) {
        element.style.scale = object.scale.map((axis) => axis / 1000).join(' ');
        element.style.transformOrigin = `${frame.centerX}px ${frame.centerY}px`;
      }
      if (object.blend === 1) element.style.mixBlendMode = 'plus-lighter';
      if (object.blend === 3) element.style.mixBlendMode = 'multiply';
      if (object.blend === 4) element.style.mixBlendMode = 'screen';
      for (const axis of ['x', 'y'] as const) {
        const event = object.positionEvents?.[axis];
        if (!event) continue;
        const property = axis === 'x' ? 'left' : 'top';
        const animation = element.animate(
          {[property]: [`${event.from + frame[axis]}px`, element.style[property]]},
          event.time,
        );
        animation.currentTime = performance.now() - event.started;
      }
      this.applyClip(
        element,
        object,
        object.x + frame.x,
        object.y + frame.y,
        frame.width,
        frame.height,
      );
      element.append(canvas);
      if (object.patternCycle) {
        const {count, duration, started} = object.patternCycle;
        const elapsed = performance.now() - started;
        for (let index = 0; index < count; index++) {
          const graphic = (object.frames[index] ??= await this.graphic(object.name, index));
          const image = index === object.pattern ? canvas : this.node(graphic);
          if (image !== canvas) element.append(image);
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
      }
      parent.append(element);
      if (object.sourceClip) {
        const [x, y, width, height] = object.sourceClip;
        canvas.style.clipPath = `inset(${y}px ${frame.width - x - width}px ${frame.height - y - height}px ${x}px)`;
      }
      if (element instanceof HTMLButtonElement) {
        const target = object.button!;
        element.style.clipPath = this.buttonHitPath(frame, canvas, object);
        const role = object.name.split('_').at(-1);
        const supported =
          !object.name.startsWith('__sys_title_btn_') ||
          role === 'start' ||
          role === 'prol' ||
          role === 'exit' ||
          role === 'load' ||
          role === 'music' ||
          role === 'config';
        element.disabled = !supported || Boolean(object.disabled);
        element.style.pointerEvents = supported ? 'auto' : 'none';
        element.style.cursor = 'pointer';
        element.setAttribute(
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
        element.dataset.siglusButton = String(target.id);
        element.dataset.siglusGroup = String(target.group);
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          this.stage.focus({preventScroll: true});
          if (!object.pushKeep || event.detail === 0) button(target);
        });
        element.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          this.pressed = target;
          if (object.pushKeep) {
            this.heldButton = {pointerId: event.pointerId, release: () => button(target)};
            this.stage.setPointerCapture(event.pointerId);
          }
        });
      }
      if (object.horizontalMotion) {
        const {from, duration, delay, easing, started} = object.horizontalMotion;
        const elapsed = performance.now() - started;
        if (elapsed < duration + delay) {
          const animation = element.animate(
            {transform: [`translateX(${from - object.x}px)`, 'translateX(0px)']},
            {duration, delay, easing: eventEasing(easing), fill: 'both'},
          );
          animation.currentTime = elapsed;
        }
      }
      this.applyLeafOpacity(element, object, animate, parentOpacity);
      if (animate && object.movement) {
        const [target, time, delay, mode, start] = object.movement;
        element.animate(
          {transform: [`translateY(${start}px)`, `translateY(${target}px)`]},
          {duration: time, delay, easing: eventEasing(mode), fill: 'both'},
        );
      }
      if (object.children)
        await this.appendChildren(parent, object, button, animate, parentOpacity);
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
      registerOpacityProperty(property);
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
    if (object.transparency !== undefined)
      element.style.setProperty(property, String(object.transparency / 255));
    if (!object.opacity || (!animate && object.opacityStarted === undefined)) return;
    const [target, duration, delay, mode, start] = object.opacity;
    const elapsed =
      object.opacityStarted === undefined ? 0 : performance.now() - object.opacityStarted;
    if (duration + delay <= elapsed) return;
    const animation = element.animate(
      {[property]: [String(start / 255), String(target / 255)]},
      {duration, delay, easing: eventEasing(mode), fill: 'both'},
    );
    animation.currentTime = elapsed;
  }

  private async appendChildren(
    parent: HTMLElement,
    object: DrawObject,
    button: (target: NonNullable<DrawObject['button']>) => void,
    animate: boolean,
    parentOpacity: readonly string[],
  ): Promise<void> {
    // Applying the group alpha to its leaves keeps blending in the stage's backdrop.
    const children = document.createElement('div');
    children.style.cssText = `position:absolute;left:${object.x}px;top:${object.y}px;pointer-events:none`;
    if ((object.transparency ?? 255) !== 255 || object.opacity) {
      const property = '--siglus-group-opacity-' + parentOpacity.length;
      registerOpacityProperty(property);
      this.applyObjectOpacity(children, object, animate, property);
      parentOpacity = [...parentOpacity, property];
    }
    parent.append(children);
    await this.appendObjects(
      children,
      orderedObjects(object.children!),
      button,
      animate,
      parentOpacity,
    );
  }

  finishWipe(): boolean {
    if (this.wipe?.playState !== 'running') return false;
    this.wipe.finish();
    return true;
  }

  private async replaceLayer(next: HTMLElement, duration: number, fan?: FanWipe): Promise<void> {
    this.signal.throwIfAborted();
    const previous = [...this.layers.children];
    for (const child of previous) (child as HTMLElement).inert = true;
    this.layers.append(next);
    this.background = next;
    if (duration > 0) {
      if (fan) await this.animateFanWipe(next, duration, fan);
      else {
        this.wipe = next.animate({opacity: [0, 1]}, {duration});
        await this.wipe.finished;
        this.wipe = undefined;
      }
    }
    for (const child of previous) child.remove();
  }

  private async animateFanWipe(layer: HTMLElement, duration: number, fan: FanWipe): Promise<void> {
    const {width, height} = this;
    const values = fanWipeMask(width, height, fan);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    const pixels = context.createImageData(width, height);
    for (let index = 0; index < values.length; index++) {
      pixels.data[index * 4 + 3] = values[index]!;
    }
    context.putImageData(pixels, 0, 0);
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
    image.setAttribute('href', canvas.toDataURL());
    image.setAttribute('filter', `url(#${filter.id})`);
    transfer.append(alpha);
    filter.append(transfer);
    mask.append(image);
    svg.append(filter, mask);
    this.stage.append(svg);
    layer.style.backgroundColor = 'black';
    layer.style.maskImage = `url(#${mask.id})`;
    const animation = layer.animate([], {duration, fill: 'both'});
    this.wipe = animation;
    const stop = () => animation.cancel();
    this.signal.addEventListener('abort', stop, {once: true});
    let frame = 0;
    const render = () => {
      const time = Number(animation.currentTime ?? 0);
      const progress = Math.min(65536, Math.floor((time * 65536) / duration)) / 65536;
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
      svg.remove();
      this.wipe = undefined;
    }
  }

  async setBackground(
    name: string,
    duration: number,
    pan?: BackgroundPan,
    clearCast = false,
  ): Promise<void> {
    await this.finishCastTransition();
    const next = await this.backgroundLayer({name, pan}, duration);
    if (this.pendingGans.size) {
      const cast = clearCast ? [] : [...this.copyStageLayer(this.cast).children];
      await this.presentStage(next, cast, duration);
    } else await this.replaceLayer(next, duration);
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
    sprites: readonly {name: string; costume: string; position?: [number, number]}[],
    duration: number,
    publish = false,
    backdrop?: SiglusBackground,
  ): Promise<void> {
    await this.finishCastTransition();
    const characters = await Promise.all(
      sprites.map(async ({name, costume, position}, index) => {
        const match = /^(bs\d_)?([a-z]{2})(\d\d)(\d\d)/i.exec(name);
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
        layer.style.cssText = `position:absolute;left:${x}px;top:${y}px`;
        for (const graphic of [body, face])
          layer.append(this.node({...graphic, x: -graphic.centerX, y: -graphic.centerY}));
        return layer;
      }),
    );
    this.signal.throwIfAborted();
    if (publish && this.pendingGans.size) {
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
    } else {
      this.cast.replaceChildren(...characters);
      if (duration > 0 && characters.length) this.cast.animate({opacity: [0, 1]}, {duration});
    }
    this.root.dataset.cast = sprites.map(({name}) => name).join(',');
  }

  setTextSize(size?: number): void {
    const pixels = size ?? this.defaultTextSize;
    this.text.style.fontSize = `${pixels}px`;
    this.text.style.lineHeight = `${pixels + this.textMetrics.lineSpace}px`;
    this.text.style.height = `${(pixels + this.textMetrics.lineSpace) * this.textMetrics.rows}px`;
    this.text.style.setProperty(
      '--siglus-ruby-offset',
      `${pixels / 2 + this.textMetrics.rubySpace}px`,
    );
    this.alignDomText();
    this.paintMessageText();
  }

  centerText(center: boolean): void {
    this.text.style.textAlign = center ? 'center' : '';
    this.paintMessageText();
  }

  setMessageSlide(time?: number): void {
    this.slideTime = time;
    if (time === undefined) this.resetSlide();
    this.text.toggleAttribute('data-siglus-slide', time !== undefined);
    this.paintMessageText();
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
      const node = this.node({...graphic, x: x + frame.x + graphic.x, y: y + frame.y + graphic.y});
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

  get hasGanChanges(): boolean {
    return this.pendingGans.size > 0;
  }

  async stageGan(checkpoint: SiglusGanCheckpoint): Promise<void> {
    const slot = checkpoint.slot ?? 200;
    const gan = await this.ganAnimation(checkpoint);
    this.signal.throwIfAborted();
    const previous = this.pendingGans.get(slot);
    if (previous) this.removeGan(previous);
    this.pendingGans.set(slot, gan);
    const now = document.timeline.currentTime as number;
    for (const animation of gan.animations) {
      animation.startTime = now;
      animation.currentTime = checkpoint.elapsed;
    }
  }

  retireGans(first: number, count: number): void {
    for (const slot of this.activeGans.keys())
      if (slot >= first && slot < first + count && !this.pendingGans.has(slot))
        this.pendingGans.set(slot, null);
  }

  async loadGans(checkpoints: readonly SiglusGanCheckpoint[]): Promise<void> {
    for (const checkpoint of checkpoints) await this.stageGan(checkpoint);
    this.applyGanChanges(this.effect);
  }

  saveGans(): SiglusGanCheckpoint[] | undefined {
    if (!this.activeGans.size) return;
    return Array.from(this.activeGans.values(), ({checkpoint, animations}) => {
      const animation = animations[0];
      const time = Math.max(0, Math.floor(Number(animation?.currentTime ?? 0)));
      const duration = Number(animation?.effect?.getTiming().duration ?? 0);
      const elapsed = duration && checkpoint.loop ? time % duration : time;
      return {...checkpoint, elapsed};
    });
  }

  private applyGanChanges(incoming: HTMLElement, outgoing?: HTMLElement): void {
    for (const [slot, next] of this.pendingGans) {
      const previous = this.activeGans.get(slot);
      if (previous) {
        if (outgoing) outgoing.append(previous.layer);
        else this.removeGan(previous);
        this.activeGans.delete(slot);
      }
      if (next) {
        incoming.append(next.layer);
        this.activeGans.set(slot, next);
      }
    }
    this.pendingGans.clear();
  }

  private removeGan({layer, animations}: GanLayer): void {
    for (const animation of animations) animation.cancel();
    layer.remove();
  }

  private clearGan(): void {
    for (const gan of this.activeGans.values()) this.removeGan(gan);
    for (const gan of this.pendingGans.values()) if (gan) this.removeGan(gan);
    this.activeGans.clear();
    this.pendingGans.clear();
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
    fan?: FanWipe,
  ): Promise<void> {
    const previous = this.background;
    const retired = [...this.pendingGans.keys()].flatMap((slot) => this.activeGans.get(slot) ?? []);
    next.style.position = 'absolute';
    next.style.inset = '0';
    next.style.backgroundColor = 'black';
    next.style.pointerEvents ||= 'none';
    if (previous && duration > 0) previous.append(this.cast);
    const cast = document.createElement('div');
    cast.style.cssText = this.cast.style.cssText;
    cast.append(...characters);
    next.append(cast);
    this.applyGanChanges(next, duration > 0 ? previous : undefined);
    try {
      await this.replaceLayer(next, duration, fan);
    } finally {
      for (const gan of retired) this.removeGan(gan);
      this.cast.replaceChildren(...cast.children);
      if (this.cast.parentElement !== this.stage) this.layers.after(this.cast);
      this.cast.inert = false;
      cast.remove();
      for (const {layer} of this.activeGans.values())
        if (layer.parentElement === next) this.effect.append(layer);
    }
  }

  private shakeAnimation?: Animation;

  endShake(duration: number): void {
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
    this.clearGan();
    this.endLayerEffects();
  }

  endLayerEffects(): void {
    for (const animation of this.layers.getAnimations()) animation.cancel();
    this.recollect(false);
  }

  repPosition(x: number, y: number): void {
    this.message.style.translate = `${x}px ${y}px`;
  }

  cinema(size: number, opacity = 255): void {
    this.stage.style.boxShadow = size
      ? `inset 0 ${size}px rgba(0,0,0,${opacity / 255}), inset 0 -${size}px rgba(0,0,0,${opacity / 255})`
      : '';
    this.layers.style.clipPath = size ? `inset(${size}px 0)` : '';
    this.cast.style.clipPath = this.layers.style.clipPath;
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

  name(value: string): void {
    this.currentName = value;
    this.speaker.textContent = value;
    this.paintMessageText();
  }

  append(value: string): void {
    this.appendRun(value);
  }

  appendRun(value: string) {
    const fragment = {text: value, ruby: this.ruby || undefined};
    const node = document.createTextNode(value);
    let annotation: HTMLElement | undefined;
    this.currentText.push(fragment);
    if (fragment.ruby) {
      const ruby = document.createElement('ruby');
      // Place the reading above its base without increasing the line box.
      ruby.style.cssText = 'position:relative;display:inline-block;white-space:nowrap';
      annotation = document.createElement('rt');
      annotation.style.cssText =
        'position:absolute;bottom:calc(50% + var(--siglus-ruby-offset));left:50%;' +
        'transform:translateX(-50%);line-height:1';
      annotation.style.fontSize = `${this.textMetrics.rubySize}px`;
      annotation.textContent = value ? fragment.ruby : '';
      ruby.append(node, annotation);
      this.text.append(ruby);
      this.ruby = '';
    } else this.text.append(node);
    this.message.hidden = false;
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
    this.portrait.replaceChildren();
    this.currentFace = undefined;
    this.currentFaceCostume = undefined;
    delete this.root.dataset.sprite;
  }

  closeMessage(): void {
    this.clearText();
    this.message.hidden = true;
    this.pageControls();
  }

  saveMessage(): SiglusMessageSnapshot {
    return {
      name: this.currentName,
      text: this.currentText.map((fragment) => ({...fragment})),
      face: this.currentFace,
      faceCostume: this.currentFaceCostume,
      index: this.windowIndex,
      size: Number.parseFloat(this.text.style.fontSize),
      slideTime: this.slideTime,
    };
  }

  async loadMessage(message: SiglusMessageSnapshot): Promise<void> {
    this.clearText();
    this.setMessageSlide(message.slideTime);
    this.selectMessageWindow(message.index);
    this.setTextSize(message.size);
    this.name(message.name);
    if (message.face) await this.face(message.face, message.faceCostume);
    for (const {text, ruby} of message.text) {
      if (ruby) this.annotate(ruby);
      this.append(text);
    }
    this.finishMessageSlide();
  }

  private async prepareFrameActions(): Promise<void> {
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
    for (const [key, value] of this.config) {
      if (!/^WAKU\.000\.BTN\.\d+\.TYPE$/.test(key)) continue;
      const [, type, parameters] = value.split('"');
      if (!type || !Object.hasOwn(labels, type)) continue;
      const id = Number(key.split('.')[3]);
      const prefix = key.slice(0, -4);
      const call = this.config.get(prefix + 'CALL');
      if (type === 'none' && !call) continue;
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
      if (!file || anchor !== 2 || x === undefined || y === undefined) continue;
      const pattern = Number(this.config.get(prefix + 'CUT_NO') ?? 0);
      const frame = await this.graphic(file, pattern);
      const hover = await this.graphic(file, pattern + 1);
      const pressed = await this.graphic(file, pattern + 2);
      const disabled = await this.graphic(file, pattern + 3);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.siglusAction = type;
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
      button.style.cssText = `position:absolute;left:${x}px;bottom:${y - frame.height}px;width:${frame.width}px;height:${frame.height}px;border:0;padding:0;background:none;pointer-events:auto`;
      const canvas = this.node(frame);
      const paint = (graphic: Graphic) => {
        const context = canvas.getContext('2d')!;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(graphic.image, 0, 0);
      };
      button.addEventListener('pointerenter', () => paint(button.disabled ? disabled : hover));
      button.addEventListener('pointerleave', () => paint(button.disabled ? disabled : frame));
      button.addEventListener('pointerdown', () => paint(pressed));
      button.addEventListener('pointerup', () => paint(hover));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.stage.focus({preventScroll: true});
        this.activateFrameAction?.(action);
      });
      button.append(canvas);
      this.frameActions.push({
        action,
        button,
        refresh: () => paint(button.disabled ? disabled : frame),
      });
      this.controls.append(button);
    }
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
    overlay.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;overflow:hidden;pointer-events:auto`;
    overlay.append(this.node(await this.graphic(backdrop)));
    const [left, top, , bottom] = numbers('MSGBK.DISP_MARGIN', [0, 0, 0, 0]);
    const [columns] = numbers('MSGBK.MOJI_CNT', [34]);
    const [letterSpace, lineSpace] = numbers('MSGBK.MOJI_SPACE', [0, 0]);
    const fontSize = Number(this.config.get('MSGBK.MOJI_SIZE') ?? 34);
    const textLeft = Number(this.config.get('MSGBK.MESSAGE_POS') ?? 0);
    const scroll = document.createElement('div');
    scroll.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${textLeft + columns! * (fontSize + letterSpace!)}px;bottom:${bottom}px;overflow:auto;scrollbar-width:none;user-select:text;color:white;font-size:${fontSize}px;line-height:${fontSize + lineSpace!}px;letter-spacing:${letterSpace}px`;
    scroll.style.fontFamily = this.message.style.fontFamily;
    overlay.append(scroll);
    const makeButton = async (kind: string, label: string, action: () => void) => {
      const key = 'MSGBK_ITEM.' + kind + '.';
      const file = quoted(key + 'FILE');
      if (!file) return;
      const [bx, by] = numbers(key + 'POS', [0, 0]);
      const frame = await this.graphic(file);
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.style.cssText = `position:absolute;left:${bx}px;top:${by}px;width:${frame.width}px;height:${frame.height}px;padding:0;border:0;background:none;cursor:pointer`;
      button.append(this.node(frame));
      button.onclick = (event) => {
        event.stopPropagation();
        play(undefined, Number(this.config.get(key + 'SE') ?? -1));
        action();
      };
      return button;
    };
    const divider = quoted('MSGBK.SEPARATOR_FILE');
    const separator = divider && (await this.graphic(divider));
    const replay = await makeButton('KOE_BTN', 'Replay history voice', () => {});
    const replayGraphic = replay
      ? await this.graphic(quoted('MSGBK_ITEM.KOE_BTN.FILE')!)
      : undefined;
    const jump = await makeButton('LOAD_BTN', 'Resume from this message', () => {});
    const jumpGraphic = jump ? await this.graphic(quoted('MSGBK_ITEM.LOAD_BTN.FILE')!) : undefined;
    let closeHistory: (entry?: SiglusHistoryEntry) => void = () => {};
    let focusedRow: HTMLElement | undefined;
    for (const entry of entries) {
      const row = document.createElement('div');
      row.style.cssText = 'position:relative;white-space:pre-wrap;overflow-wrap:anywhere';
      row.dataset.siglusHistoryEntry = '';
      const name = document.createElement('span');
      name.style.cssText = `position:absolute;left:0;width:${textLeft - 64}px;text-align:right`;
      name.textContent = entry.name;
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
      if (replay && replayGraphic && entry.voices.length) {
        const button = replay.cloneNode(true) as HTMLButtonElement;
        button.replaceChildren(this.node(replayGraphic));
        button.onclick = (event) => {
          event.stopPropagation();
          play(entry, Number(this.config.get('MSGBK_ITEM.KOE_BTN.SE') ?? -1));
        };
        body.append(button);
      }
      if (jump && jumpGraphic && canJump(entry)) {
        const button = jump.cloneNode(true) as HTMLButtonElement;
        if (entry === focus) button.dataset.historySelected = '';
        button.replaceChildren(this.node(jumpGraphic));
        button.onclick = (event) => {
          event.stopPropagation();
          play(undefined, Number(this.config.get('MSGBK_ITEM.LOAD_BTN.SE') ?? -1));
          closeHistory(entry);
        };
        body.append(button);
      }
      if (entry === focus) focusedRow = row;
      row.append(name, body);
      if (separator) {
        const line = this.node(separator);
        line.style.position = 'relative';
        row.append(line);
      }
      scroll.append(row);
    }
    const step = (direction: number) => scroll.scrollBy(0, direction * (fontSize + lineSpace!));
    const up = await makeButton('MSG_UP_BTN', 'Scroll history up', () => step(-1));
    const down = await makeButton('MSG_DOWN_BTN', 'Scroll history down', () => step(1));
    if (up) overlay.append(up);
    if (down) overlay.append(down);
    const sliderFile = quoted('MSGBK_ITEM.SLIDER.FILE');
    if (sliderFile) {
      const [sx, from, to] = numbers('MSGBK_ITEM.SLIDER.POS', [0, 0, 0]);
      const thumb = await this.graphic(sliderFile);
      const track = document.createElement('div');
      track.style.cssText = `position:absolute;left:${sx}px;top:${from}px;width:${thumb.width}px;height:${to! - from! + thumb.height}px;touch-action:none`;
      const icon = this.node(thumb);
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
    }
    this.signal.throwIfAborted();
    const close = await makeButton('CLOSE_BTN', 'Close message history', () => closeHistory());
    if (close) overlay.append(close);
    return new Promise<SiglusHistoryEntry | undefined>((resolve, reject) => {
      const finish = (entry?: SiglusHistoryEntry) => {
        this.signal.removeEventListener('abort', abort);
        overlay.remove();
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
    this.controls.hidden = !activate || this.frameIndex !== 0 || this.message.hidden;
    if (this.controls.hidden) return;
    for (const {action, button, refresh} of this.frameActions) {
      const status = state?.(action);
      button.hidden = status === 'hidden';
      button.disabled = status !== 'enabled';
      refresh();
    }
  }

  recollect(active: boolean): void {
    this.stage.style.boxShadow = active ? 'inset 0 0 110px 48px #fff' : '';
    this.layers.style.filter = active ? 'brightness(1.13) saturate(.85)' : '';
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
    this.clearGan();
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
