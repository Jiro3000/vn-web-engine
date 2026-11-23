import {byteDataView, checkRange} from '../../core/binary.js';
import {unpackSiglusLz, xorCycle} from './compression.js';
import {
  sceneXor,
  configXor,
  keySeed,
  lastSourceXor,
  nameSourceXor,
  maskSourceXor,
  easySourceXor,
} from './tables.js';

const utf16 = new TextDecoder('utf-16le', {ignoreBOM: true});

function span(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  checkRange(bytes.length, offset, length);
  return bytes.subarray(offset, offset + length);
}

function words(bytes: Uint8Array, offset: number, count: number): number[] {
  const view = byteDataView(span(bytes, offset, count * 4));
  return Array.from({length: count}, (_, i) => view.getUint32(i * 4, true));
}

function stringTable(
  bytes: Uint8Array,
  table: number,
  count: number,
  start: number,
  multiplier = 0,
): string[] {
  const index = words(bytes, table, count * 2);
  return Array.from({length: count}, (_, i) => {
    const data = span(bytes, start + index[i * 2]! * 2, index[i * 2 + 1]! * 2);
    if (!multiplier) return utf16.decode(data);
    const decoded = data.slice();
    const view = byteDataView(decoded);
    const key = (i * multiplier) & 0xffff;
    for (let p = 0; p < decoded.length; p += 2)
      view.setUint16(p, view.getUint16(p, true) ^ key, true);
    return utf16.decode(decoded);
  });
}

/** The optional original-source section contains a size table followed by named chunks. */
function sourceChunk(bytes: Uint8Array, wanted?: string): Uint8Array | undefined {
  const header = span(bytes, 0, 76).slice();
  xorCycle(header, lastSourceXor, 13);
  const view = byteDataView(header);
  if (view.getUint32(0, true) !== 1) throw new Error('Unsupported Siglus source chunk');
  const nameSize = view.getUint32(72, true);
  if (nameSize % 2) throw new Error('Invalid Siglus source name');
  const name = span(bytes, 76, nameSize).slice();
  xorCycle(name, lastSourceXor, 89);
  xorCycle(name, nameSourceXor, 59);
  if (wanted && utf16.decode(name).split(/[\\/]/).at(-1) !== wanted) return;
  const size = view.getUint32(68, true);
  const maskWidth = 16 + (view.getUint32(24, true) % 16);
  const maskHeight = 16 + (view.getUint32(36, true) % 16);
  const width = 32 + (view.getUint32(40, true) % 32);
  const half = Math.ceil(size / 2);
  const plane = 4 * width * Math.ceil(half / (4 * width));
  const payload = span(bytes, 76 + nameSize, plane * 2).slice();
  xorCycle(payload, lastSourceXor, 89 + nameSize);
  const packed = new Uint8Array(size);
  const mask = new Uint8Array(maskWidth * maskHeight);
  for (let i = 0; i < mask.length; i++)
    mask[i] = maskSourceXor[(96 + i) % maskSourceXor.length]! ^ header[4 + ((11 + i) % 16) * 4]!;
  for (let i = 0; i < size; i++) {
    const second = i >= half;
    const pos = second ? i - half : i;
    const pixel = pos >>> 2;
    const x = ((pixel % width) - (111 % maskWidth) + maskWidth) % maskWidth;
    const y = (Math.floor(pixel / width) - (37 % maskHeight) + maskHeight) % maskHeight;
    const swapped = mask[y * maskWidth + x]! < 128;
    packed[i] = payload[pos + (second !== swapped ? plane : 0)]!;
  }
  xorCycle(packed, easySourceXor, 173);
  return unpackSiglusLz(packed);
}

function embeddedKey(bytes: Uint8Array, tail: number, headerSize: number): Uint8Array {
  const sizes = sourceChunk(span(bytes, tail, headerSize))!;
  let offset = tail + headerSize;
  for (const size of words(sizes, 0, sizes.length / 4)) {
    const entry = sourceChunk(span(bytes, offset, size), '暗号.dat');
    if (entry) {
      // The key is mixed from the original CP932 byte sequence.
      const end = entry.findIndex((byte) => byte === 0 || byte === 10 || byte === 13);
      const password = entry.subarray(0, end < 0 ? entry.length : end);
      if (password.length < 8) break;
      const key = keySeed.slice();
      for (let i = 0; i < Math.max(key.length, password.length); i++)
        key[i % key.length] = key[i % key.length]! ^ password[i % password.length]!;
      return key;
    }
    offset += size;
  }
  throw new Error('Scene.pck has no usable embedded Siglus key');
}

