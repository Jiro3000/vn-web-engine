import {BrowserAudioContextHost} from '../../audio/browser-audio-context-host.js';
import {ScheduledPcmRange, type PcmRangeSource} from '../../audio/scheduled-pcm-range.js';
import {byteDataView} from '../../core/binary.js';
import {isOggPageStart, readOggPage} from '../../formats/ogg/page.js';
import {parseWave} from '../../formats/riff/wave.js';
import {BlobSource, type ByteSource} from '../../core/source.js';
import {workerSourceOf} from '../../core/worker-source.js';
import {decodeNwa, decodeOwp, openNwa, ovkIndex, readOvk} from '../../formats/siglus/sound.js';
import {WorkerPool, WorkerPoolLane} from '../../platform/worker-pool.js';
import type {NwaRequest} from './nwa-worker.js';

export class MissingSiglusVoiceError extends Error {}

interface Playing {
  source: AudioBufferSourceNode | ScheduledPcmRange;
  gain: GainNode;
  kind: SiglusAudioKind;
  character?: number;
  volumeType?: number;
  bgmFadeTarget?: boolean;
  bgmFadeSource?: boolean;
  resource?: string | number;
  pcm?: SiglusPcmSource;
  bgm?: BgmTrack;
  startsAt: number;
  duration: number;
  loop: boolean;
}

interface DecodedSound {
  buffer: AudioBuffer;
  sourceRate: number;
}

interface BgmCacheEntry {
  decoded: Promise<DecodedSound>;
  bytes?: number;
}

const BGM_CACHE_BYTES = 128 * 1024 * 1024;
const BGM_CACHE_ENTRIES = 16;
const NWA_STREAM_MIN_BYTES = 10 * 1024 * 1024;
// Siglus 1.1.102.1 creates 16 voices for the SE mixer at 0x5d5239.
const seVoices = Array.from({length: 16}, (_, index) => `se:${index}`);

const soundExtensions = ['wav', 'nwa', 'ogg', 'owp'] as const;
type SoundExtension = (typeof soundExtensions)[number];

interface BgmRange {
  name: string;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  start: number;
  sourceRate: number;
}

type BufferedBgm = BgmRange & {buffer: AudioBuffer};
type BgmTrack = BufferedBgm | (BgmRange & {stream: PcmRangeSource});

export interface SiglusBgmCheckpoint {
  name: string;
  loop: boolean;
  level?: number;
  ready?: boolean;
  pendingResume?: boolean;
}

interface SiglusPcmSource {
  resource: string | number;
  loop: boolean;
  volumeType?: number;
  character?: number;
  bgmName?: string;
  bgmFadeTarget?: boolean;
  bgmFadeSource?: boolean;
}

export interface SiglusPcmCheckpoint {
  channel: number;
  level: number;
  source?: SiglusPcmSource;
  ready?: boolean;
  pendingResume?: boolean;
}

export type SiglusAudioKind = 'BGM' | 'KOE' | 'PCM' | 'SE';
const mixKinds = ['ALL', 'BGM', 'KOE', 'PCM', 'SE', 'MOV'] as const;
type MixKind = (typeof mixKinds)[number];

/**
 * Native Siglus DirectSound volume curve (0x6e0bd0):
 * converts normalized linear level v in [0, 1] to DirectSound hundredths of dB
 * clamp(trunc((ln(v) / float(ln(10))) * 5000), -10000, 0), then linear WebAudio gain 10^(dB / 2000) ≈ v^2.5.
 */
export function siglusVolumeGain(normalized: number): number {
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  if (normalized >= 1) return 1;
  const hundredthsDb = Math.max(
    -10000,
    Math.min(0, Math.trunc((Math.log(normalized) / Math.fround(Math.LN10)) * 5000)),
  );
  return hundredthsDb <= -10000 ? 0 : Math.pow(10, hundredthsDb / 2000);
}

export class SiglusAudio {
  private readonly context = new AudioContext({latencyHint: 'interactive'});
  private readonly host = new BrowserAudioContextHost(this.context, document);
  private readonly soundLevels = new Map<number, number>();
  private readonly pendingPlayback = new Map<string, object>();
  private readonly pendingPromises = new Map<string, Promise<void>>();
  private pendingBgm?: {name: string; loop: boolean};
  private readonly preparedPcm = new Map<
    string,
    {source: SiglusPcmSource; buffer: AudioBuffer; bgm?: BgmTrack}
  >();
  private preparedBgm?: BgmTrack;
  private readonly bgmTable = new Map<string, string[]>();
  private readonly bgmCache = new Map<string, BgmCacheEntry>();
  private bgmCacheBytes = 0;
  private readonly nwaStreams = new Map<string, Promise<PcmRangeSource>>();
  private nwaWorker?: WorkerPool<NwaRequest, ReturnType<typeof decodeNwa>>;
  private readonly nwaQueue = new WorkerPoolLane();
  private readonly voiceCache = new Map<number, Promise<AudioBuffer>>();
  private readonly channelLevels = new Map<string, number>();
  private readonly playing = new Map<string, Playing>();
  private nextSeVoice = 0;
  private readonly fadeEnds = new Map<string, number>();
  private readonly indexes = new Map<string, ReturnType<typeof ovkIndex>>();
  private readonly ovkSources = new Map<string, ByteSource>();
  private readonly effects = new Map<string, Promise<AudioBuffer>>();
  private readonly active = new Set<Playing>();
  private readonly measured = new WeakMap<AudioBuffer, {peak: number; rms: number}>();
  private closed = false;
  private readonly levels = new Map<MixKind, number>();
  private readonly disabled = new Set<MixKind>();
  private voiceDuck = 1;
  private readonly bgmFadeInStart: number;
  private readonly bgmFadeInLen: number;
  private readonly bgmFadeOutStart: number;
  private readonly bgmFadeOutLen: number;
  private readonly voiceGroups = new Map<number, number>();
  private readonly characterLevels = new Map<number, number>();
  private readonly mutedCharacters = new Set<number>();

