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
[NOTICE](NOTICE) and [LICENSE](LICENSE). WMA Standard and Pro are separate codec
variants; this module does not yet implement them.
