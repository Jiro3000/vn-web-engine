import type {Ymv} from '../../../formats/yuris/ymv.js';
import {WorkerPool} from '../../../platform/worker-pool.js';
import type {YurisImage} from '../vm/cg.js';
import type {YmvJpegs} from './ymv-decode-worker.js';

const LOOKAHEAD_BYTES = 32 * 1024 * 1024;

/** A short rolling window around the script's requested YSMV frame. */
export class BrowserYmvDecoder {
  private readonly pool = new WorkerPool<YmvJpegs, YurisImage>(
    () => new Worker(new URL('./ymv-decode-worker.js', import.meta.url), {type: 'module'}),
  );
  private readonly prepared = new WeakMap<Ymv, Map<number, Promise<YurisImage | undefined>>>();
  private preparing = 0;

  async decode(movie: Ymv, requested: number): Promise<YurisImage | undefined> {
    if (!this.pool.available || !movie.count) return undefined;
    const index = Math.max(0, Math.min(movie.count - 1, requested));
    let frames = this.prepared.get(movie);
    if (!frames) this.prepared.set(movie, (frames = new Map()));
    // A consumed frame belongs to the CG and may be modified by later CGACT commands.
    const current = frames.get(index) ?? this.submit(movie, index);
    frames.delete(index);
    const ahead = Math.min(
      4,
      movie.count - 1,
      Math.floor(LOOKAHEAD_BYTES / Math.max(1, movie.width * movie.height * 4)),
    );
    for (const next of frames.keys())
      if ((next - index + movie.count) % movie.count > ahead) frames.delete(next);
    for (let offset = 1; offset <= ahead && this.preparing < this.pool.size; offset++) {
      const next = (index + offset) % movie.count;
      if (frames.has(next)) continue;
      this.preparing++;
      frames.set(
        next,
        this.submit(movie, next)
          .catch(() => undefined)
          .finally(() => this.preparing--),
      );
    }
    return current;
  }

  private async submit(movie: Ymv, index: number): Promise<YurisImage | undefined> {
    const {color, alpha: mask} = movie.frame(index);
    const alpha = movie.alphaMode !== 0 ? mask : null;
    // Ymv.frame owns its decrypted buffers, which can be transferred directly.
    const transfer = [color.buffer];
    if (alpha) transfer.push(alpha.buffer);
    return this.pool.run({color, alpha}, transfer);
  }

  dispose(): void {
    this.pool.terminate();
  }
}