  constructor(
    private readonly files: ReadonlyMap<string, ByteSource>,
    private readonly config: ReadonlyMap<string, string>,
    private readonly root: HTMLElement,
    private readonly settingsKey: string,
  ) {
    const readMs = (key: string): number => {
      const value = Number(config.get(key) ?? 0);
      return Number.isFinite(value) && value > 0 ? value / 1000 : 0;
    };
    this.bgmFadeInStart = readMs('BGMFADE2.IN_START_TIME');
    this.bgmFadeInLen = readMs('BGMFADE2.IN_TIME_LEN');
    this.bgmFadeOutStart = readMs('BGMFADE2.OUT_START_TIME');
    this.bgmFadeOutLen = readMs('BGMFADE2.OUT_TIME_LEN');
    for (const [key, value] of config) {
      if (/^BGM\.\d+$/.test(key)) {
        const bgmName = value.split('"')[1]?.toLowerCase();
        if (bgmName) this.bgmTable.set(bgmName, value.split(','));
        continue;
      }
      const group = /^CHRKOE\.(\d+)$/.exec(key)?.[1];
      const members = /\(([^()]*)\)\s*$/.exec(value)?.[1];
      if (group === undefined || !members) continue;
      for (const member of members.split(','))
        this.voiceGroups.set(Number(member.trim()), Number(group));
    }
    const saved = root.ownerDocument.defaultView?.localStorage.getItem(settingsKey);
    if (!saved) return;
    try {
      const {levels, disabled, characters, mutedCharacters} = JSON.parse(saved);
      for (const kind of mixKinds) {
        const level = levels?.[kind];
        if (typeof level === 'number' && Number.isFinite(level))
          this.levels.set(kind, Math.max(0, Math.min(255, level)));
        if (Array.isArray(disabled) && disabled.includes(kind)) this.disabled.add(kind);
      }
      if (Array.isArray(characters))
        for (const entry of characters) {
          if (Array.isArray(entry) && Number.isInteger(entry[0]) && Number.isFinite(entry[1]))
            this.characterLevels.set(entry[0], Math.max(0, Math.min(255, entry[1])));
        }
      if (Array.isArray(mutedCharacters))
        for (const group of mutedCharacters)
          if (Number.isInteger(group)) this.mutedCharacters.add(group);
    } catch {
      // An unreadable settings record falls back to the installation defaults.
    }
  }

  resume(): Promise<void> {
    return this.host.resume();
  }

  private async decodeSound(
    file: ByteSource,
    extension: SoundExtension,
    readSourceRate = false,
  ): Promise<DecodedSound> {
    if (extension === 'nwa') {
      let decoded: ReturnType<typeof decodeNwa> | undefined;
      if (readSourceRate && typeof Worker !== 'undefined') {
        const worker = this.nwaDecodeWorker();
        // Queue the backing file, so inactive requests hold no compressed PCM buffer.
        if (worker.available)
          decoded = await worker.run({source: await workerSourceOf(file)}, [], this.nwaQueue);
        if (this.closed) throw new Error('Siglus audio closed during NWA decode');
      }
      const {channels, rate, pcm} = decoded ?? decodeNwa(await file.read(0, file.size));
      const buffer = this.context.createBuffer(channels, pcm.length / channels, rate);
      for (let channel = 0; channel < channels; channel++) {
        const dest = buffer.getChannelData(channel);
        for (let i = 0; i < dest.length; i++) dest[i] = pcm[i * channels + channel]! / 32768;
      }
      return {buffer, sourceRate: rate};
    }
    const encoded = new Uint8Array(await file.read(0, file.size));
    const bytes = extension === 'owp' ? decodeOwp(encoded) : encoded;
    let sourceRate: number | undefined;
    if (readSourceRate) {
      if (extension === 'wav') sourceRate = parseWave(bytes).sampleRate;
      else {
        const page = isOggPageStart(bytes, 0) ? readOggPage(bytes, 0) : null;
        if (!page) throw new Error('Missing Siglus BGM Vorbis header');
        sourceRate = byteDataView(page.bytes).getUint32(page.bodyOffset + 12, true);
        if (!sourceRate) throw new Error('Invalid Siglus BGM sample rate');
      }
    }
    const buffer = await this.context.decodeAudioData(bytes.buffer);
    return {buffer, sourceRate: sourceRate ?? buffer.sampleRate};
  }

  private nwaDecodeWorker(): NonNullable<SiglusAudio['nwaWorker']> {
    return this.nwaWorker ??= new WorkerPool(
      () => new Worker(new URL('./nwa-worker.js', import.meta.url), {type: 'module'}),
      1,
    );
  }

  private async loadNwaStream(key: string, file: ByteSource): Promise<PcmRangeSource> {
    let pending = this.nwaStreams.get(key);
    if (pending) this.nwaStreams.delete(key);
    else pending = (async () => {
      const reader = await openNwa(file);
      const worker = typeof Worker === 'undefined' ? undefined : this.nwaDecodeWorker();
      const source = worker?.available ? await workerSourceOf(file) : undefined;
      const cache = new Map<string, Promise<Int16Array>>();
      const read: PcmRangeSource['read'] = async (frame, count, signal) => {
        signal?.throwIfAborted();
        const rangeKey = `${frame}:${count}`;
        let decoded = cache.get(rangeKey);
        if (decoded) cache.delete(rangeKey);
        else {
          decoded = source && worker?.available
            ? worker.run({source, range: {key, frame, count}}, [], this.nwaQueue)
              .then((result) => result?.pcm ?? reader.read(frame, count))
            : reader.read(frame, count);
          const job = decoded;
          void job.catch(() => {
            if (cache.get(rangeKey) === job) cache.delete(rangeKey);
          });
        }
        cache.set(rangeKey, decoded);
        if (cache.size > 8) cache.delete(cache.keys().next().value!);
        const pcm = await decoded;
        signal?.throwIfAborted();
        return pcm;
      };
      return {...reader, read};
    })();
    this.nwaStreams.set(key, pending);
    if (this.nwaStreams.size > 8) this.nwaStreams.delete(this.nwaStreams.keys().next().value!);
    try {
      return await pending;
    } catch (error) {
      if (this.nwaStreams.get(key) === pending) this.nwaStreams.delete(key);
      throw error;
    }
  }

