import {decodeVorbis} from '../../../audio/vorbis-decoder.js';
import {openVorbisPcm16, vorbisPcm16, type VorbisPcm16} from '../../../audio/vorbis-pcm16.js';
import {takePrefetchedVorbisPcm16} from '../../../audio/vorbis-prefetch.js';
import {OPUS_SAMPLE_RATE, openOpusPcm16, readOggOpus} from '../../../audio/opus-pcm16.js';
import {YurisError} from './errors.js';
import {YurisFileKind, YurisFileType, type YurisFiles} from './files.js';
import type {YurisMachine} from './machine.js';
import {LookupMode, type YurisNode, YurisTree, resolveNodePath} from './nodes.js';
import {type ByteString, fistp} from './numbers.js';
import {YurisType} from './variables.js';

const SOUND = 0x59,
  SOUNDEND = 0x5a,
  SOUNDINFO = 0x5b;

const enum Arg {
  Id,
  E,
  File,
  Play,
  Pause,
  Fade,
  Start,
  Restart,
  End,
  Loop,
  Volume,
  Pan,
  Pitch,
  Speed,
}

const enum InfoArg {
  Id,
  Exist,
  E,
  Play,
  Pause,
  Volume,
  Pan,
  Pitch,
  File,
  FileType,
  Start,
  Restart,
  End,
  Loop,
  LoopCount,
  Time,
  TotalTime,
  Channel,
  Bit,
  Sampling,
  DataLeft,
  DataRight,
  Codec,
  Let,
}

/** The PCM format of a secondary buffer (WAVEFORMATEX at +0x1B8). */
export interface YurisSoundFormat {
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  readonly blockAlign: number;
  readonly bytesPerSecond: number;
  /** The ring size in bytes: one second of PCM. */
  readonly byteLength: number;
}

/**
 * A looping DirectSound secondary buffer (`CreateSoundBuffer` flags 0x180E8): the engine
 * writes PCM halves ahead of the play cursor. Volume and pan are in hundredths of a decibel
 * (-10000..0, pan -10000..10000).
 */
export interface YurisSoundBuffer {
  /** `GetCurrentPosition`: the play cursor in bytes. */
  playCursor(): number;
  /** `Lock`/`Unlock`: replaces `bytes` at `offset`. */
  write(offset: number, bytes: Uint8Array): void;
  /** `Play(0, 0, DSBPLAY_LOOPING)`. */
  play(): void;
  stop(): void;
  setVolume(volume: number): void;
  setPan(pan: number): void;
  setFrequency(hz: number): void;
  release(): void;
}

/** The DirectSound device of the sound thread. */
export interface YurisSoundHost {
  /** `DirectSoundCreate` and the cooperative level (0x46B154): 0 or a failing HRESULT. */
  openSoundDevice(): number;
  createSoundBuffer(format: YurisSoundFormat): YurisSoundBuffer | null;
}

const enum SoundType {
  None = 0,
  Ogg = 1,
  Wav = 2,
  /** Version 500 (Relirium.exe SOUND, file type 12): decoded by YSOPS.DLL. */
  Opus = 3,
}

const enum State {
  Idle = 0,
  Loaded = 1,
  FadingIn = 2,
  Playing = 3,
  FadingOut = 4,
}

/** 0x46B78C: the 0x1D0-byte state of a sound node. */
export class YurisSound {
  /** +0: the file name. */
  name: ByteString = '';
  /** +0x105: 1 Ogg, 2 WAV, 3 Opus. */
  type = SoundType.None;
  /** +0x106 (a signed byte). */
  enabled = 1;
  /** +0x107: 0 PCM WAV, 1 Ogg, 2 ACM WAV or Opus (YSOPS.DLL 0x10008F56). */
  codec = 0;
  /** +0x108. */
  state = State.Idle;
  /** +0x109. */
  paused = 0;
  /** +0x10C: LOOP, the plays after which the sound stops (0: endless). */
  loop = 0;
  /** +0x110: completed plays. */
  loopCount = 0;
  /** +0x114: the plays the decoder still produces (0: endless). */
  loopsLeft = 0;
  /** +0x118: bytes played since START. */
  position = 0;
  /** +0x120: the length in milliseconds. */
  total = 0;
  /** +0x128, +0x12C, +0x134: START, RESTART and END in milliseconds. */
  start = 0;
  restart = 0;
  end = 0;
  /** +0x130: when the sound was paused (0: not paused). */
  pausedAt = 0;
  /** +0x138, +0x13C: RESTART and END of the decoder's latest wrap, until the cursor passes it. */
  wrapRestart = 0;
  wrapEnd = 0;
  /** +0x140, +0x144: PAN and PITCH, 0..0x200 around 0x100. */
  pan = 0x100;
  pitch = 0;
  /** +0x148..+0x164: volume (0x100 = full) and its fade. */
  volume = 0x100;
  fadeFrom = 0;
  fadeTo = 0x100;
  target = 0x100;
  fadeTime = 0;
  slope = 0;
  fadeStart = 0;
  fadeDone = 0;
  /** +0x168, +0x1A8: the file. */
  file: Uint8Array | null = null;
  /** The decoded Ogg or Opus file; it lives as long as `file`. */
  ogg: VorbisPcm16 | null = null;
  /** +0x16C: the half being prepared (half + 0x1000 bytes); +0x170: what overflowed it. */
  decode: Uint8Array | null = null;
  overflow: Uint8Array | null = null;
  /** +0x174: where the next half goes in the ring. */
  writeOffset = 0;
  /** +0x178: the play cursor at the last position update. */
  lastCursor = 0;
  /** +0x17C: decoded bytes since the latest seek. */
  decoded = 0;
  /** +0x180: 1 while the first half was written last, 2 for the second. */
  half = 1;
  /** +0x184: the decoder position (Ogg samples, WAV data bytes). */
  readPosition = 0;
  /** +0x188: bytes in `overflow`. */
  overflowBytes = 0;
  /** +0x190: leading silence still to output (a negative START). */
  silence = 0;
  /** +0x198: block align times sample rate. */
  bytesPerSecond = 0;
  /** +0x1A0. */
  buffer: YurisSoundBuffer | null = null;
  /** What the engine wrote to the ring, for DATALEFT and DATARIGHT. */
  ring: Uint8Array | null = null;
  /** +0x1AC, +0x1B0: the WAV data chunk. */
  dataOffset = 0;
  dataSize = 0;
  /** +0x1B4: the ring size. */
  bufferSize = 0;
  /** +0x1BA..+0x1C6: the PCM format. */
  channels = 0;
  sampleRate = 0;
  blockAlign = 0;
  bits = 0;
}

