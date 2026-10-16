# Artemis revisions

The engine accepts an executable only by its SHA-256 (`src/engines/artemis/revision.ts`).
Unless a revision is stated explicitly, native addresses in the code and in
`src/engines/artemis/README.md` describe Rev.3179 executable `8953562b…ebaf`.
This file maps those addresses to Rev.3139
(`455676b09503309b82dc78d7bac45d2eeb1837bed9ec0ab41053d7d9bb298f9e`) and Rev.3257,
and records the behavioral differences selected by exact executable hash.

A second Rev.3139 executable, `852e457db9b3d84def9a892a1a93ea752152207f36106889229c50098068da43`
(`ARTEMIS_3139_RESOURCE_VARIANT_SHA256`), has the same PE timestamp (`0x64ef20ee`) and
byte-identical `.text`, `.rdata`, `.data`, `.pdata`, second `.text` and `_RDATA` sections;
only `.rsrc` and the header fields that size it (SizeOfInitializedData, SizeOfImage,
CheckSum, the resource directory size and the `.rsrc` section header) differ. It shares
every Rev.3139 address and field below.

## Rev.2868 (PE32)

Ryuusei World Actor: Badge & Dagger executable SHA-256
`e551146298aa98987b5965964610c909ae8f2c06ab3ac536a733b4bc1e9bbcde`
selects an independent x86 profile: image base `0x400000`, entry `0x68167c`,
PE timestamp `0x608e9c71`. Boot `0x539360` publishes Rev.2868,
`Sun May 2 21:34:14 2021`, support 1103 and save version 1003. It leaves
`s.llp64` and `s.windowsfeaturelevel` absent and preserves restored values;
its touch-registration query uses the PE32 touch owner at virtual `+0x44`.
The version and architecture do not select another executable's profile.

Actor parser `0x58ca90` accepts `shader` and `shaderconstant`, then returns
without a texture-path property. DX9 draw `0x5ce4d0` writes named effect
parameters through `SetFloatArray` at virtual `+0x80`; it does not use an
ordered constant buffer. FreeType open `0x5d64e0` receives a byte size, and
glyph `0x5d6a10` returns cell advance, byte-sized height and clamped bearings.
Painted-font restore `0x4a6280` reads the expanded key layout and real PNG
atlases. These select the existing DX9, 8-bit font, clipped-cell and expanded
cache owners. No additional font or shader behavior is inferred from the title.

Screenshot tag `0x5588b0` calls renderer virtual `+0x24`, `0x5d0200`, to copy
the presented DX9 target. Sound loaders `0x5f7e70` / `0x5f7f40` reuse an opened
file without rewinding. Vorbis `0x51a090` opens `0x603b80`; its path through
`0x501250`, `0x500fa0` and `0x4fff20` requests the initial exclusive `0x10000`
page-search boundary from `0x4ffb50`. Scenario loader `0x5b3020` uses replay
hold 13. Mode owner `0x53b8b0`, return `0x53dd20` and exit `0x53dd40` retain
exit mode 14 and force saves without publishing fullscreen-at-exit status.
Pack mount `0x512270` opens the base and existing numbered archives through
`.999`, retaining ascending override order and continuing after gaps.

The eight exact raw blur-source signatures in `dx9-shader.ts` select horizontal
or vertical convolution with optional mask and optional background composition.
All eight use eight symmetric weights and named width/height steps. Plain variants
ignore masks; mask variants sample the original foreground UV and multiply alpha
before the layer alpha. AA variants sample a separate captured-background UV,
compute straight output RGB/alpha, and disable device blending for that pass.
Their original game Lua selects intermediate format 2 for the AA path. Using an
AA shader outside a captured target is explicitly refused until retained Back
ownership for that native path is modeled. Existing nineteen-source DX9 programs
retain their prior behavior. All eight real sources compile; synthetic numeric
and Brave/Metal tests check masks, backdrop composition, blend state and UVs.
This installation contains no painted-font cache index, so that format is checked
against native code and synthetic real-PNG/FreeType fixtures rather than an
installation atlas.

Gameplay validation for this installation is pending. Its unmodified
`script.ini` enables SoftDenchi and expects executable CRC32 `e0000172`,
whereas the supplied executable has CRC32 `aacc732b`. The original
`softdc_init` / `getWindowsCrc` check therefore has a mismatched input pair.
Engine support neither rewrites this expectation nor disables authentication.
Synthetic runtime checks cover boot capabilities, fonts, shaders, cached glyphs,
exit saves and fresh scenario restoration; they do not establish that this
installation reaches its title or story. The build and all 327 targeted tests pass.
The full suite has 2,073 tests, 2,036 passes and exactly the same 37 named baseline
failures, with no skips or cancellations. Brave/Metal passes 100 synthetic DX9
cases, including the new variants. Fresh-process regressions restore identical
prior scenario hashes and continue for World Actor and Sakura no Toki. The one
Badge & Dagger movie fully decodes through shared ASF codecs: 2,594 video frames,
4,150,400 audio samples per channel and no failures; no frames are displayed.
Static evidence and receipts remain under `local-runtime/ryuusei-badge-dagger/`
in the surrounding workspace.

## Rev.2601 (PE32)

Ryuusei World Actor executable SHA-256
`38feda70823430350ae58086225ac4a983ab727bd68b4800c4bbeed285ea0123`
is an independent x86 build, image base `0x400000`, entry `0x5dd8a8`, PE timestamp
`0x5cd31dcb`. Only this exact identity selects its profile.

Boot `0x493520` publishes Rev.2601, `Thu May  9 03:14:56 2019`, support 1103 and
save version 1002. It neither writes nor deletes `s.llp64` or
`s.windowsfeaturelevel`; restored values survive, and later missing literal queries
create zero. It queries the registered-touch flag independently of contacts.
The profile uses DX9, byte-sized fonts and clipped-cell glyphs: FreeType open
`0x528170` narrows the size to a byte, and glyph `0x528400` uses cell advance and
clamps negative bearings. Sound loaders `0x5491d0` / `0x5492a0` reuse the opened
file without rewinding. The first-page Vorbis search has not been audited for
this revision; its profile retains the strict decoder.

The complete actor-property parser `0x4e1b70` ends after `visible`, with no custom
shader name, constant or texture lookup. `shaderProperties = false` leaves these
keys and their named values unconsumed, including malformed numeric values;
ordinary geometry still applies. The other supported exact identities retain their
shader behavior. Screenshot `0x4acc30` → `0x4854a0` calls renderer virtual `+0x24`,
`0x522370`, which copies the presented DX9 target rather than drawing a new scene.
Return `0x496d40` and exit `0x496d60` enter mode 14; `0x495130` preserves replay
hold 13 and forces saves without publishing fullscreen status. Scenario replay
`0x5061a0` enters hold 13. Pack open `0x53a550` merges the base and existing
`.000` through `.999` archives in ascending order, despite gaps, replacing prior
entries with later ones. The existing mount implementation is unchanged.

Font wrapper `0x49b8a0` and attributes `0x479a00` read `rubyface`, never the `ruby`
alias that game Lua forwards after resolving it. The shared font parser leaves
that alias out of the font state while keeping the resolved face and ruby size.
The installation also contains native Lua 5.1 `.lub` chunks. They join the prepared
script corpus and are validated when included; each include still executes normally.
Their 32-bit bytecode ABI matches the shared Lua module's checked loader.

Painted-font cache writer `0x402630` and restore `0x402c40` use a compact key:
face string, three u32 colors and one u32 packing character/size/style, followed
by atlas index and four inclusive float clip edges. Setter `0x525720` stores
byte size and bold/italic/underline/strike bits 0–3; glyph `0x525830` uses
shadow/outline bits 4–5 and forms `(style << 24) | (size << 16) | char16`.
`fontCacheKey = packed` selects this layout; Rev.2898/3083 retain expanded keys.
The cache consumes the declared count without requiring EOF, and cropped glyphs
still use the real atlas pixels. Failed or out-of-bounds records remain errors.

Native save writer `0x504a40` emits version 1002 with zlib compression. The web
runtime keeps its established canonical version-1003 browser containers; the
published native `s.savedataversion` remains 1002. Native version-1002 scenario
imports have not been validated. Evidence is kept in the surrounding workspace
under `local-runtime/ryuusei-world-actor/`; game scripts and activation state are
not patched or preset.

Lua registration `0x4f35a0` binds `convertEncoding` to `0x4f6300`. It reads
string-valued `from`, `to`, and `source` table fields; the source and result keep
their byte lengths, including embedded NUL. The browser binds explicit `sjis`
and `utf8` conversions using shared text codecs. Invalid tables or target names
produce the native level-1 argument report and nil. Native EUC/JIS conversion
and input auto-detection (`0x586390`, up to 8192 bytes) remain explicit refusals.
Conversion dispatch is `0x586350` → `0x587950`. No activation data is synthesized:
the unmodified game verifies the user's key and writes its own activation record.

HTTP GET `0x4b7510` enters mode 8, clears `s.http.cancel`, and starts
`0x4dd190`; frame `0x48fe40` polls `0x4dd0c0` or cancels and releases the mode.
Completion `0x4de830` publishes the actual HTTP status and C-string response bytes.
Request, connection and receive failures are -1, -2 and -3; cancellation leaves
result variables untouched. The browser and probe use the shared fetch host,
retaining browser CORS restrictions. Fetch has no native socket error pair, so
negative result messages use zero for those two unavailable details. Headers,
response-file output and POST remain refused. Frame handlers continue during the
wait, allowing the game's own update-check cancellation.

Layer tween handler `0x4a7090` and removal `0x4a9370` take the native replay flag.
The dispatcher forwards it through the layer owner, so saved looping tweens restart
without appending a second copy of their command on each scenario load. This fixes
save-state growth in the shared replay path while preserving ordinary recording.

