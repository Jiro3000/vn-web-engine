import {decodePng} from '../../../formats/png/decode.js';
import {decodeArtemisPsd} from '../../../formats/artemis/psd.js';
import {objectFitPlacement} from '../../../graphics/object-fit.js';
import {decodeImageOffThread} from '../../../graphics/image-decode-offload.js';
import {decodeOpaqueJpeg} from '../../../graphics/browser-jpeg.js';
import {WebGLDrawTarget} from '../../../graphics/webgl-draw.js';
import {BrowserWindowsDynamicLibraryHost} from '../../../platform/windows-dynamic-library.js';
import {BrowserWindowsMessageBoxHost} from '../../../platform/windows-message-box.js';
import {BrowserWindowCaptionHost} from '../../../platform/window-caption.js';
import {BrowserWindowStateHost} from '../../../platform/window-state.js';
import {MessageBoxTextDialogHost} from '../../../platform/text-dialog.js';
import {FreeTypeWorker} from '../../../text/freetype-worker-client.js';
import {BrowserFullscreenMoviePlayer} from '../../../video/fullscreen-movie.js';
import {createArtemisBrowserSoundVoices} from '../browser-sound-voices.js';
import type {ArtemisFiles} from '../files.js';
import {ArtemisFileFonts} from '../file-fonts.js';
import {ArtemisGlyphPainter} from '../glyph-paint-client.js';
import {createArtemisOrdinaryGpuRaster} from '../gpu-raster.js';
import type {ArtemisImageGraphics} from '../image-graphics.js';
import {ArtemisImageLoader, type ArtemisLoadedImage} from '../image-loader.js';
import type {ArtemisLayerEventType} from '../layer-events.js';
import {artemisPngSurface} from '../png-surface.js';
import {ArtemisRuntime, type ArtemisFrameInput, type ArtemisRuntimeStorage} from '../runtime.js';
import {ArtemisRuntimeGlyphOwner} from '../runtime-glyphs.js';
import {artemisRuntimeSound} from '../runtime-sound.js';
import {ArtemisSurfaceManager} from '../surface-manager.js';
import {ArtemisTextGlyphs} from '../text-glyphs.js';
import {createArtemisBrowserLayers, type ArtemisBrowserLayers} from './layers.js';

export interface ArtemisBrowserPlayerOptions {
  readonly document: Document;
  readonly executableSha256: string;
  /** The mounted installation. */
  readonly files: ArtemisFiles;
  /** Every archive and loose file name ('/'-separated). */
  readonly paths: ReadonlySet<string>;
  readonly storage: ArtemisRuntimeStorage;
  /** The Windows version the page reports to the game; null reports none. */
  readonly windowsVersion: {readonly major: number; readonly minor: number} | null;
  /** The page's display host. */
  readonly display: {toggleFullscreen(): void};
  /** Surface manager budget in bytes. */
  readonly surfaceBudget?: bigint;
  diagnostic(message: string): void;
  /** The game stopped with an error. */
  exit(error: unknown): void;
}

const VK_LBUTTON = 1,
  VK_RBUTTON = 2;
const NO_INPUT: ArtemisFrameInput = {click: false, cancel: false, layerEvents: [], keys: []};
/** The browser's float trigonometry for layer rotation; the native engine uses the CRT
 * sinf/cosf, which agree with correctly rounded results for ordinary angles. */
const trig = (radians: number) => ({
  sin: Math.fround(Math.sin(radians)),
  cos: Math.fround(Math.cos(radians)),
});
const isPng = (bytes: Uint8Array) =>
  [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);

/** Browser panel for an Artemis game: the stage canvas, pointer and keyboard input mapped
 * to stage coordinates, Web Audio output and the runtime's frame loop. */
