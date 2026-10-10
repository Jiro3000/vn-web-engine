import type {ByteSource} from '../../core/source.js';
import type {
  MovieBatch,
  MovieFrame,
  MovieInfo,
  MoviePcm,
  MovieStream,
} from '../../video/movie-types.js';
import {WindowsMediaDecoder} from '../../video/windows-media.js';
import {AsfDemuxer, readAsfLayout, type AsfLayout, type AsfStream} from './demux.js';

/** Packets read per batch. */
const PACKETS = 64;

/** ASF movie with one Windows Media video stream and at most one audio stream. Frames carry
 * their presentation times; audio is contiguous from the first audio object's time. */
export class AsfMovie implements MovieStream {
  readonly info: MovieInfo;
  private readonly demuxer: AsfDemuxer;
  private readonly video: WindowsMediaDecoder;
  private readonly audio: WindowsMediaDecoder | null;
  private packet = 0;
  /** First audio object time, then the first decoded audio time (the decoder's own
   * presentation time when it reports one) that all later audio follows contiguously. */
  private audioObject: number | null = null;
  private audioOrigin: number | null = null;
  private audioSamples = 0;
  private done = false;

  private constructor(
    private readonly source: ByteSource,
    private readonly layout: AsfLayout,
    private readonly videoStream: AsfStream & {kind: 'video'},
    private readonly audioStream: (AsfStream & {kind: 'audio'}) | undefined,
  ) {
    if (layout.duration === null) throw Error('Unsupported broadcast ASF movie');
    const duration = layout.duration / 1000,
      frameRate = videoStream.frameTime ? 1e7 / videoStream.frameTime : 30;
    this.info = {
      width: videoStream.width,
      height: videoStream.height,
      frameRate,
      frameCount: Math.ceil(duration * frameRate),
      duration,
      sampleRate: audioStream?.sampleRate ?? 0,
      channels: audioStream?.channels ?? 0,
      sampleCount: audioStream ? Math.ceil(duration * audioStream.sampleRate) : 0,
    };
    this.demuxer = new AsfDemuxer(layout);
    this.video = new WindowsMediaDecoder(videoStream);
    try {
      this.audio = audioStream ? new WindowsMediaDecoder(audioStream) : null;
    } catch (error) {
      this.video.close();
      throw error;
    }
  }

  static async open(source: ByteSource, signal?: AbortSignal): Promise<AsfMovie> {
    if (source.size < 30) throw Error('Truncated ASF header object');
    const prefix = await source.read(0, 30, signal);
    const size = Number(new DataView(prefix.buffer, prefix.byteOffset, 30).getBigUint64(16, true));
    if (size < 30 || size + 50 > source.size) throw Error('Invalid ASF header object size');
    const layout = readAsfLayout(await source.read(0, size + 50, signal));
    const video = layout.streams.find((s) => s.kind === 'video');
    if (!video) throw Error('ASF movie without a video stream');
    if (layout.dataOffset + layout.packetCount * layout.packetSize > source.size)
      throw Error('Truncated ASF data object');
    return new AsfMovie(
      source,
      layout,
      video,
      layout.streams.find((s) => s.kind === 'audio'),
    );
  }

  async next(): Promise<MovieBatch> {
    const frames: MovieFrame[] = [],
      audio: MoviePcm[] = [];
    if (this.done) return {frames, audio, info: this.info, done: true, progress: 1};
    const {packetSize, packetCount, dataOffset} = this.layout;
    const count = Math.min(PACKETS, packetCount - this.packet);
    const bytes = await this.source.read(dataOffset + this.packet * packetSize, count * packetSize);
    for (let i = 0; i < count; i++)
      for (const object of this.demuxer.packet(
        bytes.subarray(i * packetSize, (i + 1) * packetSize),
      )) {
        if (object.stream === this.videoStream.number)
          this.pictures(this.video.decode(object.data, object.time, object.key), frames);
        else if (this.audio && object.stream === this.audioStream!.number) {
          this.audioObject ??= object.time;
          this.samples(this.audio.decode(object.data, object.time, object.key), audio);
        }
      }
    this.packet += count;
    if (this.packet >= packetCount) {
      this.pictures(this.video.decode(null), frames);
      if (this.audio) this.samples(this.audio.decode(null), audio);
      this.video.close();
      this.audio?.close();
      this.done = true;
    }
    return {frames, audio, info: this.info, done: this.done, progress: this.packet / packetCount};
  }

  private pictures(output: ReturnType<WindowsMediaDecoder['decode']>, frames: MovieFrame[]) {
    for (const o of output)
      if ('frame' in o)
        frames.push({
          ...o.frame,
          timestamp: o.time >= 0 ? o.time / 1000 : o.frame.index / this.info.frameRate,
        });
  }
  private samples(output: ReturnType<WindowsMediaDecoder['decode']>, audio: MoviePcm[]) {
    for (const o of output)
      if ('channels' in o) {
        this.audioOrigin ??= Math.max(0, o.time >= 0 ? o.time : (this.audioObject ?? 0));
        const start = this.audioSamples;
        this.audioSamples += o.channels[0]!.length;
        audio.push({
          start,
          channels: o.channels,
          timestamp: this.audioOrigin / 1000 + start / this.info.sampleRate,
        });
      }
  }
}