type SoundNode = YurisNode<YurisSound>;

/** Messages of the device check 0x41C494 by HRESULT, for sound settings 1 and 2. */
const DEVICE_MESSAGES: Record<number, readonly [string, string]> = {
  [0x8878000a]: [
    'サウンドリソースが使用中でした。他の音楽プレーヤー等、起動、常駐しているソフトがあれば終了させてください。',
    'サウンドリソースが使用中でした。他の音楽プレーヤー等、起動、常駐しているソフトがあれば終了させてください。',
  ],
  [0x88780078]: [
    'サウンド機能が無効になっています。アプリケーション終了までサウンドは出力されません。',
    '利用可能なサウンドドライバが存在しませんでした。起動にはサウンド機能が正常に動作している必要があります。',
  ],
  [0x8007000e]: ['メモリ不足です。', 'メモリ不足です。'],
  [0x80070057]: ['無効なパラメータです。', '無効なパラメータです。'],
  [0x80040110]: [
    'このオブジェクトは集合体をサポートしません。',
    'このオブジェクトは集合体をサポートしません。',
  ],
};

/** C division truncates toward zero. */
const div = (a: number, b: number) => Math.trunc(a / b);
const i32 = (v: number) => v | 0;
/** `fistp` of the default FPU rounding (to nearest, ties to even). */
const round = (v: number) => Number(fistp(v));

/**
 * The sound system: the tree 0x872420 of sound nodes (namespace 0x872430 "S0"), the commands
 * SOUND, SOUNDEND and SOUNDINFO, and the body of the sound thread 0x41C6DC.
 *
 * Natively the commands queue operations (ring 0x872A24..0x872A40, handlers at 0x872A40) that
 * the thread runs every 3 to 20 ms, and the commands wait for some of them. Here an operation
 * runs when the command issues it, and `update` runs the thread's per-pass work once per
 * frame: the background pause, the volume fades, the play position and the ring refills.
 */
export class YurisSounds {
  readonly tree = new YurisTree<YurisSound>();
  /** 0x8722D4: the YSCF sound setting (0 off, 1 on, 2 required), 0 after a device failure. */
  device = 0;
  /** 0x872264: the program is in the background and its sounds are paused. */
  muted = false;

  constructor(
    private readonly machine: YurisMachine,
    private readonly files: YurisFiles,
    private readonly host: YurisSoundHost,
    setting: number,
  ) {
    this.device = setting;
    // 0x46891C: the root has a zeroed state and no name; the group "S0" has Z 1.
    this.tree.root.payload = new YurisSound();
    this.tree.create('S0', true, 1n, new YurisSound());
  }

  install(): void {
    const m = this.machine;
    m.define(SOUND, () => this.sound());
    m.define(SOUNDEND, () => this.soundEnd());
    m.define(SOUNDINFO, () => this.soundInfo());
  }

  /**
   * Start-up of the sound thread (0x41C494) and 0x46B767: the device opens (a failure shows
   * the setting's message and turns sound off), then the leaf "ROOT" (Z 999999999) plays an
   * endless half second of 8 kHz silence at volume 2.
   */
  async open(): Promise<void> {
    if (this.device !== 0) {
      const result = this.host.openSoundDevice() >>> 0;
      if (result !== 0) {
        if (this.device === 1 || this.device === 2) {
          const message = DEVICE_MESSAGES[result];
          if (message) this.machine.messageBox(message[this.device - 1]!);
          else if (result === 0xffffffff) this.machine.fail(new YurisError(0x1adba, [], false));
        }
        this.device = 0;
      }
    }
    if (this.device === 0) return;
    const node = this.tree.create('ROOT', false, 999999999n, new YurisSound());
    const sound = node.payload!;
    sound.name = ' ';
    sound.type = SoundType.Wav;
    this.setVolume(node, 2);
    await this.load(node, ' ');
    await this.play(node, 0);
  }

  // --- Commands ---------------------------------------------------------------------------

  /** 0x4573E8 in the sound namespace, then 0x40CA7D by kind. */
  private find(): {node: SoundNode | null; path: ByteString; group: boolean} {
    const {path, group} = resolveNodePath(
      this.machine.system.names[1]!,
      this.machine.args.text(Arg.Id),
    );
    const node = this.tree.lookup(path, group ? LookupMode.Group : LookupMode.Leaf);
    return {node, path, group};
  }