export interface SiglusScene {
  name: string;
  code: Uint8Array;
  strings: string[];
  labels: number[];
  entries: number[];
  properties: number[];
  commands: number[];
  commandNames: string[];
}

export class SiglusGameConfig extends Map<string, string> {
  constructor(readonly nameEntries: readonly string[]) {
    super();
  }
}

export class SiglusScenePack {
  readonly commandNames: string[];
  readonly commandScenes: number[];
  readonly sceneNames: string[];
  readonly propertyNames: string[];
  readonly properties: number[];
  private readonly entries: number[];
  private readonly key?: Uint8Array;
  private readonly sceneBase: number;
  private readonly scenes = new Map<string, SiglusScene>();

  constructor(private readonly bytes: Uint8Array) {
    const header = words(bytes, 0, 23);
    if (header[0] !== 92 || header[14] !== header[18]) throw new Error('Invalid Siglus Scene.pck');
    this.properties = words(bytes, header[1]!, header[2]! * 2);
    this.propertyNames = stringTable(bytes, header[3]!, header[4]!, header[5]!);
    this.commandNames = stringTable(bytes, header[9]!, header[10]!, header[11]!);
    this.commandScenes = words(bytes, header[7]!, header[8]! * 2);
    this.sceneNames = stringTable(bytes, header[13]!, header[14]!, header[15]!);
    this.entries = words(bytes, header[17]!, header[18]! * 2);
    this.sceneBase = header[19]!;
    let tail = this.sceneBase;
    for (let i = 0; i < this.entries.length; i += 2)
      tail = Math.max(tail, this.sceneBase + this.entries[i]! + this.entries[i + 1]!);
    if (header[21]) this.key = embeddedKey(bytes, tail, header[22]!);
  }

  scene(name: string): SiglusScene {
    const key = name.toLowerCase();
    const cached = this.scenes.get(key);
    if (cached) return cached;
    const index = this.sceneNames.findIndex((entry) => entry.toLowerCase() === key);
    if (index < 0) throw new Error(`Missing Siglus scene ${name}`);
    const compressed = span(
      this.bytes,
      this.sceneBase + this.entries[index * 2]!,
      this.entries[index * 2 + 1]!,
    ).slice();
    if (this.key) xorCycle(compressed, this.key);
    xorCycle(compressed, sceneXor);
    const data = unpackSiglusLz(compressed);
    const header = words(data, 0, 33);
    if (header[0] !== 132) throw new Error(`Invalid Siglus scene ${name}`);
    const scene = {
      name: this.sceneNames[index]!,
      code: span(data, header[1]!, header[2]!),
      strings: stringTable(data, header[3]!, header[4]!, header[5]!, 0x7087),
      labels: words(data, header[7]!, header[8]!),
      entries: words(data, header[9]!, header[10]!),
      properties: words(data, header[13]!, header[14]! * 2),
      commands: words(data, header[19]!, header[20]!),
      commandNames: stringTable(data, header[21]!, header[22]!, header[23]!),
    };
    this.scenes.set(key, scene);
    return scene;
  }

  configuration(bytes: Uint8Array): SiglusGameConfig {
    const encrypted = byteDataView(bytes).getUint32(4, true);
    const payload = bytes.slice(8);
    xorCycle(payload, configXor);
    if (encrypted) {
      if (!this.key) throw new Error('Missing Siglus configuration key');
      xorCycle(payload, this.key);
    }
    const names: string[] = [];
    const config = new SiglusGameConfig(names);
    for (const match of utf16
      .decode(unpackSiglusLz(payload))
      .matchAll(/^#([\w.]+)\s*=([^\r\n]*)/gm)) {
      const key = match[1]!.toUpperCase();
      const value = match[2]!.trim();
      // NAMAE is repeatable. Keep the original map lookup and preserve each declaration.
      if (/^NAMAE(?:\.\d+)?$/.test(key)) names.push(value);
      config.set(key, value);
    }
    return config;
  }
}
