# YU-RIS

The TypeScript runtime reads YPF archives, YBN tables and scripts and executes the YU-RIS task VM. It implements the native variable and expression model, control flow, input, windows, layers, text, sound, file operations, PRODUCT and save buffers. Host interfaces supply platform services; the engine does not choose behavior by game name.

## Native evidence

Addresses in source comments are virtual addresses in `hajiron.exe`, SHA-256 `feb81d5e34bb7ecd784e61f476a0f321a4c4dddb88956f212eac21b55bbba043`. Addresses starting with `100` and explicitly named DLLs refer to those libraries, including YSWBP.DLL's libwebp decoder. EXE and DLL files are static evidence and resource containers; they are never executed or emulated.

YPF registration follows 0x464A3C, including ignoring files without an archive signature and overlaying update archives. YBN readers live in `src/formats/yuris`. VM code lives in `vm`; shared codecs and browser/OS services live outside the engine.

## Verification

After `npm run build:runtime`, run `node tools/verify-yuris.mjs /path/to/installation` to check archive name/data hashes, inflation and all script tables. `node tools/verify-webp.mjs` requires `cwebp` and `dwebp` on PATH and compares synthetic lossless/lossy/alpha fixtures byte for byte. `tests/webp.test.mjs` checks small synthetic fixtures without external binaries. No verification needs to display game images.

The shared WebP decoder emits straight BGRA and supports VP8L, VP8 and VP8X with ALPH. Its default color conversion matches modern libwebp, whose intermediate fixed-point products round differently from libwebp 0.4. YU-RIS hosts must pass `true` as `decodeWebp`'s second argument to select the native 14-bit scalar conversion (YSWBP.DLL 0x10021090 and related upsamplers). Animated WebP is rejected.

## Host differences

- PRODUCT caption uses a dynamically sized string rather than a fixed native buffer.
- GBK messages cross the host boundary already decoded.
- LOAD integer/float writes clamp to the allocated destination.
- Snappy and zlib output is compatible but does not reproduce native compressed bytes.
- Serialized layer structs contain zeros except for the sizes.
- Memory snapshots omit a native zlib allocation bound.
- Host write failures propagate instead of raising native error 0x18EFC.
- LOAD without FILE or MEM uses an empty filename.
- The TEXT line buffer is not bounded to 0x1000 bytes.
- MATH3D uses JavaScript double precision instead of x87 80-bit intermediates.
