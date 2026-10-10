import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

// Builds the Windows Media decoder (WMV3 video; WMA Standard, Pro and Lossless audio) from the
// FFmpeg 7.1.1 libavcodec/libavutil subset in wasm/windows-media/vendor with the flags FFmpeg's
// configure chose for that subset (see wasm/windows-media/README.md).
const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = 'wasm/windows-media/vendor';
const sources = [
  'libavcodec/aactab.c',
  'libavcodec/allcodecs.c',
  'libavcodec/avcodec.c',
  'libavcodec/bitstream.c',
  'libavcodec/bitstream_filters.c',
  'libavcodec/blockdsp.c',
  'libavcodec/bsf.c',
  'libavcodec/codec_desc.c',
  'libavcodec/codec_par.c',
  'libavcodec/decode.c',
  'libavcodec/encode.c',
  'libavcodec/error_resilience.c',
  'libavcodec/faanidct.c',
  'libavcodec/get_buffer.c',
  'libavcodec/h264chroma.c',
  'libavcodec/hpeldsp.c',
  'libavcodec/idctdsp.c',
  'libavcodec/intrax8.c',
  'libavcodec/intrax8dsp.c',
  'libavcodec/jrevdct.c',
  'libavcodec/lcevcdec.c',
  'libavcodec/lossless_audiodsp.c',
  'libavcodec/mathtables.c',
  'libavcodec/me_cmp.c',
  'libavcodec/mpeg_er.c',
  'libavcodec/mpegpicture.c',
  'libavcodec/mpegutils.c',
  'libavcodec/mpegvideo.c',
  'libavcodec/mpegvideo_dec.c',
  'libavcodec/mpegvideo_motion.c',
  'libavcodec/mpegvideodata.c',
  'libavcodec/msmpeg4_vc1_data.c',
  'libavcodec/options.c',
  'libavcodec/packet.c',
  'libavcodec/profiles.c',
  'libavcodec/qpeldsp.c',
  'libavcodec/refstruct.c',
  'libavcodec/simple_idct.c',
  'libavcodec/sinewin.c',
  'libavcodec/startcode.c',
  'libavcodec/threadprogress.c',
  'libavcodec/to_upper4.c',
  'libavcodec/utils.c',
  'libavcodec/vc1.c',
  'libavcodec/vc1_block.c',
  'libavcodec/vc1_loopfilter.c',
  'libavcodec/vc1_mc.c',
  'libavcodec/vc1_pred.c',
  'libavcodec/vc1data.c',
  'libavcodec/vc1dec.c',
  'libavcodec/vc1dsp.c',
  'libavcodec/videodsp.c',
  'libavcodec/vlc.c',
  'libavcodec/wma.c',
  'libavcodec/wma_common.c',
  'libavcodec/wma_freqs.c',
  'libavcodec/wmadec.c',
  'libavcodec/wmalosslessdec.c',
  'libavcodec/wmaprodec.c',
  'libavcodec/wmv2data.c',
  'libavcodec/wmv2dsp.c',
  'libavutil/audio_fifo.c',
  'libavutil/avsscanf.c',
  'libavutil/avstring.c',
  'libavutil/bprint.c',
  'libavutil/buffer.c',
  'libavutil/channel_layout.c',
  'libavutil/cpu.c',
  'libavutil/dict.c',
  'libavutil/error.c',
  'libavutil/eval.c',
  'libavutil/fifo.c',
  'libavutil/file_open.c',
  'libavutil/float_dsp.c',
  'libavutil/frame.c',
  'libavutil/hwcontext.c',
  'libavutil/imgutils.c',
  'libavutil/log.c',
  'libavutil/log2_tab.c',
  'libavutil/mastering_display_metadata.c',
  'libavutil/mathematics.c',
  'libavutil/mem.c',
  'libavutil/opt.c',
  'libavutil/parseutils.c',
  'libavutil/pixdesc.c',
  'libavutil/random_seed.c',
  'libavutil/rational.c',
  'libavutil/reverse.c',
  'libavutil/samplefmt.c',
  'libavutil/sha.c',
  'libavutil/time.c',
  'libavutil/tx.c',
  'libavutil/tx_double.c',
  'libavutil/tx_float.c',
  'libavutil/tx_int32.c',
  'libavutil/utils.c',
  'libavutil/video_enc_params.c',
];
const exports = [
  'malloc',
  'free',
  'wm_open',
  'wm_close',
  'wm_alloc',
  'wm_free',
  'wm_send',
  'wm_receive',
  'wm_width',
  'wm_height',
  'wm_pts',
  'wm_picture_type',
  'wm_plane',
  'wm_stride',
  'wm_samples',
  'wm_channels',
  'wm_sample_rate',
  'wm_pcm',
];
const emcc = process.env.EMCC || 'emcc';
const flags = [
  '-O3',
  '-msimd128',
  '-std=c17',
  '-fomit-frame-pointer',
  '-fno-math-errno',
  '-fno-signed-zeros',
  '-D_ISOC11_SOURCE',
  '-D_FILE_OFFSET_BITS=64',
  '-D_LARGEFILE_SOURCE',
  '-D_POSIX_C_SOURCE=200112',
  '-D_XOPEN_SOURCE=600',
  '-I' + vendor,
  '-w',
];
const run = (args) => {
  const result = spawnSync(emcc, args, {cwd: root, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Windows Media wasm build exited ' + result.status);
};
const dir = await mkdtemp(join(tmpdir(), 'vn-windows-media-'));
try {
  const objects = [];
  for (const source of sources) {
    const object = join(dir, source.replaceAll('/', '_').replace(/\.c$/, '.o'));
    const library = source.split('/')[0].slice(3);
    run([
      ...flags,
      '-DHAVE_AV_CONFIG_H',
      '-DBUILDING_' + library,
      '-c',
      join(vendor, source),
      '-o',
      object,
    ]);
    objects.push(object);
  }
  const output = join(dir, 'windows-media.wasm');
  run([
    ...flags,
    'wasm/windows-media/bridge.c',
    ...objects,
    '--no-entry',
    '-sSTANDALONE_WASM=1',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sINITIAL_MEMORY=33554432',
    '-sMAXIMUM_MEMORY=536870912',
    '-sSTACK_SIZE=1048576',
    '-sFILESYSTEM=0',
    '-sEXPORTED_FUNCTIONS=' + JSON.stringify(exports.map((n) => '_' + n)),
    '-o',
    output,
  ]);
  const bytes = await readFile(output);
  await writeFile(
    join(root, 'src/video/windows-media-wasm-binary.ts'),
    '// Generated by tools/build-windows-media.mjs from FFmpeg 7.1.1 (LGPL-2.1-or-later). Do not edit.\n// prettier-ignore\nexport const WINDOWS_MEDIA_WASM_BINARY = ' +
      JSON.stringify(bytes.toString('base64')) +
      ';\n',
  );
  console.log('Windows Media wasm bytes:', bytes.length);
} finally {
  await rm(dir, {recursive: true, force: true});
}
