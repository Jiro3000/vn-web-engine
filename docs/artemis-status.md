# Artemis implementation status

The exact supported reconstruction target is Artemis Rev.3179 from Hatsuyuki Sakura,
executable SHA-256 `8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf`.
Artemis is still under development and does not have a production player profile.

The archive/ASB readers and Lua 5.1 runtime can run the game's Lua initialization
in a nonvisual diagnostic probe. Selected services still use explicit diagnostic
hosts; reaching a command is not proof that the game is playable. The default
probe refuses `print`. With `--glyph-layout --surface-preloads --sound-decode`,
actual font/glyph/image/Vorbis workers run and real surface resources are retained.
The latest real probe reaches637 native tags and44 resource resumptions, decodes
68 UI images and one Ogg clip, then refuses the nonvisual playback owner. No game
assets are displayed and no audio device output is opened.

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
- Native wrapping with nested indentation stacks, range/logical-range checks,
  prohibited-head/foot transfers, hanging punctuation, explicit newlines and
  overflow mutation. Single-character block flags preserve the first-block
  prohibition exception after newline.
- Logical text insertion joining these components with actual glyphs and UTF-8
  consumed offsets, counter rollback, font snapshots, native frame preparation,
  metric queries and independently mutable copies sharing painted storage.
- Native block spacing, ruby distribution, reserved line height, line alignment,
  and append/pop geometry. `artemisUtf8TextRuns` provides native word grouping and
  byte spans needed to resume overflowed print data. Legacy encodings and partial
  UTF-8 scratch-buffer boundaries are explicitly unsupported.
- A print controller for history, ruby buffering, overflow variables and queued
  remainder commands. Its insertion callback is mandatory; it cannot claim output
  without a text-layout owner.

- Native `ruby`/`/ruby` buffering and whole-block insertion, including retry queue
  behavior that retains active buffers after automatic page overflow.
- `rt` newline and `rp` history/backlog/font maintenance with a mandatory resource
  clear host. The insertion owner implements the empty-outgoing-effects clear
  branch; a complete scene owner still must cancel jobs and handle nonempty effects.

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

The optional real glyph probe processes six calibration glyphs using both workers,
records metrics and RGBA hashes, and verifies that `rp` clears their logical layer.
It neither publishes frames nor displays game assets. At the tested font settings,
the line is246 units wide and56 high before clear, then all counters/metrics return
to zero. The font file is read from the installation and is not redistributed.

The asynchronous surface owner now implements native FIFO preparation, foreground
promotion, script/image loans, cancellation, conditional budget drops, inactive
retention and stale-result handling. Message-layer actors attach to the common
scene, with actual wrapper/frame references and copy/release hooks.

SE play/stop command owners preserve native skip, replacement, variable gain,
replay history, asynchronous suspension and cancellation. `ArtemisEffectVoices`
owns actual voices and integer fade tasks; the browser adapter uses shared WebAudio
with independent stereo attenuation, loop/reset controls and offline test contexts.
Filename resolution preserves native preferred suffix/sniff/appended candidates;
the revision-selected factory installs verified Vorbis-before-WAVE plugins.
The encoded WAVE owner preserves native headers, paired A/B reads and B-only reset.
Native PCM16 conversion and buffered=-1 codec services now use actual reusable
Vorbis/integer-PCM workers. Cached repeat includes the whole A+B clip; progressive
B-only refill now uses a native two-half ring and actual AudioWorklet voices.
Engine scheduler ticks pump inactive halves; device callbacks advance the cursor. The diagnostic supplies
Ogg-only registration by default. Optional `--sound-render` consumes actual PCM
through native voice owners, without an audio device. It supports sound-finish
registration, then requires a graphics feature owner. An explicitly simulated
feature-level diagnostic reaches the next unsupported `lyshader` command.

Build and218 focused tests pass. The full1892-test suite has1855 passes and the
same37 baseline failures, with no new failing names. Synthetic browser checks
cover real font/image workers, GPU scenes and sound lookup through actual offline
WebAudio voices. These checks do not establish production game compatibility.

Next complete message display/links/effects/jobs, native codec/buffer-mode behavior
and production scheduler/audio wiring. Remaining commands/transitions/masks,
media, input, save/load and the production game profile still require implementation
and real game regression coverage. Engineering completion is roughly54% (a broad
45–60% estimate), not story coverage or proof of a playable game.

The named shader registry recognizes all twenty original DX11 source signatures
with executable CPU ports and actual WebGL2 programs. Native lyshader registration
is independent of layer existence. Nonvisual probing completes all shader loads,
then reaches authentication() in init.lua. The distributed auth.lua is empty;
native file-existence/lookup behavior is under investigation. Actor shader binding
and uniform jobs remain separate from preset compilation.

CLayer shader state now owns ordered constants and retained texture leases.
All twenty executables also run through the shared DrawList renderer, verified
against dedicated WebGL outputs. Native reflection/preparation/default constants
and per-actor ImageGraphics wiring remain separate required work.
