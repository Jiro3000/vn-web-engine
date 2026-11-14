import type {ByteSource} from '../../core/source.js';
import {BrowserWindowDisplayHost} from '../../platform/browser-window-display.js';
import {readSfntFontMetadata} from '../../formats/sfnt.js';
import {G00Image} from '../../formats/siglus/g00.js';

export interface Graphic {
  image: CanvasImageSource;
  width: number;
  height: number;
  x: number;
  y: number;
  centerX: number;
  centerY: number;
}

export interface DrawObject {
  name: string;
  frames: Graphic[];
  x: number;
  y: number;
  visible: boolean;
  layer?: number;
  transparency?: number;
  pattern: number;
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
  movement?: [target: number, duration: number, delay: number, easing: number, start: number];
}

export function orderedObjects(objects: ReadonlyMap<number, DrawObject>): DrawObject[] {
  return [...objects]
    .sort(([a, first], [b, second]) => (first.layer ?? 0) - (second.layer ?? 0) || a - b)
    .map(([, object]) => object);
}

export class SiglusDisplay {
  readonly stage = document.createElement('div');
  private readonly layers = document.createElement('div');
  private readonly cast = document.createElement('div');
  private readonly effect = document.createElement('div');
  private readonly day = document.createElement('div');
  private readonly controls = document.createElement('div');
  private readonly systemLayer = document.createElement('div');
  private readonly message = document.createElement('div');
  private readonly speaker = document.createElement('div');
  private readonly text = document.createElement('div');
  private readonly portrait = document.createElement('div');
  private readonly media = new Map<string, Promise<G00Image>>();
  private readonly hitInsets = new WeakMap<Graphic, string>();
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
  private currentName = '';
  private currentText: {text: string; ruby?: string}[] = [];
  private windowIndex = 0;
  private ruby = '';
  private filter?: HTMLCanvasElement;
  private filterFrame?: Graphic;
  readonly windowDisplay: BrowserWindowDisplayHost;
  private readonly click: (event: MouseEvent) => void;
  private readonly pointerDown: (event: PointerEvent) => void;
  private readonly key: (event: KeyboardEvent) => void;
  private readonly probeConfiguration: boolean;

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
  ) {
    this.probeConfiguration = new URLSearchParams(root.ownerDocument.location.search).has(
      'siglus-probe-configuration',
    );
    root.replaceChildren(this.stage);
    this.stage.style.cssText = 'position:absolute;overflow:hidden;background:#000;color:white';
    this.layers.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.message.style.cssText = 'position:absolute;isolation:isolate;pointer-events:none';
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
    for (const layer of [this.effect, this.day])
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    this.controls.style.cssText =
      'position:absolute;right:28px;bottom:18px;display:flex;gap:8px;z-index:1';
    this.controls.hidden = true;
    this.controls.style.display = 'none';
    this.systemLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2';
    this.stage.append(
      this.layers,
      this.cast,
      this.effect,
      this.day,
      this.message,
      this.controls,
      this.systemLayer,
    );
    this.message.append(this.portrait, this.speaker, this.text);
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
  }

  setScenePaused(paused: boolean): void {
    for (const layer of [this.layers, this.cast, this.effect, this.day])
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
  ): Promise<void> {
    const next = await this.drawObjects(objects, button);
    this.signal.throwIfAborted();
    this.systemLayer.replaceChildren(next);
  }

  clearSystemObjects(): void {
    this.systemLayer.replaceChildren();
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
      for (const entry of metadata?.names ?? [])
        if ((entry.id === 1 || entry.id === 16) && entry.unicode)
          this.fontNames.set(entry.unicode.toLowerCase(), family);
    }
    this.message.style.fontFamily = this.fontFamily(
      this.config.get('CONFIG.FONT.NAME')?.split('"')[1],
    );
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
    const margin = numbers(prefix + 'MESSAGE_MARGIN', index === 0 ? [32, 32] : [0, 0]);
    const [x, y] = numbers(prefix + 'MESSAGE_POS', [362, 124]);
    place(this.text, [x! + margin[0]!, y! + margin[1]!], [size * 32, size * 4.5]);
    this.text.style.fontSize = `${size}px`;
    this.text.style.lineHeight = '1.45';
    this.text.dataset.siglusDialogue = '';
    const namePos = numbers(prefix + 'NAME_MESSAGE_POS', [x!, y! - size]);
    place(this.speaker, namePos, [500, 80]);
    this.speaker.style.fontSize = `${this.config.get(prefix + 'NAME_MOJI_SIZE') ?? 36}px`;
    place(this.portrait, numbers('WAKU.000.FACE.000.POS', [24, 24]), [340, windowSize[1]! - 24]);
    if (this.filter) this.filter.hidden = this.config.get(prefix + 'WAKU_NO') === '-1';
  }
  private readonly loadedFonts: FontFace[] = [];
  private readonly fontNames = new Map<string, string>();

  private fontFamily(name?: string): string {
    const family = name && this.fontNames.get(name.toLowerCase());
    return family ? family + ', sans-serif' : (this.loadedFonts[0]?.family ?? 'sans-serif');
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

  async graphic(name: string, pattern = 0): Promise<Graphic> {
    const resource = await this.resource(name);
    this.signal.throwIfAborted();
    if (resource.type === 3) {
      const image = await createImageBitmap(new Blob([resource.jpeg()], {type: 'image/jpeg'}));
      return {image, width: image.width, height: image.height, x: 0, y: 0, centerX: 0, centerY: 0};
    }
    const {width, height, x, y, centerX, centerY, bgra} = resource.frame(pattern);
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
    return {image, width, height, x, y, centerX, centerY};
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

  private node(graphic: Graphic): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = graphic.width;
    canvas.height = graphic.height;
    canvas.style.cssText = `position:absolute;left:${graphic.x}px;top:${graphic.y}px`;
    canvas.getContext('2d')!.drawImage(graphic.image, 0, 0);
    return canvas;
  }

  private buttonHitInsets(frame: Graphic, canvas: HTMLCanvasElement): string {
    const cached = this.hitInsets.get(frame);
    if (cached) return cached;
    const {width, height} = frame;
    const {data} = canvas.getContext('2d')!.getImageData(0, 0, width, height);
    let left = width,
      right = -1,
      top = height,
      bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!data[(y * width + x) * 4 + 3]) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = y;
      }
    }
    const inset = `inset(${top}px ${width - right - 1}px ${height - bottom - 1}px ${left}px)`;
    this.hitInsets.set(frame, inset);
    return inset;
  }

  async show(
    objects: Iterable<DrawObject>,
    duration: number,
    button: (target: NonNullable<DrawObject['button']>) => void,
  ): Promise<void> {
    const next = await this.drawObjects(objects, button);
    await this.replaceLayer(next, duration);
    this.objectLayer = next;
    this.cast.replaceChildren();
    delete this.root.dataset.cast;
    delete this.root.dataset.background;
    this.root.dataset.phase = next.querySelector('[aria-label="New Game"]') ? 'title' : 'scene';
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
        parent.append(text);
        continue;
      }
      if (!object.name && !object.frames.length) {
        if (object.children) await this.appendChildren(parent, object, button, animate);
        continue;
      }
      if (object.pattern < 0) continue;
      const frame =
        object.frames[object.pattern] ??
        (object.frames[object.pattern] = await this.graphic(object.name, object.pattern));
      const element =
        object.button === undefined
          ? document.createElement('div')
          : document.createElement('button');
      const canvas = this.node(frame);
      canvas.style.left = '0';
      canvas.style.top = '0';
      element.style.cssText = `position:absolute;left:${object.x + frame.x}px;top:${object.y + frame.y}px;width:${frame.width}px;height:${frame.height}px;border:0;padding:0;background:none`;
      this.applyClip(
        element,
        object,
        object.x + frame.x,
        object.y + frame.y,
        frame.width,
        frame.height,
      );
      element.append(canvas);
      parent.append(element);
      if (object.transparency !== undefined)
        element.style.opacity = String(object.transparency / 255);
      if (object.sourceClip) {
        const [x, y, width, height] = object.sourceClip;
        canvas.style.clipPath = `inset(${y}px ${frame.width - x - width}px ${frame.height - y - height}px ${x}px)`;
      }
      if (element instanceof HTMLButtonElement) {
        const target = object.button!;
        if (object.alphaTest !== false)
          element.style.clipPath = this.buttonHitInsets(frame, canvas);
        const role = object.name.split('_').at(-1);
        const supported =
          !object.name.startsWith('__sys_title_btn_') ||
          role === 'start' ||
          role === 'prol' ||
          role === 'exit' ||
          role === 'load' ||
          role === 'music' ||
          (role === 'config' && this.probeConfiguration);
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
      if (object.opacityStarted !== undefined) this.systemObjectOpacity(element, object);
      else if (animate && object.opacity) {
        const [target, time, delay, , start] = object.opacity;
        element.animate(
          {opacity: [start / 255, target / 255]},
          {duration: time, delay, fill: 'both'},
        );
      }
      if (animate && object.movement) {
        const [target, time, delay, , start] = object.movement;
        element.animate(
          {transform: [`translateY(${start}px)`, `translateY(${target}px)`]},
          {duration: time, delay, fill: 'both'},
        );
      }
      if (object.children) await this.appendChildren(parent, object, button, animate);
    }
  }

  private systemObjectOpacity(element: HTMLElement, object: DrawObject): void {
    if (!object.opacity || object.opacityStarted === undefined) return;
    const [target, duration, delay, , start] = object.opacity;
    const elapsed = performance.now() - object.opacityStarted;
    if (duration + delay <= elapsed) return;
    const animation = element.animate(
      {opacity: [start / 255, target / 255]},
      {
        duration,
        delay,
        fill: 'both',
      },
    );
    animation.currentTime = elapsed;
  }

  private async appendChildren(
    parent: HTMLElement,
    object: DrawObject,
    button: (target: NonNullable<DrawObject['button']>) => void,
    animate: boolean,
  ): Promise<void> {
    // Child graphics share their parent's origin without nesting interactive buttons.
    const children = document.createElement('div');
    children.style.cssText = `position:absolute;left:${object.x}px;top:${object.y}px;pointer-events:none`;
    if (object.transparency !== undefined)
      children.style.opacity = String(object.transparency / 255);
    this.systemObjectOpacity(children, object);
    parent.append(children);
    await this.appendObjects(children, orderedObjects(object.children!), button, animate);
  }

  finishWipe(): boolean {
    if (this.wipe?.playState !== 'running') return false;
    this.wipe.finish();
    return true;
  }

  private async replaceLayer(next: HTMLElement, duration: number): Promise<void> {
    this.signal.throwIfAborted();
    const previous = [...this.layers.children];
    for (const child of previous) (child as HTMLElement).inert = true;
    this.layers.append(next);
    this.background = next;
    if (duration > 0) {
      this.wipe = next.animate({opacity: [0, 1]}, {duration});
      await this.wipe.finished;
      this.wipe = undefined;
    }
    for (const child of previous) child.remove();
  }

  async setBackground(
    name: string,
    duration: number,
    pan?: {from: [number, number]; to: [number, number]; time: number; scale?: [number, number]},
  ): Promise<void> {
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
    await this.replaceLayer(next, duration);
    this.root.dataset.background = name;
    this.root.dataset.phase = 'scene';
  }

  async showCast(names: readonly string[], duration: number): Promise<void> {
    const visible = names.filter((name) => name && !name.startsWith('none'));
    const characters = await Promise.all(
      visible.map(async (name, index) => {
        const match = /^(bs\d_)?([a-z]{2})(\d\d)(\d\d)/i.exec(name);
        if (!match) throw new Error(`Invalid Siglus sprite ${name}`);
        const [, prefix = 'bs2_', actor, pose, expression] = match;
        const position = (this.width * (index + 1)) / (visible.length + 1);
        const bodyName = `${prefix}${actor}01${pose}01`;
        const body = await this.graphic(bodyName);
        const face = await this.spriteFace(prefix, actor!, pose!, expression!);
        const layer = document.createElement('div');
        layer.style.cssText = `position:absolute;left:${position}px;top:${Math.round(this.height * 0.32)}px`;
        for (const graphic of [body, face])
          layer.append(this.node({...graphic, x: -graphic.centerX, y: -graphic.centerY}));
        return layer;
      }),
    );
    this.signal.throwIfAborted();
    this.cast.replaceChildren(...characters);
    if (duration > 0 && characters.length) this.cast.animate({opacity: [0, 1]}, {duration});
    this.root.dataset.cast = visible.join(',');
  }

  setTextSize(size: number): void {
    this.text.style.fontSize = `${size}px`;
  }

  centerText(center: boolean): void {
    this.text.style.textAlign = center ? 'center' : '';
  }

  slideMessage(time: number): void {
    for (const animation of this.message.getAnimations()) animation.cancel();
    if (time > 0) this.message.animate({opacity: [0, 1]}, {duration: time});
  }

  async dayCard(index: number): Promise<void> {
    const frames = await Promise.all(
      [0, 1, 2, 9 + index].map((pattern) => this.graphic('__sys_day_frame', pattern)),
    );
    this.day.replaceChildren(...frames.map((graphic) => this.node(graphic)));
  }

  removeDayCard(): void {
    this.day.replaceChildren();
  }

  async lineEffect(color: number): Promise<void> {
    const frame = await this.graphic(color ? 'ef_line02' : 'ef_line01');
    this.effect.replaceChildren(this.node({...frame, x: frame.x - 64, y: frame.y - 60}));
  }

  shake(strength: number): void {
    const delta = 8 + Math.max(0, strength) * 2;
    this.layers.animate(
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
    this.effect.replaceChildren();
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

  async face(code: string): Promise<void> {
    const [actor, pose, expression] = code.match(/../g) ?? [];
    const body = await this.graphic(`bs2_${actor}01${pose}01`);
    const face = await this.spriteFace('bs2_', actor!, pose!, expression!);
    const composite = document.createElement('div');
    composite.style.cssText =
      'position:absolute;left:100px;top:100px;transform:scale(.7);transform-origin:0 0';
    for (const graphic of [body, face])
      composite.append(this.node({...graphic, x: -graphic.centerX, y: -graphic.centerY}));
    this.portrait.replaceChildren(composite);
    this.currentFace = code;
  }

  private spriteFace(prefix: string, actor: string, pose: string, expression: string) {
    const specific = `${prefix}${actor}_f${pose.charAt(0)}1_${expression}`;
    const generic = `${prefix}${actor}_f01_${expression}`;
    return this.graphic(this.files.has(`g00/${specific}.g00`) ? specific : generic);
  }

  name(value: string): void {
    this.currentName = value;
    this.speaker.textContent = value;
  }

  append(value: string): void {
    this.currentText.push({text: value, ruby: this.ruby || undefined});
    if (this.ruby) {
      const ruby = document.createElement('ruby');
      const rt = document.createElement('rt');
      rt.textContent = this.ruby;
      ruby.append(value, rt);
      this.text.append(ruby);
      this.ruby = '';
    } else this.text.append(value);
    this.message.hidden = false;
    if (this.currentFace) this.root.dataset.sprite = this.currentFace;
  }

  annotate(value: string): void {
    this.ruby = value;
  }

  newline(): void {
    this.text.append('\n');
    this.currentText.push({text: '\n'});
  }

  clearText(): void {
    this.currentName = '';
    this.currentText = [];
    this.ruby = '';
    this.speaker.textContent = '';
    this.text.textContent = '';
    this.portrait.replaceChildren();
    this.currentFace = undefined;
    delete this.root.dataset.sprite;
  }

  closeMessage(): void {
    this.clearText();
    this.message.hidden = true;
  }

  saveMessage() {
    return {
      name: this.currentName,
      text: this.currentText,
      face: this.currentFace,
      index: this.windowIndex,
    };
  }

  async loadMessage(message: ReturnType<SiglusDisplay['saveMessage']>): Promise<void> {
    this.clearText();
    this.selectMessageWindow(message.index);
    this.name(message.name);
    if (message.face) await this.face(message.face);
    for (const {text, ruby} of message.text) {
      if (ruby) this.annotate(ruby);
      this.append(text);
    }
  }

  pageControls(save: (() => void) | undefined, load: (() => void) | undefined): void {
    this.controls.replaceChildren();
    for (const [label, action] of [
      ['Save', save],
      ['Load', load],
    ] as const) {
      if (!action) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.siglusAction = label.toLowerCase();
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        action();
        this.stage.focus({preventScroll: true});
      });
      this.controls.append(button);
    }
    this.controls.hidden = !this.controls.childElementCount;
    this.controls.style.display = this.controls.hidden ? 'none' : 'flex';
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
    this.windowDisplay.dispose();
    this.stage.removeEventListener('click', this.click);
    this.stage.removeEventListener('pointerdown', this.pointerDown);
    this.stage.removeEventListener('keydown', this.key);
    this.stage.removeEventListener('keyup', this.key);
    for (const font of this.loadedFonts) document.fonts.delete(font);
    this.stage.remove();
  }
}
