import {isAsf} from '../formats/asf/header.js';
import {playBrowserMediaWithActivation} from './browser-media-activation.js';

/** A movie played over the whole game window by the operating system's media stack
 * (for example a DirectShow graph rendering a loose file), outside the engine renderer. */
export interface FullscreenMovieRequest {
  /** Loose file path as the engine passes it to the media stack. */
  readonly path: string;
  /** Output level in hundredths of a decibel (0 is full volume, -10000 is silence). */
  readonly attenuation: number;
  /** Engine-specific video renderer selector; hosts without a choice ignore it. */
  readonly renderer: number;
}

/** Device owner for fullscreen movies. The host decides how a movie the platform cannot
 * render is handled (play it, notify the user and complete, or wire to the OS); engines
 * only see whether playback started and whether it is still running. */
export interface FullscreenMoviePlayer {
  /** Opens and starts the movie. False is an open or render failure (missing file),
   * which the engine reports natively. */
  play(request: FullscreenMovieRequest): Promise<boolean>;
  /** Started and neither completed nor closed. */
  readonly playing: boolean;
  /** Stops and releases the movie; nothing happens when none is open. */
  close(): void;
}

export interface BrowserFullscreenMovieOptions {
  readonly document: Document;
  /** Element the video covers while it plays. */
  readonly container: HTMLElement;
  /** Loose file read; null when the file does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** The browser cannot decode or play the movie: playback completes immediately. */
  unsupported(path: string, reason: string): void;
}

/** HTMLVideoElement implementation. Containers the browser reports it cannot play (ASF/WMV
 * in most browsers) and decode errors are reported through `unsupported` and complete the
 * movie, so the engine continues as after the movie's end. */
export class BrowserFullscreenMoviePlayer implements FullscreenMoviePlayer {
  private video: HTMLVideoElement | null = null;
  private url = '';
  private abort: AbortController | null = null;
  private generation = 0;
  constructor(private readonly options: BrowserFullscreenMovieOptions) {}
  get playing(): boolean {
    return this.video !== null;
  }
  async play(request: FullscreenMovieRequest): Promise<boolean> {
    this.close();
    const generation = ++this.generation;
    const bytes = await this.options.read(request.path);
    if (generation !== this.generation) return true;
    if (!bytes) return false;
    const type = isAsf(bytes) ? 'video/x-ms-asf' : '';
    const {document, container} = this.options;
    const video = document.createElement('video');
    if (type && !video.canPlayType(type)) {
      this.options.unsupported(request.path, 'container ' + type);
      return true;
    }
    this.url = URL.createObjectURL(new Blob([bytes as BlobPart], type ? {type} : {}));
    video.src = this.url;
    video.volume = Math.min(1, 10 ** (request.attenuation / 2000));
    video.playsInline = true;
    Object.assign(video.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      background: '#000',
    });
    const finish = () => {
      if (this.video === video) this.close();
    };
    video.addEventListener('ended', finish);
    video.addEventListener('error', () => {
      if (this.video !== video) return;
      this.options.unsupported(request.path, video.error?.message || 'decode error');
      finish();
    });
    container.append(video);
    this.video = video;
    const abort = (this.abort = new AbortController());
    playBrowserMediaWithActivation(video, {document, signal: abort.signal}).catch(
      (error: unknown) => {
        if (this.video !== video) return;
        this.options.unsupported(request.path, String(error));
        finish();
      },
    );
    return true;
  }
  close(): void {
    this.generation++;
    const video = this.video;
    this.video = null;
    this.abort?.abort();
    this.abort = null;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = '';
  }
}
