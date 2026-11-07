/**
 * WebM (Matroska subset) demuxer: the EBML header, segment info, tracks and the blocks of
 * every cluster, as nestegg reads them. Lacing is resolved into separate frames.
 */

export interface WebmTrack {
  readonly number: number;
  /** 1 video, 2 audio (Matroska TrackType). */
  readonly type: number;
  readonly codec: string;
  readonly codecPrivate: Uint8Array | null;
  readonly width: number;
  readonly height: number;
  /** Nanoseconds before the first sample that the codec discards (CodecDelay). */
  readonly codecDelay: number;
  readonly defaultDuration: number;
}

export interface WebmFrame {
  readonly track: number;
  /** Presentation time in nanoseconds. */
  readonly time: number;
  readonly keyframe: boolean;
  readonly data: Uint8Array;
}

export interface Webm {
  readonly docType: string;
  /** Nanoseconds per timecode tick (TimecodeScale, 1,000,000 by default). */
  readonly timecodeScale: number;
  /** The segment duration in nanoseconds, or -1 when the file states none. */
  readonly duration: number;
  readonly tracks: readonly WebmTrack[];
  /** Every frame in file order. */
  readonly frames: readonly WebmFrame[];
}

export class WebmError extends Error {}

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

/** Top-level children of a Segment; an unknown-size cluster ends at the next one. */
const SEGMENT_CHILDREN = new Set<number>([
  0x114d9b74, // SeekHead
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  0x1c53bb6b, // Cues
  0x1941a469, // Attachments
  0x1043a770, // Chapters
  0x1254c367, // Tags
]);

interface Element {
  readonly id: number;
  readonly start: number;
  /** End of the data; the parent's end for an unknown size. */
  readonly end: number;
  readonly unknownSize: boolean;
}

class Reader {
  constructor(private readonly data: Uint8Array) {}

  /** A variable-length integer at `p`: [value, length]; the marker bit is removed for sizes. */
  vint(p: number, keepMarker: boolean): [number, number, boolean] {
    const first = this.data[p];
    if (first === undefined) throw new WebmError('WebM: truncated');
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
    if (length > 8) throw new WebmError('WebM: bad variable-length integer');
    if (p + length > this.data.length) throw new WebmError('WebM: truncated');
    let value = keepMarker ? first : first & (0xff >> length);
    let allOnes = value === 0xff >> length;
    for (let i = 1; i < length; i++) {
      const b = this.data[p + i]!;
      value = value * 256 + b;
      if (b !== 0xff) allOnes = false;
    }
    return [value, length, !keepMarker && allOnes];
  }

  element(p: number, parentEnd: number): Element {
    const [id, idLength] = this.vint(p, true);
    const [size, sizeLength, unknown] = this.vint(p + idLength, false);
    const start = p + idLength + sizeLength;
    const end = unknown ? parentEnd : Math.min(start + size, parentEnd);
    return {id, start, end, unknownSize: unknown};
  }

  uint(e: Element): number {
    let value = 0;
    for (let p = e.start; p < e.end; p++) value = value * 256 + this.data[p]!;
    return value;
  }

  float(e: Element): number {
    const view = new DataView(this.data.buffer, this.data.byteOffset + e.start, e.end - e.start);
    if (e.end - e.start === 4) return view.getFloat32(0);
    if (e.end - e.start === 8) return view.getFloat64(0);
    return 0;
  }

  text(e: Element): string {
    let s = '';
    for (let p = e.start; p < e.end && this.data[p] !== 0; p++)
      s += String.fromCharCode(this.data[p]!);
    return s;
  }

  bytes(e: Element): Uint8Array {
    return this.data.subarray(e.start, e.end);
  }

  *children(start: number, end: number): Generator<Element> {
    for (let p = start; p < end;) {
      const e = this.element(p, end);
      yield e;
      p = e.end;
    }
  }
}

export function isWebm(data: Uint8Array): boolean {
  return (
    data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3
  );
}

