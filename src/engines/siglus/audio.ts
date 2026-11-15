import {BrowserAudioContextHost} from '../../audio/browser-audio-context-host.js';
import {byteDataView} from '../../core/binary.js';
import {isOggPageStart, readOggPage} from '../../formats/ogg/page.js';
import type {ByteSource} from '../../core/source.js';
import {decodeNwa, ovkIndex, readOvk} from '../../formats/siglus/sound.js';

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
  kind: SiglusAudioKind;
  character?: number;
  volumeType?: number;
  resource?: string | number;
  pcm?: SiglusPcmSource;
  bgm?: BgmTrack;
  startsAt: number;
}

interface BgmTrack {
  name: string;
  buffer: AudioBuffer;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  start: number;
  sourceRate: number;
}

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

export class SiglusAudio {
  private readonly context = new AudioContext();
  private readonly host = new BrowserAudioContextHost(this.context, document);
  private readonly soundLevels = new Map<number, number>();
  private readonly pendingPlayback = new Map<string, object>();
  private readonly preparedPcm = new Map<string, {source: SiglusPcmSource; buffer: AudioBuffer}>();
  private preparedBgm?: BgmTrack;
  private readonly channelLevels = new Map<string, number>();
  private readonly playing = new Map<string, Playing>();
  private readonly indexes = new Map<string, ReturnType<typeof ovkIndex>>();
  private readonly effects = new Map<string, Promise<AudioBuffer>>();
  private readonly active = new Set<Playing>();
  private readonly measured = new WeakMap<AudioBuffer, {peak: number; rms: number}>();
  private closed = false;
  private readonly levels = new Map<MixKind, number>();
  private readonly disabled = new Set<MixKind>();
  private voiceDuck = 1;
  private readonly voiceGroups = new Map<number, number>();
  private readonly characterLevels = new Map<number, number>();
  private readonly mutedCharacters = new Set<number>();

  constructor(
    private readonly files: ReadonlyMap<string, ByteSource>,
    private readonly config: ReadonlyMap<string, string>,
    private readonly root: HTMLElement,
    private readonly settingsKey: string,
  ) {
    for (const [key, value] of config) {
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

  private async decode(path: string): Promise<AudioBuffer> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing Siglus sound ${path}`);
    const bytes = new Uint8Array(await file.read(0, file.size));
    const {channels, rate, pcm} = decodeNwa(bytes);
    const buffer = this.context.createBuffer(channels, pcm.length / channels, rate);
    for (let channel = 0; channel < channels; channel++) {
      const dest = buffer.getChannelData(channel);
      for (let i = 0; i < dest.length; i++) dest[i] = pcm[i * channels + channel]! / 32768;
    }
    return buffer;
  }

  private async loadBgm(name: string, loop: boolean, startSample?: number): Promise<BgmTrack> {
    const entry = [...this.config].find(
      ([key, value]) =>
        /^BGM\.\d+$/.test(key) && value.split('"')[1]?.toLowerCase() === name.toLowerCase(),
    );
    const fields = entry?.[1].split(',') ?? [];
    const file = fields[1]?.split('"')[1] ?? name;
    const path = `bgm/${file.toLowerCase()}.ogg`;
    const source = this.files.get(path);
    if (!source) throw new Error(`Missing Siglus sound ${path}`);
    const bytes = new Uint8Array(await source.read(0, source.size));
    const page = isOggPageStart(bytes, 0) ? readOggPage(bytes, 0) : null;
    if (!page) throw new Error('Missing Siglus BGM Vorbis header');
    const rate = byteDataView(page.bytes).getUint32(page.bodyOffset + 12, true);
    if (!rate) throw new Error('Invalid Siglus BGM sample rate');
    const buffer = await this.context.decodeAudioData(bytes.buffer);
    const configuredStart = Number(fields[2] ?? 0);
    const end = Number(fields[3] ?? -1);
    const loopStart = Number(fields[4] ?? 0) / rate;
    const loopEnd = end < 0 ? buffer.duration : Math.min(buffer.duration, end / rate);
    return {
      name,
      buffer,
      loop,
      loopStart,
      loopEnd,
      start: (startSample === undefined || startSample < 0 ? configuredStart : startSample) / rate,
      sourceRate: rate,
    };
  }

  async bgm(
    name: string,
    loop = true,
    fade = 0,
    crossfade = 0,
    delay = 0,
    startSample?: number,
  ): Promise<void> {
    const track = await this.loadBgm(name, loop, startSample);
    this.stop('bgm', crossfade);
    this.playBgmTrack(track, fade || crossfade, delay);
  }

  private playBgmTrack(track: BgmTrack, fade: number, delay: number): void {
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

  async readyBgm(name: string, loop: boolean, fade = 0, startSample?: number): Promise<void> {
    const track = await this.loadBgm(name, loop, startSample);
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
    if (track.loop || start < track.buffer.duration) this.preparedBgm = {...track, start};
  }

  resumeBgm(fade = 0, delay = 0): void {
    if (this.preparedBgm) this.playBgmTrack(this.preparedBgm, fade, delay);
  }

  bgmName(): string {
    return this.preparedBgm?.name ?? this.root.dataset.bgm ?? '';
  }

  bgmCheckpoint(): SiglusBgmCheckpoint | undefined {
    const level = this.channelLevel('bgm');
    if (this.preparedBgm)
      return {name: this.preparedBgm.name, loop: this.preparedBgm.loop, level, ready: true};
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

  async voice(
    id: number,
    channel = 'voice',
    character?: number,
    volumeType?: number,
  ): Promise<void> {
    const request = {};
    this.pendingPlayback.set(channel, request);
    const buffer = await this.voiceBuffer(id);
    if (this.pendingPlayback.get(channel) !== request) return;
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
  }

  private async voiceBuffer(id: number): Promise<AudioBuffer> {
    const bank = Math.floor(id / 100000);
    const path = `koe/z${String(bank).padStart(4, '0')}.ovk`;
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing Siglus voice bank ${path}`);
    let index = this.indexes.get(path);
    if (!index) {
      index = ovkIndex(file);
      this.indexes.set(path, index);
    }
    const entries = await index;
    const entry = entries.get(id % 100000);
    if (!entry) throw new Error(`Missing Siglus voice ${id}`);
    const data = await readOvk(file, entry);
    return this.context.decodeAudioData(data.buffer);
  }