export class ArtemisBrowserPlayer {
  readonly panel: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly fontWorker = new FreeTypeWorker();
  private readonly painter: ArtemisGlyphPainter;
  private readonly fonts: ArtemisFileFonts;
  private readonly glyphBlocks: ArtemisTextGlyphs;
  private readonly glyphs: ArtemisRuntimeGlyphOwner;
  private readonly surfaces: ArtemisSurfaceManager<object>;
  private readonly sound: ReturnType<typeof createArtemisBrowserSoundVoices>;
  private readonly movie: BrowserFullscreenMoviePlayer;
  private runtime: ArtemisRuntime | null = null;
  private layers: ArtemisBrowserLayers | null = null;
  private graphics: ArtemisImageGraphics | null = null;
  private target: WebGLDrawTarget | null = null;
  private readonly origin = performance.now();
  private now = 1;
  private request = 0;
  private settling = false;
  private started = false;
  private closed = false;
  /** Pointer position in stage coordinates. */
  private pointer = {x: 0, y: 0};
  private hovered: string | null = null;
  private pending: {
    click: boolean;
    cancel: boolean;
    layerEvents: {id: string; type: ArtemisLayerEventType}[];
    keys: number[];
  } = {click: false, cancel: false, layerEvents: [], keys: []};
  private readonly abort = new AbortController();

  constructor(private readonly options: ArtemisBrowserPlayerOptions) {
    const {document, executableSha256: hash, files} = options;
    this.panel = document.createElement('section');
    this.panel.className = 'live-player';
    this.panel.style.position = 'relative';
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Game screen');
    this.canvas.style.cssText = 'touch-action:none;user-select:none;-webkit-touch-callout:none';
    this.panel.append(this.canvas);
    const read = (path: string) => files.read(path);
    this.painter = new ArtemisGlyphPainter(hash);
    this.fonts = new ArtemisFileFonts(hash, {
      readFontFile: read,
      openFontFace: (bytes) => this.fontWorker.open(bytes),
    });
    this.glyphBlocks = new ArtemisTextGlyphs(hash, this.fonts, this.painter);
    this.glyphs = new ArtemisRuntimeGlyphOwner(hash, this.glyphBlocks);
    // Layer images are RGBA texture sources: gray PNGs expand to RGBA here, so their
    // budget counts four bytes per pixel instead of the native one.
    const images = new ArtemisImageLoader(read, [
      {
        extensions: ['png', 'PNG'],
        decode: async (bytes) =>
          isPng(bytes) ? ((await decodeImageOffThread(bytes, 'png')) ?? decodePng(bytes)) : null,
      },
      {
        extensions: ['jpg', 'jpeg', 'JPG', 'JPEG'],
        decode: async (bytes) =>
          bytes[0] === 255 && bytes[1] === 216
            ? ((await decodeImageOffThread(bytes, 'opaque-jpeg')) ?? decodeOpaqueJpeg(bytes))
            : null,
      },
      {
        extensions: ['psd', 'PSD'],
        decode: async (bytes) =>
          [56, 66, 80, 83].every((byte, index) => bytes[index] === byte)
            ? ((await decodeImageOffThread(bytes, 'artemis-psd')) ?? decodeArtemisPsd(bytes))
            : null,
      },
    ]);
    this.surfaces = new ArtemisSurfaceManager<object>(
      hash,
      options.surfaceBudget ?? 512n * 1024n * 1024n,
      {
        createSurface: () => ({}),
        decodeSurface: (_, name) => images.load(name),
        storageBytes: (_, resource: ArtemisLoadedImage) =>
          resource.image.width * resource.image.height * 4,
        disposeSurface: (_, resource) => {
          if (resource) this.target?.invalidate(resource.image);
        },
      },
    );
    this.sound = createArtemisBrowserSoundVoices(hash, read, 'nearest-even');
    const messageBox = new BrowserWindowsMessageBoxHost(this.panel, () =>
      this.canvas.focus({preventScroll: true}),
    );
    this.movie = new BrowserFullscreenMoviePlayer({
      document,
      container: this.panel,
      read: (path) => files.readPlain(path),
      unsupported: (path, reason) =>
        options.diagnostic(`The browser cannot play the movie ${path} (${reason}).`),
    });
    const ruleImages = new ArtemisImageLoader(read, [
      {
        extensions: ['png', 'PNG'],
        decode: async (bytes) => {
          if (!isPng(bytes)) return null;
          const png = (await decodeImageOffThread(bytes, 'png')) ?? (await decodePng(bytes));
          return png && artemisPngSurface(png);
        },
      },
    ]);
    const report = (message: string) => options.diagnostic(message);
    this.bindInput();
    this.open = ArtemisRuntime.open({
      executableSha256: hash,
      files: {
        read,
        readPlain: (path) => files.readPlain(path),
        resolvePath: (path) => files.resolvePath(path),
        setMagicPath: (name, root) => files.setMagicPath(name, root),
        paths: options.paths,
      },
      storage: options.storage,
      randomSeed: Math.floor(Date.now() / 1000),
      createLayers: (host) => {
        const {width, height} = host.stageSize();
        this.target = new WebGLDrawTarget(this.canvas, width, height);
        const {owner, graphics} = createArtemisBrowserLayers({
          executableSha256: hash,
          target: this.target,
          raster: createArtemisOrdinaryGpuRaster(hash, trig),
          images: this.surfaces,
          runMode: host,
          loadRule: async (path) => (await ruleImages.load(path))?.image ?? null,
          readVideoFile: read,
          clock: {now: () => this.now},
          glyphs: this.glyphs,
          textProperties: (key) => this.runtime?.textProperties(key),
          report,
        });
        this.layers = owner;
        this.graphics = graphics;
        return owner;
      },
      glyphs: this.glyphs,
      surfaces: this.surfaces,
      sound: artemisRuntimeSound(this.sound, (now) => {
        this.sound.effects.tick(now);
        this.sound.music.tick(now);
      }),
      moviePlayer: this.movie,
      dialogs: new MessageBoxTextDialogHost(messageBox),
      window: Object.assign(new BrowserWindowStateHost(document, options.display, report), {
        // The page keeps its stage size across display modes.
        displayModeChanged: () => {},
      }),
      caption: new BrowserWindowCaptionHost(document),
      cursor: {
        setVisible: (visible) => {
          this.canvas.style.cursor = visible ? '' : 'none';
        },
        // A page cannot move the system pointer; the game's pointer position follows.
        setPosition: (left, top) => {
          this.pointer = {x: left, y: top};
        },
      },
      pointer: {readPointerPosition: () => this.pointer},
      dynamicLibraries: new BrowserWindowsDynamicLibraryHost(),
      windowsVersion: () => options.windowsVersion,
      applyVolumes: (music, effect) => {
        this.sound.music.setGroupGain(music);
        this.sound.effects.setGroupGain(effect);
      },
      // The click-glyph byte has no browser presentation yet.
      setLayerByte16c: () => {},
      // Touch input arrives as mouse input; there is no touch contact limit.
      setTouchLimit: () => {},
      reportError: (message) => report(new TextDecoder('shift_jis').decode(message)),
    });
    this.open.catch(() => {});
  }
  /** Settles before `start`; a failure reaches `exit` when the game starts. */
  private readonly open: Promise<ArtemisRuntime>;

