/** Snapshots of Win32 menus at SetMenu / TrackPopupMenu / Shell_NotifyIcon boundaries. */
export interface WindowsMenuItem {
  readonly label: string;
  readonly enabled: boolean;
  readonly checked: boolean;
  readonly code: number;
  readonly children?: readonly WindowsMenuItem[];
}
export interface WindowsTrayIcon {
  readonly width: number;
  readonly height: number;
  /** Straight BGRA. */
  readonly pixels: Uint8Array;
}
export interface WindowsTray {
  readonly label: string;
  readonly icon: WindowsTrayIcon | null;
  readonly items: readonly WindowsMenuItem[];
}
export interface WindowsMenusHost {
  setWindowMenu(
    no: number,
    items: readonly WindowsMenuItem[],
    select: (code: number) => void,
  ): void;
  contextMenu(
    items: readonly WindowsMenuItem[],
    x: number,
    y: number,
    select: (code: number) => void,
  ): void;
  setTray(tray: WindowsTray | null, select: (code: number) => void, activate: () => void): void;
}

/** Browser windows have page menus and a page tray button in place of OS chrome. */
export class BrowserWindowsMenus implements WindowsMenusHost {
  private readonly bars = new Map<number, HTMLElement>();
  private popup: HTMLElement | null = null;
  private closed: Promise<void> = Promise.resolve();
  private resolveClosed: (() => void) | null = null;
  private popupSelect: ((code: number) => void) | null = null;
  private tray: HTMLButtonElement | null = null;
  private readonly abort = new AbortController();
  constructor(
    private readonly root: HTMLElement,
    private readonly windows: readonly HTMLElement[],
  ) {
    root.ownerDocument.addEventListener(
      'pointerdown',
      (event) => {
        if (this.popup && !this.popup.contains(event.target as Node)) this.closePopup();
      },
      {signal: this.abort.signal},
    );
    root.ownerDocument.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.popup) {
          this.closePopup();
          event.stopPropagation();
          event.preventDefault();
        }
      },
      {capture: true, signal: this.abort.signal},
    );
  }
  setWindowMenu(
    no: number,
    items: readonly WindowsMenuItem[],
    select: (code: number) => void,
  ): void {
    this.bars.get(no)?.remove();
    this.bars.delete(no);
    if (!items.length) return;
    const bar = this.root.ownerDocument.createElement('nav');
    bar.setAttribute('aria-label', 'Menu');
    bar.style.cssText = 'display:flex;gap:4px;position:relative;z-index:2000';
    this.fill(bar, items, select);
    this.windows[no]?.prepend(bar);
    this.bars.set(no, bar);
  }
  contextMenu(
    items: readonly WindowsMenuItem[],
    x: number,
    y: number,
    select: (code: number) => void,
  ): void {
    this.closePopup(false);
    const menu = this.root.ownerDocument.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:2147483647;display:flex;flex-direction:column;background:Canvas;color:CanvasText;border:1px solid;padding:4px`;
    this.fill(menu, items, select);
    this.root.append(menu);
    this.popup = menu;
    this.popupSelect = select;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  setTray(tray: WindowsTray | null, select: (code: number) => void, activate: () => void): void {
    this.tray?.remove();
    this.tray = null;
    if (!tray) return;
    const button = this.root.ownerDocument.createElement('button');
    button.type = 'button';
    button.dataset.windowsTray = '';
    button.textContent = tray.label || this.root.ownerDocument.title;
    button.title = tray.label;
    button.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483646';
    button.addEventListener('click', activate);
    button.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.contextMenu(tray.items, e.clientX, e.clientY, select);
    });
    button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.contextMenu(tray.items, e.clientX, e.clientY, select);
    });
    // Keep image data out of URLs and use the same straight-alpha browser canvas boundary.
    if (tray.icon) {
      const {width, height, pixels} = tray.icon,
        c = this.root.ownerDocument.createElement('canvas');
      c.width = width;
      c.height = height;
      const data = new Uint8ClampedArray(pixels);
      for (let i = 0; i < data.length; i += 4) {
        const b = data[i]!;
        data[i] = data[i + 2]!;
        data[i + 2] = b;
      }
      c.getContext('2d')?.putImageData(new ImageData(data, width, height), 0, 0);
      button.prepend(c);
    }
    this.root.append(button);
    this.tray = button;
  }
  private fill(
    parent: HTMLElement,
    items: readonly WindowsMenuItem[],
    select: (code: number) => void,
  ): void {
    for (const item of items) {
      if (!item.label) {
        parent.append(this.root.ownerDocument.createElement('hr'));
        continue;
      }
      const button = this.root.ownerDocument.createElement('button');
      button.type = 'button';
      button.textContent = (item.checked ? '✓ ' : '') + item.label.replace(/&(.)/g, '$1');
      button.disabled = !item.enabled;
      button.setAttribute('role', 'menuitem');
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.children) {
          const r = button.getBoundingClientRect();
          this.contextMenu(item.children, r.left, r.bottom, select);
        } else {
          this.closePopup(false);
          select(item.code);
        }
      });
      parent.append(button);
    }
  }
  /** TrackPopupMenu runs the OS message loop while the caller's game loop is suspended. */
  async waitForMenu(): Promise<void> {
    while (this.popup) await this.closed;
  }
  private closePopup(cancel = true): void {
    const select = this.popupSelect;
    this.popup?.remove();
    this.popup = null;
    this.popupSelect = null;
    this.resolveClosed?.();
    this.resolveClosed = null;
    if (cancel) select?.(0);
  }
  dispose(): void {
    this.abort.abort();
    this.closePopup();
    for (const bar of this.bars.values()) bar.remove();
    this.bars.clear();
    this.tray?.remove();
    this.tray = null;
  }
}
