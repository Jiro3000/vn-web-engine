/** Selected browser output profile; these are host primitives, not A0 declarations. */
export interface PcmBufferFormat {
  sampleRate: number;
  channels: number;
  bits: 8 | 16 | 24;
  byteLength: number;
}
export type PcmBufferCommand =
  | {kind: 'write'; offset: number; bytes: Uint8Array; initialized: Uint8Array}
  | {kind: 'notifications'; offsets: readonly number[]}
  | {kind: 'play'; loop: boolean}
  | {kind: 'stop'}
  | {kind: 'seek'; byteOffset: number}
  | {kind: 'volume'; decibels: number}
  | {kind: 'pan'; decibels: number}
  | {kind: 'frequency'; hz: number}
  | {kind: 'status'}
  | {kind: 'dispose'};
export interface PcmBufferStatus {
  playing: boolean;
  byteCursor: number;
  /** Render frames processed by this buffer, including stopped output. */
  renderFrame: number;
}
export interface PcmBufferNotification {
  index: number;
  offset: number;
  renderFrame: number;
}
export interface PcmBufferRequest {
  id: number;
  command: PcmBufferCommand;
}
export type PcmBufferResponse =
  | {kind: 'reply'; id: number; status: PcmBufferStatus}
  | {kind: 'error'; id: number; message: string}
  | {kind: 'events'; events: PcmBufferNotification[]}
  | {kind: 'failure'; message: string};