  private async loadSound(path: string, readSourceRate = false): Promise<DecodedSound> {
    // Both BGM and effects use the resolver at 0x610de0 in Siglus 1.1.134.0.
    for (const extension of soundExtensions) {
      const file = this.files.get(`${path}.${extension}`);
      if (file) return this.decodeSound(file, extension, readSourceRate);
    }
    throw new Error(`Missing Siglus sound ${path}`);
  }

  private loadBgm(name: string, loop: boolean): Promise<BufferedBgm>;
  private loadBgm(name: string, loop: boolean, startSample: number | undefined, allowStream: true): Promise<BgmTrack>;
  private async loadBgm(name: string, loop: boolean, startSample?: number, allowStream = false): Promise<BgmTrack> {
    const key = name.toLowerCase();
    const fields = this.bgmTable.get(key) ?? [];
    const file = fields[1]?.split('"')[1] ?? name;
    const path = `bgm/${file.toLowerCase()}`;
    const nwa = allowStream && !this.files.has(`${path}.wav`) ? this.files.get(`${path}.nwa`) : undefined;
    if (nwa && nwa.size >= NWA_STREAM_MIN_BYTES) {
      const stream = await this.loadNwaStream(path, nwa);
      const range = this.bgmRange(name, fields, loop, startSample, stream.rate, stream.frames / stream.rate);
      const first = Math.round(range.start * stream.rate);
      const end = Math.round(range.loopEnd * stream.rate);
      if (first < end) await stream.read(first, Math.min(end - first, Math.ceil(stream.rate * 1.5)));
      return {...range, stream};
    }
    let entry = this.bgmCache.get(path);
    if (entry) {
      this.bgmCache.delete(path);
      this.bgmCache.set(path, entry);
    } else {
      const pending: BgmCacheEntry = {decoded: this.loadSound(path, true)};
      this.bgmCache.set(path, pending);
      void pending.decoded.then(
        ({buffer}) => {
          if (this.bgmCache.get(path) !== pending) return;
          pending.bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
          this.bgmCacheBytes += pending.bytes;
          for (const [key, cached] of this.bgmCache) {
            if (this.bgmCacheBytes <= BGM_CACHE_BYTES && this.bgmCache.size <= BGM_CACHE_ENTRIES)
              break;
            if (cached.bytes === undefined) continue;
            this.bgmCacheBytes -= cached.bytes;
            this.bgmCache.delete(key);
          }
        },
        () => {
          if (this.bgmCache.get(path) === pending) this.bgmCache.delete(path);
        },
      );
      entry = pending;
    }
    const {buffer, sourceRate} = await entry.decoded;
    return {...this.bgmRange(name, fields, loop, startSample, sourceRate, buffer.duration), buffer};
  }

  private bgmRange(name: string, fields: readonly string[], loop: boolean, startSample: number | undefined, sourceRate: number, duration: number): BgmRange {
    // Gameexe %d consumes a signed integer, leaving trailing comments unread.
    const sampleField = (index: number, fallback: number): number => {
      const sample = Number.parseInt(fields[index] ?? '', 10);
      return Number.isSafeInteger(sample) ? sample : fallback;
    };
    const configuredStart = sampleField(2, 0);
    const end = sampleField(3, -1);
    const loopEnd = end < 0 ? duration : Math.min(duration, end / sourceRate);
    const loopStart = Math.min(loopEnd, Math.max(0, sampleField(4, 0) / sourceRate));
    const sample = startSample === undefined || startSample < 0 ? configuredStart : startSample;
    const start = Math.min(loopEnd, Math.max(0, sample / sourceRate));
    return {
      name,
      loop,
      loopStart,
      loopEnd,
      start: loop && start >= loopEnd && loopEnd > loopStart ? loopStart : start,
      sourceRate,
    };
  }

  bgmStart(
    name: string,
    loop = true,
    fade = 0,
    crossfade = 0,
    delay = 0,
    startSample?: number,
  ): void {
    void this.bgm(name, loop, fade, crossfade, delay, startSample).catch(() => {});
  }

  async bgm(
    name: string,
    loop = true,
    fade = 0,
    crossfade = 0,
    delay = 0,
    startSample?: number,
  ): Promise<void> {
    const request = {};
    this.preparedBgm = undefined;
    this.pendingPlayback.set('bgm', request);
    this.pendingBgm = {name, loop};
    if (!this.closed) this.root.dataset.bgm = name;
    const job = (async () => {
      const track = await this.loadBgm(name, loop, startSample, true);
      if (this.closed || this.pendingPlayback.get('bgm') !== request) return;
      this.pendingBgm = undefined;
      this.pendingPlayback.delete('bgm');
      this.stopActiveChannel('bgm', crossfade);
      this.playBgmTrack(track, fade || crossfade, delay);
    })();
    this.pendingPromises.set('bgm', job);
    try {
      await job;
    } finally {
      if (this.pendingPromises.get('bgm') === job) this.pendingPromises.delete('bgm');
      if (this.pendingPlayback.get('bgm') === request) {
        this.pendingPlayback.delete('bgm');
        this.pendingBgm = undefined;
      }
    }
  }