  /**
   * SOUND 0x44DEA4 (without a sound device it only decodes). A missing leaf is created with
   * Z 1 when FILE is given (otherwise nothing happens); a missing group is created unless
   * FILE is given (error 0x18BAC). Then, in this order: FILE (unloading the current file
   * first; a file that is not found ends the command, one that is neither WAV nor Ogg is
   * error 0x186BE), E, START, RESTART, END, LOOP, PAN, PITCH, SPEED, VOLUME (a fade target
   * with PLAY), PLAY (1 plays with a FADE-in, anything else stops with a FADE-out) and PAUSE.
   */
  private async sound(): Promise<number> {
    const m = this.machine,
      a = m.args;
    m.decode();
    if (this.device === 0) return 0;
    const found = this.find(),
      {path, group} = found;
    let node = found.node;
    const file = a.has(Arg.File);
    if (!node) {
      if (!group) {
        if (!file) return 0;
      } else if (file) throw new YurisError(0x18bac, [m.commandName(SOUND)]);
      node = this.tree.create(path, group, 1n, new YurisSound());
    }
    const s = node.payload!;
    const value = (id: number) => i32(Number(BigInt.asIntN(32, a.value[a.has(id)]!)));
    if (file) {
      const name = a.string[file]!;
      if (s.state !== State.Idle) this.unload(node);
      const resolved = this.files.resolve(name, YurisFileKind.Sound);
      if (!resolved.found) return 0;
      if (resolved.type === YurisFileType.Wav) s.type = SoundType.Wav;
      else if (resolved.type === YurisFileType.Ogg) s.type = SoundType.Ogg;
      else if (resolved.type === YurisFileType.Opus) s.type = SoundType.Opus;
      else throw new YurisError(0x186be, [m.commandName(SOUND), name]);
      await this.load(node, resolved.path);
    }
    if (a.has(Arg.E)) {
      s.enabled = (value(Arg.E) << 24) >> 24;
      this.setVolume(node, s.volume);
    }
    if (a.has(Arg.Start)) this.setStart(node, value(Arg.Start));
    if (a.has(Arg.Restart)) this.setRestart(node, value(Arg.Restart));
    if (a.has(Arg.End)) this.setEnd(node, value(Arg.End));
    if (a.has(Arg.Loop)) {
      s.loop = value(Arg.Loop);
      if (s.state !== State.Idle) s.loopsLeft = s.loop; // 0x41F2B0
    }
    if (a.has(Arg.Pan)) this.setPan(node, value(Arg.Pan));
    if (a.has(Arg.Pitch)) this.setPitch(node, value(Arg.Pitch));
    // SPEED queues 0x41F4B4, which does nothing.
    const play = a.has(Arg.Play);
    if (a.has(Arg.Volume)) {
      const volume = value(Arg.Volume);
      if (!play) this.setVolume(node, volume);
      else {
        // 0x41F278: the fade of the next PLAY goes from the current target to VOLUME.
        s.target = s.fadeTo;
        s.fadeTo = volume;
      }
    }
    if (play) {
      const fade = a.has(Arg.Fade) ? value(Arg.Fade) : 0;
      if (a.value[play] === 1n) await this.play(node, fade);
      else this.stop(node, fade);
    }
    if (a.has(Arg.Pause)) await this.pause(node, a.value[a.has(Arg.Pause)] === 1n ? 1 : 0);
    return 0;
  }

  /** SOUNDEND 0x44ED94: unloads and removes a leaf, or a group with everything below it. */
  private soundEnd(): number {
    const m = this.machine;
    m.decode();
    const {node, group} = this.find();
    if (!node) return 0;
    if (group) this.endChildren(node);
    this.endNode(node);
    return 0;
  }

  /** 0x44EE34. */
  private endChildren(group: SoundNode): void {
    for (const child of [...group.children]) {
      if (child.group) this.endChildren(child);
      this.endNode(child);
    }
  }

  /** 0x44EE78: unload (0x41F4CC), then remove the node (0x451AE8). */
  private endNode(node: SoundNode): void {
    this.unload(node);
    this.tree.remove(node);
  }

  /**
   * SOUNDINFO 0x44EFA8: a missing node stores 0 or ''. Otherwise the first present of EXIST,
   * E, PLAY, PAUSE, VOLUME, PAN and PITCH is stored; failing those, each present of FILETYPE,
   * FILE, START, RESTART, END, LOOP, LOOPCOUNT, TIME, TOTALTIME, CHANNEL, BIT, SAMPLING,
   * DATALEFT, DATARIGHT and CODEC is stored in turn into the same LET.
   */
  private soundInfo(): number {
    const m = this.machine,
      a = m.args;
    m.decode();
    const slot = a.has(InfoArg.Let),
      id = a.variable[slot]!,
      index = a.variableIndex[slot]!;
    const type = m.variables.get(id).type;
    const {node} = this.find();
    const s = node?.payload;
    const put = (value: number) => m.setInt(id, index, BigInt(value));
    if (!s) {
      if (type === YurisType.String) m.setString(id, index, '');
      else if (type === YurisType.Int || type === YurisType.Float) put(0);
      return 0;
    }
    if (a.has(InfoArg.Exist)) return (put(s.type > 0 ? 1 : 0), 0);
    if (a.has(InfoArg.E)) return (put(s.enabled), 0);
    if (a.has(InfoArg.Play)) return (put(s.state >= State.FadingIn ? 1 : 0), 0);
    if (a.has(InfoArg.Pause)) return (put(s.paused), 0);
    if (a.has(InfoArg.Volume)) return (put(s.volume), 0);
    if (a.has(InfoArg.Pan)) return (put(s.pan), 0);
    if (a.has(InfoArg.Pitch)) return (put(s.pitch), 0);
    if (a.has(InfoArg.FileType)) put(s.type);
    if (a.has(InfoArg.File)) m.setString(id, index, s.name);
    if (a.has(InfoArg.Start)) put(s.start);
    if (a.has(InfoArg.Restart)) put(s.restart);
    if (a.has(InfoArg.End)) put(s.end);
    if (a.has(InfoArg.Loop)) put(s.loop);
    if (a.has(InfoArg.LoopCount)) put(s.loopCount);
    if (a.has(InfoArg.Time)) {
      put(s.bytesPerSecond === 0 ? 0 : div(1000 * s.position, s.bytesPerSecond));
    }
    if (a.has(InfoArg.TotalTime)) put(s.total);
    if (a.has(InfoArg.Channel)) put(s.channels);
    if (a.has(InfoArg.Bit)) put(s.bits);
    if (a.has(InfoArg.Sampling)) put(s.sampleRate);
    if (a.has(InfoArg.DataLeft)) put(this.sample(s, false));
    if (a.has(InfoArg.DataRight)) put(this.sample(s, true));
    if (a.has(InfoArg.Codec)) put(s.codec);
    return 0;
  }

  /**
   * DATALEFT 0x44F92C and DATARIGHT 0x44FA48: the magnitude of the sample frame at the play
   * cursor (8-bit samples centred on 0x80), -1 without a buffer or for other formats.
   * DATARIGHT of 16-bit stereo reads 4 bytes past the frame (the next frame's left sample);
   * of mono it reads the only channel.
   */
  private sample(s: YurisSound, right: boolean): number {
    const ring = s.ring;
    if (!s.buffer || !ring) return -1;
    if ((s.channels !== 1 && s.channels !== 2) || (s.bits !== 8 && s.bits !== 16)) return -1;
    const frame = s.channels * (s.bits >> 3);
    const cursor = s.buffer.playCursor();
    if (ring.length - cursor < frame) return -1;
    const at = (o: number) => ring[(cursor + o) % ring.length]!;
    const magnitude = (v: number) => (Math.abs(v) << 16) >> 16;
    if (s.bits === 16) {
      const left = ((at(0) | (at(1) << 8)) << 16) >> 16;
      if (!right || s.channels === 1) return magnitude(left);
      return magnitude(((at(4) | (at(5) << 8)) << 16) >> 16);
    }
    if (!right || s.channels === 1) return magnitude(at(0) - 0x80);
    return magnitude(at(1) - 0x80);
  }

