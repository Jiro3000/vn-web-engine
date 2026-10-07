# FreeType 2.4.8

Portions of this software are copyright © 2011 The FreeType Project
(www.freetype.org). All rights reserved.

This project uses the FreeType License (FTL), reproduced in LICENSE.txt and emitted
as assets/freetype.LICENSE.txt by the website build. Original upstream notices and
license choices remain in wasm/freetype/vendor/docs.

Source: https://download.savannah.gnu.org/releases/freetype/freetype-old/freetype-2.4.8.tar.bz2
SHA-256: a9eb7da3875fcb2f022a9c280c01b94ae45ac83d8102838c05dce1277948fb71.

Vendored upstream include files and base/sfnt/truetype/cff/smooth/raster/psnames/
pshinter/psaux modules are unmodified. Other drivers and compressed font adapters
are omitted. wasm/freetype/config selects these modules and disables compression
and Mac file adapters. system.c replaces upstream filesystem access with a memory
allocator and an unsupported file-open result. bridge.c is this project's adapter.
No game fonts or glyphs are bundled.

The shared src/text/freetype.ts service owns an isolated, bounded memory-only wasm
library and copied font bytes. freetype-worker-client.ts performs font/raster jobs
in a dedicated browser worker. FreeType provides glyphs and metrics; engines still
own layout, spacing, wrapping, effects and rendering.

Rebuild with Emscripten on PATH: node tools/build-freetype.mjs. EMCC can select
another compiler, and EM_CONFIG its config. The embedded wasm uses Emscripten
6.0.11 with wasm longjmp/exception support. Normal builds use the checked-in binary.

This historical version is selected for the exact Artemis reconstruction: native
library initialization writes version 2.4.8. Other engines must choose their own
font owner/version explicitly; this service does not substitute installed fonts.