  /** Call from the Play button handler so audio starts inside the user gesture. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.sound.unlock().catch(() => {});
    this.canvas.focus({preventScroll: true});
    void (async () => {
      const runtime = (this.runtime = await this.open);
      if (this.closed) return;
      this.now = this.clock();
      runtime.advanceTo(this.now);
      await runtime.boot();
      if (runtime.resourcePending) this.settle(runtime);
      this.schedule();
    })().catch((error: unknown) => this.fail(error));
  }

  /** timeGetTime: milliseconds of the page clock, wrapping at 2^32 and never zero. */
  private clock(): number {
    return (Math.floor(performance.now() - this.origin) + 1) >>> 0 || 1;
  }
  private schedule(): void {
    if (!this.closed && !this.request)
      this.request = requestAnimationFrame(() => {
        this.request = 0;
        this.frame();
      });
  }
  private frame(): void {
    const runtime = this.runtime;
    if (this.closed || !runtime) return;
    try {
      this.now = this.clock();
      if (this.settling) runtime.advanceTo(this.now);
      else {
        this.hover();
        const input = this.pending;
        this.pending = {click: false, cancel: false, layerEvents: [], keys: []};
        runtime.frame(this.now, input);
        if (runtime.resourcePending) this.settle(runtime);
      }
      if (this.layers && this.graphics)
        this.graphics.drawStage(this.layers.layers.scene, this.layers.presentation);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.schedule();
  }
  /** Resumes the script after each resource operation its tags or Lua calls suspend on. */
  private settle(runtime: ArtemisRuntime): void {
    this.settling = true;
    void (async () => {
      while (runtime.resourcePending && !this.closed) await runtime.settleResource();
      this.settling = false;
    })().catch((error: unknown) => this.fail(error));
  }
  /** Rollover and rollout follow the topmost hit layer with a registered pointer event. */
  private hover(): void {
    const {layers, graphics} = this;
    if (!layers || !graphics) return;
    const candidates = new Set([
      ...layers.eventLayers('click', true),
      ...layers.eventLayers('rollover', true),
      ...layers.eventLayers('rollout', true),
    ]);
    const hit =
      graphics
        .hitTest(layers.layers.scene, this.pointer.x, this.pointer.y)
        .find((id) => candidates.has(id)) ?? null;
    if (hit === this.hovered) return;
    const previous = this.hovered;
    this.hovered = hit;
    if (previous !== null && layers.eventLayers('rollout', true).includes(previous))
      this.pending.layerEvents.push({id: previous, type: 'rollout'});
    if (hit !== null && layers.eventLayers('rollover', true).includes(hit))
      this.pending.layerEvents.push({id: hit, type: 'rollover'});
  }
  private point(event: MouseEvent): {x: number; y: number} {
    const {canvas} = this;
    const rect = canvas.getBoundingClientRect();
    const fit = objectFitPlacement(canvas, rect, canvas.width, canvas.height);
    const scaleX = fit.scaleX || 1,
      scaleY = fit.scaleY || 1;
    return {
      x: Math.floor((event.clientX - rect.left - fit.offsetX) / scaleX),
      y: Math.floor((event.clientY - rect.top - fit.offsetY) / scaleY),
    };
  }
  private bindInput(): void {
    const {canvas, panel} = this,
      signal = this.abort.signal;
    // The game screen and a fullscreen movie over it take input; dialogs keep their own.
    const game = (event: Event) =>
      event.target === canvas || event.target instanceof HTMLVideoElement;
    panel.addEventListener(
      'pointermove',
      (event) => {
        if (game(event)) this.pointer = this.point(event);
      },
      {signal},
    );
    panel.addEventListener(
      'pointerdown',
      (event) => {
        if (!game(event)) return;
        this.pointer = this.point(event);
        canvas.focus({preventScroll: true});
        if (event.button === 0) {
          this.pending.click = true;
          this.pending.keys.push(VK_LBUTTON);
          this.hover();
          if (
            this.hovered !== null &&
            this.layers?.eventLayers('click', true).includes(this.hovered)
          )
            this.pending.layerEvents.push({id: this.hovered, type: 'click'});
        } else if (event.button === 2) {
          this.pending.cancel = true;
          this.pending.keys.push(VK_RBUTTON);
        }
      },
      {signal},
    );
    panel.addEventListener(
      'contextmenu',
      (event) => {
        if (game(event)) event.preventDefault();
      },
      {signal},
    );
    canvas.addEventListener(
      'keydown',
      (event) => {
        if (event.repeat || event.altKey || event.metaKey) return;
        // Virtual-key codes: KeyboardEvent.keyCode carries the Windows VK for these keys.
        const key = event.keyCode;
        if (key > 0 && key < 256) {
          this.pending.keys.push(key);
          event.preventDefault();
        }
      },
      {signal},
    );
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.dispose();
    this.options.exit(error);
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.request) cancelAnimationFrame(this.request);
    this.abort.abort();
    this.movie.close();
    this.runtime?.close();
    this.sound.close();
    this.glyphs.close();
    void this.glyphBlocks.close().catch(() => {});
    void this.fonts.close().catch(() => {});
    void this.surfaces.close().catch(() => {});
    this.painter.close();
    this.fontWorker.close();
    this.target?.dispose();
    this.panel.remove();
  }
}
