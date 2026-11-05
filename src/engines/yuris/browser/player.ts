import {
  BrowserRasterTextPresentation,
  type BrowserTextMode,
} from '../../../text/browser-raster-text-presentation.js';
import {rasterTextBitmap, visibleRasterText} from '../../../text/raster-text.js';
import {yurisRasterBitmap} from '../vm/raster-text.js';
import {YurisMachine, type YurisMachineHost} from '../vm/machine.js';
import type {YurisProject} from '../../../formats/yuris/ybn.js';
import type {YpfFileSystem} from '../../../formats/yuris/ypf.js';
import {YurisFileType} from '../vm/files.js';
import {decodeCp932, encodeCp932} from '../../../text/cp932.js';
import {BrowserMonochromeFont} from '../../../text/browser-monochrome-font.js';
import {BrowserLoopingSoundDevice} from '../../../audio/browser-looping-sound.js';
import {BrowserAudioContextHost} from '../../../audio/browser-audio-context-host.js';
import {BrowserWindowsMenus} from '../../../platform/windows-menus.js';
import {BrowserLegacyWindows} from '../../../platform/browser-legacy-windows.js';
import {BrowserWindowsMessageBoxHost} from '../../../platform/windows-message-box.js';
import {BrowserWindowsTextInput} from '../../../platform/windows-text-input.js';
import {BrowserWindowsProcessHost} from '../../../platform/browser-windows-process.js';
import {BrowserWindowsDialogPicker} from '../../../platform/windows-picker.js';
import {StoredRegistry} from '../../../platform/registry.js';
import {MemoryStore} from '../../../platform/store.js';
import {LegacyFolder} from '../../../platform/legacy-folder.js';
import {LegacyImageCodec, swap} from '../../../graphics/legacy-image-codec.js';
import {BrowserFileMovie} from '../../../video/browser-file-movie.js';
import {setWindowsVirtualKey} from '../../../input/windows-virtual-keys.js';
import type {YurisLayers} from '../vm/cg.js';

const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const decode = (s: string): string => decodeCp932(bytes(s));
const encode = (s: string): string =>
  Array.from(encodeCp932(s), (c) => String.fromCharCode(c)).join('');

/** Let the browser copy a DOM text selection without feeding Ctrl-skip or C to the VM. */
function copiesSelectedText(event: KeyboardEvent, root: HTMLElement): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  const key = event.key.toLowerCase();
  if (key !== 'c' && key !== 'control' && key !== 'meta') return false;
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const isGameText = (node: Node | null): boolean => {
    const element = node instanceof Element ? node : node?.parentElement;
    const text = element?.closest('[data-game-text]');
    return !!text && root.contains(text);
  };
  return isGameText(selection.anchorNode) && isGameText(selection.focusNode);
}

