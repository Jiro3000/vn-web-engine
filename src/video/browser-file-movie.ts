/** Native child-window movie placement in the owner's logical client coordinates. */
export interface FileMovieRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

/** Browser media services for OS-owned file movies; decoding is independent of any VM. */
export class BrowserFileMovie {
  private video: HTMLVideoElement | null = null;
  private url = '';
  private audio: MediaElementAudioSourceNode | null = null;
  private playing = false;

  constructor(
    private readonly owner: HTMLElement,
    private readonly context: AudioContext,
  ) {}

  async play(data: Uint8Array, rect: FileMovieRect, gain: number): Promise<void> {
    this.close();
    const video = this.owner.ownerDocument.createElement('video');
    this.video = video;
    video.playsInline = true;
    video.controls = false;
    video.preload = 'auto';
    video.style.cssText = 'position:absolute;z-index:1;pointer-events:none;object-fit:fill';
    this.owner.append(video);
    const mime =
      data[4] === 102 && data[5] === 116 && data[6] === 121 && data[7] === 112
        ? 'video/mp4'
        : data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 186
          ? 'video/mpeg'
          : 'application/octet-stream';
    this.url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], {type: mime}));
    video.src = this.url;
    video.addEventListener('ended', () => {
      if (this.video === video) {
        this.playing = false;
        video.hidden = true;
      }
    });
    video.addEventListener('error', () => {
      if (this.video === video) {
        this.playing = false;
        video.hidden = true;
      }
    });
    this.audio = this.context.createMediaElementSource(video);
    this.audio.connect(this.context.destination);
    this.position(rect);
    this.volume(gain);
    // Opening resolves once the media is parsed, as a DirectShow graph is built (YU-RIS
    // VMR9PlayMovie: the file source, splitter and renderer connect, then
    // IMediaControl::Run returns without waiting for the first frame). A later playback
    // failure ends the movie like an error event.
    try {
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
        video.addEventListener('loadedmetadata', () => resolve(), {once: true});
        video.addEventListener('error', () => reject(video.error ?? new Error('movie error')), {
          once: true,
        });
      });
    } catch (error) {
      if (this.video === video) this.close();
      throw error;
    }
    if (this.video !== video) return;
    this.playing = true;
    video.play().catch(() => {
      if (this.video === video) {
        this.playing = false;
        video.hidden = true;
      }
    });
  }

  position(rect: FileMovieRect): void {
    if (!this.video) return;
    const width = rect.clientWidth || 1,
      height = rect.clientHeight || 1;
    Object.assign(this.video.style, {
      left: (rect.x / width) * 100 + '%',
      top: (rect.y / height) * 100 + '%',
      width: (rect.width / width) * 100 + '%',
      height: (rect.height / height) * 100 + '%',
    });
  }

  volume(gain: number): void {
    if (this.video) this.video.volume = Math.min(1, Math.max(0, gain));
  }
  isPlaying(): boolean {
    return this.playing;
  }
  stop(): void {
    this.video?.pause();
    if (this.video) this.video.hidden = true;
    this.playing = false;
  }

  close(): void {
    this.stop();
    this.audio?.disconnect();
    this.audio = null;
    if (this.video) {
      this.video.removeAttribute('src');
      this.video.load();
      this.video.remove();
      this.video = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = '';
    }
  }
}
