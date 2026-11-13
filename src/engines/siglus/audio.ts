import {BrowserAudioContextHost} from '../../audio/browser-audio-context-host.js';
import {byteDataView} from '../../core/binary.js';
import {isOggPageStart, readOggPage} from '../../formats/ogg/page.js';
import type {ByteSource} from '../../core/source.js';
import {decodeNwa, ovkIndex, readOvk} from '../../formats/siglus/sound.js';

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class SiglusAudio {
  private readonly context = new AudioContext();
  private readonly host = new BrowserAudioContextHost(this.context, document);
  private readonly playing = new Map<string, Playing>();
  private readonly indexes = new Map<string, ReturnType<typeof ovkIndex>>();
  private readonly effects = new Map<string, Promise<AudioBuffer>>();
  private readonly active = new Set<Playing>();
  private readonly measured = new WeakMap<AudioBuffer, {peak: number; rms: number}>();
  private closed = false;
  private bgmVolume: number;

  constructor(
    private readonly files: ReadonlyMap<string, ByteSource>,
    private readonly config: ReadonlyMap<string, string>,
    private readonly root: HTMLElement,
  ) {
    this.bgmVolume = this.volume('BGM');
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
    this.start(
      'bgm',
      buffer,
      this.bgmVolume,
      loop,
      loopStart,
      end < 0 ? buffer.duration : end / rate,
      start,
      fade || crossfade,
    );
    this.root.dataset.bgm = name;
  }

  async voice(id: number, channel = 'voice'): Promise<void> {
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
    this.start(channel, buffer, this.volume('KOE'));
    this.root.dataset.voice = String(id);
    this.root.dataset.voiceDuration = String(buffer.duration);
  }

  async effect(channel: string, name: string, loop = false): Promise<void> {
    const path = `wav/${name.toLowerCase()}.nwa`;
    let decoded = this.effects.get(path);
    if (!decoded) {
      decoded = this.decode(path);
      this.effects.set(path, decoded);
      if (this.effects.size > 16) this.effects.delete(this.effects.keys().next().value!);
    }
    this.start(channel, await decoded, this.volume(channel === 'se' ? 'SE' : 'PCM'), loop);
  }

  private start(
    channel: string,
    buffer: AudioBuffer,
    volume: number,
    loop = false,
    loopStart = 0,
    loopEnd = -1,
    start = 0,
    fade = 0,
  ): void {
    if (this.closed) return;
    this.stop(channel);
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    gain.gain.setValueAtTime(fade > 0 ? 0 : volume, now);
    if (fade > 0) gain.gain.linearRampToValueAtTime(volume, now + fade / 1000);
    source.buffer = buffer;
    source.loop = loop;
    source.loopStart = loopStart;
    source.loopEnd = loopEnd < 0 ? buffer.duration : loopEnd;
    source.connect(gain).connect(this.context.destination);
    const playing = {source, gain};
    this.playing.set(channel, playing);
    this.active.add(playing);
    source.onended = () => {
      this.active.delete(playing);
      if (this.playing.get(channel) === playing) this.playing.delete(channel);
      source.disconnect();
      gain.disconnect();
    };
    source.start(0, start);
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
          detail: {channel, frames: buffer.length, rate: buffer.sampleRate, ...levels},
        }),
      );
    }
  }

  private volume(type: string): number {
    return (
      (Number(this.config.get('CONFIG.VOLUME.ALL') ?? 255) *
        Number(this.config.get('CONFIG.VOLUME.' + type) ?? 255)) /
      (255 * 255)
    );
  }

  setBgmVolume(level: number): void {
    this.bgmVolume =
      (Number(this.config.get('CONFIG.VOLUME.ALL') ?? 255) * Math.max(0, Math.min(255, level))) /
      (255 * 255);
    const active = this.playing.get('bgm');
    if (active) active.gain.gain.value = this.bgmVolume;
  }

  stop(channel: string, fade = 0): void {
    const playing = this.playing.get(channel);
    if (!playing) return;
    this.playing.delete(channel);
    const time = this.context.currentTime;
    if (fade > 0) playing.gain.gain.linearRampToValueAtTime(0, time + fade / 1000);
    playing.source.stop(time + fade / 1000);
    if (channel === 'bgm') delete this.root.dataset.bgm;
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
