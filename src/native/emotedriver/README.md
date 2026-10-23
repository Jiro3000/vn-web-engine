# `emotedriver.dll`

TypeScript implementation of the E-mote Direct3D runtime, for build SHA-256
`a3b693b605d67812e489b1fb62cd341012b5514fc9114a032fee4685e70b3a86` (NEKOPARA Vol. 1).
It provides `contract.ts` and is registered with the loader by `library.ts`. Native
addresses in comments refer to that build.

## Layout

| Path                     | Native counterpart                      | Content                                            |
| ------------------------ | --------------------------------------- | -------------------------------------------------- |
| `contract.ts`            | exports, `IEmoteDevice`, `IEmotePlayer` | public surface                                     |
| `library.ts`             | `EmoteCreate`, `EmoteFilterTexture`     | loader registration, player assembly               |
| `filter-texture.ts`      | `EmoteFilterTexture` (0x10002c20)       | in-place decrypt and RGBA8 pixel filter            |
| `device.ts`              | `PEmoteDevice` (0x100716ec)             | module options, player creation                    |
| `player.ts`              | `PEmotePlayer` (0x1007174c)             | slot facade over the player core                   |
| `runtime/interfaces.ts`  |                                         | boundaries between the parts below                 |
| `runtime/player-core.ts` | `MEmotePlayer`                          | Progress, queuing, timelines, variables, tweens    |
| `runtime/clip.ts`        | `MMotionPlayer`                         | clip time, layer nodes, keyframes, layer pass      |
| `runtime/clip/`          | 0x1003aaf0, 0x1003ece0, 0x1003f9c0      | clip, frame slots, interpolation, vertex passes    |
| `runtime/controls/`      | `emote::EP*`                            | eye, eyebrow, mouth, selector, loop, wind, physics |
| `runtime/mesh/`          | 0x1002cd90, 0x1002d960, 0x1003f680      | vertex kernel (Wasm crate `wasm/emote-mesh`)       |
| `runtime/render/`        | `MMotionRenderer`, `MMotionDevice`      | draw list, textures, D3D9 calls                    |

Models come from `src/formats/kirikiri/emote-model.ts`; the player keeps the typed
model in place of the native PSB views. Drawing goes through the `d3d9.dll` contract
(`src/native/d3d9/contract.ts`) on the device the compositor passes to `emoteCreate`,
so state the compositor sets is visible to the runtime and restored after `render`,
as on Direct3D 9.

## Wiring

`emoteDriverLibrary({shaders})` registers the library for its SHA-256. `shaders` are the
compiled blobs of the installation's `emotedriver.dll`, read with
`extractEmoteShaderBlobs` (each blob is checked against its SHA-256); null runs the
device at shader level 0 (fixed function), as the native device does without shader
support. A player is assembled from `EmotePlayerCore` (with `emoteClipFactory` and
`createEmoteControls`) and the renderer `PEmoteDevice.createPlayers` builds.

## Unsupported paths

Paths that shipped `win` files do not use throw on load instead of approximating:
particle, anchor and screen-bounds layers, `groundCorrection`, multi-angle motions,
motion `variable` tracks, `cp`/`prt`/`camera`/`anchor`/`model`/`feedback` content, the
angle and zoom parts of `meshSyncChildMask`, and software texture converters other than
DXT5 → A8R8G8B8. Stereovision clip pairs (`p+0x1c0`, never set in this build) and the
joinTarget pass (0x100460f0, whose maps are empty in shipped data) are not reproduced.

Packed corner-color interpolation for both builds lives in
`runtime/render/vertex-colors.ts`. Each edge is interpolated first, followed by each
row, retaining the native per-channel truncation at both passes. The D3D9 device
and x64 renderer share this routine.

## Numeric conventions

