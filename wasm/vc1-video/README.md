# VC-1 pixel kernels

This crate supplies the pixel operations of `src/formats/vc1/dsp.ts` in Rust and
WebAssembly SIMD. The host in `src/formats/vc1/wasm-decoder.ts` reserves the
coefficient ring, edge-emulation buffer and rotating picture planes in one
private instance. Kernels receive offsets into that memory and do not allocate
or copy individual blocks. Compressed input parsing and prediction state belong
to `src/formats/vc1/reference.ts`.

The 8×8 inverse transform processes four columns at a time. Interpolation uses
four-lane integer vectors, clipping before averaging; smaller transforms and
loop filters preserve the reference's pass order and rounding. Signed 16-bit
coefficient storage wraps at each transform pass, while pixel output saturates.
Scratch arrays live on the Wasm stack, and kernels make no host calls.

Build with `npm run build:wasm -- vc1-video`. The dependency-free crate targets
`wasm32-unknown-unknown` with SIMD enabled. Its embedded output in
`src/formats/vc1/wasm-binary.ts` is checked in. The host falls back to JavaScript
when the module or its bounded storage is unavailable.

`tests/vc1-video.test.mjs` compares synthetic pictures and pixel operations with
the reference. `tools/benchmark-vc1.mjs` compares complete decoded output and
throughput with a baseline Windows Media decoder, without displaying media.

Derived from FFmpeg 7.1.1; distributed under LGPL 2.1 or later. Copyright notices
and license terms are in `src/formats/vc1/NOTICE` and `src/formats/vc1/LICENSE`.
