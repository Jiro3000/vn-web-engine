import {BrowserSpeakerBuffer} from './browser-speaker-buffer.js';
import type {PcmBufferCommand} from './mutable-pcm-protocol.js';

export interface LoopingSoundFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  byteLength: number;
}

/** Mutable DirectSound-style buffers consumed by the browser's real PCM device.
 * flush() runs at a host frame boundary; synchronous cursor queries use the last
 * acknowledged render position, never a wall-clock estimate. Commands are ordered
 * even while the worklet is being created, and are posted without waiting for the
 * previous acknowledgement: the processor port handles messages in order, so the
 * status reply of a flush follows every earlier command. */
export class BrowserLoopingSoundDevice {
  private readonly buffers = new Set<BrowserLoopingSoundBuffer>();
  constructor(readonly context: AudioContext) {}
  createSoundBuffer(format: LoopingSoundFormat): BrowserLoopingSoundBuffer {
    if (![8, 16, 24].includes(format.bitsPerSample)) throw new RangeError('Unsupported PCM width');
    const buffer = new BrowserLoopingSoundBuffer(this.context, format);
    this.buffers.add(buffer);
    return buffer;
  }
  async flush(): Promise<void> {
    // Buffers have independent processor ports. Keep each port's command order
    // while collecting cursor acknowledgements for the same host frame together.
    const results = await Promise.allSettled(
      Array.from(this.buffers, async (buffer) => {
        await buffer.flush();
        if (buffer.released) this.buffers.delete(buffer);
      }),
    );
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  async dispose(): Promise<void> {
    for (const buffer of this.buffers) buffer.release();
    await this.flush();
  }
}

export class BrowserLoopingSoundBuffer {
  private readonly buffer: Promise<BrowserSpeakerBuffer>;
  /** The latest posted command; its settlement implies every earlier one settled. */
  private last: Promise<unknown>;
  private cursor = 0;
  private failure: unknown;
  released = false;
  constructor(context: AudioContext, format: LoopingSoundFormat) {
    this.buffer = BrowserSpeakerBuffer.create(context, {
      channels: format.channels,
      sampleRate: format.sampleRate,
      bits: format.bitsPerSample as 8 | 16 | 24,
      byteLength: format.byteLength,
    });
    // DirectSound initializes allocated storage to PCM silence.
    const bytes = new Uint8Array(format.byteLength);
    if (format.bitsPerSample === 8) bytes.fill(128);
    this.last = this.post({
      kind: 'write',
      offset: 0,
      bytes,
      initialized: new Uint8Array(bytes.length).fill(1),
    });
  }
  /** Posts once the worklet exists; `then` callbacks run in registration order. */
  private post(command: PcmBufferCommand): Promise<unknown> {
    return this.track(this.buffer.then((b) => b.command(command)));
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    promise.catch((error: unknown) => {
      this.failure ??= error;
    });
    return promise;
  }
  private command(command: PcmBufferCommand): void {
    this.last = this.post(command);
  }
  playCursor(): number {
    if (this.failure) throw this.failure;
    return this.cursor;
  }
  write(offset: number, bytes: Uint8Array): void {
    this.command({
      kind: 'write',
      offset,
      bytes: bytes.slice(),
      initialized: new Uint8Array(bytes.length).fill(1),
    });
  }
  play(): void {
    this.command({kind: 'play', loop: true});
  }
  stop(): void {
    this.command({kind: 'stop'});
  }
  setVolume(decibels: number): void {
    this.command({kind: 'volume', decibels});
  }
  setPan(decibels: number): void {
    this.command({kind: 'pan', decibels});
  }
  setFrequency(hz: number): void {
    this.command({kind: 'frequency', hz});
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    this.last = this.track(this.buffer.then((b) => b.dispose()));
  }
  async flush(): Promise<void> {
    if (this.released) await this.last;
    else
      this.cursor = (
        await this.track(this.buffer.then((b) => b.command({kind: 'status'})))
      ).byteCursor;
    // An earlier command's failure settled before this reply.
    if (this.failure) throw this.failure;
  }
}
