# YU-RIS

The TypeScript runtime reads YPF archives, YBN tables and scripts and executes the YU-RIS task VM. It implements the native variable and expression model, control flow, input, windows, layers, text, sound, file operations, PRODUCT and save buffers. Host interfaces supply platform services; the engine does not choose behavior by game name.

## Native evidence

Addresses in source comments are virtual addresses in `hajiron.exe`, SHA-256 `feb81d5e34bb7ecd784e61f476a0f321a4c4dddb88956f212eac21b55bbba043`. Addresses starting with `100` and explicitly named DLLs refer to those libraries, including YSWBP.DLL's libwebp decoder. EXE and DLL files are static evidence and resource containers; they are never executed or emulated.

YPF registration follows 0x464A3C, including ignoring files without an archive signature and overlaying update archives. YBN readers live in `src/formats/yuris`. VM code lives in `vm`; shared codecs and browser/OS services live outside the engine.

## Verification

After `npm run build:runtime`, run `node tools/verify-yuris.mjs /path/to/installation` to check archive name/data hashes, inflation and all script tables. Add `--webp` to decode every archived WebP and print a combined BGRA hash. `node tools/verify-webp.mjs` requires `cwebp` and `dwebp` on PATH and compares synthetic lossless/lossy/alpha fixtures byte for byte. `tests/webp.test.mjs` checks small synthetic fixtures without external binaries. No verification needs to display game images.

The shared WebP decoder emits straight BGRA and supports VP8L, VP8 and VP8X with ALPH. Its default color conversion matches modern libwebp, whose intermediate fixed-point products round differently from libwebp 0.4. YU-RIS hosts must pass `true` as `decodeWebp`'s second argument to select the native 14-bit scalar conversion (YSWBP.DLL 0x10021090 and related upsamplers). Animated WebP is rejected.

YMV (0x45886C) is a YSMV container of independently indexed, XOR-obfuscated color and grayscale alpha JPEG pairs. The movie belongs to the shared CG object and is released by YMVEND or its final layer reference. YMVINFO reads the container metadata; FRAME clamps to the first/last frame. DIALOG (0x43CD48) uses shared modal message/input services. Its FILEOPEN branch and the additional checkbox/slider arguments are unused in this executable.

CGACT TEXT (0x427D0F) consumes FONT's monochrome glyph DIB and measured advance (0x442390). Its native CPU rasterizers (0x4298D0/0x42B444) support 4x4 coverage, straight-alpha blending, mono replacement, all gradient/rotation modes and SET's offset passes. The text operation continues to later CGACT tests; it does not consume a following COPY or MERGE operation.

MOVIE/MOVIEEND/MOVIEINFO (0x44A010/0x44A5FC/0x44A650) use physical folder files and OS media services, separately from YMV. The fixed native backend is DirectShow (0x59B790 = 1); its 4000·log10 volume conversion is preserved. Tasks continue during playback, while window composition/output pauses unless PRODUCT COM 0x1B enables it.

MENU/MENUACT/MENUEND/MENUINFO (0x448F74..0x449570) maintain a separate M0 tree.
Menu installation takes a snapshot in Z order: E hides entries, A disables them,
CHECK marks them, empty NAME creates a separator, and groups with children create submenus.
WM_COMMAND exposes the selected CODE's low word through system variable 0x84.
Popup menus remain inside the browser viewport and outside the owner's clipping.
Virtual hide/show preserves a minimized window's iconic state; restoration delivers
activation before the VM's foreground suspension check (0x45D738 / 0x41022A).
WINDOW MENUID installs a window menu; TRAY (0x452FB4) retains its label, optional
16x16 BGRA icon and independently installed menu snapshot.

## Host differences

- Menus and the tray use page controls instead of OS chrome. The default application tray icon is represented by its label. Menu labels have dynamic storage rather than the native 0x105-byte allocation.
- PRODUCT caption uses a dynamically sized string rather than a fixed native buffer.
- GBK messages cross the host boundary already decoded.
- LOAD integer/float writes clamp to the allocated destination.
- Snappy and zlib output is compatible but does not reproduce native compressed bytes.
- Serialized layer structs contain zeros except for the sizes.
- Memory snapshots omit a native zlib allocation bound.
- Host write failures propagate instead of raising native error 0x18EFC.
- LOAD without FILE or MEM uses an empty filename.
- The TEXT line buffer is not bounded to 0x1000 bytes.
- CGACT TEXT bounds DIB and destination accesses to their allocated storage; invalid glyph sizes that divide by zero in the native rasterizer raise RangeError.
- MATH3D uses JavaScript double precision instead of x87 80-bit intermediates.
- GRADATION retains the native full-source stride for a cropped destination, but discards writes outside the allocated buffer instead of corrupting memory. Vertical ramps also discard rows outside the source height.
- ROTATION discards accesses outside allocated pixel storage. Fresh output buffers start at zero instead of exposing native malloc contents in regions its worker leaves unwritten. Its trigonometric intermediates use JavaScript doubles instead of x87 extended precision.
- YMV frame JPEGs are decrypted into owned copies rather than mutating the archive buffer.
- JPEG decoding uses the browser codec instead of the native libjpeg build; numeric readback can differ, including one-level channel differences in grayscale alpha JPEGs.
- The browser MOVIE host uses its installed media codecs and a child video element in the virtual window, rather than DirectShow filters or MCI. Codec availability, color conversion and scheduling follow the browser.