  private playBgmTrack(track: BgmTrack, fade: number, delay: number): void {
    if ('stream' in track) {
      this.playBgmStream(track, fade, delay);
      return;
    }
    const {name, buffer, loop, loopStart, loopEnd, start, sourceRate} = track;
    this.start('bgm', buffer, 'BGM', {
      loop,
      loopStart,
      loopEnd,
      start,
      fade,
      delay,
      sourceRate,
      resource: name,
      bgm: track,
    });
    if (!this.closed) this.root.dataset.bgm = name;
  }

  private playBgmStream(track: BgmRange & {stream: PcmRangeSource}, fade: number, delay: number): void {
    if (this.closed) return;
    this.stop('bgm');
    const gain = this.context.createGain();
    const volume = this.playbackVolume('bgm', 'BGM');
    const startsAt = this.context.currentTime + Math.max(75, delay) / 1000;
    gain.gain.setValueAtTime(fade > 0 ? 0 : volume, startsAt);
    if (fade > 0) gain.gain.linearRampToValueAtTime(volume, startsAt + fade / 1000);
    gain.connect(this.context.destination);

    const {stream, sourceRate, name} = track;
    const first = Math.round(track.start * sourceRate);
    const end = Math.round(track.loopEnd * sourceRate);
    const loopStart = Math.round(track.loopStart * sourceRate);
    const loop = track.loop && end > loopStart;
    const source = new ScheduledPcmRange(
      this.context, stream, gain, startsAt, first, end, loop ? loopStart : undefined,
      (buffer) => this.tracePlayback(buffer, {
        channel: 'bgm', resource: name, gain: volume, frames: stream.frames, streaming: true,
        startSample: first, startDelay: Math.max(0, delay), sourceRate,
        loop, loopStartSample: loopStart, loopEndSample: end,
      }),
      (error) => console.error(`Siglus BGM stream ${name}:`, error),
    );
    this.registerPlayback('bgm', {source, gain, kind: 'BGM', resource: name, bgm: track,
      startsAt, duration: (end - first) / sourceRate, loop});
    this.root.dataset.bgm = name;
    this.root.dataset.audioState = this.context.state;
    source.start();
  }

  async readyBgm(name: string, loop: boolean, fade = 0, startSample?: number): Promise<void> {
    const track = await this.loadBgm(name, loop, startSample, true);
    if (this.closed) return;
    this.stop('bgm', fade);
    this.preparedBgm = track;
  }

  pauseBgm(fade: number): void {
    const playing = this.playing.get('bgm');
    const track = playing?.bgm;
    if (!track) return;
    const elapsed = this.context.currentTime - playing.startsAt + Math.max(0, fade) / 1000;
    let start = track.start + Math.max(0, elapsed);
    if (track.loop && start >= track.loopEnd && track.loopEnd > track.loopStart)
      start = track.loopStart + ((start - track.loopStart) % (track.loopEnd - track.loopStart));
    this.stop('bgm', fade);
    if (track.loop || start < track.loopEnd) this.preparedBgm = {...track, start};
  }

  resumeBgm(fade = 0, delay = 0): void {
    if (this.preparedBgm) this.playBgmTrack(this.preparedBgm, fade, delay);
  }

  bgmName(): string {
    return this.preparedBgm?.name ?? this.pendingBgm?.name ?? this.root.dataset.bgm ?? '';
  }

  bgmPlayPosition(): number {
    const active = this.playing.get('bgm');
    const bgm = active?.bgm;
    if (!active || !bgm) return 0;
    // Native 0x6e0730 returns source PCM frames, even when Web Audio resamples.
    const elapsedSec = Math.max(0, this.context.currentTime - active.startsAt);
    const rawSec = bgm.start + elapsedSec;
    if (bgm.loop && bgm.loopEnd > bgm.loopStart && rawSec >= bgm.loopEnd) {
      const span = bgm.loopEnd - bgm.loopStart;
      const looped = bgm.loopStart + ((rawSec - bgm.loopStart) % span);
      return Math.floor(looped * bgm.sourceRate);
    }
    return Math.floor(Math.min(rawSec, bgm.loopEnd) * bgm.sourceRate);
  }

  bgmCheckpoint(): SiglusBgmCheckpoint | undefined {
    const level = this.channelLevel('bgm');
    if (this.preparedBgm)
      return {name: this.preparedBgm.name, loop: this.preparedBgm.loop, level, ready: true};
    if (this.pendingBgm?.loop)
      return {name: this.pendingBgm.name, loop: this.pendingBgm.loop, level};
    const playing = this.playing.get('bgm');
    if (!playing?.bgm) return;
    const pendingResume = playing.startsAt > this.context.currentTime;
    const {name, loop} = playing.bgm;
    if (loop || pendingResume)
      return {name, loop, level, pendingResume: pendingResume || undefined};
  }

  async restoreBgm(
    checkpoint?: SiglusBgmCheckpoint,
    level = checkpoint?.level ?? 255,
  ): Promise<void> {
    this.setChannelLevel('bgm', level, 0);
    if (!checkpoint) return;
    // The Windows loader uses the saved countdown to select the source,
    // then opens it with zero delay at the configured track start.
    if (checkpoint.ready) await this.readyBgm(checkpoint.name, checkpoint.loop);
    else await this.bgm(checkpoint.name, checkpoint.loop);
  }

  prefetchVoice(id: number): void {
    if (this.closed || !Number.isInteger(id) || id < 0 || this.voiceCache.has(id)) return;
    void this.voiceBuffer(id).catch(() => {});
  }

  voiceStart(
    id: number,
    channel = 'voice',
    character?: number,
    volumeType?: number,
  ): void {
    void this.voice(id, channel, character, volumeType).catch(() => {});
  }