  // --- Volume, pan and pitch --------------------------------------------------------------

  /** 0x41EF10: E (1 or not) times volume, scaled by every named ancestor. */
  private effective(node: SoundNode | null): number {
    const s = node?.payload;
    if (!node || !s) return 0;
    const v = s.enabled === 1 ? s.volume : 0;
    const parent = this.namedParent(node);
    return parent ? Math.imul(v, this.effective(parent)) >> 8 : v;
  }

  /** 0x41EF60: a 0..0x100 volume as hundredths of a decibel, 4000·log10(v / 256). */
  private applyVolume(node: SoundNode, v: number): void {
    const s = node.payload;
    if (!s) return;
    let db = v === 0 ? -10000 : round(Math.log10(v * 0.00390625) * 40 * 100);
    if (db > 0) db = 0;
    if (db < -10000) db = -10000;
    s.buffer?.setVolume(db);
  }

  /** The parent that counts in the volume and pause chains: the root has no name. */
  private namedParent(node: SoundNode): SoundNode | null {
    const parent = node.parent;
    return parent && parent !== this.tree.root ? parent : null;
  }

  /**
   * 0x41DB14: a leaf gets `v` scaled by its parent's effective volume (its own E is not
   * applied); a group recomputes every node below it (0x41EECC).
   */
  private setVolumeOf(node: SoundNode, v: number): void {
    if (this.device === 0) return;
    if (!node.group) {
      const parent = this.namedParent(node);
      this.applyVolume(node, parent ? Math.imul(v, this.effective(parent)) >> 8 : v);
    } else this.applyBelow(node);
  }

  /** 0x41EECC. */
  private applyBelow(group: SoundNode): void {
    for (const child of group.children) {
      this.applyVolume(child, this.effective(child));
      if (child.group) this.applyBelow(child);
    }
  }

  /** The pattern before every release: a leaf is silenced, a group recomputed. */
  private silence(node: SoundNode, v = 0): void {
    if (this.device === 0) return;
    if (node.group) return this.applyBelow(node);
    const parent = this.namedParent(node);
    this.applyVolume(node, parent ? Math.imul(this.effective(parent), v) >> 8 : v);
  }

  /** 0x41F230 (operation 5): VOLUME without a fade. */
  private setVolume(node: SoundNode, v: number): void {
    const s = node.payload!;
    s.volume = s.target = s.fadeTo = v;
    this.setVolumeOf(node, v);
  }

  /** 0x41F0D0: 0..0x200 (0x100 centre) as hundredths of a decibel of the far side. */
  private applyPan(s: YurisSound, p: number): void {
    if (this.device === 0) return;
    let right = false,
      x: number;
    if (p < 0 || p > 0x200) x = 0x100;
    else {
      x = p > 0x100 ? 0x200 - p : p;
      right = p > 0x100;
    }
    let db = x === 0 ? -10000 : round(Math.log10(x * 0.00390625) * 40 * 100);
    if (db > 0) db = 0;
    if (db < -10000) db = -10000;
    s.buffer?.setPan(right ? -db : db);
  }

  /** 0x41D840: the frequency moves by (p - 0x100) / 256 of half the sample rate. */
  private applyPitch(s: YurisSound, p: number): void {
    if (p < 0 || p > 0x200) p = 0x100;
    const shift = Math.imul(p - 0x100, div(s.sampleRate, 2));
    s.buffer?.setFrequency(s.sampleRate + div(shift, 256));
  }

  /** 0x41F414 (operation 11). */
  private setPan(node: SoundNode, p: number): void {
    const s = node.payload!;
    if (s.state === State.Idle) return;
    s.pan = p;
    this.applyPan(s, p);
  }

  /** 0x41F464 (operation 12). */
  private setPitch(node: SoundNode, p: number): void {
    const s = node.payload!;
    if (s.state === State.Idle) return;
    s.pitch = p;
    this.applyPitch(s, p);
  }

  /** 0x41F2EC (operation 9): a START at or past the end is 0. */
  private setStart(node: SoundNode, v: number): void {
    const s = node.payload!;
    if (s.state !== State.Idle) s.start = v >= s.total ? 0 : v;
  }

  /** 0x41F34C (operation 10). */
  private setRestart(node: SoundNode, v: number): void {
    const s = node.payload!;
    if (s.state !== State.Idle) s.restart = v >= s.total ? 0 : v;
  }

  /** 0x41F3AC (operation 8): END is at most the length. */
  private setEnd(node: SoundNode, v: number): void {
    const s = node.payload!;
    if (s.state !== State.Idle) s.end = v > s.total ? s.total : v;
  }

  // --- Loading ------------------------------------------------------------------------------

  /**
   * 0x41E840 (operation 1). An idle sound takes the name, resets its play state and reads
   * and opens the file (0x41E95C); a loaded one is silenced and released instead.
   */
  private async load(node: SoundNode, name: ByteString): Promise<void> {
    const s = node.payload!;
    if (s.state !== State.Idle) {
      this.silence(node);
      this.release(s);
      s.state = State.Idle;
      return;
    }
    s.name = name;
    s.loopsLeft = 0;
    s.half = 1;
    s.pan = s.pitch = 0x100;
    s.start = s.restart = s.end = 0;
    s.position = 0;
    s.wrapRestart = s.wrapEnd = 0;
    if ((await this.read(node, s)) >= 0) s.state = State.Loaded;
  }