Validation includes one complete nonvisual Chiffon route from native title/start:
23,484 delivered probe clicks and 11 first-option choices reach the original
`staffroll_start`, `staffroll_bgm`, `staffroll_scroll` and `staffroll_exit`, then
reset and return to title. The game's own `gscr.vari.chi`, `gscr.staff.chi` and
`gscr.movie.chi` persist as 1 in a fresh process; the initial own save copies have
no Chiffon completion. Story `g.*` belongs to Lua's `gscr.vari`, separate from
engine variables queried with `e:var`. After reset there are no story `rt`/`rt2`
tags; four U+3000 print commands belong to the normal font warmup.

At click 10,000, saved/loaded/reloaded scenario hashes match. A fresh process
restores that hash and continues for eight clicks. All 7,899 route image decodes
succeed, with 31,784 real font raster jobs and 792,944,208 offline PCM frames.
Both installation movies fully decode through the shared ASF codecs without
failures; the probe itself only simulates fullscreen movie duration. The ending
uses the original Lua staffroll. Main-thread Wasm sampling stays below 2 GiB;
samples do not establish an absolute peak or cover worker heaps. No Lua/include/
unknown-tag/tag errors or refusals occur. Complete stream reviews and receipts
are indexed by `local-runtime/ryuusei-world-actor/full-route109.safe.json` in the
surrounding workspace. This is an automated nonvisual route pass; the separate
Brave UI check covers title/start, native quicksave/quickload, layered confirmations
and continued text. Game images, frames and saved thumbnails were not viewed.

The unchanged runtime build passes all 322 targeted Lua/Artemis tests. Its full
suite has 2,071 tests, 2,034 passes and exactly the same 37 named baseline failures,
with no skips or cancellations. Sakura no Toki also restores its previous save
hash in a fresh process and continues. Commands and private own save copies remain
in `local-runtime/ryuusei-world-actor/` in the surrounding workspace.

## Rev.3083 (PE32, wrapped executable)

Root executable SHA-256
`1249dc214c68e781ad57bf99126986d37892280342961f6dc898eee72f9bba51`
contains an unencrypted PE32 engine at file offset `0x80000`. The embedded image
is 5,267,456 bytes, SHA-256
`abbaf6524cdaf7ac4c4c5ac50af63a74c6a4f5b22d5a4336f95ab5d85c863a87`,
image base `0x400000`, entry `0x69d05c`. Its executable code differs from Rev.2898;
this is an independent profile, not a resource variant. Only the exact root hash
selects it. The wrapper and embedded Windows program are not executed by the
browser; the player interprets the installation's game resources.

Boot `0x552cb0` publishes Rev.3083, `Thu Oct 6 02:52:54 2022`, support 1103 and
save version 1003. Its Windows/DX9 branch explicitly deletes `s.llp64` and
`s.windowsfeaturelevel` through variable virtual `+0x18` (`0x53f800`), including
restored values. Later literal queries create integer zero. This differs from
Rev.2898, whose boot leaves restored values intact. `bootDeletedSystemVariables`
models the deletion independently of the existing absent-field query policy.

The profile keeps DX9 named effect constants, presented-buffer screenshots,
byte-sized fonts and clipped-cell glyph geometry. FreeType open `0x5f18a0`
reads the byte size; glyph provider `0x5f1dd0` uses the cell advance and clamps
negative bearings. The actor-property path `0x568e50` accepts `shadertexture`,
unlike Rev.2898. Sound-loader `0x613930` offers the same file to successive
codecs without a rewind. Vorbis open `0x61f560` → `0x519350` → `0x5190a0` →
`0x518020` passes the initial `0x10000` page-search boundary to `0x517c50`.
Root return `0x557df0` and exit `0x557f40` retain load hold 13 and exit mode 14,
publish fullscreen-at-exit and force the global/system save.

Static evidence and validation reports are kept in the surrounding workspace
under `local-runtime/sakuranotoki/new-exe300/`. Registration does not accept
other wrapper versions or arbitrary embedded PE files.

The full nonvisual installation probe selects the first visible enabled option
at all 10 choices. It completes 23,121 clicks / 27,543 text waits, executes the
staff-roll scroll and exit callbacks, records the game's clear/staff flags,
resets and returns to title. Include, Lua-call, unknown-tag and tag-error reports
are zero. All seven NDJSON streams (2,968,408 records) are read and hashed.
After reset there are no scenario `rt`/`rt2` tags; the four U+3000 `print` calls
are the accepted native font warmup. Save/load/reload at click 2,000 and a fresh
process over copies of the completed route's own saves have identical
scenario-state SHA-256. The fresh process continues for 20 text waits and
retains `mis=1`, `staff01=1`, `staff03mis=1` and `movieop=true`.

The route resolves 1,827 image paths, performs 6,193 real nonvisual image decodes
without failures, and decodes 11,305 sound files. Image paths and ordered audio
metadata/hashes match the previous route. The real font path performs 255 raster
jobs with 15,112 restored cache entries. Sampled Lua peak is 5,568.979 KiB;
observed main-thread Wasm memories peak at 274 MiB, below the 2 GiB limit.
These are sampled measurements, not absolute process peaks. The probe simulates
movie waits and screenshot surfaces; it does not establish visual fidelity or
natural browser movie playback. Reports: `route320/review321.safe.json` and
`fresh322/review323.safe.json` under the evidence directory above.

A separate Brave DOM-text check exercises title/start, config, volume drag and
native exit with zero console messages, exceptions or HTML dialogs. A fresh
process on the same origin and profile retains BGM 82 / master 100, group gains
656 / 1000, without save imports. The relevant runtime/scene tests pass 297/297,
including fresh saves and exit for the new profile.

## Rev.2898 (PE32)

Frame `0x535c30` updates the window and input owners through their own vtables,
clears the two event latches, polls the two sound managers, then calls
`onEnterFrame`. Its modes 1/3 deliver push handlers before the wait; mode 4
branches directly to the wait. Resource loads inside these operations are
blocking. The browser runtime therefore retains wall timestamps during async
resource work without polling frame-owned voices/tweens, including a held frame
callback whose resource promise is already being awaited. This scheduling rule
is shared with the older synchronous native frames, rather than selected as a
2898 behavior difference.

Executable `d20ffaa064efa01eeccf4e315de99a419492e5fe7a8e44bc1a0eb22fc719883e`
is an independent x86 profile (`ARTEMIS_2898_EXECUTABLE_SHA256`), image base
`0x400000`, entry `0x6821ec`, PE timestamp `0x610e8906`. It is not a resource
variant of any x64 revision. The profile selects its reconstructed DX9 presets
and bindings. Route, state, media and browser checks are recorded below; the
complete cross-revision address map remains unfinished.

Boot publication `0x539360` identifies Rev.2898, build
`Sat Aug 7 22:21:32 2021`, support 1103 and save version 1003. It publishes
neither `s.llp64` nor `s.windowsfeaturelevel`. The browser leaves those fields
absent at boot and does not query the host's feature level. Native Lua `var`
`0x5a5670` calls expression conversion `0x524e90` and `0x5ca1a0`: a missing
literal leaf is inserted by the variable interface's integer setter with zero,
then queried again. The profile permits this lazy creation only for these two
proven absent fields; unsupported device/system queries retain their guards.
An existing value restored from system data is left intact by boot publication.

The published `s.windowstouch` is a device registration capability. In Rev.2898,
tag constructor `0x52f170` installs `CArtemisTouch` at tag-object `+0x08`.
Boot `0x539360` queries that object's PE32 vtable `+0x44`, `0x4b7cd0`, which
reads its byte `+0x3c`. Constructor `0x4b7d50` initializes the byte to zero and
sets it only after `SM_DIGITIZER` reports `NID_READY`, three User32 touch APIs
resolve and `RegisterTouchWindow(hwnd, 3)` succeeds. It is not a contact count.
Rev.3179 boot `0x1400c37e0`, Rev.3139 `0x1400c36f0` and Rev.3257
`0x1400c7d80` all query their touch owner at `+0x10`, virtual `+0x98`, and
publish the boolean through the integer setter. This is shared boot behavior,
without a revision policy difference. The browser platform supplies an
unregistered touch owner; an injected native owner supplies its real flag.

Screenshot tag `0x558900` calls renderer `0x5d0db0`, which copies the existing
GPU buffer through `GetRenderTargetData` into system memory and copies its rows.
It does not draw a new scene (`screenshot = presented`). Sound loaders
`0x5f8ab0`/`0x5f89e0` retry the same opened file without a seek
(`soundLoaderRewinds = false`). The FreeType provider `0x5d7090` receives a byte
size, caches that byte and requests CELL size `uint(size) << 6`; this profile
retains the legacy 8-bit provider policy. Rev.3257 keeps all 32 bits.

`vorbisHeaderSyncBoundary = 65536` selects the confirmed Rev.2898 header search.
`CVorbisLoader` `0x51a090` opens `CVorbis` through virtual `+0x04`, `0x6046f0`.
Its `ov_open_callbacks` path is `0x501250` → `0x500fa0` → `0x4fff20`.
The initial page request passes the exclusive `0x10000` boundary to `0x4ffb50`,
which reads 2048-byte batches and loops over `ogg_sync_pageseek`, `0x4d3ae0`.
That operation checks the capture pattern, segment lengths and CRC, skipping
garbage/bad-CRC candidates and waiting on incomplete candidates. No `bw  `-specific
branch is involved. The native first Vorbis loader therefore accepts the Ogg page
after a 64-byte wrapper; the no-rewind rule is unchanged. The shared decoder's
optional first-page search models this operation; later damaged/multiplexed page
handling remains outside this extension. Other profiles keep their existing strict
decoder (`null` means this search has not been reconstructed for them, not native
absence); they do not inherit an unverified numeric boundary.

`glyphGeometry = clipped-cell` selects the Rev.2898 result ABI. FreeType glyph
provider `0x5d75c0` returns a cell width from `advance.x >> 6`, height from the
byte size, nonnegative bitmap bearings and expanded cell dimensions for overflow.
Renderer `0x5d3e50` pads this cell for shadow/outline and returns `CClippedSurface`.
Character constructor `0x5bba50` installs its clip and reads the layer width for
normal/ruby advance, adding the respective kerning. The newer `CCharSurface`
bearing/advance ABI remains selected for all four x64 identities.

