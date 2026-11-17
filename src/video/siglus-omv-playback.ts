import type {ByteSource} from '../core/source.js';
import {workerSourceOf} from '../core/worker-source.js';
import type {OmvReply, OmvRequest} from './siglus-omv-worker.js';

type OmvInfo = Extract<OmvReply, {duration: number}>;
type OmvFrame = Extract<OmvReply, {index: number}>;

/** Keeps the decoder off the UI thread and requests only the newest due frame. */
export class SiglusOmvPlayback {
  private readonly worker = new Worker(new URL('./siglus-omv-worker.js', import.meta.url), {
    type: 'module',
  });
  private pending?: {resolve: (reply: OmvReply) => void; reject: (error: Error) => void};
  private presented?: {index: number; image: ImageData};
  private startedAt?: number;
  private pausedAt = 0;
  private disposed = false;
  private info!: OmvInfo;
  private error?: Error;
  private readonly connections = new Set<{wake(): void; stop(): void}>();

  private constructor(
    private readonly signal: AbortSignal,
    private loop: boolean,
  ) {
    signal.addEventListener('abort', this.close, {once: true});
    this.worker.onmessage = ({data}: MessageEvent<OmvReply>) => {
      const pending = this.pending;
      this.pending = undefined;
      if ('error' in data) pending?.reject(new Error(data.error));
      else pending?.resolve(data);
    };
    this.worker.onerror = (event) => {
      this.error = new Error(event.message || 'Siglus OMV decoder failed');
      this.pending?.reject(this.error);
      this.pending = undefined;
    };
  }

  static async open(
    source: ByteSource,
    signal: AbortSignal,
    loop: boolean,
  ): Promise<SiglusOmvPlayback> {
    const descriptor = await workerSourceOf(source);
    signal.throwIfAborted();
    const movie = new SiglusOmvPlayback(signal, loop);
    try {
      movie.info = (await movie.request({source: descriptor})) as OmvInfo;
      await movie.decode(0);
      return movie;
    } catch (error) {
      movie.close();
      throw error;
    }
  }

  get width(): number {
    return this.info.width;
  }

  get height(): number {
    return this.info.height;
  }

  get elapsed(): number {
    const time = this.startedAt === undefined ? this.pausedAt : performance.now() - this.startedAt;
    return this.loop ? time % this.info.duration : Math.min(time, this.info.duration);
  }

  get playing(): boolean {
    if (this.error) throw this.error;
    return !this.disposed && this.startedAt !== undefined && this.elapsed < this.info.duration;
  }

  private request(request: OmvRequest): Promise<OmvReply> {
    return new Promise((resolve, reject) => {
      this.pending = {resolve, reject};
      this.worker.postMessage(request);
    });
  }

  private async decode(index: number): Promise<void> {
    const {pixels} = (await this.request({index})) as OmvFrame;
    this.presented = {index, image: new ImageData(pixels, this.width, this.height)};
  }

  play(): void {
    if (this.disposed || this.startedAt !== undefined) return;
    this.startedAt = performance.now() - this.pausedAt;
    for (const {wake} of this.connections) wake();
  }

  pause(): void {
    this.pausedAt = this.elapsed;
    this.startedAt = undefined;
  }

  seek(time: number): void {
    this.pausedAt = Math.max(0, Math.min(time, this.info.duration));
    if (this.startedAt !== undefined) this.startedAt = performance.now() - this.pausedAt;
    for (const {wake} of this.connections) wake();
  }

  async restoreFrame(time: number): Promise<void> {
    this.seek(time);
    const index = this.frameIndex();
    if (this.presented?.index !== index) await this.decode(index);
  }

  private frameIndex(): number {
    return Math.min(
      Math.floor(this.elapsed / this.info.frameTime),
      Math.round(this.info.duration / this.info.frameTime) - 1,
    );
  }

  endLoop(): void {
    const elapsed = this.elapsed;
    this.loop = false;
    this.seek(elapsed);
  }

  connect(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext('2d')!;
    let painted = -1;
    let attached = false;
    let frame: number | undefined;
    const wake = () => {
      frame ??= requestAnimationFrame(update);
    };
    const stop = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      this.connections.delete(connection);
    };
    const connection = {wake, stop};
    const update = () => {
      frame = undefined;
      if (this.disposed || (attached && !canvas.isConnected)) {
        stop();
        return;
      }
      if (!canvas.isConnected) {
        wake();
        return;
      }
      attached = true;
      const index = this.frameIndex();
      if (this.presented && painted !== this.presented.index) {
        context.putImageData(this.presented.image, 0, 0);
        painted = this.presented.index;
      }
      if (!this.error && !this.pending && index !== this.presented?.index)
        void this.decode(index).catch((error) => {
          if (!this.disposed) this.error = error;
        });
      if (!this.error && (this.playing || this.pending || painted !== index)) wake();
    };
    if (this.presented) {
      context.putImageData(this.presented.image, 0, 0);
      painted = this.presented.index;
    }
    this.connections.add(connection);
    wake();
  }

  close = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    for (const {stop} of this.connections) stop();
    this.signal.removeEventListener('abort', this.close);
    this.pending?.reject(new DOMException('Siglus OMV playback closed', 'AbortError'));
    this.pending = undefined;
    this.worker.terminate();
  };
}
