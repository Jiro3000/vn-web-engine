# Artemis implementation status

The supported reconstruction target is Artemis Rev.3179 from Hatsuyuki Sakura,
executable SHA-256 `8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf`.
Other executables are refused by hash.

## What exists

- Engine runtime (`src/engines/artemis/runtime.ts`): every native tag owner, the Lua 5.1
  runtime, the script, reset, save and load, driven by `frame(now, input)` over host
  services. See the engine [README](../src/engines/artemis/README.md).
- Browser player (`src/engines/artemis/browser/`, page `artemis.html`, controller
  `ui/runtimes/artemis.ts`): WebGL stage with image, animation, video, group and text
  layers, crossfade and rule transitions, FreeType glyphs, Web Audio effect and music
  voices, named shaders, message-box dialogs, IndexedDB save storage and
  pointer/keyboard input with image hit testing. The page reports Windows 10 and
  Direct3D feature level 11_0. Over the real installation it boots, takes the language
  choice, reaches the title menu, starts a new game and advances voiced scenario text
  through click-waits (nonvisual check: `#trace` diagnostics and canvas hashes only).
- Nonvisual probe (`tools/probe-artemis.mjs`): runs the same runtime over actual
  font, glyph, image and Vorbis workers, header-only layer geometry and offline PCM
  voices. It covers boot, the prologue with its fullscreen movies, the title, scenario
  text with click-waits, choices through layer events, and a scenario save/load round
  trip. It displays no game assets and opens no audio device.
- Synthetic browser checks (`tests/browser/artemis-images.html`): GPU scenes, shaders,
  font and image workers, sound lookup through offline Web Audio voices, the pointer
  hit test and the stage crossfade.

## Not implemented

- Layer event penetration and drag events; the click glyph (layer byte +0x16c).
- Nonempty `syncse`, scenario mode 2, `macroadd`, text-field dialogs.
- Fullscreen ASF movies play only where the browser supports the container; otherwise
  they complete immediately with a diagnostic.