Lua restore wrapper `0x5a6e90` validates a string, constructs a pack-file owner
through `0x56d430` and invokes `0x4a6280`. That operation loads numbered PNGs
until the first open failure, then reads `index.dat`: u32 count followed by a
length-prefixed face and seven u32 key fields (size, shadow, outline, foreground,
shadow and outline colors, packed style/character), atlas index and four f32
inclusive clip edges. The key's last field is `(style << 16) | (character & 65535)`;
renderer `0x5d3d20` supplies bold/italic bits 0/1, and decoration bits are 3/4.
`0x4a4bf0` constructs the shared clipped surface; `0x4a8cd0` replaces its global
cache entry. The declared record count controls parsing, without an EOF check.
This expanded restore format is used by the confirmed Rev.2898/3083 profiles;
Rev.2601 selects its compact key layout described above. Unsupported layouts
remain errors, rather than successful no-ops.

Scenario loader `0x5b3240` pushes mode 13 at `0x5b4bb4` before history replay.
Mode entry `0x53b8b0` refuses changes while the current mode is 13. Exit
`0x53dd40` enters 14; the root-return wrapper `0x53dd20` uses the same exit.
These are checked native enum values, independent of pointer width.

`publishesFullscreenAtExit = false` preserves the Rev.2898 exit operation:
it changes the run mode, releases the scheduler and forces the global/system
save without querying fullscreen or writing `s.status.fullscreenatexit`.
An existing value restored from system data remains intact. The other four
supported exact hashes retain their fullscreen query and status write.

Actor-property parser `0x58cc90` reads `shader` and `shaderconstant`, then
returns after the constant-list setter at virtual `+0xac`. Its complete body
has no texture-path lookup or setter. `shaderTextureProperties = false` leaves
`shadertexture` and its listed paths unconsumed: no file opens, texture loans or
shader-owner requirement arise from that property alone. All four supported
x64 hashes retain their texture-property parser and resource ownership.

Nineteen complete raw HLSL signatures from this installation are recognized by the
DX9 source registry. Their Fore/User coordinates are foreground UV; eighteen programs
sample mask alpha at the original UV, independently of foreground displacement.
Reset ignores the mask. Add also applies mask alpha to the user RGB addition.
These are finite, reconstructed presets rather than a general HLSL compiler.

Draw `0x5cf080` assigns builtin alpha first, then calls effect `SetFloatArray`
with each property's name, values and count. The created effect (`0x5d0ee0`,
`0x4013cc`, factory `0x421217`) has its own parameter state. PE32 vtable
`0x6f71a0 + 0x80` resolves to `0x44858f`: partial writes stop at the count or
field end and preserve remaining values. Missing names return an HRESULT that
the draw caller ignores. Array element names are resolved by `0x440638`.
`shaderConstantBinding = named-effect` keeps this state per shader resource;
the other exact hashes retain their ordered constant buffers.

GPU surface allocation `0x5d2cf0` selects D3DFMT_A8 (28) for format 0. Its upload
view stores the source gray byte in alpha and zero in RGB, following the
[Direct3D 9 format specification](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dformat).
The view has separate GPU ownership; it does not modify cached PNG pixels or
use PNG transparency to replace the gray byte. DX9 mask variants sample alpha;
the older profiles retain red-channel masks.

The draw calls `SetTexture` for a mask only when the actor has one. Method
`0x447968` and helper `0x43e1d4` retain the new interface before releasing the
previous assignment. An omitted mask therefore keeps the effect's previous
binding, including across actors using that effect. The browser keeps that
dependency until replacement or effect disposal. Foreground and background
inputs are supplied by each draw; these nineteen sources never sample Back.
User remains unbound because this property parser has no texture assignment.
The null sampler value is opaque black, consistent with the upstream
[D3D9 unbound-sampler test](https://list.winehq.org/hyperkitty/list/wine-commits%40list.winehq.org/thread/3YHC4JEKGTOFBHUH52XCK5VRO6H4JENY/).

DX9 ordinary draws also update the device's SRCBLEND/DESTBLEND factors in
`0x5cf080`; its captured branch does not. The builtin HLSL table at `0x7a0a08`
contains 168 passes: captured passes disable blending, while custom sources
enable it. Neither source sets SRCBLEND/DESTBLEND or separate alpha factors.
D3DX Begin `0x449417` records the technique's state writes with
BeginStateBlock/EndStateBlock; End `0x4413c1` restores that recorded set.
The outside blend-factor writes therefore persist across effect switches and
frames. Captured custom draws use those inherited color and alpha factors;
the D3D11 profiles continue to replace RGBA in their captured custom path.
Ordinary RGB targets preserve opaque alpha, format-2 captures preserve RGBA,
and builtin captured Back sampling uses POINT/CLAMP. No alpha-test or shader
discard is introduced into these DX9 passes.

### File and library ownership

The pack-file opener normalizes separators and tries a loose file first. A
successful open, including an empty file, keeps that file; only failure enters
the archive registry lookup. The direct file owner returns success as a zero
byte in AL. Its Unicode-path mode converts UTF-8 to UTF-16 before `_wfopen`;
the other mode passes the original bytes to `_fopen`. Both request binary reads.
The PE32 call passes `this` in ECX and one filename pointer on the stack.
Decompiler signatures that discard this byte result are incomplete.

The exact companion `iarsys.dll` SHA-256 is
`5dd56ceed78bc4af337ec5143d221f72183873252a180161486df842c1eb012a`.
Its application DllMain returns success without an application action. Its raw
callback is null in read-only data, and it has no PE TLS callback directory.
The sole C++ initializer registers locale-facet cleanup with `atexit`; the
manual TLS-init pointer is initially zero and has no recognized explicit writer.
The reviewed entry, CRT dispatch and initializer hooks contain no authorization
check. This static result does not establish the EXE's complete startup or
network call closure. Neither binary was executed.

### Validation scope

The runtime built from `42fa4da` completes a first-visible-enabled-choice route
in Sakura no Toki: ten choices, ending/staff credits, the game's own clear/seen
records, save/reset and title. A fresh process loading copies of the test saves
retains those records and continues the scenario. The saved, loaded, reloaded
and fresh-process state SHA-256 values agree. All linked route NDJSON streams
were read completely; include errors, Lua call errors, unknown-tag reports and
tag-error reports are zero.

After reset there are zero scenario `rt`/`rt2` tags and four raw `print` tags
containing U+3000 for the game's font warmup. Its merged configuration disables
the separate game menu and maps right-click to `MWOFF`; save/load/config/backlog
panels and return to the scenario are exercised through their available native
controls. These two acceptance interpretations are explicitly user-approved in
`local-runtime/sakuranotoki/criteria223-approved.safe.json`; the raw reports are
retained without filtering.

The final route loads the same 1,827 image paths and the same ordered 11,305
audio file identities as the complete decode audits. All three installed movies
also have complete nonvisual decode receipts. Lua's sampled maximum is
5,568.98 KiB. The observed main-thread Wasm memories have a sampled aggregate
maximum of 236,584,960 bytes, below 2 GiB; this is not an absolute peak or a
measurement of browser workers. The route retains 70 image surfaces totaling
536,653,504 bytes at its final observation.

The complete connected Brave run on `e058761` covers title/start, native panels, backlog scrolling,
save/load confirmation, configuration, skip, advancing auto, choice, natural full
movie playback and native exit. A fresh run on the same settings profile retains
the UI changes. Supported-game regression console counts are NUKITASHI 2: 268,
NUKITASHI 1: 60, Hatsuyuki: 3 and SakuraNoUta: 0, with zero exceptions or HTML
dialogs. The complete original NUKITASHI 1 recipe produces the same 60 messages
on the base and `e058761` runtime; this replacement for the incomplete 59-message
baseline is user-approved. The final `42fa4da` suite has 2,020 passes and the exact same
37 known failures, with no skipped or cancelled tests.

The final critical Brave check on `42fa4da` repeats title/start, save/load with
native confirmation, backlog scrolling, config, skip, auto and native exit.
Auto advances 13 text waits in 55 seconds. All 27,949 trace entries and 93 input
acknowledgements were checked, with zero console messages, exceptions or HTML
dialogs. The two native print-overflow reports belong to the save-slot preview's
explicit clipping policy. A new process on the same profile and origin, without
save imports, retains the UI's BGM change from group gain 480 to 656 (`conf.bgm`
82, master 100). Full movie playback and choice interaction remain covered by the earlier
complete connected Brave run and the final route/media receipts.

The only runtime change after those complete browser regressions is the
exact-hash exit-publication policy described above. System tests exercise exit,
global/system persistence and fresh restoration for all five supported hashes;
the other four retain their previous fullscreen publication. The historical
browser recipes are not represented as reruns on `42fa4da`.

The source-scoped native inventory contains 463 revision/address rows, covering
472 exact-SHA/address cases and 462 distinct numeric addresses. It separates
Rev.3139 citations from canonical Rev.3179 operations, including equal addresses
whose meanings differ between revisions. The current semantic ledger verifies
14 direct Rev.2898 citations and two cross-revision boot-operation rows; 447
rows remain unresolved. Registration, RTTI and signature matches remain
candidates until their bodies, owners and ABI have been checked.
The accepted delivery scope is a working game with critical checks and a final
route; the complete native-reference audit is deferred separately by explicit
user decision (`local-runtime/sakuranotoki/scope281-approved.safe.json`).
The surrounding analysis workspace retains the full evidence index, route
review, fresh-process proof and semantic ledger under
`local-runtime/sakuranotoki/`; game data and native dumps are not committed.

## Rev.3257

Executable `7c604c92b434cbee3620dcf4af8dde40d9313d04cefa794d168b03477135a08a`
is selected independently (`ARTEMIS_3257_EXECUTABLE_SHA256`). Its PE timestamp is
`0x6800fb55`; all seven section hashes differ from Rev.3179, Rev.3139 and Rev.3198.
Static Ghidra analysis identifies Rev.3257 at `0x1400c7d80`, build date
`Thu Apr 17 21:58:09 2025`, minimum support version 1103 and save data version 1003.
It is a recompiled engine: 6035 of the 6070 Rev.3198 functions having at least eight
instructions have a matching normalized instruction signature. Signatures identify
mapping candidates; they do not establish equal behavior on their own.