## Browser player

`yuris.html` opens a read-only folder selection and applies `updateN.ypf` after `pac/`. Browser saves use an IndexedDB overlay keyed by archive-index identity; the installed files are never written. `YurisBrowserPlayer` binds the VM to shared page windows, monochrome font rasterization, codecs, folder storage, registry, dialogs and mutable PCM output. Pointer coordinates are scaled from the displayed canvas to game pixels (0x403F2C).

The browser can compose the main window with integer WebGL2 textures for supported flat mode-0 layers, rule transitions, SIZE2 scaling and unmasked additive layers. Script pixel access materializes the native BGRA window on demand. Unsupported layer trees and unavailable hardware rendering use the software compositor. Both paths present an opaque BGRX window through Canvas 2D, matching the native GDI copy (0x45ECF4). PNG and WebP loaders retain the native alpha-blitter flag for layer composition.

CGCASH (0x43E0C8, loader 0x417DDC) queues PNG and WebP decodes on shared browser workers. Its prepared cache has a 160 MiB budget, partitioned into 56 MiB for WebP, 68 MiB for PNG files with at least 2 MiB of encoded data, and 36 MiB for smaller PNG files. A separate 96 MiB cache handles foreground decodes. Each layer receives mutable pixels of its own, and the loader verifies the encoded bytes before reusing a decode. The cache stores uniform decoded buffers as a single packed pixel.

Large software blends and SIZE2 can use WebAssembly SIMD with the native integer rounding. The compositor can evaluate an unchanged source layer's pending SIZE2 transform for only the damaged rectangle. Script pixel reads still resolve the full image. The VM can batch validated in-bounds array initialization and forward shifts and skip empty iterations of array guards, including guarded IF/ELSE chains. It recognizes bytecode for the library's CP932 substring, character search, lexer loops and two-range lookups. These paths keep the VM's scratch variables and replay the last skipped iteration where necessary. Instruction tracing uses the interpreter for any range the observer reads.

Game options connects the virtual main window to the shared fullscreen controls. True fullscreen uses browser user activation. Native fullscreen can fall back to a page-filling view until a player clicks Enter fullscreen.

DOM text uses the shared selectable glyph presentation for the standard `es.SJISCODE.DRAW.ONE` atlas library layout. Glyph provenance follows CGACT merges and copies into the display. The Sarasa Gothic SC atlas family carries GBK bytes through the same library. The native BGRA buffers remain available to saves and readbacks, while the DOM view presents a separate textless plane. Browser font shape and the effects of the native atlas passes are approximate. Image-only glyphs and independent CGACT TEXT rasterizers remain in the bitmap. Sound buffers use the shared mutable PCM processor in an AudioWorklet (or the shared ScriptProcessor compatibility host). The browser frame boundary acknowledges buffer commands and reads the actual audio render cursor; synchronous VM cursor reads use that last acknowledgement. This can lag within a frame, unlike the native sound thread. Pitch changes alter sample consumption in the render processor.

Long Ogg sounds open from the worker's Vorbis headers and begin playback once the first required half-buffer is ready. The worker decodes the remaining PCM in order. Each fill waits for the samples it reads, including when a script seeks ahead (0x41CCDC, 0x41DEC0).

Atlas dialogue from `es.TX.OUTPUT.ONE` supplies the configured full-width advance to DOM text. Browser tracking stays fixed as glyphs are revealed, with punctuation shaped by the browser font.

Browser windows live on a virtual desktop; fullscreen, activation, screen wake locks and process operations use the shared browser platform policy. Local Windows executables are never launched. The font provider offers CSS family aliases and uses browser fallback fonts where a native family is unavailable; glyphs therefore need not match Windows GDI. SimHei text uses GBK and the Japanese aliases use CP932. Browser image encoders may produce different compressed output and alpha rounding from native encoders. Invalid ONMOUSE window zero is mapped to the main window rather than reading before the native window pointer array.
