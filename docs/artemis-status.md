# Artemis implementation status

The exact supported reconstruction target is Artemis Rev.3179 from Hatsuyuki Sakura,
executable SHA-256 `8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf`.
Artemis is still under development and does not have a production player profile.

The archive/ASB readers and Lua 5.1 runtime can run the game's Lua initialization
in a metadata-only diagnostic probe. That probe supplies explicit simulated hosts
for selected native services; reaching a tag is not proof that the game is playable.
Its current unsupported boundary is `print`, which needs an actual text-layer owner.

The text foundations now include:

- Native font-property stacks, selected message layers, Unicode break controls,
  and text-effect descriptor vectors. `scetween` initializes/appends configuration;
  these operations do not start an animation.
- A shared, memory-only FreeType **2.4.8** WebAssembly runtime with a dedicated font
  worker. This historical version follows the target's library-version constants.
  File-font owners share faces while size selection is atomic for each raster job.
- A separate glyph-paint worker reproducing the supported grayscale branch,
  including square outlines, shifted shadows, underline and strikeout metrics.
- `ArtemisTextGlyphs`, which combines fonts and painted resources into normal/ruby
  blocks, sharing pending jobs and bounding the glyph cache. Closing the cache
  releases font loans; a frame retaining painted pixel storage remains valid.
- Native unindented wrapping, prohibited-head/foot transfers, hanging punctuation,
  explicit newlines and overflow mutation. Native single-character block flags
  include the first-block prohibition exception after newline. Indented layers
  need a separate owner.
- Native block spacing, ruby distribution, reserved line height, line alignment,
  and append/pop geometry. `artemisUtf8TextRuns` provides native word grouping and
  byte spans needed to resume overflowed print data. Legacy encodings and partial
  UTF-8 scratch-buffer boundaries are explicitly unsupported.
- A print controller for history, ruby buffering, overflow variables and queued
  remainder commands. Its insertion callback is mandatory; it cannot claim output
  without a text-layout owner.

The native reference entries are `195720` (UTF-8 runs/insertion), `1971e0`
(block construction), `198690` (wrapping), `197f40`/`197fd0`/`198080` (line geometry),
`16a0a0` (file fonts), `166420` (glyph painting), and `cc6c0` (print controller).
These are RVAs from the executable's `0x140000000` image base. Raw instruction
exports and body hashes are kept outside the engine repository in the analysis
workspace. Decompiled types alone are not authoritative ABI evidence.

The nonvisual `tools/probe-artemis-fonts.mjs` reads only encoded font data and
reports FreeType/CELL/native metrics. The actual game
`font/notosansjp-medium.ttf` opens successfully at sizes58/22 (yPpem40/15,
native baseline46/17); this check does not rasterize any glyph.

Tests generate their own rectangle TrueType font, exercise both actual workers,
compare geometry and pixels, verify cancellation/retry/cache eviction, and render
normal/ruby glyphs through the browser GPU. No game font or decoded game image is
included in these fixtures.

Next implement the text-layer owner: connect wrapping and glyph blocks,
indent stacks, resource/display ownership and UTF-8 consumed offsets. Connect it to
print, then supply scene/frame effects and completion events. Production integration
also needs the remaining commands/transitions/masks, media, input, save/load and
real game regression coverage. Existing image workers and ordinary/captured/group
GPU paths are available as foundations for that integration.
