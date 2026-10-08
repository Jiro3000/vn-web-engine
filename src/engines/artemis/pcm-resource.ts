import type {ArtemisWaveFormat} from './wave-source.js';
import type {ArtemisPcmByteSource} from './rolling-sound-buffer.js';

export interface ArtemisPcmResource {
  readonly kind: 'wave' | 'vorbis';
  readonly format: ArtemisWaveFormat;
  readonly bytes: Uint8Array;
  readonly declaredSize: number;
  readonly paired?: ArtemisPcmResource;
}

/** Owns a transferred resource in the PCM worklet; follows encoded-source cursors. */
export class ArtemisPcmCursor implements ArtemisPcmByteSource {
  private position = 0;
  private pairedActive = false;
  private readonly paired: ArtemisPcmCursor | undefined;
  constructor(private readonly resource: ArtemisPcmResource) {
    if (
      !Number.isInteger(resource.declaredSize) ||
      resource.declaredSize < 0 ||
      resource.declaredSize > 0x7fffffff ||
      resource.bytes.length > resource.declaredSize ||
      (resource.kind !== 'wave' && resource.kind !== 'vorbis')
    )
      throw Error('Invalid Artemis PCM resource snapshot');
    this.paired = resource.paired ? new ArtemisPcmCursor(resource.paired) : undefined;
  }
  get format(): ArtemisWaveFormat {
    return this.resource.format;
  }
  read(maxBytes: number): Uint8Array {
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 0x7fffffff)
      throw Error('Invalid Artemis PCM cursor request');
    if (this.resource.kind === 'vorbis' && maxBytes % this.format.blockAlign !== 0)
      throw Error('Unsupported Artemis sub-frame Vorbis cursor read');
    if (maxBytes === 0 && this.resource.kind === 'vorbis') return new Uint8Array();
    if (this.pairedActive) return this.paired!.read(maxBytes);
    const count = Math.min(maxBytes, this.resource.declaredSize - this.position),
      bytes = this.resource.bytes.slice(this.position, this.position + count);
    this.position += bytes.length;
    const atEnd =
      this.resource.kind === 'wave'
        ? this.position >= this.resource.declaredSize
        : bytes.length < maxBytes;
    if (!atEnd || !this.paired) return bytes;
    this.pairedActive = true;
    const next = this.paired.read(maxBytes - bytes.length),
      output = new Uint8Array(bytes.length + next.length);
    output.set(bytes);
    output.set(next, bytes.length);
    return output;
  }
  reset(): void {
    if (this.pairedActive) this.paired!.reset();
    else this.position = 0;
  }
}
