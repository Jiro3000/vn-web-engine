import {PcmBufferRenderCore} from './mutable-pcm-core.js';
import type {PcmBufferFormat, PcmBufferRequest, PcmBufferResponse} from './mutable-pcm-protocol.js';

/** One command/render owner for both browser audio hosts. */
export class PcmBufferProcessor {
  private readonly core: PcmBufferRenderCore;
  private closed = false;
  private failure: string | null = null;
  constructor(
    format: PcmBufferFormat,
    outputRate: number,
    private readonly send: (response: PcmBufferResponse) => void,
  ) {
    this.core = new PcmBufferRenderCore(format, outputRate);
  }
  receive({id, command}: PcmBufferRequest): void {
    try {
      if (this.failure !== null) throw new Error(this.failure);
      const status = this.core.command(command);
      if (command.kind === 'dispose') this.closed = true;
      this.events();
      this.send({kind: 'reply', id, status});
    } catch (error) {
      this.send({
        kind: 'error',
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private events(): void {
    const events = this.core.takeNotifications();
    if (events.length !== 0) this.send({kind: 'events', events});
  }
  render(output: Float32Array[]): boolean {
    if (this.closed || this.failure !== null) return false;
    try {
      this.core.render(output);
      this.events();
      return true;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.send({kind: 'failure', message: this.failure});
      return false;
    }
  }
}