Confirmed revision fields:

- `screenshot = scene`: `0x1400ee300` changes the renderer target, draws the committed
  scene through `0x14015a220`, and restores the previous target and renderer mode.
- `loadRunMode = 14`, `exitRunMode = 15` (older revisions: 13/14): scenario loader
  `0x14014a2a0` holds replay in mode 14; mode entry `0x1400cb290` refuses changes from
  that hold. Exit `0x1400cdf40` enters 15 unless replay holds 14. Window frame
  `0x1401449f0` closes after mode 15. Runtime replay, exit guarding, fullscreen-video
  entry and the host's exit predicate use these exact-hash fields.
- `soundLoaderRewinds = true`: `0x140197120` and `0x140197010` seek the opened file
  through file virtual slot `+0x30` with `(0, 0)` before a further loader.
- Archive mount `0x1401884a0` opens the base, then existing `.000` through `.999` in
  ascending order, including after gaps. The current mount implementation includes
  `.500` without a special suffix rule.
- `indentModify = true` (false for 3179/3139): constructor `0x1400be300` registers
  `indentmodify` at `0x1400d87a0`. Its optional `unindent` argument is read with
  `atoi`, then selected-layer virtual `+0x1b8` (`0x1401537c0`) pops both paired
  indentation stacks, stopping at an empty stack; any negative value clears both.
  Existing line geometry is untouched. The tag records text history except during
  replay and does not update the persistent indent replay slot. The new var system
  `get_message_layer_indent_nest` (`0x1400f42f0`) reads selected-layer virtual `+0x158`
  (`0x1401535e0`, the depth at `+0x510`). Earlier revisions retain their unknown-tag
  report and unknown-system no-write behavior for these names.

The address map and route validation are in progress; see `RESUME-SAKURANOUTA.md`
in the surrounding analysis workspace. Do not apply Rev.3179 addresses to this
executable without an explicit mapping.

### Confirmed Rev.3257 method correspondence

RTTI identifies a class, but multiple inheritance can give that class several
virtual tables. Keep every table for a class and pair each using already matched
methods. The primary text-layer table at `0x140376af0` (3179, 67 slots) corresponds
to `0x140371e18` (3257, 69 slots). Rev.3257 inserts the depth getter at slot 43
(`+0x158`) and unindent at slot 55 (`+0x1b8`): old slots 0–42 keep their indices,
43–53 move by one, and 54–66 move by two. Secondary tables with the same RTTI
identity do not replace this primary table.

The following pairs have also been checked in paired decompiles. Constructor
inlining and equivalent compiler branches account for their instruction differences;
the listed state layout and operations agree for the checked operations. The full
local correspondence file covers all 392 cited reference addresses, including 11
entries whose implementation is part of a containing operation. Its path is
`local-runtime/sakuranouta/map-cited-final1.txt`; the adjacent safe JSON receipt
records its SHA256 and coverage audit. The tables below explain selected pairs.

| Rev.3179      | Rev.3257      | Checked operation                                                                   |
| ------------- | ------------- | ----------------------------------------------------------------------------------- |
| `0x140015b50` | `0x140013140` | Theora constructor and BT.601 conversion table arithmetic                           |
| `0x14009d200` | `0x14009ff90` | INI shared-holder constructor, flags and map slots                                  |
| `0x1400a3640` | `0x1400a6450` | Actor constructor, virtual-base layout and property defaults                        |
| `0x1400b1860` | `0x1400b4a90` | Scene node destruction, captures and map/actor release order                        |
| `0x1400ef000` | `0x1400fed50` | Float tween constructor, state offsets and callback ownership                       |
| `0x140149760` | `0x140152ea0` | Tween-id query across active and pending registries                                 |
| `0x140171140` | `0x1401791d0` | Horizontal rule copies and vertical row wrapping                                    |
| `0x140190920` | `0x140197920` | Sound manager load, inactive-handle pruning and index insertion                     |
| `0x14019aa00` | `0x1401a0f80` | Tween frame completion, destruction and pending-registry merge                      |
| `0x1400a54b0` | `0x1400a8580` | Tween finish lookup and virtual `+0x18` (cancel uses `+0x10`)                       |
| `0x1400adcf0` | `0x1400b0d80` | Sound handle lookup and playing query at virtual `+0x30`                            |
| `0x1400b6520` | `0x1400b9b10` | File/label jump, script load and caret transfer                                     |
| `0x140138f10` | `0x140140230` | Lua float table setter, stack values and registry lookup                            |
| `0x14014f2a0` | `0x140158e80` | Capture enumeration/transfer and temporary identifier lifetime                      |
| `0x140178e80` | `0x140181900` | JPEG file read/rewind, buffer sizing and decode result                              |
| `0x1400a1060` | `0x1400a3d80` | Display base constructor, virtual-base adjustment and member defaults               |
| `0x1400b5a30` | `0x1400b8cd0` | Caret constructor, wait fields and pending-command queue                            |
| `0x1400b5b20` | `0x1400b8dc0` | Caret destructor and string/map/queue release order                                 |
| `0x1400b6cf0` | `0x1400ba2c0` | Pending capture restoration; text virtual `+0x1b0` becomes `+0x1c0`                 |
| `0x140057750` | `0x1400562e0` | Decoder read-context flags and callback setup; callback construction is inlined     |
| `0x1400a0340` | `0x1400a2fd0` | Encoding-aware replacement for Shift-JIS, EUC and UTF-8                             |
| `0x1400add70` | `0x1400b0e00` | Scoped sound gain query, missing-handle result and scope conversion                 |
| `0x1400ae110` | `0x1400b1220` | Pan tween cancellation, current-pan query and setter; registry insertion is inlined |
| `0x1400afc60` | `0x1400b2ee0` | Expression string read, empty result and temporary release                          |
| `0x1400b0e90` | `0x1400b40a0` | Save-state clone, maps and scalar fields                                            |
| `0x1400b1690` | `0x1400b4890` | Scene-node construction, reference counts, actor arrays and inlined payload copy    |
| `0x1400c6480` | `0x1400cb6d0` | Run-mode scope release, scheduler, pending queue and modes 5/6                      |
| `0x140134ca0` | `0x14013b680` | Lua display-info float extraction and property setter                               |
| `0x14013ef10` | `0x140146c60` | String-map restoration                                                              |
| `0x1401593a0` | `0x140161f40` | Operator-byte classification, including punctuation predicates and result masks     |
| `0x1401856c0` | `0x14018d0c0` | Integer-string predicate: empty rejection, leading minus and digit checks           |
| `0x1401990e0` | `0x1401a0110` | Relative float tween construction, six properties and from/to reversal              |
| `0x1400a5ac0` | `0x1400a89e0` | Property block assignment, scalar/flag fields and two strings                       |
| `0x1400c2400` | `0x1400c6bf0` | Tag copy constructor, string/map members and field `+0x58`                          |
| `0x1400adf30` | `0x1400b0fb0` | Scoped sound-volume tween, prior tween cancellation and default gain 1000           |
| `0x140144960` | `0x14014cfe0` | Layer history erase, argument subset matching, shifting and recursive removal       |
| `0x140165bb0` | `0x14016de30` | Directory preparation, multibyte path stepping and A/W file open                    |
| `0x1400f53d0` | `0x140103010` | Shared-owner dynamic cast with identical RTTI source/destination descriptors        |
| `0x1400f8820` | `0x1401063b0` | Second shared-owner dynamic cast and matching reference release                     |
| `0x140176b10` | `0x14017f5f0` | INI string query, section/key presence and missing empty result                     |
| `0x1400a4eb0` | `0x1400a7ec0` | Actor property assignment; base copy is outlined and shared transfers inlined       |
| `0x1400a0770` | `0x1400a33a0` | Encoding-aware string splitting, empty fields and delimiter boundaries              |
| `0x1400ae440` | `0x1400b1590` | Sound handle lookup and virtual `+0x70` query                                       |
| `0x1400b8090` | `0x1400bbd80` | Command state assignment, three strings and unchanged scalar/flag offsets           |
| `0x1400ecc70` | `0x1400fc9b0` | Curve member assignment and tagged callable transfer/release                        |
| `0x1400ae2e0` | `0x1400b1440` | Sound callback setter at virtual `+0x68`, callable copy and release                 |
| `0x1400ed9d0` | `0x1400fd750` | Integer tween constructor, from/to conversion and callable ownership                |
| `0x1400f8050` | `0x1401058c0` | Script event callable construction, tag copies and temporary release                |
| `0x1400acbb0` | `0x1400b0230` | Key-role binding, wheel flags and unique integer-key set insertion                  |
| `0x1400c9870` | `0x1400d0090` | Caption conversion, encoding guard and native window handle lookup                  |
| `0x14009d150` | `0x14009fe60` | Archive string length/bytes and field-id bookkeeping; bookkeeping is inlined        |
| `0x1400b9cd0` | `0x1400bdfc0` | Empty history argument-map construction, copy and append                            |
| `0x1400ebf10` | `0x1400fbab0` | Automode indicator-map search/insert and default member layout                      |
| `0x14012d490` | `0x1401325e0` | Native report encoding guard, conversion and temporary release                      |
| `0x1400b5690` | `0x1400b8a10` | Key-role decide query, wheel/ordinary keys and Alt+Enter suppression                |
| `0x140130350` | `0x140135db0` | Lua tag parsing, script-queue append and severity-1 report branch                   |

