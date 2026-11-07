import {WebmVideo} from '../../../video/webm-video.js';

/**
 * YSWBM.DLL, the WebM decoder of the YBN version 500 build (nestegg, libvpx 1.15.2 and libyuv),
 * reached through PRODUCT COM 0x5DC1..0x5DC4 and 0x5DC9. One stream is open at a time
 * (0x1014F298). Frames are decoded in stream order, one shown frame per call, and converted
 * with libyuv's BT.601 `I420ToARGB` (`I444ToARGB`, `I010ToARGB`) into rows of the movie's
 * own width, 4 bytes per pixel.
 */
export class Yswbm {
  private video: WebmVideo | null = null;
  /** +0x3C: the stream has ended. */
  private ended = false;
  /** +0x38: frames written so far. */
  frames = 0;

  /**
   * Ordinal 1 (0x10025668): closes any open stream, opens `data` (the `fopen` "rb" of the
   * path, null when it failed), takes the first video track, which must be VP8 or VP9, and
   * starts its decoder. 0, or -1 on any failure.
   */
  preload(data: Uint8Array | null): number {
    if (this.video) this.end();
    if (!data) return -1;
    const video = WebmVideo.open(data);
    if (!video) return -1;
    this.video = video;
    this.ended = false;
    this.frames = 0;
    return 0;
  }

  /** The open stream's frame size (the track's PixelWidth and PixelHeight). */
  get size(): {readonly width: number; readonly height: number} | null {
    return this.video ? {width: this.video.width, height: this.video.height} : null;
  }

  /**
   * Ordinal 2 (0x10025A32): reads packets of the video track and decodes them until one frame
   * converts into `out`; 0 then, 1 once the stream has ended (and on every later call), -1
   * without a stream and -2 without a buffer. The rows are `width * 4` bytes apart whatever
   * the buffer's own size, and stop where `out` ends.
   */
  async decode(out: Uint8Array | null): Promise<number> {
    const video = this.video;
    if (!video) return -1;
    if (!out) return -2;
    if (this.ended) return 1;
    for (;;) {
      const frame = await video.read();
      if (this.video !== video) return -1;
      if (!frame) {
        this.ended = true;
        return 1;
      }
      const picture = frame.picture;
      // Without a browser decoder a shown frame leaves the buffer as it is.
      let written = picture === null;
      if (picture) {
        written = await picture.readArgb({
          out,
          stride: video.width * 4,
          width: video.width,
          height: video.height,
        });
        picture.close();
      }
      if (written) {
        this.frames++;
        return 0;
      }
    }
  }

  /** Ordinal 3 (0x10025DC6): the time of the last packet read in milliseconds, -1 without a stream. */
  time(): bigint {
    return this.video ? BigInt(Math.trunc(this.video.lastTime / 1e6)) : -1n;
  }

  /** Ordinal 4 (0x10025DF3): the segment duration in milliseconds (0 without one), -1 without a stream. */
  duration(): bigint {
    return this.video ? BigInt(Math.trunc(this.video.duration / 1e6)) : -1n;
  }

  /** Ordinal 5 (0x10025E20): closes the stream; 0, or -1 when none was open. */
  end(): number {
    if (!this.video) return -1;
    this.video.close();
    this.video = null;
    return 0;
  }
}
