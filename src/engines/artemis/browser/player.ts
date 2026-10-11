import {decodePng} from '../../../formats/png/decode.js';
import {decodeArtemisPsd} from '../../../formats/artemis/psd.js';
import {objectFitPlacement} from '../../../graphics/object-fit.js';
import {decodeImageOffThread} from '../../../graphics/image-decode-offload.js';
import {decodeOpaqueJpeg} from '../../../graphics/browser-jpeg.js';
import {WebGLDrawTarget} from '../../../graphics/webgl-draw.js';
import {BrowserWindowsDynamicLibraryHost} from '../../../platform/windows-dynamic-library.js';
import {BrowserWindowCaptionHost} from '../../../platform/window-caption.js';
import {BrowserWindowStateHost} from '../../../platform/window-state.js';
import {BrowserTextDialogHost} from '../../../platform/text-dialog.js';
import {FreeTypeWorker} from '../../../text/freetype-worker-client.js';
import {BrowserFullscreenMoviePlayer} from '../../../video/fullscreen-movie.js';
import {createArtemisBrowserSoundVoices} from '../browser-sound-voices.js';
import {BlobSource} from '../../../core/source.js';
import {ArtemisDrawShaderResource} from '../draw-shader.js';
import {compileArtemisShaderPreset} from '../raster-shader.js';
import {ArtemisShaderLibrary} from '../shader-library.js';
import type {ArtemisFiles} from '../files.js';
import {ArtemisFileFonts} from '../file-fonts.js';
import {ArtemisGlyphPainter} from '../glyph-paint-client.js';
import {createArtemisOrdinaryGpuRaster} from '../gpu-raster.js';
import type {ArtemisImageGraphics} from '../image-graphics.js';
import {ArtemisImageLoader, type ArtemisLoadedImage} from '../image-loader.js';
import {artemisPngSurface} from '../png-surface.js';
import {
  ArtemisRuntime,
  type ArtemisFrameInput,
  type ArtemisRuntimeStorage,
  type ArtemisRuntimeTrace,
} from '../runtime.js';
import {ArtemisRuntimeGlyphOwner} from '../runtime-glyphs.js';
import {artemisRuntimeSound} from '../runtime-sound.js';
import {ArtemisSurfaceManager} from '../surface-manager.js';
import {ArtemisTextGlyphs} from '../text-glyphs.js';
import {createArtemisBrowserLayers, type ArtemisBrowserLayers} from './layers.js';
import {ArtemisDomText} from './dom-text.js';
import {
  artemisCurrentBlock,
  artemisJumpNames,
  artemisNameMap,
  artemisNextBlockNames,
  artemisScenarioPath,
  type ArtemisNameMap,
  type ArtemisScenarioJump,
} from '../read-ahead.js';
import type {Lua51} from '../../../core/lua51/runtime.js';
import type {ArtemisReadAheadName} from '../files.js';
import {VirtualKeyState} from '../../../input/virtual-keys.js';
import {beginRuntimeSpan} from '../../../platform/runtime-performance.js';

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
  /** The Direct3D feature level the page reports for its renderer. */
  readonly graphicsFeatureLevel: number;
  /** The page's display host. */
  readonly display: {toggleFullscreen(): void};
  /** Surface manager budget in bytes. */
  readonly surfaceBudget?: bigint;
  /** Diagnostic stream of tags, script steps and owner effects. */
  readonly trace?: ArtemisRuntimeTrace;
  /** While the script waits for input, reads the files of the next scenario block and of
   * the scenario file it enters (default true). */
  readonly readAhead?: boolean;
  diagnostic(message: string): void;
  /** The game stopped with an error. */
  exit(error: unknown): void;
  /** The game closed itself (script run mode 14) after its save writes completed. */
  closed(): void;
}

