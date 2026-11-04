import {PcmBufferProcessor} from './mutable-pcm-processor.js';
import type {PcmBufferFormat, PcmBufferRequest} from './mutable-pcm-protocol.js';

// The DOM library describes the main-thread node; these declarations describe the worklet realm.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, constructor: typeof PcmBufferWorklet): void;

class PcmBufferWorklet extends AudioWorkletProcessor {
  private readonly processor: PcmBufferProcessor;
  constructor(options: {processorOptions: {format: PcmBufferFormat}}) {
    super(options);
    this.processor = new PcmBufferProcessor(
      options.processorOptions.format,
      sampleRate,
      (response) => this.port.postMessage(response),
    );
    this.port.onmessage = (event: MessageEvent<PcmBufferRequest>) =>
      this.processor.receive(event.data);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    return this.processor.render(outputs[0]!);
  }
}
registerProcessor('mutable-pcm', PcmBufferWorklet);