/** Parses a whole WebM file. */
export function parseWebm(data: Uint8Array): Webm {
  const r = new Reader(data);
  if (!isWebm(data)) throw new WebmError('WebM: missing EBML header');
  const header = r.element(0, data.length);
  let docType = 'matroska';
  for (const e of r.children(header.start, header.end))
    if (e.id === ID.DocType) docType = r.text(e);
  if (docType !== 'webm' && docType !== 'matroska') throw new WebmError('WebM: bad DocType');
  const segment = r.element(header.end, data.length);
  if (segment.id !== ID.Segment) throw new WebmError('WebM: missing Segment');
  let timecodeScale = 1_000_000;
  let durationTicks = -1;
  const tracks: WebmTrack[] = [];
  const frames: WebmFrame[] = [];
  let p = segment.start;
  while (p < segment.end) {
    let e: Element;
    try {
      e = r.element(p, segment.end);
    } catch {
      break;
    }
    if (e.id === ID.Info) {
      for (const c of r.children(e.start, e.end)) {
        if (c.id === ID.TimecodeScale) timecodeScale = r.uint(c);
        else if (c.id === ID.Duration) durationTicks = r.float(c);
      }
    } else if (e.id === ID.Tracks) {
      for (const entry of r.children(e.start, e.end))
        if (entry.id === ID.TrackEntry) tracks.push(readTrack(r, entry));
    } else if (e.id === ID.Cluster) {
      p = readCluster(r, e, timecodeScale, frames);
      continue;
    }
    p = e.end;
  }
  return {
    docType,
    timecodeScale,
    duration: durationTicks < 0 ? -1 : durationTicks * timecodeScale,
    tracks,
    frames,
  };
}

function readTrack(r: Reader, entry: Element): WebmTrack {
  let number = 0,
    type = 0,
    codec = '',
    codecPrivate: Uint8Array | null = null,
    width = 0,
    height = 0,
    codecDelay = 0,
    defaultDuration = 0;
  for (const c of r.children(entry.start, entry.end)) {
    if (c.id === ID.TrackNumber) number = r.uint(c);
    else if (c.id === ID.TrackType) type = r.uint(c);
    else if (c.id === ID.CodecID) codec = r.text(c);
    else if (c.id === ID.CodecPrivate) codecPrivate = r.bytes(c);
    else if (c.id === ID.CodecDelay) codecDelay = r.uint(c);
    else if (c.id === ID.DefaultDuration) defaultDuration = r.uint(c);
    else if (c.id === ID.Video)
      for (const v of r.children(c.start, c.end)) {
        if (v.id === ID.PixelWidth) width = r.uint(v);
        else if (v.id === ID.PixelHeight) height = r.uint(v);
      }
  }
  return {number, type, codec, codecPrivate, width, height, codecDelay, defaultDuration};
}

/** Reads a cluster's blocks; returns where the next segment child starts. */
function readCluster(r: Reader, cluster: Element, scale: number, frames: WebmFrame[]): number {
  let base = 0;
  let p = cluster.start;
  while (p < cluster.end) {
    let e: Element;
    try {
      e = r.element(p, cluster.end);
    } catch {
      return cluster.end;
    }
    if (cluster.unknownSize && SEGMENT_CHILDREN.has(e.id)) return p;
    if (e.id === ID.Timecode) base = r.uint(e);
    else if (e.id === ID.SimpleBlock) readBlock(r, e, base, scale, true, frames);
    else if (e.id === ID.BlockGroup)
      for (const c of r.children(e.start, e.end))
        if (c.id === ID.Block) readBlock(r, c, base, scale, false, frames);
    p = e.end;
  }
  return cluster.end;
}

function readBlock(
  r: Reader,
  e: Element,
  base: number,
  scale: number,
  simple: boolean,
  frames: WebmFrame[],
): void {
  const data = r.bytes(e);
  const [track, length] = r.vint(e.start, false);
  if (length + 3 > data.length) return;
  const relative = ((data[length]! << 24) >> 16) | data[length + 1]!;
  const flags = data[length + 2]!;
  const time = (base + relative) * scale;
  const keyframe = simple ? (flags & 0x80) !== 0 : false;
  let p = length + 3;
  const lacing = (flags >> 1) & 3;
  if (lacing === 0) {
    frames.push({track, time, keyframe, data: data.subarray(p)});
    return;
  }
  const count = data[p++]! + 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    // Xiph lacing.
    for (let i = 0; i < count - 1; i++) {
      let size = 0;
      let b: number;
      do {
        b = data[p++]!;
        size += b;
      } while (b === 255 && p < data.length);
      sizes.push(size);
    }
  } else if (lacing === 3) {
    // EBML lacing: the first size, then signed differences.
    const [first, n] = r.vint(e.start + p, false);
    p += n;
    sizes.push(first);
    for (let i = 1; i < count - 1; i++) {
      const [raw, m] = r.vint(e.start + p, false);
      p += m;
      const bias = 2 ** (7 * m - 1) - 1;
      sizes.push(sizes[i - 1]! + raw - bias);
    }
  } else {
    const each = Math.floor((data.length - p) / count);
    for (let i = 0; i < count - 1; i++) sizes.push(each);
  }
  for (const size of sizes) {
    frames.push({track, time, keyframe, data: data.subarray(p, p + size)});
    p += size;
  }
  frames.push({track, time, keyframe, data: data.subarray(p)});
}