// Mouse buttons 0..2 as virtual keys; the wheel notches are keys 136 (up) and 137 (down).
const VK_BUTTONS = [1, 4, 2] as const;
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
  private readonly shaders: ArtemisShaderLibrary<ArtemisDrawShaderResource>;
  private runtime: ArtemisRuntime | null = null;
  private layers: ArtemisBrowserLayers | null = null;
  private graphics: ArtemisImageGraphics | null = null;
  private target: WebGLDrawTarget | null = null;
  private readonly origin = performance.now();
  private now = 1;
  private request = 0;
  private settling = false;
  /** The block whose next block was read ahead, and when the block was last checked. */
  private aheadBlock: string | undefined;
  private aheadCandidate: string | undefined;
  private aheadChecked = 0;
  private nameMap: {vm: Lua51; map: ArtemisNameMap} | undefined;
  /** Names of the files that recent scenario jumps show first, by jump. */
  private readonly jumpNames = new Map<string, Promise<ArtemisReadAheadName[]>>();
  private started = false;
  private closed = false;
  /** Pointer position in stage coordinates. */
  private pointer = {x: 0, y: 0};
  /** Diagnostic: the topmost hit layer with a registered pointer event. */
  private hovered: string | null = null;
  /** Diagnostic: the music and effect group gains applied last. */
  private volumes: readonly [number, number] | null = null;
  private readonly keys = new VirtualKeyState();
  private wheel: (136 | 137)[] = [];
  private pointerInside = false;
  private readonly abort = new AbortController();
  /** Selectable text over the stage, created with the stage. */
  private domText: ArtemisDomText | null = null;
  private textMode: 'native' | 'dom' = 'native';
  /** A left press on the DOM text, which becomes a click unless it selects text. */
  private textPress: {x: number; y: number} | null = null;

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
    // Save directory paths read the save storage, as native reads its real files.
    const read = (path: string) => this.runtime?.readSaveDirectoryFile(path) ?? files.read(path);
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
    this.sound = createArtemisBrowserSoundVoices(
      hash,
      {
        read,
        open: async (path) => {
          const saved = this.runtime?.readSaveDirectoryFile(path);
          if (saved === undefined) return files.open(path);
          const bytes = await saved;
          return bytes && new BlobSource(new Blob([bytes.slice().buffer]));
        },
      },
      'nearest-even',
    );
    this.movie = new BrowserFullscreenMoviePlayer({
      document,
      container: this.panel,
      open: (path) => files.openPlain(path),
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
    // Named shaders: the original sources select WebGL ports of their programs.
    this.shaders = new ArtemisShaderLibrary<ArtemisDrawShaderResource>(
      hash,
      read,
      {
        compile: async (_, bytes) => {
          const {kind} = await compileArtemisShaderPreset(hash, bytes);
          const target = this.target;
          if (!target) throw Error('Artemis shader loaded before the stage');
          return {
            shader: new ArtemisDrawShaderResource(hash, kind, (fragment, count) =>
              target.prepareTriangleShader(fragment, count),
            ),
          };
        },
        dispose: (shader) => shader.dispose(),
      },
      (tag, reason, error) =>
        report(`Shader ${reason} failure: ${tag.args.get('file') ?? ''} ${error ?? ''}`.trim()),
    );
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
          shaderPrograms: {bind: (id) => this.shaders.bind(id)},
          glyphs: this.glyphs,
          textProperties: (key) => this.runtime?.textProperties(key),
          report,
        });
        this.layers = owner;
        this.graphics = graphics;
        this.domText = new ArtemisDomText({
          document,
          parent: this.panel,
          canvas: this.canvas,
          width,
          height,
          layers: () =>
            this.layers && this.graphics ? this.graphics.textLayers(this.layers.layers.scene) : [],
          readFont: read,
          hideText: (hidden) => graphics.hideText(hidden),
        });
        this.domText.setEnabled(this.textMode === 'dom');
        return owner;
      },
      glyphs: this.glyphs,
      surfaces: this.surfaces,
      shaders: {dispatch: (tag) => this.shaders.dispatch(tag)},
      screenshots: {
        take: () => {
          if (!this.graphics || !this.layers) throw Error('Artemis takess before the stage');
          this.graphics.takeScreenshot(this.layers.layers.scene);
        },
        read: (width, height) => this.graphics?.readScreenshot(width, height) ?? null,
      },
      sound: artemisRuntimeSound(this.sound, (now) => {
        this.sound.effects.tick(now);
        this.sound.music.tick(now);
      }),
      moviePlayer: this.movie,
      dialogs: new BrowserTextDialogHost(this.panel, () =>
        this.canvas.focus({preventScroll: true}),
      ),
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
      graphicsFeatureLevel: () => options.graphicsFeatureLevel,
      applyVolumes: (music, effect) => {
        this.volumes = [music, effect];
        this.sound.music.setGroupGain(music);
        this.sound.effects.setGroupGain(effect);
      },
      // The click-glyph byte has no browser presentation yet.
      // Touch input arrives as mouse input; there is no touch contact limit.
      setTouchLimit: () => {},
      // Native script error reports (c84b0, c7260, 0x14012d080 level 1): the game logs them
      // and continues. Engine refusals (unsupported behavior) still stop the game.
      reportIncludeError: (path, error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/Unsupported|not implemented|not prepared|budget|cancelled|requires/i.test(message))
          throw error;
        report(`Include error in ${path}: ${message}`);
      },
      reportLuaCallError: ({file, tag, message}) =>
        report(`${file}:${tag.sourceLine} ${new TextDecoder().decode(message)}`),
      reportUnknownTag: ({file, tag, message}) =>
        report(
          `${file}:${tag.sourceLine} ${tag.name}: ${new TextDecoder('shift_jis').decode(message)}`,
        ),
      reportError: (message) => report(new TextDecoder('shift_jis').decode(message)),
      ...(options.trace ? {trace: options.trace} : {}),
    });
    this.open.catch(() => {});
  }
  /** Settles before `start`; a failure reaches `exit` when the game starts. */
  private readonly open: Promise<ArtemisRuntime>;

  /** Run mode, script, resource and wait state for diagnostics. */
  get state(): object | null {
    const runtime = this.runtime;
    return (
      runtime && {
        runMode: runtime.runMode,
        settling: this.settling,
        resourcePending: runtime.resourcePending,
        script: runtime.script.state,
        file: runtime.script.currentFile,
        queuedTags: runtime.script.queuedTags,
        luaCalls: runtime.script.pendingLuaCalls,
        wait: runtime.wait.pending ? runtime.wait.reason : null,
        pointer: this.pointer,
        hovered: this.hovered,
        volumes: this.volumes,
        movie: this.movie.progress,
        videoLayers: this.layers?.videoLayers,
        clickable: this.layers?.eventLayers('click', true),
        text: this.textState(),
      }
    );
  }
  /** Diagnostic counts of the text the stage draws, while DOM text is on. */
  private textState(): object | null {
    if (!this.domText?.active || !this.graphics || !this.layers) return null;
    const layers = this.graphics.textLayers(this.layers.layers.scene);
    return {
      layers: layers.length,
      cells: layers.reduce((count, layer) => count + (layer.text.cells?.().length ?? 0), 0),
      hidden: this.graphics.textHidden,
    };
  }
  /** `dom` adds selectable text over the game text for copying and dictionary extensions;
   * a reader style shows it instead of the stage's glyphs. */
  setTextMode(mode: 'native' | 'dom'): void {
    this.textMode = mode;
    this.domText?.setEnabled(mode === 'dom');
  }
  /** Re-reads the canvas placement; box resizes are observed, `object-fit` changes are not. */
  relayout(): void {
    this.domText?.relayout();
  }
  /** Layer ids at a stage point, topmost first, for diagnostics. */
  hitTest(x: number, y: number): string[] {
    return this.layers && this.graphics
      ? this.graphics.hitTest(this.layers.layers.scene, x, y)
      : [];
  }

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
    // 0x14013cec0 closes the window after the frame that entered run mode 14.
    if (runtime.exited && !this.settling) {
      this.finish(runtime);
      return;
    }
    try {
      this.now = this.clock();
      if (this.settling) runtime.advanceTo(this.now);
      else {
        const hits =
          this.layers && this.graphics
            ? this.graphics.hitTest(this.layers.layers.scene, this.pointer.x, this.pointer.y)
            : [];
        this.hover(hits);
        const input: ArtemisFrameInput = {
          sample: {
            down: this.keys.sample(),
            wheel: this.wheel,
            pointerInside: this.pointerInside,
          },
          pointer: {...this.pointer, hits},
        };
        this.wheel = [];
        runtime.frame(this.now, input);
        if (runtime.resourcePending) this.settle(runtime);
        else if (this.options.readAhead !== false) this.readAhead(runtime);
      }
      if (this.layers && this.graphics) {
        this.graphics.drawStage(this.layers.layers.scene, this.layers.presentation);
        this.domText?.update();
      }
    } catch (error) {
      this.fail(error);
      return;
    }
    this.schedule();
  }
  /** Once the current block has been waiting for input across two checks, reads the files
   * of the next one. */
  private readAhead(runtime: ArtemisRuntime): void {
    const now = performance.now();
    if (now - this.aheadChecked < 250) return;
    this.aheadChecked = now;
    if (runtime.skipping || runtime.script.state !== 'waiting') {
      this.aheadCandidate = undefined;
      return;
    }
    const vm = runtime.lua.vm,
      position = artemisCurrentBlock(vm),
      current = position && `${position.file}\0${position.block}`;
    if (!position || current === this.aheadBlock) return;
    if (current !== this.aheadCandidate) {
      this.aheadCandidate = current;
      return;
    }
    this.aheadBlock = current;
    if (this.nameMap?.vm !== vm) this.nameMap = {vm, map: artemisNameMap(vm)};
    const map = this.nameMap.map;
    const {names, jumps} = artemisNextBlockNames(vm, position.block, map);
    if (!jumps.length) {
      this.options.files.readAhead(names);
      return;
    }
    const paths = jumps.map((jump) => artemisScenarioPath(vm, jump.file));
    void Promise.all(jumps.map((jump, index) => this.jumpTarget(jump, paths[index], 2)))
      .then((found) => {
        if (this.aheadBlock === current) this.options.files.readAhead(names.concat(...found));
      })
      .catch((error: unknown) => this.options.diagnostic(`read-ahead: ${String(error)}`));
  }
  /** Names a scenario jump shows first, following a flow script's own jump `depth` times. */
  private jumpTarget(
    jump: ArtemisScenarioJump,
    path: string | undefined,
    depth: number,
  ): Promise<ArtemisReadAheadName[]> {
    if (!path) return Promise.resolve([]);
    const key = JSON.stringify([path, jump.label, jump.block, jump.count]);
    let found = this.jumpNames.get(key);
    if (!found) {
      const runtime = this.runtime;
      found = (async () => {
        const bytes = await this.options.files.read(path);
        if (!bytes) return [];
        const names: ArtemisReadAheadName[] = [];
        const finish = beginRuntimeSpan('artemis.read-ahead.jump', undefined, 0);
        const further = artemisJumpNames(bytes, path, jump, names, this.nameMap?.map);
        finish?.({names: names.length});
        if (depth > 1 && runtime)
          for (const next of further) {
            const nextPath = artemisScenarioPath(runtime.lua.vm, next.file);
            names.push(...(await this.jumpTarget(next, nextPath, depth - 1)));
          }
        return names;
      })();
      this.jumpNames.set(key, found);
      if (this.jumpNames.size > 4) this.jumpNames.delete(this.jumpNames.keys().next().value!);
    }
    return found;
  }
  /** Resumes the script after each resource operation its tags or Lua calls suspend on. */
  private settle(runtime: ArtemisRuntime): void {
    this.settling = true;
    const finish = beginRuntimeSpan('artemis.resource.settle');
    void (async () => {
      while (runtime.resourcePending && !this.closed) await runtime.settleResource();
      this.settling = false;
      finish?.();
    })().catch((error: unknown) => this.fail(error));
  }
  /** The runtime raises pointer events itself (`ArtemisLayerOwner.updatePointer`); this
   * tracks the layer it would raise rollover for while it accepts input. */
  private hover(hits: readonly string[]): void {
    const {layers, runtime} = this;
    if (!layers || !runtime?.acceptsInput) return;
    const candidates = new Set([
      ...layers.eventLayers('click', true),
      ...layers.eventLayers('rollover', true),
      ...layers.eventLayers('rollout', true),
    ]);
    this.hovered = hits.find((id) => candidates.has(id)) ?? null;
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
    const onText = (event: Event) => !!this.domText?.element.contains(event.target as Node);
    panel.addEventListener(
      'pointermove',
      (event) => {
        if (!game(event) && !onText(event)) return;
        this.pointer = this.point(event);
        this.pointerInside = true;
      },
      {signal},
    );
    // The canvas is the client area of the key 1 and 2 queries.
    canvas.addEventListener(
      'pointerleave',
      () => {
        this.pointerInside = false;
      },
      {signal},
    );
    panel.addEventListener(
      'pointerdown',
      (event) => {
        // A press on the DOM text may select it; it clicks when released in place.
        if (onText(event)) {
          if (event.button === 0) this.textPress = {x: event.clientX, y: event.clientY};
          return;
        }
        if (!game(event)) return;
        this.pointer = this.point(event);
        this.pointerInside = true;
        canvas.focus({preventScroll: true});
        const key = VK_BUTTONS[event.button as 0 | 1 | 2];
        if (key !== undefined) this.keys.press(key);
      },
      {signal},
    );
    // A button released anywhere is up.
    for (const type of ['pointerup', 'pointercancel'] as const)
      this.options.document.addEventListener(
        type,
        (event) => {
          const press = this.textPress;
          if (press && event.button === 0) {
            this.textPress = null;
            if (
              type === 'pointerup' &&
              !this.domText?.selected &&
              Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5
            )
              this.click(1, event);
          }
          const key = VK_BUTTONS[event.button as 0 | 1 | 2];
          if (key !== undefined) this.keys.release(key);
        },
        {signal},
      );
    panel.addEventListener(
      'wheel',
      (event) => {
        if (event.target !== canvas && !onText(event)) return;
        if (event.deltaY) this.wheel.push(event.deltaY < 0 ? 136 : 137);
        event.preventDefault();
      },
      {signal, passive: false},
    );
    panel.addEventListener(
      'contextmenu',
      (event) => {
        if (game(event)) event.preventDefault();
        // The browser menu stays available for copying a selection.
        else if (onText(event) && !this.domText?.selected) {
          event.preventDefault();
          this.click(2, event);
        }
      },
      {signal},
    );
    // Keys reach the game from the canvas or the DOM text, not from dialogs in the panel.
    const forGame = (event: KeyboardEvent) => event.target === canvas || onText(event);
    panel.addEventListener(
      'keydown',
      (event) => {
        if (!forGame(event) || event.repeat || event.metaKey) return;
        // With DOM text, Shift is left to dictionary extensions (Yomichan scans with it)
        // and Control to copying a selection.
        if (this.textMode === 'dom' && event.key === 'Shift') return;
        if ((event.key === 'Control' || event.ctrlKey) && this.domText?.selected) return;
        // Virtual-key codes: KeyboardEvent.keyCode carries the Windows VK for these keys.
        const key = event.keyCode;
        if (key > 0 && key < 256) {
          this.keys.press(key);
          event.preventDefault();
        }
      },
      {signal},
    );
    panel.addEventListener(
      'keyup',
      (event) => {
        if (forGame(event)) this.keys.release(event.keyCode);
      },
      {signal},
    );
    canvas.addEventListener('blur', () => this.keys.releaseAll(), {signal});
  }
  /** A press and release of mouse button `key` (1 or 2) at the event point, sampled by the
   * next frame. */
  private click(key: 1 | 2, event: MouseEvent): void {
    this.pointer = this.point(event);
    this.pointerInside = true;
    this.keys.press(key);
    this.keys.release(key);
  }
  private finish(runtime: ArtemisRuntime): void {
    void runtime.flushSaves().then(
      () => {
        if (this.closed) return;
        this.dispose();
        this.options.closed();
      },
      (error: unknown) => this.fail(error),
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
    this.shaders.close();
    this.glyphs.close();
    void this.glyphBlocks.close().catch(() => {});
    void this.fonts.close().catch(() => {});
    void this.surfaces.close().catch(() => {});
    this.painter.close();
    this.fontWorker.close();
    this.target?.dispose();
    this.domText?.dispose();
    this.panel.remove();
  }
}
