import type {AudioVoice} from '../../audio/transport.js';
import {BrowserAudioTransport} from '../../audio/transport.js';
import type {PcmClip} from '../../audio/pcm.js';
import type {SseRounding} from '../../core/sse-integer.js';
import {ArtemisEffectVoices} from './effect-voices.js';
import {createArtemisBufferedSoundDecoder} from './buffered-sound-decoder.js';
import {createArtemisSoundLoader} from './sound-loader.js';
import {ArtemisVorbisSource} from './vorbis-source.js';
import {ArtemisWaveSource} from './wave-source.js';
import {ArtemisVorbisPcmDecoder} from './vorbis-pcm-decoder.js';
import {createArtemisRollingVoice} from './browser-rolling-voice.js';
import {artemisRevision} from './revision.js';

/** Native file/codec/voice owner for cached and progressive playback. Engine
 * scheduler ticks pump real device buffers through ArtemisEffectVoices.tick.
 * Codec resources are eagerly decoded in workers; progressive decode-error and
 * damaged/chained-stream timing are not claimed equivalent to native libvorbis.
 */
export function createArtemisBrowserSoundVoices(
  hash: string,
  readFile: (path: string) => Promise<Uint8Array | null>,
  rounding: SseRounding,
  context?: AudioContext | OfflineAudioContext,
): {effects: ArtemisEffectVoices; unlock(): Promise<void>; close(): void} {
  artemisRevision(hash);
  const graph = context ?? new AudioContext(),
    clips = new Map<number, PcmClip>(),
    cached = createArtemisBufferedSoundDecoder(hash, readFile, rounding),
    vorbis = new ArtemisVorbisPcmDecoder(hash, rounding),
    rolling = new Set<AudioVoice>(),
    transport = new BrowserAudioTransport(async (_bank, index) => {
      const clip = clips.get(index);
      if (!clip) throw Error('Missing cached Artemis PCM');
      return clip;
    }, graph),
    loader = createArtemisSoundLoader<ArtemisWaveSource | ArtemisVorbisSource>(hash, readFile, {
      vorbis: (bytes, _mode, path) =>
        ArtemisVorbisSource.fromBytes(hash, path, bytes, readFile, (data) => vorbis.decode(data)),
      wave: (bytes, _mode, path) => ArtemisWaveSource.fromBytes(hash, path, bytes, readFile),
    });
  let next = 0,
    closed = false;
  const effects = new ArtemisEffectVoices(hash, {
    prepareVoice: async (file, bufferMode) => {
      if (closed) throw Error('Artemis sound owner closed');
      if (bufferMode === -1) {
        const clip = await cached.decode(file, bufferMode);
        if (closed) throw Error('Artemis sound owner closed during decode');
        if (!clip) return null;
        const index = ++next;
        clips.set(index, clip);
        try {
          return await transport.prepare(0, index, false);
        } finally {
          clips.delete(index);
        }
      }
      const loaded = await loader.load(file, bufferMode);
      if (closed) throw Error('Artemis sound owner closed during decode');
      if (!loaded) return null;
      const voice = await createArtemisRollingVoice(graph, {
        hash,
        resource: loaded.sound.snapshot(),
        bufferMode,
      });
      if (closed) {
        voice.dispose();
        throw Error('Artemis sound owner closed during voice preparation');
      }
      const dispose = voice.dispose;
      voice.dispose = () => {
        dispose();
        rolling.delete(voice);
      };
      rolling.add(voice);
      return voice;
    },
  });
  return {
    effects,
    unlock: () => transport.unlock(),
    close: () => {
      if (closed) return;
      closed = true;
      effects.close();
      for (const voice of rolling) voice.dispose();
      cached.close();
      vorbis.close();
      clips.clear();
      transport.dispose();
    },
  };
}
