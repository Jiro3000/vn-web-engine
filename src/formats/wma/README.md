# WMA audio

`WmaLosslessDecoder` in `lossless.ts` decodes complete ASF audio media objects
to caller-owned planar float, retaining packet timestamps and the decoder's
end-of-stream sample trim. `decode(null)` drains the bit reservoir; further
drain calls return an empty array. `close()` is idempotent.

The supported Lossless configuration is stereo, 16 or 24 bits, 44.1 or 48 kHz,
channel mask 3 and compression flags `0x1a1`. Frames contain 2048 samples per
channel, split into as many as sixteen variable-length tiles. The decoder
implements raw PCM, adaptive Rice residues, cascaded LMS prediction,
multichannel LMS prediction, stereo decorrelation, AC prediction, quantization
and padding. Arithmetic coding, splicing and the inverse LPC tool are rejected.
The latter also lacks a working inverse filter in the source decoder.

`createWmaLosslessDecoder` in `wasm-decoder.ts` constructs the shared TypeScript
front end with the Rust SIMD backend, or returns `null` if WebAssembly SIMD is
unavailable. The caller can then construct the JavaScript implementation. Each
accelerated instance reserves a private 512 KiB arena before creating typed-array
views. Reservoir, coefficients, prediction histories and reconstruction buffers
remain in that arena. Entropy decoding and cascaded prediction cross the ABI
once per coded channel per tile; stereo/AC reconstruction crosses once per tile.
The JavaScript implementation uses the same wrapping integer arithmetic and
reusable typed arrays, without allocating in sample loops.

Codec packets are bounded to 64 KiB, compressed media objects to 16 MiB and the
bit reservoir to 64 KiB. The bit reader is shared with `../vc1/bitstream.ts`.
No codec packet is read from disk by this module. ASF demuxing belongs to
`../asf`; the player owns scheduling and worker execution.

`tests/wma-lossless.test.mjs` generates synthetic raw PCM and adaptive-prediction
packets, including signed samples, end trim and isolation checks. No media
fixture is required. `tools/benchmark-wma.mjs` compares PCM hashes and warmed
decode timings against an existing decoder build without displaying or saving
decoded audio.

The implementation is derived from FFmpeg 7.1.1 under LGPL 2.1 or later. See
[NOTICE](NOTICE) and [LICENSE](LICENSE).

`WmaStandardDecoder` in `standard.ts` implements stereo WMA v2 with VLC exponents,
bit reservoir and five variable block sizes (128 through 2048). Supported streams
have flags `0x000f`, 44.1/48 kHz rates and bitrates that disable noise coding.
Spectral run/level decoding, independent or mid/side stereo, float IMDCT and
overlap windows preserve the source decoder's float operation order. The first
4096 samples are suppressed, with the corresponding packet timestamp adjustment;
draining returns the final 2048 samples of overlap output.

`imdct.ts` supplies the power-of-two split-radix inverse MDCT and bounded sine
window caches. The float angle is rounded before evaluating each window's sine.
Transform calls use caller-supplied buffers and allocate no temporary arrays.
`standard-tables.ts` contains exponent, coefficient and frequency-band tables.
Standard packets are bounded to 32 KiB, media objects to 16 MiB and the reservoir
to 32 KiB. The Standard implementation currently runs in TypeScript; its Rust
backend is separate from the Lossless factory. Pro decoding is not supported.