| `0x1400b73e0` | `0x1400bac20` | Event delivery callback: guards, delivery modes and queued-tag fallback |
| `0x1400e10a0` | `0x1400ed4f0` | Flip command, debug-skip guard and inlined stage commit |
| `0x14014f420` | `0x140158ff0` | Stage commit, capture reset, presentation and pending transition state |
| `0x1400b7440` | `0x1400bac80` | Transition completion, inlined stage commit and run-mode scope release |
| `0x1400c7800` | `0x1400ccd10` | Numeric estimate argument and cursor field `+0xb90` assignment |
| `0x1400128b0` | `0x140010ac0` | Serialized preload FIFO, budget guard, backend load and completed-resource registries |
| `0x14012d590` | `0x140132730` | Lua file execution, two backend attempts, load/protected-call branches and error reporting |
| `0x14012fa10` | `0x140135310` | Lua alias table update: indexed/named pairs, nonempty assignment and empty-root deletion |
| `0x140131480` | `0x1401371b0` | Lua script-status result from current script run-mode field `+0xc70` |
| `0x140134180` | `0x14013a2b0` | Lua foreground surface load at virtual `+8` and immediate lease release |
| `0x140182710` | `0x14018afb0` | Font enumeration callback, four filter flags and UTF-16 name insertion |

| `0x140017010` | `0x140014a10` | Video packet worker, EOF/rewind, decode budget and granule position |
| `0x1400a0560` | `0x1400a31d0` | Substring character boundaries for Shift-JIS, EUC and UTF-8 |
| `0x1400a56f0` | `0x1400a8670` | Pending tween deque append, block allocation and size increment |
| `0x1400c3720` | `0x1400c7cf0` | Display string encoding conversion guarded by field `+0xaf0` |
| `0x1400c28c0` | `0x1400c7150` | Display-mode restoration, device presentation and scaled side-picture rectangle |
| `0x1400c6580` | `0x1400cb7b0` | Script return, saved caret transfer, queue pop and pending callback release |
| `0x14014a9a0` | `0x140154170` | Draw-string display constructor and virtual-base/member defaults |
| `0x14014fc10` | `0x140159950` | Capture creation, margin crop and scaled copy; invalid dimensions return empty |
| `0x1401662e0` | `0x14016e6f0` | Font-provider selection, retained provider on failure and face/flag storage |
| `0x1400f4f90` | `0x1401029a0` | Nested key-role map serialization with field bookkeeping and sorted tree traversal |
| `0x1400f8210` | `0x140105ab0` | Event callable copy construction and consumed tag-payload release |
| `0x14013ec90` | `0x140146a80` | Lua variable snapshot, prefix filtering and string-pair serialization |
| `0x14012ca50` | `0x140131ae0` | Lua tag-handler lookup, argument-table construction and protected dispatch |
| `0x140008940` | `0x140008c00` | Archive field-offset bookkeeping and optional nested section creation |
| `0x1400a2290` | `0x1400a5070` | Archive nested section completion and bookkeeping deque pop |
| `0x1400a2300` | `0x1400a50e0` | Empty event-block constructor; ordered-map sentinel creation is inlined |
| `0x1400ebd90` | `0x1400fb950` | MT19937 draw, tempering and inclusive integer-range reduction |
| `0x1400ec380` | `0x1400fbfc0` | Tree clear, recursive payload destruction and sentinel restoration |
| `0x14011ef00` | `0x140124f60` | Scenario-state serialization: section 7 and collection fields 1–6 |
| `0x140193720` | `0x14019aab0` | Text-block defaults and two inline default-font strings |

| `0x1400f0f70` | `0x140107260` | Recursive tree-node destruction and payload release |
| `0x140122c60` | `0x140128810` | Point-vector archive serialization and extension-provider traversal |
| `0x140123ba0` | `0x140129ad0` | Deque of serializable objects and nested section completion |
| `0x140123c70` | `0x140129b60` | Vector of 96-byte serializable objects and nested section completion |
| `0x14012c030` | `0x140130e50` | Dotted Lua function lookup, optional argument table, protected call and error result |
| `0x1401469c0` | `0x140150150`, `0x14014f800` | String-keyed serializable-object map; two compiled variants |
| `0x140146ae0` | `0x14014fad0` | String-keyed point-vector map serialization |
| `0x140146cc0` | `0x14014fe20` | Integer-keyed serializable-object map serialization |
| `0x140146e00` | `0x14014ff30` | String-keyed vector-of-object map serialization |
| `0x14015adc0` | `0x140163a10` | Six-component affine matrix equality using the same float epsilon |
| `0x140176f30` | `0x140180110` | Encoding-aware INI whitespace trim, including multibyte boundaries |
| `0x14014c5d0` | `0x140155e30` + `0x14019f710` | Text layout wrapper and extracted line-position/alignment helper |
| `0x1400b6820` | `0x1400b9e00` | Click-wait glyph selection and actor ownership; text virtual `+0x1b0` becomes `+0x1c0` |
| `0x140088340` | `0x14008a520` | Vorbis integer samples, interleaving, PCM16 clipping and consumed-frame accounting |
| `0x1400acec0` | `0x1400b0360` | Role-14 pressed query: wheel flags and bound-key traversal |
| `0x1400f3c00` | `0x1401014b0` | String/C-string equality, NUL length and byte comparison |

Some cited helpers have been inlined or folded into a containing operation.
These entries identify the checked component, rather than a separate Rev.3257 entry:

| Rev.3179 helper | Rev.3257 containing operation               | Checked component                                                                  |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `0x14009ff30`   | `0x1400a2a60`                               | Six epsilon clamps after the enclosing translation operation                       |
| `0x140185740`   | `0x14018f7c0`, `0x14018d8a0`                | Numeric ordering when both keys are integer strings; byte ordering otherwise       |
| `0x140182640`   | `0x14009d710`                               | Shutdown module-cache walk, FreeLibrary calls, tree clear and sentinel restoration |
| `0x14019a940`   | `0x1400d3630`, `0x1400df290`, `0x140163310` | Shared once-only timeBeginPeriod(1) guard followed by timeGetTime                  |
| `0x1400ad130`   | `0x1400b8a10`                               | Key-role down-edge query before the enclosing Alt+Enter guard                      |
| `0x140105530`   | `0x140106a60`                               | Click-glyph map-node construction and default members                              |

The lookup at `0x1400eb500` returns the click-glyph payload directly. Its checked
Rev.3257 counterpart `0x140106a60` returns a node iterator and insertion flag;
callers access the payload at node `+0x40`. The node constructor formerly at
`0x140105530` is inlined into its missing-key branch. This is a changed native
container interface with the same checked map insertion and payload defaults.

The text subclass table at `0x140377418` (72 slots) becomes `0x1403726b8`
(74 slots), using the same depth/unindent insertions as the primary text table.
All 64 previously mapped slots align without contradiction. The layout wrapper's
virtual refresh slot moves from `+0x228` to `+0x238`; its extracted helper retains
line positions, maximum width, accumulated height and alignment calculations.
The two default-font strings copied by the text-block constructor have identical
13-byte SHA256 values in both binaries; their contents are not part of this evidence.

| `0x14013f940` | `0x1401475d0` | Compressed save archive writing, version 1003 and encoding-aware paths |
| `0x140157ff0` | `0x140160770` | Expression tokenization/evaluation and integer-zero variable leaves |
| `0x140166420` | `0x14016e840` | Glyph cache key, provider calls, empty glyph/advance branches and result layout |
| `0x140176090` | `0x14017e9e0` | INI state machine, multibyte scanning, section/key maps and trim calls |
| `0x1401971e0` | `0x14019e170` | Text-block construction, style fields and character break flags |
| `0x1400a0040` | `0x1400a2c00` | Encoding-aware character count for Shift-JIS, EUC and UTF-8 |
| `0x1400a2400` | `0x1400a5210` | Tag serialization, sorted argument traversal and delimiter escaping |
| `0x1400b5830` | `0x1400b8bf0` + `0x140102b50` | Key-role archive read: ordinary-key map clear/rebuild and section-1 guard |
| `0x1400eb990` | `0x140106e70` | Caret deque append, complete field copy and remaining tag-queue copy |
| `0x1400ebb70` | `0x1400fb830` | Read-history file-map insertion and empty integer-set construction |
| `0x14015e1b0` | `0x1401673c0` | Float-array zero initialization; the newer compiler uses memset over count × 4 bytes |

Additional folded/specialized components are `0x140017360` (shared-owner reset,
checked inside `0x140013300`), `0x140157fa0` (missing-variable integer-zero creation,
inside `0x140160770`), and `0x1400edec0` (a singleton tag-vector constructor,
inside `0x1400dfba0` and the other matched history-reset callers). These are
recorded separately from ordinary function-entry pairs in the local map.

The RNG seed routine at `0x1400f1a10` is inlined in the script constructor
`0x1400be300`: its 624-word recurrence, state-zero normalization and all-zero fallback
agree. Initialization uses the low 32 bits of the native epoch-second clock. The old
`0x14019a970` null-argument clock wrapper is folded into a direct call to
`0x140268924`; both implement the 64-bit epoch-second clock contract. These native
clock functions are distinct from the multimedia millisecond timer.

Quote registration at `0x1400afd90` becomes the specialized `0x1400b3040`.
It inserts delimiter byte 39 through `0x140102270`. The old character-to-boolean
registry is represented by a character set in the new binary; the script still
registers the same active quote delimiter. The browser parser's fixed delimiter
already represents this configuration.

The flip entry is actual code at `0x1400e10a0` in Rev.3179; Ghidra's initial
function analysis omitted it. Transient disassembly in a read-only project confirms
its debug-skip guard and stage-commit call. Rev.3257 inlines that commit in both flip
and transition completion. A prior Rev.3139 bridge alias at this address must not be
used to identify the Rev.3257 flip entry. Instruction-signature hashes alone are not
byte comparisons: memory displacements are omitted, so short matches require body
or caller checks. The paired stage-commit bodies agree at all checked offsets.

Matrix normalization retains the float epsilon bit pattern `872415232`
(`1.1920929e-7`). The newer compiler's 32-bit float absolute-value mask and the older
compiler's promoted 64-bit double mask give the same normalization comparison.