  async voice(
    id: number,
    channel = 'voice',
    character?: number,
    volumeType?: number,
  ): Promise<void> {
    if (channel === 'se') channel = this.allocateSeVoice();
    const request = {};
    this.pendingPlayback.set(channel, request);
    const job = (async () => {
      const buffer = await this.voiceBuffer(id);
      if (this.closed || this.pendingPlayback.get(channel) !== request) return;
      this.pendingPlayback.delete(channel);
      this.start(channel, buffer, 'KOE', {
        resource: id,
        volumeType,
        character:
          character === undefined ? undefined : (this.voiceGroups.get(character) ?? character),
      });
      if (channel === 'voice') {
        this.root.dataset.voice = String(id);
        this.root.dataset.voiceDuration = String(buffer.duration);
      }
    })();
    this.pendingPromises.set(channel, job);
    try {
      await job;
    } finally {
      if (this.pendingPromises.get(channel) === job) this.pendingPromises.delete(channel);
      if (this.pendingPlayback.get(channel) === request) this.pendingPlayback.delete(channel);
    }
  }

  private async voiceBuffer(id: number): Promise<AudioBuffer> {
    let cached = this.voiceCache.get(id);
    if (cached) {
      this.voiceCache.delete(id);
      this.voiceCache.set(id, cached);
      return cached;
    }
    cached = this.loadVoice(id);
    this.voiceCache.set(id, cached);
    cached.catch(() => {
      if (this.voiceCache.get(id) === cached) this.voiceCache.delete(id);
    });
    if (this.voiceCache.size > 24) this.voiceCache.delete(this.voiceCache.keys().next().value!);
    return cached;
  }

  private ovkSource(path: string, file: ByteSource): ByteSource {
    let source = this.ovkSources.get(path);
    if (!source) {
      // Bypass BlobSource's 8 MiB read-ahead window for random-access OVK headers and voice clips.
      source = file instanceof BlobSource ? new BlobSource(file.blob, 0) : file;
      this.ovkSources.set(path, source);
    }
    return source;
  }

  private async loadVoice(id: number): Promise<AudioBuffer> {
    const bank = String(Math.floor(id / 100000)).padStart(4, '0');
    const loose = `koe/${bank}/z${String(id).padStart(9, '0')}`;
    // The voice resolver at 0x6112f0 prefers loose WAV, then loose NWA, then OVK.
    for (const extension of ['wav', 'nwa'] as const) {
      const file = this.files.get(`${loose}.${extension}`);
      if (file) return (await this.decodeSound(file, extension)).buffer;
    }
    const path = `koe/z${bank}.ovk`;
    const file = this.files.get(path);
    if (!file) throw new MissingSiglusVoiceError(`Missing Siglus voice bank ${path}`);
    const source = this.ovkSource(path, file);
    let index = this.indexes.get(path);
    if (!index) {
      const loading = ovkIndex(source);
      this.indexes.set(path, loading);
      loading.catch(() => {
        if (this.indexes.get(path) === loading) this.indexes.delete(path);
      });
      index = loading;
    }
    const entry = (await index).get(id % 100000);
    if (!entry) throw new MissingSiglusVoiceError(`Missing Siglus voice ${id}`);
    const data = await readOvk(source, entry);
    return this.context.decodeAudioData(data.buffer);
  }

  private effectBuffer(name: string): Promise<AudioBuffer> {
    const path = `wav/${name.toLowerCase()}`;
    let decoded = this.effects.get(path);
    if (decoded) {
      this.effects.delete(path);
      this.effects.set(path, decoded);
    } else {
      decoded = this.loadSound(path).then(({buffer}) => buffer);
      this.effects.set(path, decoded);
      decoded.catch(() => {
        if (this.effects.get(path) === decoded) this.effects.delete(path);
      });
      if (this.effects.size > 64) this.effects.delete(this.effects.keys().next().value!);
    }
    return decoded;
  }

  effectStart(channel: string, name: string): void {
    void this.effect(channel, name).catch(() => {});
  }

  async effect(channel: string, name: string): Promise<void> {
    const kind = channel === 'se' ? 'SE' : 'PCM';
    if (channel === 'se') channel = this.allocateSeVoice();
    const request = {};
    this.pendingPlayback.set(channel, request);
    const job = (async () => {
      const buffer = await this.effectBuffer(name);
      if (this.closed || this.pendingPlayback.get(channel) !== request) return;
      this.pendingPlayback.delete(channel);
      this.start(channel, buffer, kind, {resource: name});
    })();
    this.pendingPromises.set(channel, job);
    try {
      await job;
    } finally {
      if (this.pendingPromises.get(channel) === job) this.pendingPromises.delete(channel);
      if (this.pendingPlayback.get(channel) === request) this.pendingPlayback.delete(channel);
    }
  }

  private allocateSeVoice(): string {
    // 0x5d9200 checks the rotating slot and searches for an idle voice.
    let index = this.nextSeVoice;
    for (let count = 0; count < seVoices.length; count++) {
      if (!this.channelState(seVoices[index]!)) break;
      index = (index + 1) % seVoices.length;
    }
    this.nextSeVoice = (index + 1) % seVoices.length;
    return seVoices[index]!;
  }

  async effectDurationMs(name: string): Promise<number> {
    try {
      const buffer = await this.effectBuffer(name);
      return Math.round(buffer.duration * 1000);
    } catch {
      return 0;
    }
  }

  pcmStart(channel: number, source: SiglusPcmSource, ready = false, fade = 0): void {
    void this.pcm(channel, source, ready, fade).catch(() => {});
  }

