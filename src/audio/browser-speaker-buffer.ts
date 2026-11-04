import {createBrowserPcmNode, type BrowserPcmNode} from './browser-pcm-node.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';
import {PcmBufferProcessor} from './mutable-pcm-processor.js';
import type {
  PcmBufferCommand,
  PcmBufferFormat,
  PcmBufferNotification,
  PcmBufferRequest,
  PcmBufferResponse,
  PcmBufferStatus,
} from './mutable-pcm-protocol.js';

/** Actual browser buffer primitive. Every command, including cursor queries, is acknowledged
 * by its audio processor owner. There is no synchronous cursor cache or wall-clock estimate. */
export class BrowserSpeakerBuffer {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {resolve(value: PcmBufferStatus): void; reject(reason: unknown): void}
  >();
  private readonly listeners = new Set<(event: PcmBufferNotification) => void>();
  private failure: Error | null = null;
  private disposed = false;
  private constructor(private readonly node: BrowserPcmNode) {
    node.port.onmessage = (event: MessageEvent<PcmBufferResponse>) => {
      const response = event.data;
      if (response.kind === 'failure') {
        this.fail(new Error(response.message));
        return;
      }
      if (response.kind === 'events') {
        for (const item of response.events) for (const listener of this.listeners) listener(item);
        return;
      }
      const pending = this.pending.get(response.id);
      if (pending === undefined) return;
      this.pending.delete(response.id);
      if (response.kind === 'reply') pending.resolve(response.status);
      else pending.reject(new Error(response.message));
    };
    node.onprocessorerror = () => this.fail(new Error('PCM audio processor failed'));
  }
  static async create(
    context: BaseAudioContext,
    format: PcmBufferFormat,
    destination: AudioNode = context.destination,
  ): Promise<BrowserSpeakerBuffer> {
    if (destination.context !== context)
      throw new Error('PCM audio destination belongs to a different context');
    const node = await createBrowserPcmNode<PcmBufferRequest, PcmBufferResponse>(context, {
      module: new URL('./mutable-pcm-worklet.js', import.meta.url),
      name: 'mutable-pcm',
      channels: Math.max(2, format.channels),
      interpretation: 'speakers',
      processorOptions: {format: {...format}},
      createProcessor: (send) => new PcmBufferProcessor(format, context.sampleRate, send),
    });
    const buffer = new BrowserSpeakerBuffer(node);
    node.connect(destination);
    try {
      await buffer.command({kind: 'status'});
      return buffer;
    } catch (error) {
      node.disconnect();
      node.port.close();
      throw error;
    }
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }
  command(command: PcmBufferCommand): Promise<PcmBufferStatus> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.disposed) return Promise.reject(new Error('Browser PCM speaker buffer is disposed'));
    const id = this.nextId++;
    const finishTiming = beginRuntimeSpan('audio.pcm.command.' + command.kind);
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (status) => {
          finishTiming?.();
          resolve(status);
        },
        reject: (reason: unknown) => {
          finishTiming?.();
          reject(reason);
        },
      });
      const request: PcmBufferRequest = {id, command};
      try {
        this.node.port.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        finishTiming?.();
        reject(error);
      }
    });
  }
  onNotification(listener: (event: PcmBufferNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async dispose(): Promise<void> {
    try {
      await this.command({kind: 'dispose'});
    } finally {
      this.disposed = true;
      this.node.disconnect();
      this.node.port.close();
      this.fail(new Error('Browser PCM speaker buffer is disposed'));
      this.listeners.clear();
    }
  }
}
