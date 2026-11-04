import {BrowserWindowDisplayHost, browserDesktopSize} from './browser-window-display.js';

/** Window-shaped page services. Native geometry is retained independently of CSS scaling. */
export class BrowserLegacyWindows {
  readonly elements: HTMLElement[] = [];
  private readonly states: {
    x: number;
    y: number;
    width: number;
    height: number;
    minimized: boolean;
    caption: string;
  }[] = [];
  readonly display: BrowserWindowDisplayHost;
  private wake: WakeLockSentinel | null = null;
  private edit: HTMLInputElement | null = null;
  constructor(
    readonly root: HTMLElement,
    private readonly decode: (s: string) => string,
    private readonly encode: (s: string) => string,
  ) {
    const main = document.createElement('div');
    main.style.cssText = 'position:relative;transform-origin:0 0';
    root.append(main);
    this.elements[0] = main;
    this.states[0] = {x: 0, y: 0, width: 1280, height: 720, minimized: false, caption: ''};
    this.display = new BrowserWindowDisplayHost(root, root, main);
  }
  createWindow(no: number, caption: string, width: number, height: number): boolean {
    if (!this.elements[no]) {
      const e = document.createElement('div');
      e.style.cssText = 'position:absolute;transform-origin:0 0';
      this.elements[no] = e;
      this.root.append(e);
    }
    this.states[no] = {x: 0, y: 0, width, height, minimized: false, caption};
    this.setClientSize(no, width, height);
    return true;
  }
  showWindow(no: number, state: 'hide' | 'show' | 'minimize' | 'restore'): void {
    const e = this.elements[no];
    if (!e) return;
    e.hidden = state === 'hide' || state === 'minimize';
    this.states[no]!.minimized = state === 'minimize';
  }
  setCaption(no: number, caption: string): void {
    this.states[no]!.caption = caption;
    this.elements[no]?.setAttribute('aria-label', this.decode(caption));
    if (no === 0) document.title = this.decode(caption);
  }
  setAlpha(no: number, alpha: number): void {
    if (this.elements[no]) this.elements[no]!.style.opacity = String(alpha / 255);
  }
  setPosition(no: number, x: number, y: number): void {
    Object.assign(this.states[no]!, {x, y});
    if (no === 0) this.display.setPosition(x, y);
    else Object.assign(this.elements[no]!.style, {left: x + 'px', top: y + 'px'});
  }
  position(no: number): {x: number; y: number} {
    const {x, y} = this.states[no]!;
    return {x, y};
  }
  setClientSize(no: number, width: number, height: number): void {
    Object.assign(this.states[no]!, {width, height});
    if (no === 0) this.display.configure({width, height, fullscreen: this.display.isExpanded});
    else Object.assign(this.elements[no]!.style, {width: width + 'px', height: height + 'px'});
  }
  clientSize(no: number): {width: number; height: number} {
    const {width, height} = this.states[no]!;
    return {width, height};
  }
  blockScreenSaver(blocked: boolean): void {
    if (blocked && navigator.wakeLock)
      void navigator.wakeLock
        .request('screen')
        .then((w) => {
          this.wake = w;
        })
        .catch(() => {});
    else if (this.wake) {
      void this.wake.release();
      this.wake = null;
    }
  }
  desktop(): {width: number; height: number; bitsPerPixel: number} {
    const [width, height] = browserDesktopSize(window);
    return {width, height, bitsPerPixel: 32};
  }
  setOrder(no: number, z: number): void {
    if (this.elements[no])
      this.elements[no]!.style.zIndex = String(z === 1 ? 1000 : z === 2 ? -1 : z === 3 ? 0 : 1);
  }
  activate(no: number): void {
    this.elements[no]?.focus();
  }
  setFrame(no: number, maximizeBox: boolean, resizable: boolean): void {
    this.elements[no]?.toggleAttribute('data-resizable', resizable);
    this.elements[no]?.toggleAttribute('data-maximize', maximizeBox);
  }
  setFullscreen(value: boolean): void {
    this.display.setFullscreen(value);
  }
  setMaximized(no: number, value: boolean): void {
    if (no === 0) this.display.setFullscreen(value);
  }
  flash(no: number, count: number, timeout: number): void {
    this.elements[no]?.animate([{opacity: 1}, {opacity: 0.5}, {opacity: 1}], {
      duration: Math.max(100, timeout),
      iterations: Math.max(1, count),
    });
  }
  minimized(no: number): boolean {
    return this.states[no]?.minimized ?? false;
  }
  createEdit(text: string, x: number, y: number, width: number, height: number): void {
    this.closeEdit();
    const e = (this.edit = document.createElement('input'));
    e.value = this.decode(text);
    e.maxLength = 256;
    e.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;font:14px sans-serif;z-index:2147483647`;
    this.elements[0]!.append(e);
  }
  closeEdit(): void {
    this.edit?.remove();
    this.edit = null;
  }
  setEditText(text: string): void {
    if (this.edit) this.edit.value = this.decode(text);
  }
  editText(): string {
    return this.encode(this.edit?.value ?? '');
  }
  focusEdit(focused: boolean): void {
    if (focused) this.edit?.focus();
    else this.edit?.blur();
  }
  dispose(): void {
    this.closeEdit();
    this.blockScreenSaver(false);
    this.display.dispose();
    for (const e of this.elements) e.remove();
  }
}