  async pcm(channel: number, source: SiglusPcmSource, ready = false, fade = 0): Promise<void> {
    const key = `pcm${channel}`;
    this.stop(key);
    const request = {};
    this.pendingPlayback.set(key, request);
    const job = (async () => {
      let buffer: AudioBuffer;
      let bgm: BgmTrack | undefined;
      if (source.bgmName) {
        bgm = await this.loadBgm(source.bgmName, source.loop);
        buffer = bgm.buffer;
      } else {
        buffer =
          typeof source.resource === 'number'
            ? await this.voiceBuffer(source.resource)
            : await this.effectBuffer(source.resource);
      }
      if (this.closed || this.pendingPlayback.get(key) !== request) return;
      this.pendingPlayback.delete(key);
      this.preparedPcm.set(key, {source, buffer, bgm});
      if (!ready) this.resumePcm(channel, fade);
    })();
    this.pendingPromises.set(key, job);
    try {
      await job;
    } finally {
      if (this.pendingPromises.get(key) === job) this.pendingPromises.delete(key);
      if (this.pendingPlayback.get(key) === request) this.pendingPlayback.delete(key);
    }
  }

  resumePcm(channel: number, fade = 0, delay = 0): void {
    const key = `pcm${channel}`;
    const prepared = this.preparedPcm.get(key);
    if (!prepared) return;
    const {source, buffer, bgm} = prepared;
    const {resource, loop, volumeType, character, bgmFadeTarget, bgmFadeSource} = source;
    this.start(key, buffer, typeof resource === 'number' ? 'KOE' : 'PCM', {
      resource,
      loop,
      loopStart: bgm?.loopStart,
      loopEnd: bgm?.loopEnd,
      start: bgm?.start,
      sourceRate: bgm?.sourceRate,
      fade,
      delay,
      volumeType,
      bgmFadeTarget,
      bgmFadeSource,
      character:
        character === undefined ? undefined : (this.voiceGroups.get(character) ?? character),
      pcm: source,
    });
  }

  pcmCheckpoint(): SiglusPcmCheckpoint[] {
    const channels = new Set([
      ...this.channelLevels.keys(),
      ...this.playing.keys(),
      ...this.preparedPcm.keys(),
    ]);
    const checkpoint: SiglusPcmCheckpoint[] = [];
    for (const key of channels) {
      if (!/^pcm\d+$/.test(key)) continue;
      const level = this.channelLevel(key);
      const prepared = this.preparedPcm.get(key);
      const playing = this.playing.get(key);
      const pcm = playing?.pcm;
      const pendingResume = playing !== undefined && playing.startsAt > this.context.currentTime;
      if (prepared)
        checkpoint.push({
          channel: Number(key.slice(3)),
          level,
          source: prepared.source,
          ready: true,
        });
      else if (pcm && (pcm.loop || pendingResume))
        checkpoint.push({
          channel: Number(key.slice(3)),
          level,
          source: pcm,
          pendingResume: pendingResume || undefined,
        });
      else if (level !== 255) checkpoint.push({channel: Number(key.slice(3)), level});
    }
    return checkpoint;
  }

  async restorePcm(checkpoint: readonly SiglusPcmCheckpoint[]): Promise<void> {
    for (const key of this.channelLevels.keys())
      if (/^pcm\d+$/.test(key)) this.channelLevels.delete(key);
    for (const {channel, level, source, ready} of checkpoint) {
      this.setChannelLevel(`pcm${channel}`, level, 0);
      if (source) await this.pcm(channel, source, ready);
    }
  }

  private start(
    channel: string,
    buffer: AudioBuffer,
    kind: SiglusAudioKind,
    {
      loop = false,
      loopStart = 0,
      loopEnd = -1,
      start = 0,
      fade = 0,
      delay = 0,
      character,
      volumeType,
      bgmFadeTarget,
      bgmFadeSource,
      resource,
      pcm,
      bgm,
      sourceRate = buffer.sampleRate,
    }: {
      loop?: boolean;
      loopStart?: number;
      loopEnd?: number;
      start?: number;
      fade?: number;
      delay?: number;
      character?: number;
      volumeType?: number;
      bgmFadeTarget?: boolean;
      bgmFadeSource?: boolean;
      resource?: string | number;
      pcm?: SiglusPcmSource;
      bgm?: BgmTrack;
      sourceRate?: number;
    } = {},
  ): void {
    if (this.closed) return;
    this.stop(channel);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    const volume = this.playbackVolume(channel, kind, character, volumeType, bgmFadeTarget);
    const startsAt = this.context.currentTime + Math.max(0, delay) / 1000;
    gain.gain.setValueAtTime(fade > 0 ? 0 : volume, startsAt);
    if (fade > 0) gain.gain.linearRampToValueAtTime(volume, startsAt + fade / 1000);
    source.buffer = buffer;
    source.loop = loop;
    source.loopStart = loopStart;
    source.loopEnd = loopEnd < 0 ? buffer.duration : loopEnd;
    source.connect(gain).connect(this.context.destination);
    this.registerPlayback(channel, {
      source,
      gain,
      kind,
      character,
      volumeType,
      bgmFadeTarget,
      bgmFadeSource,
      resource,
      pcm,
      bgm,
      startsAt,
      duration: bgm ? bgm.loopEnd - bgm.start : buffer.duration,
      loop,
    });
    if (bgm && !loop && loopEnd < buffer.duration)
      source.start(startsAt, start, Math.max(0, loopEnd - start));
    else source.start(startsAt, start);
    if (channel === 'voice' || bgmFadeSource) this.updateVoiceDuckGains(true);
    this.root.dataset.audioState = this.context.state;
    this.tracePlayback(buffer, {
      channel: channel.startsWith('se:') ? 'se' : channel, resource, volumeType, gain: volume,
      frames: buffer.length,
      ...(kind === 'BGM' || pcm ? {
        startSample: Math.round(start * sourceRate),
        startDelay: Math.max(0, delay),
        sourceRate,
        loop,
        loopStartSample: Math.round(source.loopStart * sourceRate),
        loopEndSample: Math.round(source.loopEnd * sourceRate),
      } : {}),
    });
  }