The native code stores single-precision floats and computes in x87 registers, with SSE
paths in some math routines (selected by 0x10028200). SSE paths are reproduced in single
precision; x87 code uses doubles with `Math.fround` where the native code stores a
`float`. `Math.pow`/`sin`/`cos`/`atan` stand in for the CRT versions and can differ by one
ulp before rounding.

## Tests

`tests/emotedriver-*.test.mjs` drive the runtime through the contract on synthetic
models (`tests/kirikiri-psb-fixtures.mjs`) and compare variables, node state and vertex
output at fixed times. Rendering tests record D3D9 calls on a recording device.
`tests/emotedriver-library.test.mjs` loads the library through the loader and plays a
synthetic motion file through the contract.

Probes on real files (non-visual: counts, NaN checks and SHA-256 digests):

- `tools/probe-emotedriver.mjs <tpm> <emotedriver.dll> <xp3>...`: every model through
  the contract on a counting D3D9 device (create, play each main timeline, progress,
  render);
- `tools/probe-emotedriver-clip.mjs`: clip evaluation and mesh kernel agreement;
- `tools/probe-emotedriver-controls.mjs`: control and physics output sequences.

## Public D3D11 contract

`EMOTE_DRIVER_D3D11` in `contract.ts` is revision `2`, for the exact x64 image
`80d28bd0…1e051`. Revision `1` and its D3D9 exports remain independent. Both use the
existing Native library loader; an implementation is selected by image identity,
and callers request the matching contract token.

The D3D11 revision declares the native SDK/build exports, the default-allocator
`InitParam` with device and immediate context, ten device operations and 98 player
operations. Public objects use only Native contracts and plain values. Player
coordinate/force output pointers become `{x, y}` results. Native slots and entry
addresses are recorded on each member, including the x64 deleting-destructor slot
that shifts reference counting. Unknown integer player slots 15/16 and device
operations outside the audited subset are absent.

`runtime/render/d3d11-program.ts` owns a shader, its input layout for a vertex stage,
and reflected constant buffers through the D3D11 contract. Named writes update CPU
shadows; binding uploads dirty buffers before selecting the native stage and buffers.
Missing parameters are no-ops. Partial construction releases every acquired reference;
disposal releases the owner's references without clearing the context's owned bindings.
This resource owner consumes prepared reflection and has no browser context or GPU
implementation dependency.

`runtime/render/d3d11-shaders.ts` owns the fixed bank of twelve vertex programs and
2,077 pixel programs. Its selectors retain the native basic, buffered-blend, alpha-mask
and alpha-reference table coordinates; the two separate transition entries remain
addressable by index. Late initialization failure releases all earlier stages.

`runtime/render/d3d11-mesh.ts` packs the native non-indexed 2D allocation mode into
20-byte XY/BGRA/UV vertices for input-layout row 4 (vertex shader 1). Quads keep
their four-vertex strip order; subdivided grids expand six vertices per cell.
Position words retain their original bits. UV construction preserves the native
float stores and the quad division versus grid reciprocal-multiply distinction.
Corner colors use the shared fixed-point interpolation. A mesh's output and scratch
allocations are bounded to 64 MiB. Submission creates a native default vertex buffer
through the D3D11 contract and releases its reference after Draw, including failures;
the context owns any retained binding. Shader and output state belong to the caller.

`runtime/render/d3d11-textures.ts` owns shared native atlas textures and shader views.
The x64 loader uploads one mip at the source dimensions through initial resource data;
the x86 truncated-size and optional-mip rules do not apply. L8/A8/A8L8, RGBA8/RGBX8,
BC1/2/3 and win-spec BC7 retain their native DXGI formats. Win RGBA8/RGBX8 use BGRA
storage; common-spec data use RGBA. Native win software-storage aliases retain these
formats. CPU converter formats are refused. Acquiring the same source shares its
resource; the last release retires the cache's texture and view references. View
creation failure retires the partially created texture. Context bindings keep their
own native references, independently of cache disposal.