Fullscreen movie cleanup corresponds from `0x14015c0a0` to `0x1401650e0`,
but its native resource layout changed. The active flag moves from `+0x58`
to `+0x68`, and the seven existing interface members move from `+0x18..0x48`
to `+0x28..0x58`. Rev.3257 also invokes a resource owner at `+0x18`
through its virtual `+0x58` and `+0x68` methods before clearing the member.
The browser owns its media backend through `BrowserFullscreenMoviePlayer.close`:
it cancels pending activation and playback, disposes the audio voice, joins decoder
shutdown, releases the renderer and removes the movie surface. This lifecycle already
covers the additional native owner; the native pointer layout is not reproduced in
browser memory. Existing revision behavior is unchanged.

Font-provider size width is selected by the executable hash through
`ArtemisRevision.fontSizeBits`. Rev.3257 `0x14016e6f0` forwards the full word:
FreeType open `0x140172580` caches an unsigned 32-bit size and writes the CELL
request as a 32-bit `size << 6`; rendered-font open `0x140191c90` builds its
filename from a signed 32-bit size. Older callers narrow the provider argument
to its low byte. File-font requests/metrics and rendered-font names/cache keys
retain this difference. A synthetic 300-pixel FreeType glyph and rendered-font
cache collision checks cover the wider case; all three older hashes retain byte
sizing and their zero-size refusal.

## How the revisions were compared

Both executables were analyzed read-only in Ghidra (`scripts/ArtemisFunctionHashes.java`,
`scripts/ArtemisVtableSlots.java`, instruction listings and decompiles); nothing was run.

- 12164 functions have equal instruction hashes; 57 pair by position and differ; 240
  (3179) / 194 (3139) are unpaired, mostly template instantiations that differ in
  inlining (`boost::make_shared` in 3179, `new` + `shared_ptr` in 3139).
- Of the 330 function addresses cited by the Artemis sources, 312 are identical, 15
  changed and 3 unpaired (table below). The tag names, Lua methods and `system` values
  are the same strings in both; 3179 additionally imports `CreateEventA` and
  `CreateFileMappingA`.
- The changed functions were compared by literals, struct offsets and called functions;
  the differences below are the only ones found that change behavior.

## Behavioral differences (`ArtemisRevision`)

| Field                                      | 3179                                                                                     | 3139                                                                                                                                                                                                                        | Native                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `engineVersion`, `buildDate`               | 3179, `Thu Dec 21 04:26:04 2023`                                                         | 3139, `Wed Aug 30 19:57:57 2023`                                                                                                                                                                                            | 0x1400c37e0 / 0x1400c36f0                           |
| `minimumSupportVersion`, `saveDataVersion` | 1103, 1003                                                                               | 1103, 1003                                                                                                                                                                                                                  | same                                                |
| `screenshot`                               | `scene`: takess renders the committed scene into the screenshot surface +0x1c0           | `presented`: takess calls CGpuRenderer slot +0x48 (0x14015e9b0 ≡ 3179 0x140160080), which copies swap-chain buffer 1 (the frame presented last) and stores the margins +0x74/+0x78 as the crop +0x1d0/+0x1d4 read by savess | 0x1400e1cf0 (both)                                  |
| `soundLoaderRewinds`                       | CSoundLoaders seek the exact file back to 0 (file slot +0x30) before each further loader | no seek: a further loader continues at the failed loader's position; the browser refuses that case                                                                                                                          | 0x140190290, 0x140190170 / 0x14018e760, 0x14018e650 |

The browser presentation target is stage sized, so the Rev.3139 crop is empty there.

## Changed functions without a behavioral difference

Codegen only (inlined accessors, `make_shared` vs `new`, exception-state flags, struct
typing in the decompile): 0x1400b9e80 (engine constructor), 0x1400bf210 (reset),
0x1400d22b0, 0x1400d5930, 0x1400ddc70 (anime), 0x1400e4650 (video), 0x1400e56a0 (var),
0x1400ea0b0 (file), 0x140141b10, 0x14014d100 (stage initializer), 0x140178e80 (CJpg
path), 0x1401962d0 and 0x140196b10 (text display), 0x1400f1a10 (MT seed; 3139
0x1400edf00).

Not verified line by line: CDialog slot +0xa0 (0x140159710 / 0x140158100: the immediates
0x200000/0x300000 appear only in 3179), CPropertyHolder +0x130 (0x14017b890 /
0x140179d10), CLinkableTextLayer +0x218/+0x220, the Vorbis/WAVE loader slot +0x10,
CGpuRenderer +0x60/+0x68, CMja +0x8, CRenderedFont +0x8.

## Function address map (3179 → 3139)

