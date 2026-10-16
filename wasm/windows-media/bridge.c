/* Windows Media decoder bridge over the libavcodec subset in vendor/. One handle wraps one
 * decoder: WMV3/VC-1 video (planar 8-bit 4:2:0) or WMA Standard/Pro/Lossless audio (converted to
 * planar float). Timestamps are milliseconds and pass through the decoder unchanged. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "libavcodec/avcodec.h"
#include "libavutil/log.h"
#include "libavutil/mem.h"

typedef struct {
  AVCodecContext *context;
  AVPacket *packet;
  AVFrame *frame;
  float *pcm;
  int pcm_capacity;
} decoder;

/* kind 0: video, `tag` a FourCC (WMV3/WVC1); kind 1: audio, `tag` a WAVEFORMATEX format tag. */
decoder *wm_open(int kind, uint32_t tag, int width, int height, int sample_rate, int channels,
                 int bit_rate, int block_align, int bits_per_sample, const uint8_t *extra,
                 int extra_size) {
  enum AVCodecID id = AV_CODEC_ID_NONE;
  if (kind == 0 && tag == 0x33564d57u) id = AV_CODEC_ID_WMV3;
  if (kind == 0 && tag == 0x31435657u) id = AV_CODEC_ID_VC1;
  if (kind == 1 && tag == 0x161) id = AV_CODEC_ID_WMAV2;
  if (kind == 1 && tag == 0x162) id = AV_CODEC_ID_WMAPRO;
  if (kind == 1 && tag == 0x163) id = AV_CODEC_ID_WMALOSSLESS;
  av_log_set_level(AV_LOG_QUIET);
  const AVCodec *codec = avcodec_find_decoder(id);
  if (!codec) return 0;
  decoder *d = calloc(1, sizeof(*d));
  if (!d) return 0;
  d->context = avcodec_alloc_context3(codec);
  d->packet = av_packet_alloc();
  d->frame = av_frame_alloc();
  if (!d->context || !d->packet || !d->frame) goto fail;
  AVCodecContext *c = d->context;
  c->pkt_timebase = (AVRational){1, 1000};
  c->codec_tag = tag;
  c->bit_rate = bit_rate;
  if (kind == 0) {
    c->width = width;
    c->height = height;
  } else {
    c->sample_rate = sample_rate;
    av_channel_layout_default(&c->ch_layout, channels);
    c->block_align = block_align;
    c->bits_per_coded_sample = bits_per_sample;
  }
  if (extra_size > 0) {
    c->extradata = av_mallocz(extra_size + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!c->extradata) goto fail;
    memcpy(c->extradata, extra, extra_size);
    c->extradata_size = extra_size;
  }
  if (avcodec_open2(c, codec, 0) < 0) goto fail;
  return d;
fail:
  avcodec_free_context(&d->context);
  av_packet_free(&d->packet);
  av_frame_free(&d->frame);
  free(d);
  return 0;
}

void wm_close(decoder *d) {
  if (!d) return;
  avcodec_free_context(&d->context);
  av_packet_free(&d->packet);
  av_frame_free(&d->frame);
  free(d->pcm);
  free(d);
}

/* Input buffer the caller fills before wm_send; size includes the decoder padding. */
uint8_t *wm_alloc(int size) { return av_mallocz(size + AV_INPUT_BUFFER_PADDING_SIZE); }
void wm_free(void *p) { av_free(p); }

/* Sends one media object (size 0 drains). 0 on success, 1 when output must be received
 * first, a negative libavcodec error otherwise. */
int wm_send(decoder *d, uint8_t *data, int size, int pts, int key) {
  int r;
  if (size == 0) r = avcodec_send_packet(d->context, 0);
  else {
    av_packet_unref(d->packet);
    d->packet->data = data;
    d->packet->size = size;
    d->packet->pts = pts;
    d->packet->dts = AV_NOPTS_VALUE;
    d->packet->flags = key ? AV_PKT_FLAG_KEY : 0;
    r = avcodec_send_packet(d->context, d->packet);
    d->packet->data = 0;
    d->packet->size = 0;
  }
  return r == AVERROR(EAGAIN) ? 1 : r;
}

/* 1: a frame is available through the accessors; 0: more input is needed; 2: drained;
 * negative: a decode error. */
int wm_receive(decoder *d) {
  av_frame_unref(d->frame);
  int r = avcodec_receive_frame(d->context, d->frame);
  if (r == AVERROR(EAGAIN)) return 0;
  if (r == AVERROR_EOF) return 2;
  if (r < 0) return r;
  if (d->context->codec_type == AVMEDIA_TYPE_VIDEO)
    return d->frame->format == AV_PIX_FMT_YUV420P ? 1 : -1000;
  /* Audio: planar float, as libswresample converts each sample format. */
  int channels = d->frame->ch_layout.nb_channels, n = d->frame->nb_samples;
  if (channels * n > d->pcm_capacity) {
    float *p = realloc(d->pcm, sizeof(float) * channels * n);
    if (!p) return -1001;
    d->pcm = p;
    d->pcm_capacity = channels * n;
  }
  for (int ch = 0; ch < channels; ch++) {
    float *out = d->pcm + ch * n;
    switch (d->frame->format) {
    case AV_SAMPLE_FMT_FLTP: memcpy(out, d->frame->extended_data[ch], sizeof(float) * n); break;
    case AV_SAMPLE_FMT_S16P: {
      const int16_t *in = (const int16_t *)d->frame->extended_data[ch];
      for (int i = 0; i < n; i++) out[i] = in[i] * (1.0f / (1 << 15));
      break;
    }
    case AV_SAMPLE_FMT_S32P: {
      const int32_t *in = (const int32_t *)d->frame->extended_data[ch];
      for (int i = 0; i < n; i++) out[i] = in[i] * (1.0f / 2147483648.0f);
      break;
    }
    default: return -1002;
    }
  }
  return 1;
}

int wm_width(decoder *d) { return d->frame->width; }
int wm_height(decoder *d) { return d->frame->height; }
int wm_pts(decoder *d) {
  int64_t t = d->frame->pts != AV_NOPTS_VALUE ? d->frame->pts : d->frame->best_effort_timestamp;
  return t == AV_NOPTS_VALUE ? -1 : (int)t;
}
int wm_picture_type(decoder *d) { return d->frame->pict_type; }
uint8_t *wm_plane(decoder *d, int i) { return d->frame->data[i]; }
int wm_stride(decoder *d, int i) { return d->frame->linesize[i]; }
int wm_samples(decoder *d) { return d->frame->nb_samples; }
int wm_channels(decoder *d) { return d->frame->ch_layout.nb_channels; }
int wm_sample_rate(decoder *d) { return d->frame->sample_rate; }
float *wm_pcm(decoder *d) { return d->pcm; }