`tools/probe-emote-d3d11-shaders.mjs --driver <exact-driver.dll> --output <new.json>`
reads that image as data and exercises the bank through the D3D11 system library on
an isolated WebGL2 context. Geometry and textures are generated; assertions compare
numeric framebuffer bytes. It covers color modulation, filtering constants, screen
masks, buffered addition, A8 mask construction and alpha-reference boundary/discard.
Packed-mesh draws cover quads, subdivided grids and a numeric BGRA corner gradient.
Atlas samples use the native texture owner, including L8 and A8L8 shader selection.
It never executes PE functions, presents game pixels or takes screenshots. Full player,
compositor and model verification are separate gates.

The contract does not expose internal model caches, clips, draw commands, browser
objects or a renderer callback. Rendering uses the compositor's D3D11 resources and
context. The x64 implementation and Artemis consumer migration are still pending;
the legacy host path described below remains the current integration.

## Artemis x64 integration

A browser port of the E-mote 3.9.8 runtime in the x64 D3D11 `emotedriver.dll`, SHA-256
`80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051` (SDK `3.9.8`, build
`2022/12/28-13:02:35`). Addresses in these sources are functions of that build. Only this
exact DLL hash selects the driver (`emoteDriverProfile`); any other build is refused.
The engine reads the DLL as data for its hash; it never runs.

## Layout

| File                        | Native part                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `driver.ts`                 | The device: driver profile, PSB header key, model cache, `createPlayer`         |
| `runtime/player-core.ts`    | Both exact builds of `MEmotePlayer`: variables, controls, timelines, transforms |
| `player.ts`                 | Exported x86 player and x64 host calling convention                             |
| `runtime/clip/scalar.ts`    | Scalar `MMotionPlayer` binding to shared evaluation and draw interfaces         |
| `controls.ts`, `physics.ts` | Gaze, blink, mouth, selector and orbit controls; bust, pendulum, wind           |
| `timelines.ts`, `tween.ts`  | Main and difference timelines; value and rotation tweens                        |
| `mesh.ts`                   | Bezier patches and mesh interpolation                                           |
| `renderer.ts`               | The D3D11 renderer as WebGL draw commands                                       |

Motion files are read by `src/formats/psb` (PSB containers, filtered headers) and
`src/formats/emote` (typed model and metadata). Atlas textures decode through
`src/graphics/block-texture.ts`.

## Data flow

`EmotePlayer.progress(frames)` steps the controls, applies the variables to the clip and
rebuilds `clip.drawList`: one `EmoteDrawItem` per visible image layer with its icon
rectangle, corner colours, blend mode, vertex grid and stencil links. A host draws the
player by passing the draw list to `EmoteRenderer.render`, which returns the commands that
draw it into the renderer's `surface`. The Artemis CEmoteLayer does this on every draw of
its layer (`src/engines/artemis/image-graphics.ts`).

## Renderer

`EmoteRenderer` reproduces the render handler 0x180006430/0x1800069a0 and the device:

- Ordering: the list is sorted by depth (`z`), then the clip flags compared as float32,
  then list index; unordered (NaN) comparisons are false, as in the native comparator.
  Blank items, zero opacity and blend mode 6 are skipped.
- Meshes: a 1×1 grid is a four-vertex strip; larger grids are triangle lists with corner
  colours spread by the native 8-bit fixed-point interpolation (`emoteColorGrid`).
  Positions are raw E-mote coordinates under the host projection
  `[2/W, −2/H]` (origin at the target centre, y down). Vertex colours are the item
  colours as UNORM bytes; `bm & 0x10` doubles the colour of halved (0x80 = 1.0) items.
- Masks: the device runs in alpha-mask mode. When the stencil parent changes, the parent
  chain draws into two viewport-sized mask targets — intersect parents (stencil type 1)
  multiply, subtract parents (type 2) erase — and the group then draws with its alpha
  multiplied by the mask. Stencil type 4 draws the parent's composite list instead of the
  parent.