  /**
   * 0x41E95C: the file into memory; a node with Z 999999999 instead gets a generated
   * half second of 8-bit mono 8 kHz silence. Then 0x41CC94 opens it by type.
   */
  private async read(node: SoundNode, s: YurisSound): Promise<number> {
    if (s.file) return -0x3f2;
    if (node.z === 999999999n) {
      const wave = new Uint8Array(0xfcc);
      const view = new DataView(wave.buffer);
      wave.fill(0x80, 0x2c, 0x2c + 4000);
      view.setUint32(0, 0x46464952, true);
      view.setUint32(4, 0xfc4, true);
      view.setUint32(8, 0x45564157, true);
      view.setUint32(12, 0x20746d66, true);
      view.setUint32(16, 0x10, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true);
      view.setUint32(28, 8000, true);
      view.setUint16(32, 1, true);
      view.setUint16(34, 8, true);
      view.setUint32(36, 0x61746164, true);
      view.setUint32(40, 4000, true);
      s.file = wave;
    } else {
      // 0x40BC29: a file that cannot be read is -0x3FC.
      try {
        s.file = await this.files.read(s.name);
      } catch {
        return -0x3fc;
      }
    }
    return this.openFile(s);
  }

  /** 0x41CC94. */
  private async openFile(s: YurisSound): Promise<number> {
    if (this.device === 0) return 0;
    if (s.type === SoundType.Ogg) return this.openOgg(s);
    if (s.type === SoundType.Wav) return this.openWav(s);
    if (s.type === SoundType.Opus) return this.openOpus(s);
    return 0;
  }

  /**
   * YSOPS.DLL Load (ordinal 2, 0x10008F56): `op_open_callbacks` over the file (-0xFBE), which
   * must be seekable (-0xFC8) with one link (-0xFCD) and an OpusHead (-0xFD2); a negative
   * `op_pcm_total` fails with -0xFD7. The length is trunc(total · 1000 / 48000) ms and becomes
   * END; the codec byte is 2 and the format 48 kHz 16-bit with the head's channels.
   */
  private openOpus(s: YurisSound): number {
    if (!s.ogg) {
      const info = readOggOpus(s.file!);
      if (!info) return -0xfbe;
      if (info.links !== 1) return -0xfcd;
      if (info.channels === 0) return -0xfd2;
      if (info.frames < 0) return -0xfd7;
      s.ogg = openOpusPcm16(s.file!, info);
    }
    const pcm = s.ogg;
    s.total = Math.trunc((pcm.frames * 1000) / OPUS_SAMPLE_RATE);
    s.end = i32(s.total);
    s.codec = 2;
    return this.format(
      s,
      OPUS_SAMPLE_RATE,
      pcm.channels,
      pcm.channels * 96000,
      pcm.channels * 2,
      16,
    );
  }

  /**
   * 0x41CCDC: `ov_open_callbacks` over the file, which must be seekable with one logical
   * stream; the length is round(`ov_time_total` · 1000) and becomes END. The PCM is 16-bit.
   */
  private async openOgg(s: YurisSound): Promise<number> {
    if (!s.ogg) {
      try {
        // The PCM is filled by a worker while the first half plays; 0x41DEC0 waits for the
        // prefix it reads. A whole-file decode before PLAY delayed voice lines by its length.
        const file = s.file!;
        s.ogg = await (takePrefetchedVorbisPcm16(file) ?? openVorbisPcm16(file).catch(() => null));
        if (!s.ogg) {
          const pcm = await decodeVorbis(file);
          s.ogg = vorbisPcm16(pcm.planes, pcm.frames, pcm.sampleRate);
        }
      } catch {
        return -0x406;
      }
    }
    const ogg = s.ogg;
    s.total = round((ogg.frames / ogg.sampleRate) * 1000);
    s.end = i32(s.total);
    s.codec = 1;
    return this.format(
      s,
      ogg.sampleRate,
      ogg.channels,
      ogg.sampleRate * ogg.channels * 2,
      ogg.channels * 2,
      16,
    );
  }

  /**
   * 0x41D030: a RIFF WAVE with "fmt " and "data" chunks (found by 0x41D74C). PCM (tag 1) is
   * played from the file; other tags are converted by the ACM natively and fail here. The
   * length is round(data bytes / (block align · rate) · 1000).
   */
  private openWav(s: YurisSound): number {
    const file = s.file!;
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const u32 = (o: number) => (o + 4 <= file.length ? view.getUint32(o, true) : 0);
    if (u32(0) !== 0x46464952) return -0x2738;
    if (u32(8) !== 0x45564157) return -0x2742;
    let fmt = -1,
      fmtSize = 0,
      data = -1,
      dataSize = 0;
    const end = Math.min(file.length, u32(4) + 8);
    for (let p = 12; p + 8 <= end;) {
      const id = u32(p),
        size = u32(p + 4);
      if (id === 0x20746d66 && fmt < 0) {
        fmt = p + 8;
        fmtSize = size;
      } else if (id === 0x61746164 && data < 0) {
        data = p + 8;
        dataSize = size;
      }
      p += 8 + ((size + 1) & ~1);
    }
    if (fmt < 0) return -0x274c;
    if (data < 0) return -0x2760;
    if (fmtSize < 0xe) return -0x276a;
    const u16 = (o: number) => (o + 2 <= file.length ? view.getUint16(o, true) : 0);
    if (u16(fmt) !== 1) return -0x27d8; // ACM conversion (acmFormatSuggest onwards)
    s.codec = 0;
    const channels = u16(fmt + 2),
      rate = u32(fmt + 4),
      average = u32(fmt + 8),
      blockAlign = u16(fmt + 12),
      bits = u16(fmt + 14);
    s.total = 0;
    const perSecond = blockAlign * rate;
    if (perSecond !== 0) s.total = round((dataSize / perSecond) * 1000);
    s.end = i32(s.total);
    s.dataOffset = data;
    s.dataSize = dataSize;
    return this.format(s, rate, channels, average, blockAlign, bits);
  }