  private registerPlayback(channel: string, playing: Playing): void {
    const {source, gain, bgmFadeSource} = playing;
    this.playing.set(channel, playing);
    this.active.add(playing);
    const ended = () => {
      this.active.delete(playing);
      if (this.playing.get(channel) === playing) {
        this.playing.delete(channel);
        if (channel === 'bgm') delete this.root.dataset.bgm;
      }
      source.disconnect();
      gain.disconnect();
      if (channel === 'voice' || bgmFadeSource) this.updateVoiceDuckGains(false);
    };
    if (source instanceof ScheduledPcmRange) source.addEventListener('ended', ended, {once: true});
    else source.onended = ended;
  }

  private tracePlayback(buffer: AudioBuffer, detail: Record<string, string | number | boolean | undefined>): void {
    if (!new URLSearchParams(location.search).has('siglus-trace')) return;
    let levels = this.measured.get(buffer);
    if (!levels) {
      let sum = 0;
      let peak = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        for (const sample of buffer.getChannelData(channel)) {
          sum += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
      }
      levels = {peak, rms: Math.sqrt(sum / (buffer.length * buffer.numberOfChannels))};
      this.measured.set(buffer, levels);
    }
    this.root.dispatchEvent(new CustomEvent('siglus-audio', {
      detail: {...detail, rate: buffer.sampleRate, ...levels},
    }));
  }

  private isVoiceDucking(): boolean {
    if (this.playing.has('voice')) return true;
    for (const playing of this.playing.values()) if (playing.bgmFadeSource) return true;
    return false;
  }

  volume(kind: Exclude<MixKind, 'ALL'>, character?: number): number {
    const duck = kind === 'BGM' && this.isVoiceDucking() ? this.voiceDuck : 1;
    const individual =
      character === undefined
        ? 1
        : this.characterEnabled(character)
          ? this.characterLevel(character) / 255
          : 0;
    return this.enabled('ALL') && this.enabled(kind)
      ? (this.level('ALL') * this.level(kind) * duck * individual) / (255 * 255)
      : 0;
  }

  characterLevel(group: number): number {
    return this.characterLevels.get(group) ?? 255;
  }

  characterEnabled(group: number): boolean {
    return !this.mutedCharacters.has(group);
  }

  setCharacterLevel(group: number, level?: number): void {
    if (level === undefined) this.characterLevels.delete(group);
    else this.characterLevels.set(group, Math.max(0, Math.min(255, level)));
    this.updateGains('KOE');
    this.saveMix();
  }

  setCharacterEnabled(group: number, enabled: boolean): void {
    if (enabled) this.mutedCharacters.delete(group);
    else this.mutedCharacters.add(group);
    this.updateGains('KOE');
    this.saveMix();
  }

  setVoiceDuck(level: number): void {
    this.voiceDuck = Math.max(0, Math.min(255, level)) / 255;
    this.updateGains('BGM');
  }

  level(kind: MixKind): number {
    return this.levels.get(kind) ?? Number(this.config.get('CONFIG.VOLUME.' + kind) ?? 255);
  }

  enabled(kind: MixKind): boolean {
    return !this.disabled.has(kind);
  }

  setLevel(kind: MixKind, level?: number): void {
    if (level === undefined) {
      if (!this.levels.delete(kind)) return;
    } else {
      const next = Math.max(0, Math.min(255, level));
      if (next === this.level(kind)) return;
      this.levels.set(kind, next);
    }
    this.updateGains(kind);
    this.saveMix();
  }

  setEnabled(kind: MixKind, enabled: boolean): void {
    if (this.enabled(kind) === enabled) return;
    if (enabled) this.disabled.delete(kind);
    else this.disabled.add(kind);
    this.updateGains(kind);
    this.saveMix();
  }

  private saveMix(): void {
    this.root.ownerDocument.defaultView?.localStorage.setItem(
      this.settingsKey,
      JSON.stringify({
        levels: Object.fromEntries(this.levels),
        disabled: [...this.disabled],
        characters: [...this.characterLevels],
        mutedCharacters: [...this.mutedCharacters],
      }),
    );
  }

  soundLevel(type: number): number {
    return this.soundLevels.get(type) ?? 255;
  }

  setSoundLevel(type: number, level?: number): void {
    if (level === undefined) this.soundLevels.delete(type);
    else this.soundLevels.set(type, Math.max(0, Math.min(255, level)));
    this.updateGains('ALL');
  }

  private playbackVolume(
    channel: string,
    kind: SiglusAudioKind,
    character?: number,
    volumeType?: number,
    bgmFadeTarget?: boolean,
  ): number {
    const level = this.channelLevel(channel);
    const duck = kind !== 'BGM' && bgmFadeTarget && this.isVoiceDucking() ? this.voiceDuck : 1;
    const volume =
      volumeType === undefined || volumeType === 1
        ? this.volume(kind, character)
        : this.enabled('ALL')
          ? (this.level('ALL') * this.soundLevel(volumeType)) / (255 * 255)
          : 0;
    return siglusVolumeGain((volume * duck * level) / 255);
  }

  channelLevel(channel: string): number {
    return this.channelLevels.get(channel.startsWith('se:') ? 'se' : channel) ?? 255;
  }

  setChannelLevel(channel: string, level: number, fade: number): void {
    this.channelLevels.set(channel, Math.max(0, Math.min(255, level)));
    if (channel === 'se') {
      for (const voice of seVoices) this.applyChannelLevel(voice, fade);
    } else this.applyChannelLevel(channel, fade);
  }

  private applyChannelLevel(channel: string, fade: number): void {
    const playing = this.playing.get(channel);
    if (!playing) return;
    const {gain, kind, character, volumeType, bgmFadeTarget} = playing;
    const time = this.context.currentTime;
    gain.gain.cancelAndHoldAtTime(time);
    gain.gain.linearRampToValueAtTime(
      this.playbackVolume(channel, kind, character, volumeType, bgmFadeTarget),
      time + Math.max(0, fade) / 1000,
    );
  }

