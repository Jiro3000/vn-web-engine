import {
  BrowserRasterTextPresentation,
  type BrowserTextMode,
} from '../../../text/browser-raster-text-presentation.js';
import {rasterTextBitmap, visibleRasterText} from '../../../text/raster-text.js';
import {YURIS_SC_ATLAS_FAMILY, yurisRasterBitmap} from '../vm/raster-text.js';
import {domTextFamily, getDomTextStyle} from '../../../text/dom-text-style.js';
import {YurisMachine, type YurisMachineHost} from '../vm/machine.js';
import type {YurisProject} from '../../../formats/yuris/ybn.js';
import type {YpfFileSystem} from '../../../formats/yuris/ypf.js';
import {YurisFileKind, YurisFileType} from '../vm/files.js';
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
import {bgraDisplayFrame} from '../../../graphics/bgra-effects-wasm.js';
import {BrowserFileMovie} from '../../../video/browser-file-movie.js';
import {setWindowsVirtualKey} from '../../../input/windows-virtual-keys.js';
import type {YurisCgNode, YurisLayers} from '../vm/cg.js';
import {YurisIntegerWindow} from './integer-window.js';

const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const decode = (s: string): string => decodeCp932(bytes(s));
const encode = (s: string): string =>
  Array.from(encodeCp932(s), (c) => String.fromCharCode(c)).join('');