  /**
   * 0x41CE91: the format, a one-second ring, the overflow (0x1000) and decode (half +
   * 0x1000) buffers, and the secondary buffer.
   */
  private format(
    s: YurisSound,
    rate: number,
    channels: number,
    average: number,
    blockAlign: number,
    bits: number,
  ): number {
    void average;
    const perSecond = blockAlign * rate;
    s.channels = channels;
    s.sampleRate = rate;
    s.blockAlign = blockAlign;
    s.bits = bits;
    s.bufferSize = perSecond >>> 0;
    s.bytesPerSecond = perSecond;
    if (s.overflow) return -0x424;
    s.overflow = new Uint8Array(0x1000);
    if (s.decode) return -0x438;
    s.decode = new Uint8Array((s.bufferSize >>> 1) + 0x1000);
    s.ring = new Uint8Array(s.bufferSize);
    s.buffer = this.host.createSoundBuffer({
      channels,
      sampleRate: rate,
      bitsPerSample: bits,
      blockAlign,
      bytesPerSecond: average,
      byteLength: s.bufferSize,
    });
    if (!s.buffer) return -0x460;
    return 0;
  }

  /** 0x41DB6C: stops and releases the buffer and frees the file; START and RESTART become 0. */
  private release(s: YurisSound): void {
    this.releaseBuffer(s);
    s.file = null;
    s.ogg?.close?.();
    s.ogg = null;
    s.start = s.restart = 0;
  }

  /** 0x41CA64: stops and releases the buffer and the decode buffers, keeping the file. */
  private releaseBuffer(s: YurisSound): void {
    s.buffer?.stop(); // 0x46B12C
    s.buffer?.release();
    s.buffer = null;
    s.ring = null;
    s.decode = null;
    s.overflow = null;
  }

  // --- Playback -----------------------------------------------------------------------------

  /**
   * 0x41EA64 (operation 2), with the fade time. An idle sound with a name reloads and an idle
   * or loaded one starts at START, silent, fading in to its fade target; a fading or
   * playing sound fades from its volume to the target again; a fading-out one stops.
   */
  private async play(node: SoundNode, fade: number): Promise<void> {
    const s = node.payload!,
      now = this.machine.now();
    s.fadeTime = fade;
    switch (s.state) {
      case State.Idle:
      case State.Loaded: {
        if (s.state === State.Idle) {
          if (s.name === '') return;
          s.half = 1;
          s.start = 0;
          s.position = 0;
        }
        s.lastCursor = 0;
        s.overflowBytes = 0;
        s.fadeStart = i32(now);
        s.fadeDone = 0;
        s.silence = 0;
        if (s.state === State.Idle && (await this.read(node, s)) < 0) return;
        if (s.end <= s.start) s.start = 0;
        if (this.seek(s, s.start) < 0) return;
        s.position = s.decoded;
        s.half = 1;
        s.writeOffset = 0;
        if ((await this.fill(s)) < 0) return;
        this.silence(node);
        this.applyPan(s, s.pan);
        if (!s.buffer) return;
        s.buffer.play();
        s.fadeFrom = 0;
        s.slope = s.fadeTime === 0 ? s.fadeTo << 10 : div(s.fadeTo << 10, s.fadeTime);
        s.state = State.FadingIn;
        return;
      }
      case State.FadingIn:
        s.fadeStart = i32(now);
        s.fadeDone = 0;
        s.fadeFrom = s.volume;
        s.slope =
          s.fadeTime === 0
            ? (s.fadeTo - s.target) * 0x400
            : div((s.fadeTo - s.target) * 0x400, s.fadeTime);
        return;
      case State.Playing:
        s.fadeStart = i32(now);
        s.fadeDone = 0;
        s.fadeFrom = s.volume;
        s.slope =
          s.fadeTime === 0
            ? (s.fadeTo - s.volume) * 0x400
            : div((s.fadeTo - s.volume) * 0x400, s.fadeTime);
        s.state = State.FadingIn;
        return;
      case State.FadingOut: {
        const from = s.fadeFrom;
        s.fadeFrom = s.fadeTo;
        s.fadeTo = from;
        this.silence(node);
        this.release(s);
        s.state = State.Idle;
        return;
      }
    }
  }

  /** 0x46B414 (operation 4): a playing sound fades out to 0 over `fade` milliseconds. */
  private stop(node: SoundNode, fade: number): void {
    const s = node.payload!;
    if (s.state < State.FadingIn) return;
    s.fadeTime = fade;
    s.fadeStart = i32(this.machine.now());
    s.fadeDone = 0;
    s.fadeFrom = s.volume;
    s.fadeTo = 0;
    const from = s.state === State.FadingIn ? s.target : s.volume;
    s.slope = fade === 0 ? Math.imul(from, -0x400) : div(Math.imul(from, -0x400), fade);
    s.state = State.FadingOut;
  }

  /** 0x41F4CC (operation 14): a loaded sound loses its name and is released. */
  private unload(node: SoundNode): void {
    const s = node.payload!;
    if (s.state === State.Idle) return;
    s.name = '';
    this.silence(node);
    this.release(s);
    s.state = State.Idle;
  }

  /** 0x41F1A4 (operation 3): PAUSE of a node, and of everything below a group (0x41F1F0). */
  private async pause(node: SoundNode, paused: number): Promise<void> {
    node.payload!.paused = paused;
    await this.pauseOne(node, paused);
    if (node.group) await this.pauseBelow(node, paused);
  }

  /** 0x41C8BC. */
  private async pauseBelow(group: SoundNode, paused: number): Promise<void> {
    for (const child of [...group.children]) {
      await this.pauseOne(child, paused);
      if (child.group) await this.pauseBelow(child, paused);
    }
  }

  /** 0x41C91D: pause, or resume when E holds up the chain (0x41CAC4) and no PAUSE does (0x41CAF0). */
  private async pauseOne(node: SoundNode, paused: number): Promise<void> {
    if (paused === 1) return this.suspend(node);
    if (paused !== 0) return;
    let enabled = -1,
      held = 0;
    for (let n: SoundNode | null = node; n && n !== this.tree.root; n = n.parent) {
      enabled &= n.payload!.enabled;
      held |= n.payload!.paused;
    }
    if (enabled === 1 && held === 0) await this.resume(node);
  }