  private updateVoiceDuckGains(duckingStarted: boolean): void {
    const active = this.isVoiceDucking();
    if (this.voiceDuck >= 1) {
      this.updateGains('ALL');
      return;
    }
    const fade =
      duckingStarted && active
        ? {delay: this.bgmFadeInStart, duration: this.bgmFadeInLen}
        : !active
          ? {delay: this.bgmFadeOutStart, duration: this.bgmFadeOutLen}
          : undefined;
    this.updateGains('ALL', fade);
  }

  private updateGains(kind: MixKind, duckFade?: {delay: number; duration: number}): void {
    const time = this.context.currentTime;
    for (const [channel, {gain, kind: playingKind, character, volumeType, bgmFadeTarget}] of this
      .playing) {
      if (kind !== 'ALL' && playingKind !== kind) continue;
      const target = this.playbackVolume(channel, playingKind, character, volumeType, bgmFadeTarget);
      if (
        duckFade &&
        duckFade.duration > 0 &&
        (playingKind === 'BGM' || bgmFadeTarget) &&
        typeof gain.gain.cancelAndHoldAtTime === 'function'
      ) {
        gain.gain.cancelAndHoldAtTime(time);
        if (duckFade.delay > 0) gain.gain.setValueAtTime(gain.gain.value, time + duckFade.delay);
        gain.gain.linearRampToValueAtTime(target, time + duckFade.delay + duckFade.duration);
      } else {
        gain.gain.cancelScheduledValues(time);
        gain.gain.setValueAtTime(target, time);
      }
    }
  }

  async waitForEnd(channel: string): Promise<void> {
    const pending = this.pendingPromises.get(channel);
    if (pending) await pending.catch(() => {});
    const playing = this.playing.get(channel);
    if (!playing) return;
    await new Promise<void>((resolve) =>
      playing.source.addEventListener('ended', () => resolve(), {once: true}),
    );
  }

  channelRemainingMs(channel: string): number {
    if (channel === 'se') return Math.max(...seVoices.map((voice) => this.channelRemainingMs(voice)));
    const playing = this.playing.get(channel);
    if (!playing || playing.loop) return 0;
    const endsAt = playing.startsAt + playing.duration;
    return Math.max(0, Math.ceil((endsAt - this.context.currentTime) * 1000));
  }

  fadeRemaining(channel: string): number {
    if (channel === 'se') return Math.max(...seVoices.map((voice) => this.fadeRemaining(voice)));
    const end = this.fadeEnds.get(channel) ?? 0;
    return Math.max(0, Math.ceil((end - this.context.currentTime) * 1000));
  }

  isPending(channel: string): boolean {
    if (channel === 'se') return seVoices.some((voice) => this.pendingPromises.has(voice));
    return this.pendingPromises.has(channel);
  }

  channelState(channel: string): number {
    if (channel === 'se') {
      for (const voice of seVoices)
        if (this.playing.has(voice) || this.pendingPromises.has(voice)) return 1;
      return this.fadeRemaining(channel) > 0 ? 2 : 0;
    }
    if (this.playing.has(channel) || this.pendingPromises.has(channel)) return 1;
    return this.fadeRemaining(channel) > 0 ? 2 : 0;
  }

  private stopActiveChannel(channel: string, fade = 0): void {
    const playing = this.playing.get(channel);
    if (!playing) return;
    this.playing.delete(channel);
    const time = this.context.currentTime;
    if (fade > 0) {
      this.fadeEnds.set(channel, time + fade / 1000);
      playing.gain.gain.linearRampToValueAtTime(0, time + fade / 1000);
    } else this.fadeEnds.delete(channel);
    playing.source.stop(time + fade / 1000);
    if (channel === 'voice' || playing.bgmFadeSource) this.updateVoiceDuckGains(false);
  }

  stop(channel: string, fade = 0): void {
    if (channel === 'se') {
      for (const voice of seVoices) this.stop(voice, fade);
      return;
    }
    if (channel === 'bgm') {
      this.preparedBgm = undefined;
      this.pendingBgm = undefined;
      delete this.root.dataset.bgm;
    }
    this.pendingPlayback.delete(channel);
    this.pendingPromises.delete(channel);
    this.preparedPcm.delete(channel);
    this.stopActiveChannel(channel, fade);
  }

  stopPcmChannels(): void {
    for (const channel of new Set([
      ...this.playing.keys(),
      ...this.preparedPcm.keys(),
      ...this.pendingPlayback.keys(),
    ])) {
      if (/^pcm\d+$/.test(channel)) this.stop(channel);
    }
  }

  stopEffects(): void {
    this.stop('se');
    this.stopPcmChannels();
    for (const channel of this.playing.keys()) {
      if (channel !== 'bgm' && channel !== 'voice') this.stop(channel);
    }
  }

  resetPlayback(): void {
    this.pendingPlayback.clear();
    this.pendingPromises.clear();
    this.pendingBgm = undefined;
    this.preparedPcm.clear();
    this.preparedBgm = undefined;
    this.playing.clear();
    this.fadeEnds.clear();
    // A source in a fade-out is no longer addressable by its channel.
    for (const {source} of this.active) source.stop();
    delete this.root.dataset.bgm;
    delete this.root.dataset.voice;
    delete this.root.dataset.voiceDuration;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pendingPlayback.clear();
    this.pendingPromises.clear();
    this.pendingBgm = undefined;
    this.bgmCache.clear();
    this.bgmCacheBytes = 0;
    this.nwaStreams.clear();
    this.nwaWorker?.terminate();
    this.indexes.clear();
    this.ovkSources.clear();
    this.voiceCache.clear();
    this.effects.clear();
    this.host.dispose();
    for (const {source} of this.active) source.stop();
    await this.context.close();
  }
}
