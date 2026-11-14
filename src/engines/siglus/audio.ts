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
}

export type SiglusAudioKind = 'BGM' | 'KOE' | 'PCM' | 'SE';
const mixKinds = ['ALL', 'BGM', 'KOE', 'PCM', 'SE', 'MOV'] as const;
type MixKind = (typeof mixKinds)[number];

export class SiglusAudio {
  private readonly context = new AudioContext();
  private readonly host = new BrowserAudioContextHost(this.context, document);
  private readonly soundLevels = new Map<number, number>();
  private readonly pendingVoices = new Map<string, object>();
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

  async bgm(name: string, loop = true, fade = 0, crossfade = 0): Promise<void> {
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
    const start = Number(fields[2] ?? 0) / rate;
    const end = Number(fields[3] ?? -1);
    const loopStart = Number(fields[4] ?? 0) / rate;
    if (crossfade > 0) this.stop('bgm', crossfade);
    this.start('bgm', buffer, 'BGM', {
      loop,
      loopStart,
      loopEnd: end < 0 ? buffer.duration : end / rate,
      start,
      fade: fade || crossfade,
    });
    this.root.dataset.bgm = name;
  }

  async voice(
    id: number,
    channel = 'voice',
    character?: number,
    volumeType?: number,
  ): Promise<void> {
    const request = {};
    this.pendingVoices.set(channel, request);
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
    const buffer = await this.context.decodeAudioData(data.buffer);
    if (this.pendingVoices.get(channel) !== request) return;
    this.pendingVoices.delete(channel);
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

  async effect(channel: string, name: string, loop = false, volumeType?: number): Promise<void> {
    const path = `wav/${name.toLowerCase()}.nwa`;
    let decoded = this.effects.get(path);
    if (!decoded) {
      decoded = this.decode(path);
      this.effects.set(path, decoded);
      if (this.effects.size > 16) this.effects.delete(this.effects.keys().next().value!);
    }
    this.start(channel, await decoded, channel === 'se' ? 'SE' : 'PCM', {
      loop,
      volumeType,
      resource: name,
    });
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
      character,
      volumeType,
      resource,
    }: {
      loop?: boolean;
      loopStart?: number;
      loopEnd?: number;
      start?: number;
      fade?: number;
      character?: number;
      volumeType?: number;
      resource?: string | number;
    } = {},
  ): void {
    if (this.closed) return;
    this.stop(channel);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    const volume = this.playbackVolume(channel, kind, character, volumeType);
    const now = this.context.currentTime;
    gain.gain.setValueAtTime(fade > 0 ? 0 : volume, now);
    if (fade > 0) gain.gain.linearRampToValueAtTime(volume, now + fade / 1000);
    source.buffer = buffer;
    source.loop = loop;
    source.loopStart = loopStart;
    source.loopEnd = loopEnd < 0 ? buffer.duration : loopEnd;
    source.connect(gain).connect(this.context.destination);
    const playing = {source, gain, kind, character, volumeType};
    this.playing.set(channel, playing);
    this.active.add(playing);
    source.onended = () => {
      this.active.delete(playing);
      if (this.playing.get(channel) === playing) this.playing.delete(channel);
      source.disconnect();
      gain.disconnect();
      if (channel === 'voice') this.updateGains('BGM');
    };
    source.start(0, start);
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
    const level = this.channelLevels.get(channel) ?? 255;
    const volume =
      volumeType === undefined || volumeType === 1
        ? this.volume(kind, character)
        : this.enabled('ALL')
          ? (this.level('ALL') * this.soundLevel(volumeType)) / (255 * 255)
          : 0;
    return (volume * level) / 255;
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
    this.pendingVoices.delete(channel);
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
    for (const channel of this.playing.keys()) {
      if (/^pcm\d+$/.test(channel)) this.stop(channel);
    }
  }

  stopEffects(): void {
    for (const channel of this.playing.keys()) {
      if (channel !== 'bgm' && channel !== 'voice') this.stop(channel);
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.host.dispose();
    for (const {source} of this.active) source.stop();
    await this.context.close();
  }
}