  /**
   * 0x41C964: a playing sound adds the cursor's progress to its position and releases its
   * buffer, keeping the file; after END it simply becomes idle.
   */
  private suspend(node: SoundNode): void {
    const s = node.payload!;
    if (s.state <= State.Loaded || s.pausedAt !== 0) return;
    if (this.machine.quit) {
      this.silence(node, 2);
      s.state = State.Idle;
      return;
    }
    if (!s.buffer) return;
    const cursor = s.buffer.playCursor();
    let delta = cursor - s.lastCursor;
    if (cursor < s.lastCursor) delta += s.bufferSize;
    s.lastCursor = cursor;
    s.position += delta;
    this.releaseBuffer(s);
    s.pausedAt = i32(this.machine.now());
  }

  /** 0x41CB1C: a paused sound reopens and continues from its position. */
  private async resume(node: SoundNode): Promise<void> {
    const s = node.payload!;
    if (s.state <= State.Loaded || s.pausedAt === 0) return;
    s.half = 1;
    s.start = i32(div(1000 * s.position, s.bytesPerSecond));
    s.position = 0;
    s.lastCursor = 0;
    s.overflowBytes = 0;
    s.silence = 0;
    const end = s.end;
    if ((await this.openFile(s)) < 0) return;
    s.end = end;
    if (end <= s.start) s.start = 0;
    if (this.seek(s, s.start) < 0) return;
    s.position = s.decoded;
    s.half = 1;
    s.writeOffset = 0;
    if ((await this.fill(s)) < 0) return;
    this.setVolumeOf(node, s.fadeTo);
    this.applyPan(s, s.pan);
    this.applyPitch(s, s.pitch);
    if (!s.buffer) return;
    s.buffer.play();
    s.pausedAt = 0;
  }

  // --- Decoding -----------------------------------------------------------------------------

  /**
   * The seeks 0x41E1C8 (Ogg, `ov_time_seek`) and 0x41E650 (WAV) to `ms`: a time at or past
   * the length is 10 ms before it; a negative time becomes leading silence. The decoded
   * count starts at the time's byte offset.
   */
  private seek(s: YurisSound, ms: number): number {
    if (ms >= s.total) ms = i32(s.total - 10);
    const perSecond = s.bytesPerSecond;
    if (ms < 0) {
      const silence = div(-ms * perSecond, 1000) + s.silence;
      s.silence = silence - (silence % s.blockAlign);
    }
    s.decoded = i32(div(ms * perSecond, 1000));
    if (ms < 0) ms = 0;
    if (s.type === SoundType.Opus) {
      // YSOPS.DLL SetPos 0x10008CBB: `op_pcm_seek` to trunc(ms · 48000 / 1000).
      const frame = Math.trunc((ms * OPUS_SAMPLE_RATE) / 1000);
      if (frame > s.ogg!.frames) return -0x139c;
      s.readPosition = frame;
      return 0;
    }
    if (s.type === SoundType.Ogg) {
      const ogg = s.ogg!;
      const seconds = ms / 1000;
      if (seconds >= ogg.frames / ogg.sampleRate) return -0x7e4;
      s.readPosition = Math.trunc(seconds * ogg.sampleRate);
      return 0;
    }
    const offset = div(ms * perSecond, 1000);
    const aligned = offset - (offset % s.blockAlign);
    s.readPosition = aligned >>> 0 < s.dataSize >>> 0 ? aligned : s.dataSize - s.blockAlign;
    return 0;
  }

  /** `ov_read` / the WAV copy: up to `n` bytes at the decoder position into `out`. */
  private readPcm(s: YurisSound, out: Uint8Array, at: number, n: number): number {
    if (s.type === SoundType.Ogg || s.type === SoundType.Opus) {
      const ogg = s.ogg!,
        frame = ogg.channels * 2;
      // YSOPS.DLL 0x1000883F passes `op_read` the frame count as its sample count, so a read
      // holds at most n / (2 · channels²) frames; 0 counts as the end of the stream.
      const limit =
        s.type === SoundType.Opus
          ? Math.floor(Math.floor(n / frame) / ogg.channels)
          : Math.floor(n / frame);
      const frames = Math.min(limit, ogg.frames - s.readPosition);
      if (frames <= 0) return 0;
      const from = s.readPosition * frame;
      out.set(ogg.bytes.subarray(from, from + frames * frame), at);
      s.readPosition += frames;
      return frames * frame;
    }
    // The WAV copy is not bounded by the data chunk natively; past the file it reads zeros.
    const file = s.file!,
      from = s.dataOffset + s.readPosition;
    const available = Math.max(0, Math.min(n, file.length - from));
    out.set(file.subarray(from, from + available), at);
    out.fill(0, at + available, at + n);
    s.readPosition += n;
    return n;
  }

  /**
   * The half fill 0x41DEC0 (Ogg) / 0x41E3E0 (WAV) and its write 0x41E2FC: the overflow, then
   * leading silence, then PCM up to END in reads of 0x1000 bytes (Ogg reads under 0x20 bytes
   * count as the end). At the end the sound pads the half with silence when this was its last
   * play, and otherwise seeks to RESTART and records the wrap for the position update.
   */
  private async fill(s: YurisSound): Promise<number> {
    const decode = s.decode,
      overflow = s.overflow;
    if (!decode || !overflow) return -1;
    const half = s.bufferSize >>> 1;
    let filled = s.overflowBytes;
    decode.set(overflow.subarray(0, filled), 0);
    let written = 0;
    while (filled < half) {
      if (s.silence > 0) {
        const n = Math.min(s.silence, half - filled);
        decode.fill(0, filled, filled + n);
        s.silence -= n;
        filled += n;
        written += n;
        continue;
      }
      const endBytes = div(s.bytesPerSecond * s.end, 1000);
      let n: number;
      if (written + 0x1000 + s.decoded >= endBytes) {
        n = i32(endBytes - (written + s.decoded));
        n -= n % s.blockAlign;
      } else n = 0x1000;
      const ogg = s.ogg;
      if (ogg?.waitForFrames && s.type !== SoundType.Wav && n >= 0x20) {
        const end = Math.min(ogg.frames, s.readPosition + Math.floor(n / s.blockAlign));
        const pending = ogg.waitForFrames(end);
        if (pending && !(await pending)) return -0x406;
      }
      const got =
        s.type === SoundType.Ogg && n < 0x20 ? 0 : n <= 0 ? 0 : this.readPcm(s, decode, filled, n);
      filled += got;
      written += got;
      if (got !== 0) continue;
      if (s.loopsLeft !== 0 && s.loopsLeft < 2) {
        decode.fill(0, filled, half);
        filled = half;
        break;
      }
      s.loopsLeft = Math.max(s.loopsLeft - 1, 0);
      s.wrapEnd = s.end;
      s.wrapRestart = s.restart;
      if (s.end <= s.restart) s.restart = 0;
      const sought = this.seek(s, s.restart);
      if (sought < 0) return s.type === SoundType.Opus ? sought : -0x7e4;
      written = 0;
    }
    s.decoded += written;
    s.overflowBytes = filled - half;
    if (s.overflowBytes > 0) overflow.set(decode.subarray(half, filled), 0);
    const bytes = decode.slice(0, half);
    s.ring?.set(bytes, s.writeOffset);
    s.buffer?.write(s.writeOffset, bytes);
    return 0;
  }

