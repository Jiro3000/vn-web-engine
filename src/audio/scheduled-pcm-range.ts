import {scheduleFrameDeadline} from '../core/frame-deadline.js';

export interface PcmRangeSource {
  readonly channels: number;
  readonly rate: number;
  readonly frames: number;
  read(frame: number, count: number, signal?: AbortSignal): Promise<Int16Array>;
}

/** Keep a short PCM window queued on one AudioContext timeline. */
export class ScheduledPcmRange extends EventTarget {
  private readonly controller = new AbortController();
  private readonly nodes = new Set<AudioBufferSourceNode>();
  private cancelRefill?: () => void;
  private stopAt = Infinity;
  private cursor: number;
  private scheduledFrames = 0;
  private scheduleEnded = false;
  private ended = false;

  constructor(
    private readonly context: AudioContext,
    private readonly input: PcmRangeSource,
    private readonly gain: GainNode,
    private readonly startsAt: number,
    private readonly startFrame: number,
    private readonly endFrame: number,
    private readonly loopFrame: number | undefined,
    private readonly firstBuffer: (buffer: AudioBuffer) => void,
    private readonly failed: (error: unknown) => void,
  ) {
    super();
    this.cursor = this.startFrame;
  }

  start(): void {
    void this.fill();
  }

  stop(when = this.context.currentTime): void {
    this.stopAt = Math.min(this.stopAt, when);
    if (this.ended) return;
    for (const node of this.nodes) node.stop(this.stopAt);
    if (this.stopAt <= this.context.currentTime) this.finish();
  }

  disconnect(): void {
    this.finish();
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.controller.abort();
    this.cancelRefill?.();
    for (const node of this.nodes) {
      node.onended = null;
      node.stop();
      node.disconnect();
    }
    this.nodes.clear();
    this.dispatchEvent(new Event('ended'));
  }

  private async fill(): Promise<void> {
    const signal = this.controller.signal;
    const {rate, channels} = this.input;
    try {
      while (!this.scheduleEnded && !signal.aborted) {
        const now = this.context.currentTime;
        const at = this.startsAt + this.scheduledFrames / rate;
        if (at >= this.stopAt || at >= now + 5) break;
        if (this.cursor >= this.endFrame) {
          if (this.loopFrame === undefined) {
            this.scheduleEnded = true;
            break;
          }
          this.cursor = this.loopFrame;
        }
        const count = this.loopFrame === undefined
          ? Math.min(Math.ceil(rate * 1.5), this.endFrame - this.cursor)
          : Math.ceil(rate * 1.5);
        const pcm = await this.read(count, signal);
        if (signal.aborted || at >= this.stopAt) break;
        if (pcm.length !== count * channels) throw new Error('Short PCM range read');
        const skip = Math.max(0, Math.ceil((this.context.currentTime - at) * rate));
        if (skip < count) {
          const buffer = this.context.createBuffer(channels, count, rate);
          for (let channel = 0; channel < channels; channel++) {
            const output = buffer.getChannelData(channel);
            for (let frame = 0; frame < count; frame++) output[frame] = pcm[frame * channels + channel]! / 32768;
          }
          const node = this.context.createBufferSource();
          node.buffer = buffer;
          node.connect(this.gain);
          this.nodes.add(node);
          node.onended = () => {
            this.nodes.delete(node);
            node.disconnect();
            if (this.scheduleEnded && !this.nodes.size) this.finish();
          };
          node.start(at + skip / rate, skip / rate);
          if (Number.isFinite(this.stopAt)) node.stop(this.stopAt);
          if (this.scheduledFrames === 0) this.firstBuffer(buffer);
        }
        this.scheduledFrames += count;
      }
      if (signal.aborted) return;
      if (this.context.currentTime >= this.stopAt || (this.scheduleEnded && !this.nodes.size)) this.finish();
      else if (!this.scheduleEnded || Number.isFinite(this.stopAt))
        this.cancelRefill = scheduleFrameDeadline(250, () => { void this.fill(); });
    } catch (error) {
      if (signal.aborted) return;
      this.failed(error);
      this.finish();
    }
  }

  private async read(count: number, signal: AbortSignal): Promise<Int16Array> {
    const channels = this.input.channels;
    const tail = Math.min(count, this.endFrame - this.cursor);
    const first = await this.input.read(this.cursor, tail, signal);
    this.cursor += tail;
    if (tail === count) return first;

    const loop = this.loopFrame!;
    const rest = count - tail;
    const length = this.endFrame - loop;
    const repeat = await this.input.read(loop, Math.min(rest, length), signal);
    const pcm = new Int16Array(count * channels);
    const offset = tail * channels;
    pcm.set(first);
    pcm.set(repeat, offset);
    for (let filled = repeat.length; offset + filled < pcm.length; filled *= 2) {
      pcm.copyWithin(offset + filled, offset, offset + Math.min(filled, pcm.length - offset - filled));
    }
    this.cursor = loop + rest % length;
    return pcm;
  }
}