- Destination blends (`bm & 0xf00` = 0x100): before each draw the destination region (the
  item's grid bounds, projected and rounded out) is copied into a copy texture that is
  reallocated when the region outgrows it or falls below half its size. 0x100 adds; 0x101–0x10b
  are the subtract, overlay, hard/soft light, dodge, burn, lighten, darken, difference,
  exclusion and luminosity modes; 0x10c is a mosaic, 0x10d a blur of horizontal and vertical
  passes whose radii step down through 9, 6, 3, 2, 1 texels.
- Colour filters (`grayscaleMode` 1–4: mix, add, subtract, invert by the level colour) and
  the colour fix-ups of blend modes 3 and 4 (premultiply) and 5 (invert) follow `fs_basic`.

The pixel programs are generated GLSL; the native HLSL is not used. Blend states follow
the device table 0x180061d60.

### Textures

PSB atlases upload their block data unchanged and decode once on the GPU into an RGBA8
surface shared by every renderer of a texture cache (`EmoteTextureCache`). Supported types:
`L8`, `A8`, `A8L8`, `DXT1`, `DXT3`, `DXT5`, `BC7` and their `_SW` variants. Reserved BC7
blocks decode to transparent black, as D3D11 specifies. The types the device converts on
the CPU (`RGBA5650`, `RGBA5551`, `RGBA4444`, `RGBA8`, `RGBX8`, `ETC1`, `PVRTC`, `CI4`,
`CI8`) throw `EmoteUnsupportedError`.

## Unsupported paths

Data or calls outside the supported paths throw `EmoteUnsupportedError` instead of drawing
approximately: easing curves and `cp` paths, motion tags, variable lists, streams,
own-rotation motions, particle, anchor, camera and clip-rect layers, ground correction,
stencil alpha tests, directional nested-motion modes, stereovision, `clone`,
`assignState`/`getState`, API-log replay, item clip rectangles, the stencil-buffer device
mode and blend indices 13–15.

## Verification

- `tests/emote-renderer.test.mjs` checks ordering, decoding, mesh vertices, the colour grid,
  mask passes, the destination copy and the blur passes on synthetic draw lists.
- `tests/block-texture.test.mjs` checks the BCn and linear decodes against reference
  texels.
- Amakano 3's 132 character models (`image/fg/*.psb`, BC7 and DXT5 atlases) play 240
  frames each through the player and the renderer without errors; their draw lists use
  blend modes 0x10, 0x13 and 0x118 and composite intersect masks (stencil type 5).

## Shared control tweens

`runtime/controls/transition.ts` implements value tweens for both exact DLL images
listed in `build.ts`. Unknown identities are rejected. The x86 image starts a
queued entry without advancing it; the x64 image advances it immediately and
passes the full interval to each entry completed in the same call. Float stores,
completion tolerance and repeated-target behavior retain each image's semantics.
`runtime/controls/rotate.ts` similarly preserves each build's shortest-arc
rotation, retarget retention and queue timing. The x64 compatibility constructors
in `tween.ts` delegate to these shared implementations.

`runtime/controls/graph.ts` shares path search between the two images. The x86
graph constructor truncates frames to integers; the x64 constructor preserves float32
frames and rounds backtracking differences before updating path cost. The
shared follower retains each image's queue timing, retarget behavior and
overshoot accounting. The x64 names in `controls.ts` delegate to it. Both
images use the same xorshift word update and 23-bit uniform output.

`runtime/controls/eye.ts` and `eyebrow.ts` share graph motion for both images.
The x64 image preserves float frame labels and consumes specific blink phase
changes in the current call. Its blink toggle resets the open position and
interval when disabled. The x86 image keeps its integer frame loading and
one-phase-per-call behavior. Compatibility names in `controls.ts` delegate
to these controls, sharing the process random source.

`runtime/controls/selector.ts` drives transitions through the
`EmoteSelectorTransition` interface. Both builds retain their distance threshold,
index conversion and queue timing: the x86 image tests the normalized remaining
distance and starts requests on a later call, while the x64 image tests absolute
distance and advances queued requests immediately. Its compatibility constructor
in `controls.ts` delegates to this shared selector.

`runtime/controls/wind.ts` shares gust storage and queries. The x64 variant keeps
float stores in power interpolation, position advance and window bounds. The
pendulum samples wind through `EmoteWindField`, so a different field implementation
can supply the same acceleration query. The x64 class in `physics.ts` delegates
to this shared wind and retains its signed-speed restart semantics.

`runtime/controls/bust.ts` shares spring state and reset behavior. Its exact-build
variant preserves the x64 intermediate float stores, damping and soft-angle
mapping. The x64 entry driver in `physics.ts` retains its zero-time first anchor
and interpolated substeps, with accumulated outer forces applied to the base.
Both pendulum paths sample `EmoteWindField` through its query interface.

`runtime/controls/pendulum.ts` also shares the joint and bend state for both
builds. The x64 path preserves rounded rod constraints, force/damping stores,
the one-bit-smaller bend period and zero output for an invalid vertical joint
index. Its entry driver keeps the native output-label mapping and substeps.

`runtime/controls/mouth.ts` keeps the x86 lip-sync easing and the x64 value-tween
semantics behind the same control API. The x64 player sets, steps and skips that
control instead of accessing its concrete tween. State assignment copies queued
requests within the same DLL build. The x64 update pair is borrowed to avoid a
per-substep allocation.

`runtime/controls/orbit.ts` implements the x64 orbit value scheduler. Its first
call selects the first value without consuming elapsed time; later calls emit
variable requests only when the interval crosses a value boundary. It preserves
float interval wrapping and tween duration and rejects DLL builds without this
control.

`createEmoteControls(metadata, {driverSha256})` assembles these controls for a
validated DLL image; omitting the hash keeps the x86 image. Physics reads the
`EmoteControlHost` interface. For x64, the host supplies the transformed base
position, combined rotation and accumulated forces; the driver anchors once at
zero time and rounds interpolation stores. `skip(host)` also clears physics
outputs immediately. The x86 driver retains its full-time first update and
previous-position fallback. X64 selectors can be disabled, and its metadata has
no loop controls; the x86 reader still requires its original loop-control list.

`runtime/player/timelines.ts` stores timeline and track state for both DLL images
through `EmoteTimelineHost`. The x64 image normalizes fullwidth ASCII labels,
retains the last content frame when seeking across an empty segment and advances
each playing timeline with its own elapsed interval. Its fade timing, float
stores, NaN comparisons, replay reset and loop-step flag remain build-specific.
The x86 image keeps its original seek/evaluate behavior and carries loop remainder
into the next playing timeline. The x64 names in `timelines.ts` delegate here.

PSB decoding is shared in `src/formats/kirikiri/psb.ts`. Its exact-x64 options
enable copied header filtering, version-4 extra chunks, an eagerly validated root
and shared resource identity; integers outside the safe JavaScript range are
rejected. The default reader retains lazy roots, independent resource views and
bigint values. `src/formats/psb/psb.ts` supplies the x64 compatibility constructor.
Build identities and body keys are shared with the format layer's existing
`psb-filter.ts` table.

Metadata decoding is shared in `src/formats/kirikiri/emote-metadata.ts`, selected
by the exact driver image. The x64 reader nests its presence gates: `eyeControl`
enables the following expression controls, `clampControl` enables mirror and
instant-variable settings, and `timelineControl` enables stereovision, character
profiles and orbits. Disabled selectors remain raw; immediate controls default
to the three native face labels. The x86 reader retains its required control
lists and loop controls. Both metadata readers convert graph frame labels and
edges to integers and nodes to float32. Diagnostics use `EmoteDiagnosticSink`,
so readers do not require a particular collector implementation.

The typed model graph is also read in `src/formats/kirikiri/emote-model.ts`.
Selecting the x64 image adds icon resolution, variable-driven mesh combinators,
blend parameters and color-presence flags. The x86 result keeps those keys in
`unread` where appropriate and does not add x64 fields to its object shape.
`EmoteX64Model` narrows the shared graph interfaces for callers of that image;
`src/formats/emote/model.ts` supplies the compatibility entry point.

`runtime/player/clamp.ts` shares the two-variable clamp arithmetic. Its exact
image selector preserves the different float stores in normalization, radial
limits, easing and reconstruction. The returned pair is borrowed per clamp;
players apply their own variable blending and mirroring around this calculation.

`EmotePlayerCore` selects its build through `driverSha256`; omission keeps x86.
X64 construction requires the device's process RNG and a clip implementing
`EmoteX64ClipPlayerAccess`. Its control factory receives the same image and RNG
through `EmoteControlLinks` and provides `EmoteX64ControlSet`'s blink API. The core
uses these interfaces for physics positions, rotation, forces, grayscale and
transforms. It preserves x64 orbit/timeline/difference ordering, UTF-8 variable
order, expression-loader gates, coordinate flags and original-scale behavior.
X86 retains its own queuing, clamps, rounding and copy behavior.

The x64 `EmotePlayer` binding delegates to this core. The x64 device factory supplies the
actual clip through `EmoteClipDriver` and `EmoteX64ClipPlayerAccess`; the core drives
its advance, evaluation and event-retirement phases directly. A queued flag 0x40
holds all three phases for that call, and nested clips advance the shared clock
without the top-level queue/combinator pass. X64 actions retain their existing
internal retirement rather than reaching the x86 listener interface. Physics
reads `layerPosition`, so x86 node-layout queries are refused. The binding keeps
its tuple coordinate return and explicit unsupported stereovision/state-copy
operations. Older diagnostic clip hosts can use the combined-pass adapter.
`library.ts` registers the x86 native export contract; `driver.ts` provides the
x64 host binding.

`runtime/clip/interpolate.ts` shares scalar, angle, color, coordinate and patch
interpolation for both exact DLL images. X64 preserves its rounded residual
weight, 360-degree wrap, integer color blend and near-zero patch fast path. X86
keeps its curve cursors and SSE-style patch stores. Coordinates and patches are
written into caller-owned buffers; the x64 helpers in `mesh.ts` delegate here.
Whole-frame evaluation also lives here, through `EmoteFrameClock` and the block
or scalar node interfaces. The clip binding selects its storage layout. X86 keeps
half-even time quantization and its literal epsilon comparison; x64 truncates
quantized time and compares against a float epsilon. Native empty-slot behavior,
curve errors, unchanged-weight skipping and patch ownership remain image-specific.
The empty-patch sentinel is shared with the slot loader. Scalar non-tween frames
retain cached patch references; block frames copy or interpolate into their own
storage.

`runtime/clip/frame.ts` loads keyframe slots for both images. X64 resets its
mesh and nested-motion state for every frame, uses infinite time past the frame
list and retains the reader's scalar/list color distinction. It normalizes
full-range RGB channels with the native blend-mode flag and defers curve/path
errors until interpolation. X86 retains its lazy content loading, curve cursors,
last-frame reads and stale mesh/motion structs. X64 clips keep a read-only sequence
of these same slots per layer, cached by layer identity; scans move references
without copying frame fields into another representation. Absent x64 source/icon
keys remain null, distinct from an explicitly empty key. The x86 reader keeps its
empty-string defaults.

`runtime/clip/combinators.ts` owns x64 variable-driven patch combinations. It
reads `EmoteCombinatorVariables` and writes through `EmoteCombinatorTarget`,
independent of clip and node classes. Patches passed to the target are borrowed
for that call. Registrations carry an opaque owner token so unloading one clip
retains other clips sharing the same variable entry. Float stores, neutral
patches and sparse updates preserve the exact x64 image's behavior.

`ClipParameter.apply` shares variable-to-frame mapping for both images. It clears
parameter flags, applies optional integer discretization, clamps reversed ranges
and preserves the sign of zero. X86 rounds incoming values to float32 before
mapping; x64 retains the incoming value until the result store. The clip callers
keep their own ordinary and scoped variable lookup behavior.

`runtime/clip/matrix.ts` composes local frames and parent products for both
images through transform and matrix-storage interfaces. Callers can supply
Float32Array storage or a scalar `EmoteMatrixTarget`; the latter keeps the x64
binding's existing node fields without per-call buffers. X86 retains array
stores and its degree conversion. X64 retains scalar intermediate values, its
rounded degree factor and operand order before writing the completed frame.

`createEmoteMeshKernel({driverSha256})` selects the existing vertex kernel's exact
image variant. X64 uses sequential double products and independent SIMD lanes
for x/y; the TypeScript twin keeps the same stores. It adds transformed-patch,
affine and offset point operations through `EmoteX64MeshKernel`. Resources take
that interface, and the x64 device can receive a kernel when constructed. Clip
grids and anchor scratch buffers are reused; compatibility helpers in `mesh.ts`
delegate to the shared kernel. Short patch queries use the TypeScript arithmetic
to avoid host-copy costs. Factory selection is fixed per image, with the twin
available on hosts without WebAssembly SIMD.

`NodeState` stores evaluated transforms and adjustment blocks for both images.
The x64 node extends that state directly and keeps its player/nested-clip
adjustments in a second shared state; copying overrides uses `copyFrom`.
`visible` controls drawing and `shown` propagates visibility along the parent
chain. Matrix interfaces read the shared transform fields without alias getters.

`NodeState.inheritTransform` and `removeTransform` compose or remove angle, zoom, slant and flip
components selected by a native inheritance mask. Both clip variants use it for
partial inheritance. Coordinate projection, matrix composition and native
opacity arithmetic stay with the layer pass that selects their image behavior.

`runtime/clip/time.ts` owns the running and clamped clip clocks and their scan
order. Clips supply frame-reset, forward/backward and parameter scan hooks.
The exact DLL image selects replay at zero delta, tag-stop checkpoints and loop
rounding: x86 clears alignment at the start and stops after a holding tag; x64
replays forward at zero delta and keeps two float stores per loop wrap. Each
clip keeps its native keyframe and event storage behind those hooks.

The player reuses one root-transform input record. `EmoteClipDriver` borrows it
for the synchronous setter call; clip implementations copy the fields they
retain. Each clip receives the same per-call field reads and native float stores
without allocating a message for every transform sub-step.

`runtime/clip/source.ts` resolves frame source keys for both images. Its
`EmoteSourceTarget` interface writes the layer's existing storage: x86 uses an
integer rectangle and renderer atlas indices; x64 keeps scalar rectangles and
indices in the resolved file. The exact image selects blank-number parsing,
missing-source field retention and resolution stores. A shared resolver searches
the current motion file first and then the resource files in load order. Cached
keys, including null versus empty x64 keys, belong to each layer. No source
adapter or proxy is allocated during layer evaluation.

`runtime/clip/layer.ts` runs layer evaluation through `EmoteLayerEvaluation` and
image-specific storage interfaces. X86 supplies evaluated state blocks and array
matrices; x64 supplies direct scalar fields. The exact image selects its loop once
at clip creation, avoiding layout checks on every node. Both paths retain native
parent bypass, empty-state copying, opacity, projection axes and float stores.
Frame interpolation and mesh synchronization run through typed clip hooks. The
pass allocates no layer adapters or per-call closures.

`runtime/clip/vertices.ts` evaluates both native vertex layouts through plain node,
resource and scratch interfaces. The image binding chooses the array or scalar
pass; no node proxies or per-node variant checks are needed. X64 keeps its single
corner-expression stores, truncated subdivision, clamped axes and deformed-chain
translation baseline. X86 keeps its intermediate stores and half-even division.
The scalar pass borrows the resource's `EmoteX64MeshKernel` and one clip's reused
corner and point buffers. Grids remain owned by their nodes. Shape evaluation
retains each image's radius arithmetic and supported shape kinds. Motions without
child nodes skip the scalar vertex call, whose loop would have no iterations.

Mesh synchronization also lives in `runtime/clip/vertices.ts`. Clip hooks reference
its functions directly. X86 maps position using the child's projection axis and
rejects inherited angle/zoom synchronization. X64 uses the parent's axis and maps
angle/zoom through finite differences of the patch. Narrow parent, target and
resource interfaces preserve direct fields, native error ordering and float stores.

`EmoteScalarNode` in `runtime/clip/node.ts` owns the x64 record layout alongside the
x86 node. Its host interface supplies node-id allocation, source resolution, the
current model and the top clip's subdivision ratio. Nested-clip storage is generic;
node code imports no concrete clip. The image binding aliases the shared class
directly. Scalar draw-item records live in `runtime/interfaces.ts` and keep their
native field order. The frame module's eager layer cache shares loaded slots by
layer identity and creates a fresh end slot for each out-of-range lookup. Nodes
retain their original override, matrix, source-cache and combinator-patch stores.

The complete evaluation phases also live in `runtime/clip/layer.ts`. The native
image binding calls the scalar or block phase on its layer evaluator through a
typed host interface. `EmoteLayerEvaluator` separates the evaluator implementation
from state and nested-motion hooks. Root integration and decay, velocity snapshots and deltas, root matrix
copying, child evaluation, geometry, masks, shapes, nested-motion hooks and final
flag retirement retain native order. Host state belongs to this library's internal
interfaces; the public DLL contract is unchanged. Scalar integration keeps its
intermediate product store and wide decay exponent; the block phase keeps its
wide translation product and rounded exponent. No phase adapter or closure is
allocated per call.

`runtime/clip/nested.ts` drives motion-reference layers through explicit parent,
child-clip and node interfaces. It shares no concrete clip or node types. The
block and scalar passes retain their native flag contributions, reverse-loop
boundaries, coordinate projection, directional matrix arithmetic and mask links.
Child event queues are read after child progress and replaced only when retired;
reentrant callbacks therefore see the same live parent queue and clock state.
The clip bindings select the pass and supply their native lifecycle operations.
These interfaces are internal; the public DLL surface remains in `contract.ts`.

`runtime/render/draw-list.ts` constructs both native draw lists through plain
clip/node records and item-pool interfaces. Child clips supply their recursive
draw operation. The block path retains its pooled items, OR of corner alpha and
replaced stencil child arrays; the scalar path retains its AND of corner alpha,
blend-specific neutral colors and stable composite arrays. Live parent draw order
and stencil lists remain visible across child calls. Both paths use the same
saturated RGBA product in `runtime/render/color.ts`; item layouts remain distinct.

Both clip bindings live under `runtime/clip/`: `clip.ts` retains the block layout
and `scalar.ts` retains the scalar layout. The scalar binding owns motion selection,
parameters and resource lookup; clock, frames, node storage, layer evaluation,
vertices, nested motion and draw construction use the shared runtime interfaces.
`runtime/clip.ts` exposes both internal bindings. Neither binding depends on a
concrete exported player or renderer. These runtime bindings are library-internal.

`extractEmoteX64ShaderBlobs` in `runtime/render/shaders.ts` reads the exact x64
image's native shader pointer/size tables (construction at `0x180062580`). It
verifies the whole DLL identity before returning borrowed byte views for 12
vertex shaders, 2,077 pixel shaders and their 12 input layouts. The owner keeps
the DLL bytes unchanged. The shared DXBC envelope reader validates part ranges
and preserves native table order; it does not interpret shader instructions.