const imageMime: Readonly<Partial<Record<YurisFileType, string>>> = {
  [YurisFileType.Png]: 'image/png',
  [YurisFileType.Webp]: 'image/webp',
  [YurisFileType.Bmp]: 'image/bmp',
  [YurisFileType.Jpg]: 'image/jpeg',
  [YurisFileType.Gif]: 'image/gif',
};
const PRELOADED_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** StretchDIBits with SRCCOPY (0x45ECF4) treats the composed window as BGRX. */
function updateBgrx(
  pixels: Uint8Array,
  frame: ImageData,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number {
  const rgba = frame.data;
  const source = new Uint32Array(pixels.buffer, pixels.byteOffset, frame.width * frame.height);
  const output = new Uint32Array(rgba.buffer, rgba.byteOffset, frame.width * frame.height);
  let first = 0,
    last = 0;
  for (let y = top; y <= bottom; y++) {
    let changed = 0;
    const row = y * frame.width;
    for (let i = row + left; i <= row + right; i++) {
      const bgra = source[i]!;
      const color = 0xff000000 | ((bgra & 255) << 16) | (bgra & 0xff00) | ((bgra >>> 16) & 255);
      changed |= color ^ output[i]!;
      output[i] = color;
    }
    if (changed) {
      last = y - top + 1;
      if (first === 0) first = last;
    }
  }
  return first | (last << 16);
}

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
  // The es.SEL library draws option labels over its canvas hit targets.
  private readonly textPresentation = new BrowserRasterTextPresentation(
    (flow) => !flow.startsWith('ES.SEL.'),
  );
  private textModeChanged = false;
  private domFontsReady = false;
  private readonly codecs = new LegacyImageCodec();
  private readonly preloadQueue = new Map<string, string>();
  private readonly preloading = new Set<string>();
  private readonly preloadedArchiveFiles = new Map<string, Uint8Array>();
  private preloadedArchiveBytes = 0;
  private readonly fonts = new BrowserMonochromeFont((s, face) =>
    face === 'SimHei' ? new TextDecoder('gbk').decode(bytes(s)) : decode(s),
  );
  private readonly registry = new StoredRegistry(new MemoryStore());
  private readonly contexts: CanvasRenderingContext2D[] = [];
  private readonly frames: ImageData[] = [];
  private readonly fallbackFrames: ImageData[] = [];
  private readonly packedFrames = new WeakMap<
    Uint8Array,
    {
      frame: ImageData;
      update: NonNullable<ReturnType<typeof bgraDisplayFrame>>['update'];
    } | null
  >();
  private readonly frameSources: (Uint8Array | undefined)[] = [];
  private readonly integerWindow = new YurisIntegerWindow();
  /** The differential harness can force the software path for comparison. */
  useIntegerWindow = true;
  private lastIntegerWindow?: YurisCgNode;
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
      read: (path) => this.readAsset(path),
      archiveNames: () => files.archives.map((a) => a.archive.entries.map((e) => e.key)),
      decodeImage: (data, type, path) =>
        codec.decodeCached(data, imageMime[type] ?? 'application/octet-stream', true, path),
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
      preload: (name) => this.preloadImage(name),
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
  private async readAsset(path: string, preload = false): Promise<Uint8Array> {
    // Loose files and their save overlay retain precedence over the mounted archive.
    const loose = await this.folder.readFile(path);
    if (loose) return loose;
    const cached = this.preloadedArchiveFiles.get(path);
    if (cached) {
      if (!preload) {
        this.preloadedArchiveFiles.delete(path);
        this.preloadedArchiveBytes -= cached.length;
      }
      return cached;
    }
    const bytes = await this.files.read(path);
    if (preload && bytes.length <= PRELOADED_ARCHIVE_BYTES && !this.abort.signal.aborted) {
      for (const [old, contents] of this.preloadedArchiveFiles) {
        if (this.preloadedArchiveBytes + bytes.length <= PRELOADED_ARCHIVE_BYTES) break;
        this.preloadedArchiveFiles.delete(old);
        this.preloadedArchiveBytes -= contents.length;
      }
      this.preloadedArchiveFiles.set(path, bytes.slice());
      this.preloadedArchiveBytes += bytes.length;
    }
    return bytes;
  }
  /** 0x417DDC/0x417EFD: the CGCASH queue resolves and decodes images away from the VM. */
  private preloadImage(name: string): void {
    if (typeof Worker === 'undefined' || this.preloadQueue.size >= 1024) return;
    const file = this.machine.files.resolve(name, YurisFileKind.Image);
    if (!file.found || (file.type !== YurisFileType.Png && file.type !== YurisFileType.Webp))
      return;
    if (!this.preloading.has(file.path)) this.preloadQueue.set(file.path, imageMime[file.type]!);
    this.drainPreloadQueue();
  }
  private drainPreloadQueue(): void {
    while (this.preloading.size < 2 && !this.abort.signal.aborted) {
      const next = this.preloadQueue.entries().next();
      if (next.done) return;
      const [path, mime] = next.value;
      this.preloadQueue.delete(path);
      this.preloading.add(path);
      void this.readAsset(path, true)
        .then((data) => this.codecs.preload(data, mime, path))
        .catch(() => {
          // The foreground loader retains its original error handling and reads current bytes.
        })
        .finally(() => {
          this.preloading.delete(path);
          this.drainPreloadQueue();
        });
    }
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
    if (mode === 'dom' && !this.domFontsReady) {
      this.domFontsReady = true;
      // Resolve system fallback faces when enabling DOM text, before the first dialogue.
      const measure = this.root.ownerDocument.createElement('canvas').getContext('2d');
      if (measure) {
        const style = getDomTextStyle();
        measure.fontKerning = 'none';
        for (const face of [YURIS_SC_ATLAS_FAMILY, 'serif']) {
          const family = style.enabled ? domTextFamily(style, face) : face;
          for (const weight of ['normal', 'bold']) {
            measure.font = `${weight} 32px ${family}`;
            measure.measureText('国日本語，。！“”');
          }
        }
      }
    }
    this.textPresentation.setTextMode(mode);
    this.textModeChanged = true;
  }
  private present(layers: YurisLayers): void {
    const forceText = this.textModeChanged;
    this.textModeChanged = false;
    for (let no = 0; no < 4; no++) {
      const node = layers.windowLayers[no],
        cg = node?.payload;
      if (!node || !cg?.hasPixels) {
        this.frameSources[no] = undefined;
        continue;
      }
      const dom = this.textPresentation.textMode === 'dom';
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
            if (no === 0) this.lastIntegerWindow = undefined;
          },
          {signal: this.abort.signal},
        );
        this.windows.elements[no]?.append(canvas);
        this.bindPointer(canvas);
      }
      const canvas = context.canvas;
      if (no === 0 && this.useIntegerWindow) {
        layers.flushDamage();
        if (
          this.lastIntegerWindow === node &&
          !cg.dirty &&
          !forceText &&
          canvas.width === cg.width &&
          canvas.height === cg.height
        )
          continue;
        if (canvas.width !== cg.width) canvas.width = cg.width;
        if (canvas.height !== cg.height) canvas.height = cg.height;
        const glyphs = this.integerWindow.render(
          layers,
          node,
          context,
          dom,
          this.lastIntegerWindow === node,
        );
        if (glyphs) {
          this.lastIntegerWindow = node;
          this.frameSources[no] = undefined;
          if (dom) this.textPresentation.replace(canvas, () => glyphs);
          continue;
        }
      }
      if (no === 0) this.lastIntegerWindow = undefined;
      layers.composeSet(node);
      const raw = cg.pixels!;
      const sourceChanged = this.frameSources[no] !== raw;
      if (!cg.dirty && !forceText && !sourceChanged) continue;
      this.frameSources[no] = raw;
      const bitmap = dom ? yurisRasterBitmap(raw, cg.width, cg.height) : null;
      const pixels = bitmap ? rasterTextBitmap(bitmap).storage!.bytes : raw;
      let packed = this.packedFrames.get(pixels);
      if (packed === undefined) {
        const conversion = bgraDisplayFrame(pixels, cg.width, cg.height);
        packed = conversion
          ? {
              frame: new ImageData(conversion.pixels, cg.width, cg.height),
              update: conversion.update,
            }
          : null;
        this.packedFrames.set(pixels, packed);
      }
      let frame = packed?.frame ?? this.fallbackFrames[no];
      let fullUpload = forceText || sourceChanged;
      if (!frame || frame.width !== cg.width || frame.height !== cg.height) {
        frame = this.fallbackFrames[no] = new ImageData(cg.width, cg.height);
        packed = null;
      }
      if (canvas.width !== cg.width || canvas.height !== cg.height) {
        canvas.width = cg.width;
        canvas.height = cg.height;
        fullUpload = true;
      }
      if (this.frames[no] !== frame) {
        this.frames[no] = frame;
        fullUpload = true;
      }
      const [left, top, right, bottom] = fullUpload ? [0, 0, cg.width - 1, cg.height - 1] : cg.clip;
      const width = right! - left! + 1;
      const rows = packed
        ? packed.update(left!, top!, width, bottom! - top! + 1)
        : updateBgrx(pixels, frame, left!, top!, right!, bottom!);
      const first = top! + (rows & 0xffff) - 1;
      const last = top! + (rows >>> 16) - 1;
      if (fullUpload) context.putImageData(frame, 0, 0);
      else if (rows) context.putImageData(frame, 0, 0, left!, first, width, last - first + 1);
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
    this.preloadQueue.clear();
    this.preloadedArchiveFiles.clear();
    this.preloadedArchiveBytes = 0;
    this.menus.dispose();
    this.textPresentation.dispose();
    this.integerWindow.dispose();
    this.movie.close();
    await this.device.dispose();
    this.audioHost.dispose();
    await this.audio.close();
    this.windows.dispose();
    if (this.cursorUrl) URL.revokeObjectURL(this.cursorUrl);
  }
}