| 3179          | 3139                                  | Status            |
| ------------- | ------------------------------------- | ----------------- |
| `0x140008940` | `0x1400088d0`                         | same              |
| `0x140011080` | `0x140011000`                         | same              |
| `0x1400116b0` | `0x140011630`                         | same              |
| `0x140011a90` | `0x140011a10`                         | same              |
| `0x140012200` | `0x140012180`                         | same              |
| `0x140015b50` | `0x140015a40`                         | same              |
| `0x140015d00` | `0x140015bf0`                         | same              |
| `0x140016390` | `0x140016280`                         | same              |
| `0x140016c40` | `0x140016b30`                         | same              |
| `0x140017010` | `0x140016f00`                         | same              |
| `0x140017360` | `0x140017250`                         | same              |
| `0x14009d150` | `0x14009d040`                         | same              |
| `0x14009ff30` | `0x14009fe20`                         | same              |
| `0x1400a0040` | `0x14009ff30`                         | same              |
| `0x1400a0560` | `0x1400a0450`                         | same              |
| `0x1400a0770` | `0x1400a0660`                         | same              |
| `0x1400a1060` | `0x1400a0f50`                         | same              |
| `0x1400a14b0` | `0x1400a13a0`                         | same              |
| `0x1400a17c0` | `0x1400a16b0`                         | same              |
| `0x1400a2290` | `0x1400a22d0`                         | same              |
| `0x1400a2a50` | `0x1400a2a90`                         | same              |
| `0x1400a3640` | `0x1400a36d0`                         | same              |
| `0x1400a3e60` | `0x1400a3ef0`                         | same              |
| `0x1400a3ee0` | `0x1400a3f70`                         | same              |
| `0x1400a45d0` | `0x1400a4660`                         | same              |
| `0x1400a4680` | `0x1400a4710`                         | same              |
| `0x1400a46d0` | `0x1400a4760`                         | same              |
| `0x1400a46f0` | `0x1400a4780`                         | same              |
| `0x1400a4710` | `0x1400a47a0`                         | same              |
| `0x1400a4960` | `0x1400a49f0`                         | same              |
| `0x1400a4970` | `0x1400a4a00`                         | same              |
| `0x1400a4980` | `0x1400a4a10`                         | same              |
| `0x1400a49c0` | `0x1400a4a50`                         | same              |
| `0x1400a4c60` | `0x1400a4cf0`                         | same              |
| `0x1400a4eb0` | `0x1400a4f40`                         | same              |
| `0x1400a5360` | `0x1400a53f0`                         | same              |
| `0x1400a54b0` | `0x1400a5540`                         | same              |
| `0x1400a56f0` | `0x1400a5780`                         | same              |
| `0x1400a57b0` | `0x1400a5840`                         | same              |
| `0x1400a58c0` | `0x1400a5950`                         | same              |
| `0x1400a5990` | `0x1400a5a20`                         | same              |
| `0x1400a5ac0` | `0x1400a5b50`                         | same              |
| `0x1400a9470` | `0x1400a9530`                         | same              |
| `0x1400aca40` | `0x1400acb70`                         | same              |
| `0x1400acbb0` | `0x1400acce0`                         | same              |
| `0x1400acec0` | `0x1400acff0`                         | same              |
| `0x1400ad130` | `0x1400ad260`                         | same              |
| `0x1400adcf0` | `0x1400adec0`                         | same              |
| `0x1400add70` | `0x1400adf40`                         | same              |
| `0x1400adf30` | `0x1400ae100`                         | same              |
| `0x1400ae110` | `0x1400ae2e0`                         | same              |
| `0x1400af400` | `0x1400af5d0`                         | same              |
| `0x1400af4c0` | `0x1400af690`                         | same              |
| `0x1400af5d0` | `0x1400af7a0`                         | same              |
| `0x1400af990` | `0x1400afb60`                         | same              |
| `0x1400afc60` | `0x1400afe30`                         | same              |
| `0x1400afd90` | `0x1400aff60`                         | same              |
| `0x1400aff10` | `0x1400b00e0`                         | same              |
| `0x1400b0370` | `0x1400b0540`                         | same              |
| `0x1400b0880` | `0x1400b0a50`                         | same              |
| `0x1400b0940` | `0x1400b0b10`                         | same              |
| `0x1400b0a00` | `0x1400b0bd0`                         | same              |
| `0x1400b0bd0` | `0x1400b0da0`                         | same              |
| `0x1400b0db0` | `0x1400b0f80`                         | same              |
| `0x1400b0e90` | `0x1400b1060`                         | same              |
| `0x1400b1220` | `0x1400b13f0`                         | same              |
| `0x1400b1240` | `0x1400b1410`                         | same              |
| `0x1400b12a0` | `0x1400b1470`                         | same              |
| `0x1400b1690` | `0x1400b1860`                         | same              |
| `0x1400b1860` | `0x1400b1a30`                         | same              |
| `0x1400b22e0` | `0x1400b24b0`                         | same              |
| `0x1400b2660` | `0x1400b2830`                         | same              |
| `0x1400b2e10` | `0x1400b2fe0`                         | same              |
| `0x1400b2f00` | `0x1400b30d0`                         | same              |
| `0x1400b30b0` | `0x1400b3280`                         | same              |
| `0x1400b3340` | `0x1400b3510`                         | same              |
| `0x1400b3790` | `0x1400b3960`                         | same              |
| `0x1400b49c0` | `0x1400b4b90`                         | same              |
| `0x1400b5170` | `0x1400b5340`                         | same              |
| `0x1400b51a0` | `0x1400b53c0`                         | same              |
| `0x1400b5650` | `0x1400b5870`                         | same              |
| `0x1400b5690` | `0x1400b58b0`                         | same              |
| `0x1400b5830` | `0x1400b5a50`                         | same              |
| `0x1400b5c00` | `0x1400b5e20`                         | same              |
| `0x1400b5e50` | `0x1400b6070`                         | same              |
| `0x1400b6020` | `0x1400b6240`                         | same              |
| `0x1400b6440` | `0x1400b6660`                         | same              |
| `0x1400b6520` | `0x1400b6740`                         | same              |
| `0x1400b6820` | `0x1400b6a40`                         | same              |
| `0x1400b6cf0` | `0x1400b6f10`                         | same              |
| `0x1400b7440` | `0x1400b7660`                         | same              |
| `0x1400b7460` | `0x1400b7680`                         | same              |
| `0x1400b7810` | `0x1400b7a30`                         | same              |
| `0x1400b7ba0` | `0x1400b7dc0`                         | same              |
| `0x1400b7c70` | `0x1400b7e90`                         | same              |
| `0x1400b9cd0` | `0x1400b9ef0`                         | same              |
| `0x1400b9e80` | `0x1400ba120`                         | changed-same-spot |
| `0x1400bf210` | `0x1400bf250`                         | changed-same-spot |
| `0x1400c0560` | `0x1400c0470`                         | same              |
| `0x1400c2400` | `0x1400c2310`                         | same              |
| `0x1400c2bc0` | `0x1400c2ad0`                         | same              |
| `0x1400c37e0` | `0x1400c36f0`                         | changed-same-spot |
| `0x1400c4680` | `0x1400c4590`                         | same              |
| `0x1400c4ad0` | `0x1400c49e0`                         | same              |
| `0x1400c5800` | `0x1400c5710`                         | same              |
| `0x1400c6160` | `0x1400c6070`                         | same              |
| `0x1400c6480` | `0x1400c6390`                         | same              |
| `0x1400c7800` | `0x1400c7710`                         | same              |
| `0x1400c7bb0` | `0x1400c7ac0`                         | same              |
| `0x1400c8250` | `0x1400c8160`                         | same              |
| `0x1400c8380` | `0x1400c8290`                         | same              |
| `0x1400c91e0` | `0x1400c90e0`                         | same              |
| `0x1400c9870` | `0x1400c9770`                         | same              |
| `0x1400c9dc0` | `0x1400c9cc0`                         | same              |
| `0x1400ca3d0` | `0x1400ca2d0`                         | same              |
| `0x1400ca5b0` | `0x1400ca4b0`                         | same              |
| `0x1400ca740` | `0x1400ca640`                         | same              |
| `0x1400caad0` | `0x1400ca9d0`                         | same              |
| `0x1400cbf20` | `0x1400cbe20`                         | same              |
| `0x1400cc0c0` | `0x1400cbfc0`                         | same              |
| `0x1400d1c10` | `0x1400d1b10`                         | same              |
| `0x1400d20d0` | `0x1400d1fd0`                         | same              |
| `0x1400d3290` | `0x1400d31e0`                         | same              |
| `0x1400d4350` | `0x1400d42a0`                         | same              |
| `0x1400d47b0` | `0x1400d4700`                         | same              |
| `0x1400d4a10` | `0x1400d4960`                         | same              |
| `0x1400d4cb0` | `0x1400d4c00`                         | same              |
| `0x1400d52c0` | `0x1400d5210`                         | same              |
| `0x1400d5930` | `0x1400d5880`                         | changed-same-spot |
| `0x1400d6670` | `0x1400d6650`                         | same              |
| `0x1400d76d0` | `0x1400d76b0`                         | same              |
| `0x1400d8a10` | `0x1400d89f0`                         | same              |
| `0x1400da830` | `0x1400da810`                         | same              |
| `0x1400dd3a0` | `0x1400dd380`                         | same              |
| `0x1400dd840` | `0x1400dd820`                         | same              |
| `0x1400dd8f0` | `0x1400dd8d0`                         | same              |
| `0x1400ddc70` | `0x1400ddc50`                         | changed-same-spot |
| `0x1400df0c0` | `0x1400df0c0`                         | same              |
| `0x1400dfe2b` | `0x1400df0c0`                         | same              |
| `0x1400dff1f` | `0x1400df0c0`                         | same              |
| `0x1400e0330` | `0x1400e0330`                         | same              |
| `0x1400e10a0` | `0x1400e0330`                         | same              |
| `0x1400e10c0` | `0x1400e10c0`                         | same              |
| `0x1400e1cf0` | `0x1400e1cf0`                         | changed-hunk      |
| `0x1400e1d90` | `0x1400e1d50`                         | same              |
| `0x1400e3ee0` | `0x1400e3ea0`                         | same              |
| `0x1400e4220` | `0x1400e41e0`                         | same              |
| `0x1400e4650` | `0x1400e4610`                         | changed-hunk      |
| `0x1400e56a0` | `0x1400e56f0`                         | changed-same-spot |
| `0x1400e9fb0` | `0x1400ea010`                         | same              |
| `0x1400ea0b0` | `0x1400ea110`                         | changed-same-spot |
| `0x1400eb500` | `0x1400eb600`                         | same              |
| `0x1400ebb70` | `0x1400ebd30`                         | same              |
| `0x1400ebd90` | `0x1400ebf80`                         | same              |
| `0x1400ebf10` | `0x1400ec150`                         | same              |
| `0x1400ec380` | `0x1400ec5c0`                         | same              |
| `0x1400ecbd0` | `0x1400ecde0`                         | same              |
| `0x1400eccf0` | `0x1400ecf00`                         | same              |
| `0x1400edec0` | `0x1400ee160`                         | same              |
| `0x1400ee280` | `0x1400ee520`                         | same              |
| `0x1400ee310` | `0x1400ee5b0`                         | same              |
| `0x1400ef000` | `0x1400ef2a0`                         | same              |
| `0x1400f0f70` | `0x1400f11e0`                         | same              |
| `0x1400f17b0` | `0x1400f1a20`                         | same              |
| `0x1400f1a10` | `0x1400edf00`                         | unpaired          |
| `0x1400f4f90` | `0x1400f4d00`                         | same              |
| `0x1400f53d0` | `0x1400f5100`                         | same              |
| `0x1400f5a30` | `new(0x3890) + 0x1400b5370`           | unpaired          |
| `0x1400f5d60` | `new + ctor, assigned by 0x1400f5fd0` | unpaired          |
| `0x1400f8820` | `0x1400f7a50`                         | same              |
| `0x1400fdda0` | `0x1400fd1b0`                         | same              |
| `0x140101520` | `0x1401007c0`                         | same              |
| `0x140105530` | `0x140104080`                         | same              |
| `0x140112bd0` | `0x1401116d0`                         | same              |
| `0x140113ab0` | `0x1401125b0`                         | same              |
| `0x140113e50` | `0x140112950`                         | same              |
| `0x140115650` | `0x140114150`                         | same              |
| `0x140116ee0` | `0x1401159e0`                         | same              |
| `0x1401193d0` | `0x140117ed0`                         | same              |
| `0x14011a740` | `0x1401192f0`                         | same              |
| `0x14011ef00` | `0x14011dbc0`                         | same              |
| `0x140122c60` | `0x140121920`                         | same              |
| `0x140123ba0` | `0x140122860`                         | same              |
| `0x140123c70` | `0x140122930`                         | same              |
| `0x14012c030` | `0x14012acf0`                         | same              |
| `0x14012ca50` | `0x14012b710`                         | same              |
| `0x14012d080` | `0x14012bd40`                         | same              |
| `0x14012d490` | `0x14012c150`                         | same              |
| `0x14012eb30` | `0x14012d7c0`                         | same              |
| `0x14012fa10` | `0x14012e6c0`                         | same              |
| `0x140130350` | `0x14012f000`                         | same              |
| `0x1401304d0` | `0x14012f180`                         | same              |
| `0x140131480` | `0x140130130`                         | same              |
| `0x1401315b0` | `0x140130260`                         | same              |
| `0x1401318a0` | `0x140130550`                         | same              |
| `0x140133730` | `0x1401323e0`                         | same              |
| `0x140134180` | `0x140132e30`                         | same              |
| `0x1401345b0` | `0x140133260`                         | same              |
| `0x140134ca0` | `0x140133950`                         | same              |
| `0x140135480` | `0x140134130`                         | same              |
| `0x140138f10` | `0x140137790`                         | same              |
| `0x140139920` | `0x1401381a0`                         | same              |
| `0x14013cec0` | `0x14013b7a0`                         | same              |
| `0x14013e5c0` | `0x14013cea0`                         | same              |
| `0x14013ec90` | `0x14013d570`                         | same              |
| `0x14013ef10` | `0x14013d7f0`                         | same              |
| `0x14013f390` | `0x14013dc70`                         | same              |
| `0x14013f940` | `0x14013e220`                         | same              |
| `0x14013fde0` | `0x14013e6c0`                         | same              |
| `0x140140770` | `0x14013f050`                         | same              |
| `0x140141b10` | `0x1401403f0`                         | changed-same-spot |
| `0x140144570` | `0x140142f50`                         | same              |
| `0x140144960` | `0x140143340`                         | same              |
| `0x1401469c0` | `0x1401453a0`                         | same              |
| `0x140146ae0` | `0x1401454c0`                         | same              |
| `0x140146cc0` | `0x1401456a0`                         | same              |
| `0x140146e00` | `0x1401457e0`                         | same              |
| `0x140149760` | `0x140148140`                         | same              |
| `0x140149d90` | `0x140148770`                         | same              |
| `0x140149e60` | `0x140148840`                         | same              |
| `0x140149ea0` | `0x140148880`                         | same              |
| `0x14014a0a0` | `0x140148a80`                         | same              |
| `0x14014b350` | `0x140149d30`                         | same              |
| `0x14014d100` | `0x14014bd50`                         | changed-same-spot |
| `0x14014f2a0` | `0x14014e200`                         | same              |
| `0x14014f420` | `0x14014e380`                         | same              |
| `0x14014f490` | `0x14014e3f0`                         | same              |
| `0x14014fc10` | `0x14014eb70`                         | same              |
| `0x140156190` | `0x140154b80`                         | same              |
| `0x1401562b0` | `0x140154ca0`                         | same              |
| `0x140156400` | `0x140154df0`                         | same              |
| `0x140157fa0` | `0x140156990`                         | same              |
| `0x140157ff0` | `0x1401569e0`                         | same              |
| `0x1401593a0` | `0x140157d90`                         | same              |
| `0x14015adc0` | `0x140159730`                         | same              |
| `0x14015b440` | `0x140159db0`                         | same              |
| `0x14015ba00` | `0x14015a370`                         | same              |
| `0x14015c0a0` | `0x14015aa10`                         | same              |
| `0x14015d120` | `0x14015ba90`                         | same              |
| `0x14015f1d0` | `0x14015db00`                         | same              |
| `0x14015fd30` | `0x14015e660`                         | same              |
| `0x14015fe10` | `0x14015e740`                         | same              |
| `0x1401649b0` | `0x140163200`                         | same              |
| `0x1401658c0` | `0x140163ee0`                         | same              |
| `0x140165bb0` | `0x1401641d0`                         | same              |
| `0x140165e50` | `0x140164470`                         | same              |
| `0x1401662e0` | `0x140164900`                         | same              |
| `0x140166420` | `0x140164a40`                         | same              |
| `0x140171140` | `0x14016f7b0`                         | same              |
| `0x1401756a0` | `0x140173b40`                         | same              |
| `0x140177e90` | `0x140176330`                         | same              |
| `0x140178130` | `0x1401765d0`                         | same              |
| `0x140178c50` | `0x1401770f0`                         | same              |
| `0x140178db0` | `0x140177250`                         | same              |
| `0x140178e80` | `0x1401772e0`                         | changed-hunk      |
| `0x140179120` | `0x1401775a0`                         | same              |
| `0x140179e80` | `0x140178300`                         | same              |
| `0x140179f50` | `0x1401783d0`                         | same              |
| `0x14017b6a0` | `0x140179b20`                         | same              |
| `0x14017e8d0` | `0x14017cd40`                         | same              |
| `0x14017f7c0` | `0x14017dc30`                         | same              |
| `0x14017fb10` | `0x14017df80`                         | same              |
| `0x140181db0` | `0x140180220`                         | same              |
| `0x1401823a0` | `0x140180810`                         | same              |
| `0x140182640` | `0x140180ab0`                         | same              |
| `0x1401838e0` | `0x140181d50`                         | same              |
| `0x1401841b0` | `0x140182620`                         | same              |
| `0x1401856c0` | `0x140183aa0`                         | same              |
| `0x140185740` | `0x140183b20`                         | same              |
| `0x1401857c0` | `0x140183ba0`                         | same              |
| `0x140185bf0` | `0x140183fd0`                         | same              |
| `0x1401864a0` | `0x140184880`                         | same              |
| `0x140186770` | `0x140184b50`                         | same              |
| `0x140187d00` | `0x1401860e0`                         | same              |
| `0x14018d6c0` | `0x14018bba0`                         | same              |
| `0x14018d9f0` | `0x14018bed0`                         | same              |
| `0x14018e1e0` | `0x14018c6c0`                         | same              |
| `0x140190290` | `0x14018e760`                         | changed-same-spot |
| `0x140190920` | `0x14018eda0`                         | same              |
| `0x1401910e0` | `0x14018f560`                         | same              |
| `0x140191250` | `0x14018f6d0`                         | same              |
| `0x140191720` | `0x14018fba0`                         | same              |
| `0x140193720` | `0x140191ba0`                         | same              |
| `0x1401962d0` | `0x140194750`                         | changed-same-spot |
| `0x140196b10` | `0x140194f90`                         | changed-same-spot |
| `0x140197100` | `0x140195510`                         | same              |
| `0x140198ce0` | `0x1401970f0`                         | same              |
| `0x1401990e0` | `0x1401974f0`                         | same              |
| `0x14019a970` | `0x140198e60`                         | same              |
| `0x14019a980` | `0x140198e70`                         | same              |
| `0x14019aa00` | `0x140198ef0`                         | same              |
| `0x1403636f8` | `0x14029bf60`                         | same              |
| `0x140368fd8` | `0x14029bf60`                         | same              |
| `0x140369b10` | `0x14029bf60`                         | same              |
| `0x140369e78` | `0x14029bf60`                         | same              |
| `0x140369ea0` | `0x14029bf60`                         | same              |
| `0x14036ad40` | `0x14029bf60`                         | same              |
| `0x14036b964` | `0x14029bf60`                         | same              |
| `0x1403718c8` | `0x14029bf60`                         | same              |
| `0x1403721a0` | `0x14029bf60`                         | same              |
| `0x140372360` | `0x14029bf60`                         | same              |
| `0x1403723a0` | `0x14029bf60`                         | same              |
| `0x1403723c8` | `0x14029bf60`                         | same              |
| `0x140372420` | `0x14029bf60`                         | same              |
| `0x140372480` | `0x14029bf60`                         | same              |
| `0x1403724b8` | `0x14029bf60`                         | same              |
| `0x1403724e0` | `0x14029bf60`                         | same              |
| `0x140372518` | `0x14029bf60`                         | same              |
| `0x140372540` | `0x14029bf60`                         | same              |
| `0x140372a18` | `0x14029bf60`                         | same              |
| `0x140372a48` | `0x14029bf60`                         | same              |
| `0x140372a70` | `0x14029bf60`                         | same              |
| `0x140375638` | `0x14029bf60`                         | same              |
| `0x140375910` | `0x14029bf60`                         | same              |
| `0x140375b78` | `0x14029bf60`                         | same              |
| `0x140375ba8` | `0x14029bf60`                         | same              |
| `0x140375c08` | `0x14029bf60`                         | same              |
| `0x140375d68` | `0x14029bf60`                         | same              |
| `0x140376af0` | `0x14029bf60`                         | same              |
| `0x1403fbf38` | `0x14029bf60`                         | same              |
| `0x1403fbf78` | `0x14029bf60`                         | same              |
| `0x1403fbf98` | `0x14029bf60`                         | same              |
| `0x1403fbff0` | `0x14029bf60`                         | same              |
| `0x1403fc1d8` | `0x14029bf60`                         | same              |
| `0x1403fc1e8` | `0x14029bf60`                         | same              |
| `0x1403fc200` | `0x14029bf60`                         | same              |
| `0x14046e058` | `0x14029bf60`                         | same              |
| `0x14046e088` | `0x14029bf60`                         | same              |
| `0x140485434` | `0x14029bf60`                         | same              |
| `0x1404859c0` | `0x14029bf60`                         | same              |