  private effectBuffer(name: string): Promise<AudioBuffer> {
    const path = `wav/${name.toLowerCase()}.nwa`;
    let decoded = this.effects.get(path);
    if (!decoded) {
      decoded = this.decode(path);
      this.effects.set(path, decoded);
      if (this.effects.size > 16) this.effects.delete(this.effects.keys().next().value!);
    }
    return decoded;
  }

  async effect(channel: string, name: string): Promise<void> {
    this.start(channel, await this.effectBuffer(name), channel === 'se' ? 'SE' : 'PCM', {
      resource: name,
    });
  }

  async pcm(channel: number, source: SiglusPcmSource, ready = false, fade = 0): Promise<void> {
    const key = `pcm${channel}`;
    this.stop(key);
    const request = {};
    this.pendingPlayback.set(key, request);
    const buffer =
      typeof source.resource === 'number'
        ? await this.voiceBuffer(source.resource)
        : await this.effectBuffer(source.resource);
    if (this.closed || this.pendingPlayback.get(key) !== request) return;
    this.pendingPlayback.delete(key);
    this.preparedPcm.set(key, {source, buffer});
    if (!ready) this.resumePcm(channel, fade);
  }

  resumePcm(channel: number, fade = 0, delay = 0): void {
    const key = `pcm${channel}`;
    const prepared = this.preparedPcm.get(key);
    if (!prepared) return;
    const {source, buffer} = prepared;
    const {resource, loop, volumeType, character} = source;
    this.start(key, buffer, typeof resource === 'number' ? 'KOE' : 'PCM', {
      resource,
      loop,
      fade,
      delay,
      volumeType,
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
    const volume = this.playbackVolume(channel, kind, character, volumeType);
    const startsAt = this.context.currentTime + Math.max(0, delay) / 1000;
    gain.gain.setValueAtTime(fade > 0 ? 0 : volume, startsAt);
    if (fade > 0) gain.gain.linearRampToValueAtTime(volume, startsAt + fade / 1000);
    source.buffer = buffer;
    source.loop = loop;
    source.loopStart = loopStart;
    source.loopEnd = loopEnd < 0 ? buffer.duration : loopEnd;
    source.connect(gain).connect(this.context.destination);
    const playing = {
      source,
      gain,
      kind,
      character,
      volumeType,
      resource,
      pcm,
      bgm,
      startsAt,
    };
    this.playing.set(channel, playing);
    this.active.add(playing);
    source.onended = () => {
      this.active.delete(playing);
      if (this.playing.get(channel) === playing) {
        this.playing.delete(channel);
        if (channel === 'bgm') delete this.root.dataset.bgm;
      }
      source.disconnect();
      gain.disconnect();
      if (channel === 'voice') this.updateGains('BGM');
    };
    source.start(startsAt, start);
    if (channel === 'voice') this.updateGains('BGM');
    this.root.dataset.audioState = this.context.state;
    if (new URLSearchParams(location.search).has('siglus-trace')) {
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
      this.root.dispatchEvent(
        new CustomEvent('siglus-audio', {
          detail: {
            channel,
            resource,
            volumeType,
            gain: volume,
            frames: buffer.length,
            rate: buffer.sampleRate,
            ...(kind === 'BGM' || pcm
              ? {
                  startSample: Math.round(start * sourceRate),
                  startDelay: Math.max(0, delay),
                  sourceRate,
                  loop,
                  loopStartSample: Math.round(source.loopStart * sourceRate),
                  loopEndSample: Math.round(source.loopEnd * sourceRate),
                }
              : {}),
            ...levels,
          },
        }),
      );
    }
  }

  volume(kind: Exclude<MixKind, 'ALL'>, character?: number): number {
    const duck = kind === 'BGM' && this.playing.has('voice') ? this.voiceDuck : 1;
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
  ): number {
    const level = this.channelLevel(channel);
    const volume =
      volumeType === undefined || volumeType === 1
        ? this.volume(kind, character)
        : this.enabled('ALL')
          ? (this.level('ALL') * this.soundLevel(volumeType)) / (255 * 255)
          : 0;
    return (volume * level) / 255;
  }

  channelLevel(channel: string): number {
    return this.channelLevels.get(channel) ?? 255;
  }

  setChannelLevel(channel: string, level: number, fade: number): void {
    this.channelLevels.set(channel, Math.max(0, Math.min(255, level)));
    const playing = this.playing.get(channel);
    if (!playing) return;
    const {gain, kind, character, volumeType} = playing;
    const time = this.context.currentTime;
    gain.gain.cancelAndHoldAtTime(time);
    gain.gain.linearRampToValueAtTime(
      this.playbackVolume(channel, kind, character, volumeType),
      time + Math.max(0, fade) / 1000,
    );
  }

  private updateGains(kind: MixKind): void {
    const time = this.context.currentTime;
    for (const [channel, {gain, kind: playingKind, character, volumeType}] of this.playing) {
      if (kind !== 'ALL' && playingKind !== kind) continue;
      gain.gain.cancelScheduledValues(time);
      gain.gain.setValueAtTime(
        this.playbackVolume(channel, playingKind, character, volumeType),
        time,
      );
    }
  }

  async waitForEnd(channel: string): Promise<void> {
    const playing = this.playing.get(channel);
    if (!playing) return;
    await new Promise<void>((resolve) =>
      playing.source.addEventListener('ended', () => resolve(), {once: true}),
    );
  }

  stop(channel: string, fade = 0): void {
    if (channel === 'bgm') this.preparedBgm = undefined;
    this.pendingPlayback.delete(channel);
    this.preparedPcm.delete(channel);
    const playing = this.playing.get(channel);
    if (!playing) return;
    this.playing.delete(channel);
    const time = this.context.currentTime;
    if (fade > 0) playing.gain.gain.linearRampToValueAtTime(0, time + fade / 1000);
    playing.source.stop(time + fade / 1000);
    if (channel === 'bgm') delete this.root.dataset.bgm;
    if (channel === 'voice') this.updateGains('BGM');
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
    this.stopPcmChannels();
    for (const channel of this.playing.keys()) {
      if (channel !== 'bgm' && channel !== 'voice') this.stop(channel);
    }
  }

  resetPlayback(): void {
    this.pendingPlayback.clear();
    this.preparedPcm.clear();
    this.preparedBgm = undefined;
    this.playing.clear();
    // A source in a fade-out is no longer addressable by its channel.
    for (const {source} of this.active) source.stop();
    delete this.root.dataset.bgm;
    delete this.root.dataset.voice;
    delete this.root.dataset.voiceDuration;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.host.dispose();
    for (const {source} of this.active) source.stop();
    await this.context.close();
  }
}