  // --- The sound thread ---------------------------------------------------------------------

  /**
   * One pass of the sound thread 0x41C6DC: the background pause (with BACKGROUNDEXEC only a
   * suspended program pauses its sounds; without it also an inactive main window), then the
   * fades (0x41D944), the positions (0x46B190) and the refills (0x41DBF4).
   */
  async update(): Promise<void> {
    if (this.device === 0) return;
    const system = this.machine.system,
      active = this.machine.windows.windows[0]!.active;
    if (system.backgroundExec === 0) {
      if (system.suspended || (!active && !this.muted)) {
        this.muted = true;
        await this.pauseBelow(this.tree.root, 1);
      } else if (!system.suspended && active && this.muted) {
        this.muted = false;
        await this.pauseBelow(this.tree.root, 0);
      }
    } else if (system.suspended && !this.muted) {
      this.muted = true;
      await this.pauseBelow(this.tree.root, 1);
    } else if (!system.suspended && this.muted) {
      this.muted = false;
      await this.pauseBelow(this.tree.root, 0);
    }
    this.fades(this.tree.root);
    this.positions(this.tree.root);
    await this.refills(this.tree.root);
  }

  /** 0x41D944: volume fades, frozen while paused or muted. */
  private fades(group: SoundNode): void {
    for (const node of [...group.children]) {
      const s = node.payload;
      if (s && (s.state === State.FadingIn || s.state === State.FadingOut)) {
        const now = i32(this.machine.now());
        if (s.paused === 0 && !this.muted) {
          const elapsed = i32(now - s.fadeStart);
          if (s.state === State.FadingIn && elapsed < 0) this.silence(node, 2);
          else {
            const product = Math.imul(elapsed, s.slope);
            let v = div(product, 1024) + s.fadeFrom;
            if (s.slope < 0) {
              if (v <= s.fadeTo) {
                v = s.fadeTo;
                s.fadeDone = i32(this.machine.now());
              }
            } else if (v >= s.fadeTo) {
              v = s.fadeTo;
              s.fadeDone = i32(this.machine.now());
            }
            this.setVolumeOf(node, v);
            s.volume = v;
          }
          if (s.fadeDone !== 0) {
            s.fadeDone = 0;
            if (s.state === State.FadingIn) s.state = State.Playing;
            if (s.state === State.FadingOut) {
              s.volume = 0x100;
              s.fadeFrom = 0;
              s.fadeTo = 0x100;
              s.target = 0x100;
              s.state = State.Idle;
              this.release(s);
            }
          }
        } else {
          const d = i32(now - s.pausedAt);
          s.fadeStart = i32(s.fadeStart + d);
          s.pausedAt = i32(s.pausedAt + d);
        }
      }
      if (node.group) this.fades(node);
    }
  }

  /**
   * 0x46B190: the played bytes follow the play cursor. Past END (or the end of the
   * decoder's latest wrap) the position restarts at RESTART and a play completes; after LOOP
   * plays the sound stops. When the program quits every sound becomes idle.
   */
  private positions(group: SoundNode): void {
    for (const node of [...group.children]) {
      const s = node.payload;
      if (s && s.state > State.Idle) {
        if (this.machine.quit) {
          this.silence(node, 2);
          s.state = State.Idle;
        } else if (s.state >= State.FadingIn && s.paused === 0 && !this.muted && s.buffer) {
          const cursor = s.buffer.playCursor();
          let delta = cursor - s.lastCursor;
          if (cursor < s.lastCursor) delta += s.bufferSize;
          s.lastCursor = cursor;
          const position = s.position + delta;
          let restart = s.restart,
            end = s.end;
          if (s.wrapEnd !== 0) {
            restart = s.wrapRestart;
            end = s.wrapEnd;
          }
          if (Math.trunc((1000 * position) / s.bytesPerSecond) >= end) {
            const restarted = Math.trunc((restart * s.bytesPerSecond) / 1000);
            s.wrapEnd = s.wrapRestart = 0;
            const count = s.loopCount + 1;
            if (count === s.loop) {
              s.loop = s.loopCount = 0;
              s.position = 0;
              this.release(s);
              s.state = State.Idle;
            } else {
              s.loopCount = count;
              s.position = restarted;
            }
          } else s.position = position;
        }
      }
      if (node.group) this.positions(node);
    }
  }

  /** 0x41DBF4: a half is refilled once the play cursor has moved into the other half. */
  private async refills(group: SoundNode): Promise<void> {
    for (const node of [...group.children]) {
      const s = node.payload;
      if (s && s.state > State.Idle) {
        if (this.machine.quit) {
          this.silence(node, 2);
          s.state = State.Idle;
        } else if (s.state >= State.FadingIn && s.paused === 0 && !this.muted && s.buffer) {
          const cursor = s.buffer.playCursor(),
            half = s.bufferSize >>> 1;
          let next = 0;
          if (s.half === 1 && cursor < half) next = 2;
          else if (s.half === 2 && cursor > half) next = 1;
          if (next !== 0) {
            s.half = next;
            s.writeOffset = next === 1 ? 0 : half;
            await this.fill(s);
          }
        }
      }
      if (node.group) await this.refills(node);
    }
  }
}