## Data address map (3179 → 3139)

Matched by content (bytes compared at each cited address).

| 3179          | 3139          | Match                  |
| ------------- | ------------- | ---------------------- |
| `0x1403636f8` | —             | not matched by content |
| `0x140368fd8` | `0x14036f4d8` | .rdata, 8 bytes equal  |
| `0x140369b10` | `0x1403708d0` | .rdata, 8 bytes equal  |
| `0x140369e78` | —             | not matched by content |
| `0x140369ea0` | —             | not matched by content |
| `0x14036ad40` | —             | not matched by content |
| `0x14036b964` | `0x140367c40` | .rdata, 8 bytes equal  |
| `0x1403718c8` | `0x14036db70` | .rdata, 8 bytes equal  |
| `0x1403721a0` | `0x14036e460` | .rdata, 24 bytes equal |
| `0x140372360` | `0x14036e650` | .rdata, 24 bytes equal |
| `0x1403723a0` | —             | not matched by content |
| `0x1403723c8` | `0x14036e700` | .rdata, 48 bytes equal |
| `0x140372420` | `0x14036e6a0` | .rdata, 48 bytes equal |
| `0x140372480` | `0x14036e768` | .rdata, 48 bytes equal |
| `0x1403724b8` | `0x14036e740` | .rdata, 24 bytes equal |
| `0x1403724e0` | `0x14036e7b8` | .rdata, 24 bytes equal |
| `0x140372518` | `0x14036e810` | .rdata, 24 bytes equal |
| `0x140372540` | —             | not matched by content |
| `0x140372a18` | —             | not matched by content |
| `0x140372a48` | `0x14036ecf0` | .rdata, 24 bytes equal |
| `0x140372a70` | `0x14036ed20` | .rdata, 24 bytes equal |
| `0x140375638` | `0x140373490` | .rdata, 48 bytes equal |
| `0x140375910` | `0x140373760` | .rdata, 48 bytes equal |
| `0x140375b78` | `0x1403739c8` | .rdata, 48 bytes equal |
| `0x140375ba8` | `0x1403739f8` | .rdata, 48 bytes equal |
| `0x140375c08` | `0x140373a58` | .rdata, 48 bytes equal |
| `0x140375d68` | `0x140373bb8` | .rdata, 48 bytes equal |
| `0x140376af0` | —             | not matched by content |
| `0x1403fbf38` | `0x1403fa0e0` | .rdata, 48 bytes equal |
| `0x1403fbf78` | `0x1403fa120` | .rdata, 48 bytes equal |
| `0x1403fbf98` | `0x1403fa140` | .rdata, 48 bytes equal |
| `0x1403fbff0` | `0x1403fa198` | .rdata, 48 bytes equal |
| `0x1403fc1d8` | `0x1403fa380` | .rdata, 48 bytes equal |
| `0x1403fc1e8` | `0x1403fa390` | .rdata, 48 bytes equal |
| `0x1403fc200` | `0x1403fa3a8` | .rdata, 24 bytes equal |
| `0x14046e058` | —             | ambiguous (48 bytes)   |
| `0x14046e088` | —             | ambiguous (48 bytes)   |
| `0x140485434` | —             | not matched by content |
| `0x1404859c0` | —             | not matched by content |