/** Browser bindings for the native VM. Folder writes stay in its virtual overlay. */
export class YurisBrowserPlayer {
  machine!: YurisMachine;
  private running = false;
  readonly audio = new AudioContext();
  private readonly audioHost: BrowserAudioContextHost;
  readonly device = new BrowserLoopingSoundDevice(this.audio);
  readonly windows: BrowserLegacyWindows;
  readonly movie: BrowserFileMovie;
  readonly menus: BrowserWindowsMenus;
  private readonly textPresentation = new BrowserRasterTextPresentation();
  private textModeChanged = false;
  private readonly codecs = new LegacyImageCodec();
  private readonly fonts = new BrowserMonochromeFont((s, face) =>
    face === 'SimHei' ? new TextDecoder('gbk').decode(bytes(s)) : decode(s),
  );
  private readonly registry = new StoredRegistry(new MemoryStore());
  private readonly contexts: CanvasRenderingContext2D[] = [];
  private readonly frames: ImageData[] = [];
  private readonly frameSources: (Uint8Array | undefined)[] = [];
  private readonly abort = new AbortController();
  private cursorUrl = '';
  private host: YurisMachineHost;
  constructor(
    readonly root: HTMLElement,
    readonly files: YpfFileSystem,
    readonly folder: LegacyFolder,
    readonly stopped: (error?: unknown) => void = () => {},
    readonly trace?: YurisMachineHost['trace'],
    displayOptions?: ConstructorParameters<typeof BrowserLegacyWindows>[4],
  ) {
    this.audioHost = new BrowserAudioContextHost(
      this.audio,
      root.ownerDocument,
      () => {},
      (e) => this.stopped(e),
    );
    // Native WM_ACTIVATE (0x45D738): virtual ShowWindow/SetForegroundWindow events
    // update +0x2A8 before the next background/suspension check (0x41022A).
    this.windows = new BrowserLegacyWindows(
      root,
      decode,
      encode,
      (no, active) => this.machine?.windows.activate(no, active),
      displayOptions,
    );
    this.menus = new BrowserWindowsMenus(root, this.windows.elements);
    this.movie = new BrowserFileMovie(this.windows.elements[0]!, this.audio);
    const win = this.windows,
      codec = this.codecs,
      process = new BrowserWindowsProcessHost();
    const dialogs = new BrowserWindowsMessageBoxHost(root);
    const textInput = new BrowserWindowsTextInput(root);
    const picker = new BrowserWindowsDialogPicker({
      document,
      parent: root,
      files: folder.files,
      mounts: [{native: 'C:\\', mounted: '/'}],
      decodeAnsi: (b) => decodeCp932(b),
      encodeAnsi: encodeCp932,
      isWritable: () => true,
    });
    const methods = <T extends object>(object: T): T =>
      new Proxy(object, {
        get: (target, key) => {
          const v = Reflect.get(target, key);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    const w = methods(win),
      f = methods(folder);
    this.host = {
      menus: {
        setWindowMenu: (no, items, select) => this.menus.setWindowMenu(no, items, select),
        contextMenu: (items, x, y, select) => {
          const rect = this.contexts[0]?.canvas.getBoundingClientRect();
          this.menus.contextMenu(
            items,
            rect ? rect.left + (x / this.machine.screenWidth) * rect.width : x,
            rect ? rect.top + (y / this.machine.screenHeight) * rect.height : y,
            select,
          );
        },
        setTray: (tray, select, activate) =>
          this.menus.setTray(tray, select, () => {
            this.windows.activate(0);
            activate();
          }),
      },
      exists: (path) => folder.existsFile(path) || !!files.find(path),
      read: async (path) => (await folder.readFile(path)) ?? files.read(path),
      archiveNames: () => files.archives.map((a) => a.archive.entries.map((e) => e.key)),
      decodeImage: (data, type) =>
        codec.decode(
          data,
          (
            {
              [YurisFileType.Png]: 'image/png',
              [YurisFileType.Webp]: 'image/webp',
              [YurisFileType.Bmp]: 'image/bmp',
              [YurisFileType.Jpg]: 'image/jpeg',
              [YurisFileType.Gif]: 'image/gif',
            } as Record<number, string>
          )[type] ?? 'application/octet-stream',
          true,
        ),
      encodeImage: codec.encode.bind(codec),
      now: () => performance.now(),
      sleep: (ms) => process.sleep(ms),
      openSoundDevice: () => 0,
      createSoundBuffer: (format) => this.device.createSoundBuffer(format),
      readPads: () =>
        Array.from(navigator.getGamepads?.() ?? [], (p) =>
          p
            ? {
                x: Math.round(((p.axes[0] ?? 0) + 1) * 32767.5),
                y: Math.round(((p.axes[1] ?? 0) + 1) * 32767.5),
                buttons: p.buttons.reduce((v, b, i) => v | (b.pressed ? 1 << i : 0), 0),
              }
            : null,
        ),
      showCursor: (visible) => {
        root.style.cursor = visible ? '' : 'none';
      },
      moveCursor: () => {},
      setCursor: (cursor) => {
        if (typeof cursor === 'number') {
          root.style.cursor = cursor === 0x7f02 ? 'wait' : cursor === 0x7f01 ? 'text' : 'default';
          return;
        }
        const c = new OffscreenCanvas(cursor.width, cursor.height),
          ctx = c.getContext('2d');
        if (!ctx) throw new Error('Cursor rasterization unavailable');
        ctx.putImageData(
          new ImageData(
            new Uint8ClampedArray(swap(cursor.pixels.slice())),
            cursor.width,
            cursor.height,
          ),
          0,
          0,
        );
        void c.convertToBlob().then((blob) => {
          if (this.cursorUrl) URL.revokeObjectURL(this.cursorUrl);
          this.cursorUrl = URL.createObjectURL(blob);
          root.style.cursor = `url("${this.cursorUrl}") ${cursor.hotX} ${cursor.hotY},auto`;
        });
      },
      fontFamilies: () =>
        ['SimHei', 'ＭＳ ゴシック', 'ＭＳ Ｐゴシック', 'ＭＳ 明朝', 'ＭＳ Ｐ明朝', 'Arial'].map(
          (name) => ({
            name: encode(name),
            pitchAndFamily: 0x31,
            script: name === 'SimHei' ? 'CHINESE_GB2312' : 'Japanese',
          }),
        ),
      textOut: this.fonts.textOut.bind(this.fonts),
      createWindow: w.createWindow,
      showWindow: w.showWindow,
      setCaption: w.setCaption,
      setAlpha: w.setAlpha,
      setPosition: w.setPosition,
      position: w.position,
      setClientSize: w.setClientSize,
      clientSize: w.clientSize,
      blockScreenSaver: w.blockScreenSaver,
      desktop: w.desktop,
      setOrder: w.setOrder,
      activate: w.activate,
      setFrame: w.setFrame,
      setFullscreen: w.setFullscreen,
      setMaximized: w.setMaximized,
      flash: w.flash,
      minimized: w.minimized,
      stat: f.stat,
      createDirectory: f.createDirectory,
      copyFile: f.copyFile,
      deleteFile: f.deleteFile,
      removeDirectory: f.removeDirectory,
      readFile: f.readFile,
      writeFile: f.writeFile,
      appendFile: f.appendFile,
      list: f.list,
      setCurrentDirectory: f.setCurrentDirectory,
      shellExecute: (file, parameters) => {
        process.shellExecuteW(
          null,
          'open',
          decode(file),
          parameters ? decode(parameters) : null,
          null,
          1,
        );
      },
      findExecutable: () => '',
      preload: () => {},
      inputDialog: async (text, limit) => {
        const value = window.prompt(decode(text), decode(text));
        return value === null ? null : encode(value.slice(0, limit));
      },
      saveFileDialog: async (name, type) => {
        const result = await picker.selectSaveFile({
          // 0x45A8F8: 32-bit OPENFILENAMEA; callers 0x45A2A2/0x45A307.
          structureSize: 0x4c,
          owner: root,
          filter: bytes(`${type.toUpperCase()} File(*.${type})\0*.${type}\0\0`),
          filterIndex: 0,
          fileCapacity: 0x209,
          filename: bytes(name),
          initialDirectory: null,
          title: null,
          defaultExtension: null,
          flags: 0x180e,
        });
        return result ? String.fromCharCode(...result) : null;
      },
      browseFolder: async (title, initial) =>
        encode(
          (await picker.selectFolder({
            owner: root,
            rootItemIdentifier: 0x11,
            displayNameCapacity: 784,
            title: decode(title),
            flags: 3,
            initialFolder: decode(initial),
            centerOnInitialize: true,
            image: 0,
          })) ?? '',
        ),
      diskFreeSpace: async () =>
        BigInt(
          Math.max(0, (await navigator.storage.estimate()).quota ?? 0) -
            Math.max(0, (await navigator.storage.estimate()).usage ?? 0),
        ),
      windowsDirectory: () => 'C:\\WINDOWS',
      deleteRegistryValue: async (hive, key, name) => {
        try {
          await this.registry.deleteValue({hive, view: '32', path: decode(key)}, decode(name));
          return true;
        } catch {
          return false;
        }
      },
      deleteRegistryKey: async (hive, key) => {
        try {
          await this.registry.deleteKey({hive, view: '32', path: decode(key)});
          return true;
        } catch {
          return false;
        }
      },
      isUserAnAdmin: () => process.isUserAdministrator(),
      createEdit: w.createEdit,
      closeEdit: w.closeEdit,
      setEditText: w.setEditText,
      editText: w.editText,
      focusEdit: w.focusEdit,
      messageBox: (text) => {
        void dialogs.messageBox(text, 'YU-RIS', 0);
      },
      dialogMessage: (text, caption, type) =>
        dialogs.messageBox(decode(text), decode(caption), type),
      moviePlay: (data, rect, gain) => this.movie.play(data, rect, gain),
      moviePosition: (rect) => this.movie.position(rect),
      movieVolume: (gain) => this.movie.volume(gain),
      moviePlaying: () => this.movie.isPlaying(),
      movieStop: () => this.movie.stop(),
      movieClose: () => this.movie.close(),
      dialogInput: async (text, caption, initial, limit) =>
        encode(
          await textInput.show({
            text: decode(text),
            caption: decode(caption),
            value: decode(initial),
            limit,
          }),
        ),
      error: (message, error) => {
        throw new Error(`YU-RIS ${error.code.toString(16)}: ${message}`);
      },
      rasterText: true,
      present: (layers) => this.present(layers),
      trace,
    };
    const signal = this.abort.signal;
    document.addEventListener(
      'keydown',
      (e) => {
        if (
          !this.machine ||
          copiesSelectedText(e, root) ||
          e.target instanceof HTMLInputElement ||
          (e.target instanceof Element &&
            e.target.closest(
              'button, select, textarea, a, [contenteditable], dialog[open], [role=menu], [role=menuitem], [data-windows-tray]',
            ))
        )
          return;
        const key = setWindowsVirtualKey(this.machine.input.keyboard, e, true);
        if (key) this.machine.input.keyDown(key);
        e.preventDefault();
      },
      {signal},
    );
    document.addEventListener(
      'keyup',
      (e) => {
        if (this.machine) setWindowsVirtualKey(this.machine.input.keyboard, e, false);
      },
      {signal},
    );
    window.addEventListener(
      'blur',
      () => {
        this.machine?.input.keyboard.fill(0);
      },
      {signal},
    );
    root.addEventListener('contextmenu', (e) => e.preventDefault(), {signal});
  }
  async start(project: YurisProject): Promise<void> {
    await this.audioHost.resume();
    this.machine = await YurisMachine.create(project, this.host);
    this.running = true;
    void this.loop();
  }
  private async loop(): Promise<void> {
    try {
      while (this.running && !this.machine.quit) {
        await this.menus.waitForMenu();
        if (!this.running) break;
        await this.device.flush();
        await this.machine.frame();
      }
      if (this.running) this.stopped();
    } catch (e) {
      this.running = false;
      this.stopped(e);
    }
  }
  setTextMode(mode: BrowserTextMode): void {
    if (mode === this.textPresentation.textMode) return;
    this.textPresentation.setTextMode(mode);
    this.textModeChanged = true;
  }
  private present(layers: YurisLayers): void {
    const forceText = this.textModeChanged;
    this.textModeChanged = false;
    for (let no = 0; no < 4; no++) {
      const node = layers.windowLayers[no],
        cg = node?.payload;
      if (!node || !cg?.pixels) {
        this.frameSources[no] = undefined;
        continue;
      }
      layers.composeSet(node);
      const sourceChanged = this.frameSources[no] !== cg.pixels;
      if (!cg.dirty && !forceText && !sourceChanged) continue;
      this.frameSources[no] = cg.pixels;
      const dom = this.textPresentation.textMode === 'dom';
      const bitmap = dom ? yurisRasterBitmap(cg.pixels, cg.width, cg.height) : null;
      let context = this.contexts[no];
      if (!context) {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
        const created = canvas.getContext('2d', {alpha: false});
        if (!created) throw new Error('Canvas 2D unavailable');
        context = this.contexts[no] = created;
        canvas.addEventListener(
          'contextrestored',
          () => {
            this.frameSources[no] = undefined;
          },
          {signal: this.abort.signal},
        );
        this.windows.elements[no]?.append(canvas);
        this.bindPointer(canvas);
      }
      const canvas = context.canvas;
      let frame = this.frames[no];
      let fullUpload = forceText || sourceChanged;
      if (!frame || frame.width !== cg.width || frame.height !== cg.height) {
        canvas.width = cg.width;
        canvas.height = cg.height;
        frame = this.frames[no] = new ImageData(cg.width, cg.height);
        fullUpload = true;
      }
      const pixels = bitmap ? rasterTextBitmap(bitmap).storage!.bytes : cg.pixels;
      const rgba = frame.data;
      // StretchDIBits with SRCCOPY (0x45ECF4) treats the composed window as BGRX.
      const source = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
      const output = new DataView(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      const [left, top, right, bottom] = fullUpload ? [0, 0, cg.width - 1, cg.height - 1] : cg.clip;
      let first = cg.height,
        last = -1;
      const stride = cg.width * 4;
      for (let y = top!; y <= bottom!; y++) {
        let changed = 0;
        const row = y * stride,
          end = row + (right! + 1) * 4;
        for (let i = row + left! * 4; i < end; i += 4) {
          const bgra = source.getUint32(i, true);
          const color =
            0xff000000 | ((bgra & 0xff) << 16) | (bgra & 0xff00) | ((bgra >>> 16) & 0xff);
          changed |= color ^ output.getUint32(i, true);
          output.setUint32(i, color, true);
        }
        if (changed) {
          if (first === cg.height) first = y;
          last = y;
        }
      }
      if (fullUpload) context.putImageData(frame, 0, 0);
      else if (last >= first)
        context.putImageData(frame, 0, 0, left!, first, right! - left! + 1, last - first + 1);
      if (bitmap) this.textPresentation.replace(canvas, () => visibleRasterText(bitmap));
    }
  }
  private bindPointer(canvas: HTMLCanvasElement): void {
    const signal = this.abort.signal;
    const point = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const m = this.machine;
      m.input.cursorX = Math.floor(((e.clientX - r.left) * canvas.width) / r.width);
      m.input.cursorY = Math.floor(((e.clientY - r.top) * canvas.height) / r.height);
      m.input.mouseMove();
    };
    canvas.addEventListener('pointermove', point, {signal});
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        point(e);
        const button = [1, 4, 2][e.button] ?? 1;
        this.machine.input.keyboard[button] = 128;
        this.machine.input.buttonDown(button);
        canvas.setPointerCapture(e.pointerId);
      },
      {signal},
    );
    canvas.addEventListener(
      'pointerup',
      (e) => {
        point(e);
        this.machine.input.keyboard[[1, 4, 2][e.button] ?? 1] = 0;
      },
      {signal},
    );
    canvas.addEventListener(
      'wheel',
      (e) => {
        this.machine.input.wheel(-e.deltaY);
        e.preventDefault();
      },
      {signal, passive: false},
    );
  }
  async dispose(): Promise<void> {
    this.running = false;
    this.abort.abort();
    this.menus.dispose();
    this.textPresentation.dispose();
    this.movie.close();
    await this.device.dispose();
    this.audioHost.dispose();
    await this.audio.close();
    this.windows.dispose();
    if (this.cursorUrl) URL.revokeObjectURL(this.cursorUrl);
  }
}
