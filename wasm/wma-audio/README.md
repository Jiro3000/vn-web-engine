# WMA audio kernels

Rust implementation of the WMA Lossless entropy decoder, wrapping integer
adaptive predictors and stereo reconstruction. The TypeScript packet/tile front
end and JavaScript fallback live in `src/formats/wma`.

Build the checked-in embedded module with:

```sh
npm run build:wasm -- wma-audio
```

The crate has no dependencies, imports or allocator. The host reserves a bounded
arena and passes pointers to internal typed arrays. SIMD dot products read
signed 16/32-bit histories and update signed 16-bit LMS coefficients with exactly
the scalar decoder's modulo arithmetic. No floating-point transform is used.

Derived from FFmpeg 7.1.1 under LGPL 2.1 or later; attribution and license text are
in `src/formats/wma/NOTICE` and `src/formats/wma/LICENSE`.
