# Artemis Rev.3179 integration

The integration targets Hatsuyuki Sakura's executable SHA-256
`8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf`.
Native addresses below describe this exact build; they are not selectors for
other games or revisions. No Artemis player or compatibility profile is exposed
in the UI yet.

## Resource and script execution

`src/formats/artemis/pfs.ts` reads PF8 indexes using shared `ByteSource` range
reads and Web Crypto SHA-1. Payloads are lazy and XOR starts at the entry-relative
position. `files.ts` mounts the base PFS and existing `.000` through `.999` packs
in ascending order, including after gaps. Later archives replace earlier entries;
a loose file, including an empty file, wins. Names preserve case and Unicode and
normalize slash spelling only. The host supplies filesystem case rules. Extra pack lists, embedded packs and other revisions are unsupported.
Relevant native entries: `0x14017fb10`, `0x14017e8d0`.

ASB v0 carries tag arguments, source-line numbers and labels indexing the tag
sequence (`0x1400c4ad0`). IET supports the UTF-8 boot subset: labels, square tags,
quoted/named/positional arguments, escapes, comments and raw inline Lua. Lines are
zero-based and refer to the closing token. Plain dialogue, @ commands, tag.ini
aliases and native conditional/loop compilation are not implemented. Unknown
commands require explicit host dispatch; they do not silently succeed.

`script.ts` caches loaded programs, executes inline Lua once during initial load,
then runs the cursor and FIFO tag queue. Queued tags precede the next script tag
(`0x1400c0560`, `0x140130350`). Call/jump accept the current file when omitted;
empty labels begin at tag zero (`0x1400b6520`). Call/return scope effects and root
exit/save handling belong to the host. End of a called script returns to its
caller. A host provides waits, stop effects, rendering and all remaining services.
`run(maxSteps)` bounds dispatch; it does not schedule a browser frame.

`lua.ts` connects shared Lua 5.1 to include, file reads/existence, now, tag,
enqueueTag, literal variables and live tag filters. Direct/queued Lua tags have
source line -1 and bypass the script tag filter (`0x14012ca50`). Lua tables holding
filters remain live, including closures installed after registration. Argument
conversion follows the investigated string/numeric subset; other values fail.
AST files are Lua assignments. Story traversal must run the game's Lua interpreter,
not a separately invented AST VM.

`variables.ts` preserves byte strings and resolves only the current local scope
before globals (`0x1400b0880`). An exact delete removes only that key; otherwise
it removes keys starting with the name plus a dot (`0x1400af990`). Expressions,
empty-name global clears and complete system-variable initialization remain incomplete.
Global sf-prefix writes track changes in bytes; deletion preserves the native dirty-flag quirk.
Literal Lua queries create missing variables as integer zero (0x140157fa0),
while raw map reads preserve empty absence. Other expressions remain unsupported. Stage-size queries require a configuration/rendering provider.
`revision.ts` initializes the confirmed static boot variables only after exact
executable-hash selection. Host Windows-version failure produces native 0.0;
platform identity/capabilities are never invented.

`modes.ts` owns skip/auto/autosave command state and emits required status/effect
callbacks (`0x1400d47b0`, `0x1400d4350`, `0x1400ca3d0`). Scheduler, indicator,
message and save effects still require native service implementations. Nonempty
syncse is refused until its audio behavior is implemented.

`events.ts` copies recognized callback names and applies partial updates, including
the legacy onClickWait alias. The frame/input/save owner emits callbacks; failed
frame/click-wait callbacks are disabled. Named Lua calls resolve dotted table paths and supply
engine plus the native argument table when nonempty (`0x14012c030`, `0x140133730`).
Native metamethod-based callback lookup is not reproduced by the raw-field bridge.

`mouse.ts` dispatches cursor visibility/position through shared `CursorHost` and
implements the native unsigned auto-hide deadline. Native pointer activity resets
and browser window coordinate mapping remain unconnected.

`dialog.ts` supplies UTF-8 message dialogs through shared `TextDialogHost`. It
pauses script progress and writes the returned native result before the host resumes.
Text fields and their encoding/truncation remain unsupported. Full scheduler effects
are supplied by the host (`0x1400c91e0`, `0x1400b7460`). There is no browser dialog UI
wired to this integration yet.

## Verification and remaining work

After `npm run build:runtime`:

```sh
node --test tests/artemis-formats.test.mjs tests/lua51-runtime.test.mjs tests/artemis-execution.test.mjs
node tools/verify-artemis.mjs GAME_DIRECTORY
node tools/probe-artemis.mjs GAME_DIRECTORY
```

The verifier checks real archive indexes, ASB records and loose precedence without
extracting or rendering media. The probe preloads script/text resources, compiles
Lua/AST sources in the actual wasm VM, and runs boot until the first unsupported
service. It uses a deterministic clock and explicit Windows INI stage dimensions;
it is not a production filesystem, clock or complete INI loader. The actual game
`readScriptFile` load-only path validates AST loading; this is not story execution.
By default dialogs remain pending. `--dialog-result=0` or `--dialog-result=1`
explicitly supplies a simulated outcome for a separate probe, recorded in its JSON.
Probe cursor/scheduler effects are record-only and do not represent production effects.

Remaining work includes native system variables/events, expression evaluation,
full IET compilation, AST story execution, text/media/save services and UI wiring.
The integration is not playable. Shared platform/media services must remain in
the shared layers. Evidence and game resources are local-only and are not part of
this source tree.

## Timed waits and save requests

`wait.ts` implements the empty-message timed subset of native wait, including
input=2 skip/debug-skip bypass, strict absolute uint32 deadline comparison and the
zero-deadline sentinel. Input=1 enters click-wait: the host receives scheduler/
indicator state, In callback and the native save request. Completion releases the
scheduler, emits Out and updates message state. Active message/automode progression,
scenario, media and click-to-skip remain explicitly unsupported.

`save.ts` preserves the native save gate: empty filename/force=false/clean sf state
performs no writes. A nonempty filename emits onSave before the scenario snapshot;
callback errors are reported and disable the callback before native save continues.
Dirty/forced global saves write global state, clear dirty, then write system state.
Actual serialization and persistence are required host effects and are not implemented
by this gate. No JSON replacement for native save formats is provided.

Probe `--advance-waits` advances its simulated clock beyond each timed deadline,
up to 100 waits. It is separate from actual user input and production scheduling.
The probe uses a windowed shared geometry fixture for fullscreen queries.

## Virtual paths and application arguments

`ArtemisFiles.setMagicPath(name, root)` stores one installation-relative alias;
empty root removes it. `resolvePath` substitutes `:name` once, appending the
literal suffix at its slash/backslash delimiter before loose/PFS lookup. Updates
retain overlay keys, case, Unicode and empty loose-file precedence. Native CLua
receives a tuple with numeric keys 1 and 2, copying only string values.

The native unknown/empty-alias branch reports success without opening a file.
This stateless ByteSource interface explicitly refuses that branch rather than
inventing a source or retaining a stale handle. Absolute/traversal roots and
nested alias roots are also outside its supported installation-relative subset.
Known aliases with a trailing directory separator are not file sources.

`get_exe_parameter` obtains the owner's already-parsed `ApplicationArguments`
map and writes dotted `name.key` variables into the selected local/global scope.
It preserves old keys absent from a later map, matching the native handler.
The shared application argument interface does not inspect the harness process
command line. The probe supplies an explicit empty application argument fixture.

Recording flags and right-click configuration are kept in the mode owner:
`alreadyread` treats a missing mode as enabled, while `writebacklog` disables on
missing mode. Exact string `0` disables; `00` remains enabled. `rclick` preserves
its script filename when omitted and replaces it even with an explicit empty value.
These command flags do not implement history collection, backlog rendering or
right-click dispatch by themselves.

`text-controls.ts` handles UTF-8 backlog/hide configuration. It preserves empty
comma-separated names, literal whitespace, include-font state and per-current-layer
backlog overrides. Omitting an override layer disables its use while retaining the
prior identifier. New backlog message layers are created/selected through the owner
and the current message layer is restored. Clearing backlog requires the storage
owner to clear every native collection. Configuration is not message/backlog rendering.

`key-bindings.ts` stores native signed ordinary-key sets in sorted order and keeps
codes 136/137 as separate flags. `keyconfig` clears the role first; missing keys
leave it empty, while explicit empty keys add ordinary code 0. `delonpush` removes
both native handler-map slots, using integer-zero for a missing key. Stored command
arguments are copied. Physical input sampling, special-code interpretation,
frame dispatch remain separate input-owner work.

`setEventFilter` retains a live Lua function independently of the tag-filter table.
`filterEvent` supplies the engine, event name and named arguments and preserves the
native 32-bit numeric result: zero falls through, two fails, and other nonzero
values consume successfully. Numeric strings are rejected. The event owner must
report Lua callback errors and continue its default dispatch, as the native owner
does. Default event actions and physical input dispatch remain unimplemented.

`setUseMultiTouch` requires a numeric limit, truncates it toward zero and calls the
input owner's contact-limit operation. It is bound only when that owner exists;
the nonvisual probe records the configuration and does not simulate touch input.

`event-commands.ts` copies mode/hide/backlog/directory event commands. Label-only
registrations capture the current script filename; explicit empty filenames are
preserved. `setonpush` replaces one of two per-key slots: missing/exact-zero
keyrepeat chooses slot 0, other strings choose slot 1. Registering one slot keeps
the other. These stores require mode/input owners to emit and dispatch events.

`native-library.ts` implements the synchronous native string-call ABI through the
shared `WindowsDynamicLibraryHost`. Modules are cached per owner after a successful
load; failed loads are retried. Each export receives a NUL-terminated string and
returns a native pointer. The owner copies the result before querying/calling
`Delete`; absent module/export, null result and absent `Delete` produce an empty
result, matching the native implementation. Browser DLL loading returns failure.
Successful native hosts must supply `readCString`. The current tag adapter supports
ASCII arguments only; legacy ANSI encoding remains unsupported. `reset()` releases
cached modules in native byte-key order and clears the registry for later reuse.
Returned bytes are published through the variable owner without UTF-8 conversion.

`initializeArtemisResourcePaths` publishes the filesystem owner's resolved data
and save roots. It does not resolve Windows known folders or choose persistence.
The nonvisual probe uses an installation-relative namespace and accepts only an
explicit simple SAVEPATH with no SAVEPATH_CSIDL. Reads remain in the selected
installation; it does not create directories or write saves.

A resource owner can opt into `suspendableTags` and return `suspended` after
starting an asynchronous native tag operation. `createCall` keeps the Lua call's
arguments/locals; its owner resumes after applying the completed resource effects.
`ArtemisScript` drives `calllua` through those coroutines when opted in, suspends
nested calls, and resumes the deepest call before its callers. `resumeLua` supplies
completion values, while ordinary timed waits continue using `resume`. Resource
failures resume with false/error bytes and propagate through the suspended calls.
Loading another script cancels old Lua continuations; the resource owner must also
cancel or reject stale resource completions. Lua callback return values are discarded.

Tag filters also retain their continuation: the first numeric return decides
consume/fallthrough, and native dispatch receives the original arguments. Extra
returns are discarded, matching native single-result callbacks. Event filters
and inline includes remain synchronous. Lua 5.1
cannot yield across a protected C-call boundary; such asynchronous paths refuse.
The default owner keeps the original synchronous callback path. Probe `--async-lua`
checks the coroutine path through the actual boot without loading/rendering assets.

`image-loader.ts` resolves resources asynchronously with native extension preference,
then content sniffing of the exact file, then appended-extension candidates. Codec
registration and extension order are preserved; Unicode names/aliases stay unchanged.
The exact-hash factory selects PNG (`png`, `PNG`), JPEG (`jpg`, `jpeg`, `JPG`, `JPEG`),
then PSD (`psd`, `PSD`), matching the stage initializer. PNG uses the shared straight
RGBA decoder on the shared worker when available, with an in-thread fallback.
Merged PSD uses the format reader below on that same worker. JPEG still requires
an injected owner and refuses when selected without one. Decoder null means native failure/fallback; host and unsupported-format errors
propagate. Corrupt PNGs are refused by the strict shared reader. Image loading is
separate from cache eviction, layer geometry, property application and presentation.
The pipeline is verified with synthetic PNGs through suspended Lua callbacks.

`scene.ts` models the UTF-8 hierarchical child maps separately from image and
rendering owners. Dots separate components, including empty components. Missing
ancestors become empty groups; removing the last child keeps its parent group.
The image-backed constructor has native type 1 and blocks child traversal;
empty groups have type 0. Owners explicitly select the group type when inserting
a group payload. Mutations copy each affected current child map while
retaining its previous structure; `commit()` recursively releases that structural
version. Both map and inner-actor buffers retain their physical slot indices;
nodes shared between maps keep their resources until their last reference.
Presentation timing remains a separate owner. Relevant native entries:
`0x140185bf0`, `0x1400b3340`.

Child order compares signed decimal keys numerically when both are numeric and
otherwise compares UTF-8 bytes (`0x140185740`). Equivalent keys such as `2` and
`02` preserve the first stored spelling. Native accepts a lone minus as numeric
zero. Numeric overflow and numeric-looking nonnumeric components are refused:
the latter can make the native comparator nontransitive, so a sorted-array model
cannot reproduce their native tree behavior. This scene subset requires the
exact executable hash. `entries()` exposes structural traversal for owners; it
is separate from native selection. `select(id)` expands the current selected
subtree in child order and preserves the requested id spelling in its prefix
(`0x140113e50`, `0x140113ab0`). Wildcards and shader/message selection are
outside this child-map API.

`layers.ts` connects the ordinary image-backed `lyc`, `lydel` and geometry subset
of `lyprop` to the image loader and scene. Its required graphics owner allocates,
copies and releases native image actors, applies properties, and owns outer-wrapper
alpha and native command registrations. `lyc` sets float32 anchors to half the
image dimensions, deletes the previous selected subtree only after successful
resource creation, inserts an image leaf and resets that id's command list.
Creation-tag geometry arguments are not applied: the native command uses separate
`lyprop`. A missing resource reports a script error while preserving the old layer.
Rules and capture-mode creation are explicitly unsupported. When file loading
fails and width/height/color are all present, solid fallback uses shared straight
RGBA fill. Six-byte colors and eight-byte 0x/0X forms select RGB with forced opaque
alpha; other forms select ARGB. Hex conversion preserves native prefix/sign and
uint32 overflow saturation. Decimal dimensions preserve atoi prefixes; negative
dimensions and signed allocation overflow refuse. Missing any fallback field
reports the normal load error. Native surface resize/fill: 0x1401910e0/0x140191250.
Relevant native entries: `0x1400d5930`, `0x1400d6670`, `0x14014f2a0`.

Ordinary image properties copy the inner actor on the first edit after commit,
retaining its old state (`0x1400b49c0`). Left/top, anchors, rotation, alpha,
percentage scale and reverse/visible flags are supported. Decimal prefixes use
native-style conversion; nonfinite/hex values and other property keys refuse.
Only exact `0` disables flags. Inner alpha rounds to float32 before division by
255; outer-wrapper alpha divides as double before float32 conversion. Values
are not clamped by the adapter. Applying these values and recording the original
command require owner effects. Root/shader properties and the alternate
retained-actor editing mode remain unsupported. Ordinary and intermediate group
properties are described below. Native entries:
`0x140115650`, `0x1400d76d0`.

Use the layer owner's `commit()` at a confirmed native commit boundary. It releases
actors absent from all reachable current/retained child maps and inner-actor versions.
Commit visits current children ascending, releases the node's old actor, then
clears its old child map. Full-map destruction releases children descending
(`0x1400ec380`, `0x1400f0f70`). A removed node destroys physical map slots 1 then 0,
followed by actor slots 1 then 0 (`0x1400b1860`). Shared-node and payload references
preserve this order without releasing live aliases. The layer owner processes
scene release notifications in order, so surface-cache victims and idle FIFO
depend on native lifetime order rather than actor allocation order.
`close()` cancels pending work and clears both scene buffers in that order.
Scene release callbacks only record notifications; they must not mutate the scene
or throw. Owners must return fresh
actors from create/copy and retain shared image resources when copying. Async
resource dispatch rejects overlapping operations and snapshots tag arguments;
`cancelPending()` prevents stale completion effects alongside cancellation of
Lua continuations. These services are tested with synthetic images and suspended
Lua; the image raster owner below remains separate from stage/scheduler and UI wiring.

The scene/layer system checks run with:

```sh
node --test tests/artemis-scene.test.mjs tests/artemis-image-worker.test.mjs
```

`display-object.ts` implements native CDisplayObject defaults and float32 local
matrix composition. Translation, anchor translation, rotation, scale, reversal
and inverse-anchor translation preserve the native order, rounding and strict
snap below `2^-23` after each operation (`0x1400a1060`, `0x1400a14b0`,
`0x14009ff30`). Matrices use `[a,b,tx,c,d,ty]`. Nonzero rotations require an
injected native float trig owner; zero rotation is exact without one. Arbitrary
JS Math trigonometry is not silently substituted.

`image-graphics.ts` implements ordinary unclipped straight-RGBA image actors
through shared `DrawListTarget`. Native command/error services, sampler and blend
selection remain explicit providers. `createArtemisOrdinaryGpuRaster()` supplies
the confirmed ordinary D3D11 policy for this exact revision's single-level image
subset. Actors prepare their images before scene
insertion; copies share texture ownership and outer-wrapper metadata while copying
inner display state. The last actor releases its image binding. Nonzero rotation,
group raster, shader, mask and transition paths remain outside this raster subset.

`drawCommitted()` emits retained GPU images in ascending child order through the
preparation path (`0x140186770`); higher numeric ids paint after lower ids. The
separate ordinary callback path (`0x1401864a0`) traverses descending for non-raster
effects. Native selection and structural traversal remain ascending. Image quads
preserve float32 transform,
viewport normalization and triangle-strip order (`0x14015d120`). The stage owner
chooses frame/commit timing; this method does not implement the full native flip
state machine. There is no playable Artemis UI/profile yet.

Shared `WebGLDrawTarget.prepareImage()` uploads and retains an image until
`invalidate()`, including empty/hidden frames. Normal unprepared images retain
per-frame eviction behavior. Failed uploads delete their partial GPU allocation.
`tests/browser/artemis-images.html` checks synthetic PNG decoding, Lua suspension,
actual shared WebGL alpha pixels, ascending GPU overlap order, retained resources and
upload-error cleanup. It contains no game assets. Browser checks use explicit
sampler/blend fixtures and do not establish native GPU equivalence.

`stage.ts` supplies native `flip` through required stage effects. Nonzero script
capture mode returns immediately. Transition state 2 clears the transition rule
and resets the transition layer's virtual +0xe0 value to uint32 -1 before changing
state. The adapter then writes transition state 0, marks the scene dirty, commits
the actual layer/resource owner and changes a nonzero refresh state to 2. Refresh
state is read after commit, preserving effects from resource release callbacks.
Native entries: flip prefix `0x1400e10a0` and helper `0x14014f420`.

The flip prefix is present as a Ghidra label rather than a canonical function;
its saved raw bytes/instructions confirm the capture-mode branch and tail jump.
Transition reset's stored field +0x168 is confirmed by `0x1400a4960`; its full
transition rendering semantics are still host work. `flip` marks presentation
pending; the scheduler/presenter decides when to draw. It does not bypass required
transition effects or silently perform them with a scene commit alone.

`layer-commands.ts` owns the native per-id command lists required by the raster
services (`0x140144570`, called by `0x1400b9cd0`). Missing id does not record a
command. Recording scans backward for the newest same-name command whose selected
comparison keys exist and match in both argument maps. It merges incoming
arguments into that record without replacing the earlier line/name; intervening
commands do not prevent merging. Ordinary properties use an empty comparison-key
set. Other registration owners can supply their native key sets.

Lists preserve raw id strings, so numeric aliases remain separate registry keys.
Reset creates an empty list; deletion removes exact selected ids. Returned history
and UTF-8-byte-ordered snapshots copy argument maps. These data are inputs for the
native save owner; the registry does not serialize them as a substitute save format.
The browser fixture connects actual reset/clear/property recording to this registry.

`gpu-raster.ts` maps the ordinary D3D11 sampler and blend descriptor to shared
draw commands. Native renderer initialization `0x14015f1d0` creates filter 0x15
with clamp addressing, and `0x14015fd30` binds that sampler at slot 0. Ordinary
shader-table entry 0 samples the foreground texture and multiplies its alpha;
it does not discard transparent texels. Mode 0 in `0x14015d120` uses RGB source
alpha / inverse source alpha, but alpha source alpha / one. Alpha accumulates the source alpha squared plus
the previous target alpha, clamped to the target format. Native frame
clear `0x14015fe10` supplies transparent black. Shared `DrawList.clearColor`
preserves the existing opaque-black default for other callers.

These constants map to Microsoft's [D3D11 filter enumeration](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_filter),
[blend enumeration](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_blend)
and [render-target descriptor](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ns-d3d11-d3d11_render_target_blend_desc).
The synthetic browser test reads actual framebuffer RGBA while scaling a
transparent-red/half-alpha-green PNG over quarter-alpha red. It checks linear interpolation,
independent alpha writes, transparent-fragment writes and transparent clear.
This establishes the implemented WebGL behavior against the recovered equations;
it is not a native GPU differential test. Texture mip chains,
custom shaders and alternate rendering backends remain outside this policy.

`lyprop clip` accepts exactly four comma-separated fields: left, top, width and
height. Prefix float parsing includes empty fields as zero and stops at NUL.
Inclusive right/bottom endpoints use separate float32 addition and subtraction
of one (`0x140115650`). The native setter compares only left/top/right/bottom
before copying all six fields (`0x1400a45d0`); the initial all-zero rectangle
therefore ignores `0,0,1,1`. Unchanged rounded endpoints preserve the old dimensions.
Clip state is retained independently of geometry and wrapper alpha.

Positive width and height enable source cropping. An entirely outside rectangle
skips drawing; nonpositive dimensions disable cropping. The resulting quad starts
at local zero with its cropped size, while UVs retain the clamped source offset
(`0x14015d120`). Anchors keep their original image values. Linear sampling still
uses the full texture, including adjacent texels at a clip boundary. Node tests
check retained state, inclusive bounds and endpoint rounding; the synthetic GPU
fixture checks the rebased cropped quad and actual linear-sampled framebuffer.

`lyprop layermode` preserves the native exact spellings `normal`, `add`, `screen`
and `multiply`; any other value leaves the old mode intact (`0x140115650`). Mode
state belongs to the inner image actor and is copied independently of its shared
outer-wrapper alpha. Retained rendering keeps the earlier mode until commit.
Custom raster policies must supply their mode owner before non-normal modes can
be applied. Native setter `0x1400a4680` changes field +0x100 and invalidates the
blend state; the shared renderer selects each draw's blend explicitly.

Add uses source-alpha / one for RGB. Screen's shader 24 premultiplies RGB by its
effective alpha, outputs alpha 0 and blends inverse-destination-color / one.
Multiply's shader 48 interpolates foreground RGB toward white as effective alpha
decreases, outputs alpha 1 and blends zero / source-color. Their distinct alpha
outputs are preserved, including transparent texels in multiply. The browser
fixture checks actual framebuffer RGBA for all four ordinary modes. Captured-back
shader variants and color-key mode remain unsupported.

`negative`, `grayscale` and `colormultiply` belong to the same copied inner actor.
Native setters `0x1400a46d0`, `0x1400a46f0` and `0x1400a4710` invalidate its
shader state. The 24 recovered foreground shaders (indices 0–7, 24–31 and 48–55)
apply negative, then grayscale, then RGB multiplication, before the mode's
alpha expression. Grayscale uses weights 0.298912, 0.586611 and 0.114478.
Color bytes are divided by 255 as float32; the high byte does not affect RGB.
Boolean properties preserve the native exact `"0"` comparison, and hexadecimal
colors preserve Windows uint32 prefix parsing and overflow saturation.
Custom raster policies require an effects owner before any non-default effect
is applied. The synthetic browser fixture checks framebuffer pixels for all
32 combinations of four modes and three effect flags; these checks do not
establish native GPU rounding equivalence.

The exact-hash raster policy also exposes the format-2 captured-background
shaders (indices 72–79, 96–103, 120–127 and 144–151). These sample a GPU
snapshot through additional texture 0 and replace the destination RGBA without
hardware blending. Alpha uses `back.a * (1 - fore.a) + fore.a`; RGB follows the
native normal/add/screen/multiply formulas and divides by that output alpha.
The native zero-alpha division is preserved. All 32 effect combinations are
checked with synthetic nonzero-alpha foreground/background texels in Chrome.
The group owner below schedules these shaders with GPU background copies.

`surface-cache.ts` supplies the ordinary native surface-manager loan policy
(`0x140011a90`, `0x140012200`, `0x1400116b0`). Requested UTF-8 names are exact cache
keys, independently of the loader's resolved extension/path. Active hits add a
loan; idle hits remove the surface from its FIFO position and reuse it. Only a
miss trims oldest idle surfaces, and only while the current total exceeds the
budget. It does not reserve space for the new resource, so active surfaces can
exceed the budget. The last loan disposes its surface immediately when over
budget; otherwise it appends the surface to the idle FIFO. Active resources are
never evicted by trimming.

The host supplies the uint64 budget, native storage size and actual surface
prepare/dispose effects. Decoded RGBA length is not assumed to be native GPU
storage size. Idle resources retain their GPU binding through empty frames.
Cache shutdown releases idle resources immediately and defers active disposal
until the last loan returns. A decode completing after shutdown is disposed.
Worker preloading and overlapping native load modes are explicitly unsupported.

`ArtemisLoadedImage.lease` represents one load's loan. Successful layer creation
transfers it to the outer image wrapper. Current/retained inner actor copies share
that wrapper; they do not add surface-manager loans. Separate layers each retain
their own loan even when sharing one texture. Cancellation, failed actor creation
and blocked scene insertion release their unadopted resource. Ordinary unmanaged
images keep the earlier last-actor invalidation behavior. Cached resources use the
surface owner's disposal effect instead. Close layers before closing the cache
and raster target at installation shutdown.

## Ordinary group display properties

Empty hierarchy nodes allocate their native identity property holder through
`createGroupLayer` when created. Ordinary `lyprop` can update that group's geometry, alpha,
visibility and reversals. First edits retain the previous inner state until commit;
subsequent edits reuse the current copy. The shared outer alpha metadata remains
separate from draw opacity. No image texture or resource loan belongs to an empty
ordinary group.

The raster traversal follows native ascending GPU preparation order (`0x140186770`),
composes each child's float32 matrix with its parent's world matrix, and multiplies
parent/child alpha in float32 (`0x14015b440`, `0x1400b3790`). Hidden groups,
nonpositive scales and effective group alpha below `2**-23`
suppress their entire descendant branch during preparation. Group anchors default
to zero; image anchors remain centered. Empty dotted identifiers and numeric aliases
retain scene lookup semantics. Nonzero group rotation still requires the native
float trig owner.

The display owner retains the native parent-matrix acceptance state
(`0x14015adc0`, `0x14015b440`). All six float32 differences must be strictly below
`2**-23` to preserve the previous parent matrix; reaching the threshold updates all
six coefficients together. Inner copies preserve this parent and world state
(`0x1400a17c0`). The browser memoizes unchanged geometry calculations, while alpha
and visibility remain live. Each implicit group owns its own display state.
Native updates a holder's matrix before testing its own visibility or alpha;
nonpositive scales and a gated ancestor prevent that update. Consequently a hidden
rotated holder still needs the native trig provider.

## Intermediate group composition

`lyprop intermediate_render` changes the group's shared node configuration before
holder commit. Exact `0` disables and releases capture storage; every other value
enables it. Exact `1` selects format2, exact `2` format1, and other values retain
its previous format (initially2). Type1 image leaves ignore this configuration,
as native `0x1400b30b0` does. Group clip, layer mode and color effects belong to
its copied holder and are used when rendering the group's captured result.
They do not affect a direct group with intermediate rendering disabled.

The retained GPU path binds a persistent surface, prepares children ascending with
identity translated by minus the capture bounds and alpha1, restores the parent
target, then paints the captured layer using the group's matrix, opacity and
raster effects. Nested captures restore their own parent target. Format2 uses
the captured-background shader and a GPU snapshot before each layer; format1 uses
the ordinary blend path. Neither surface format forces alpha opaque.

Positive clip dimensions select explicit bounds with float32 left/top and ceiled
allocation dimensions. The output clip starts at0,0 and preserves the original
fractional width/height. Otherwise bounds callbacks walk descendants regardless
of visibility/alpha, composing uncached local transforms and extending four
pixel-center corners at0 and dimension-minus-one. Nonzero image clip dimensions
override natural dimensions independently. The bounds rectangle starts with all
six fields0; extending an endpoint recomputes its dimension inclusively. This
preserves origin inclusion and the native degenerate single-point behavior.
Nonzero rotation still requires the native float trig owner.

Without a mask, capture storage is resized only when either requested dimension
exceeds capacity. Both dimensions become the newly requested values. A change of
preferred format alone does not replace existing storage; its old format remains
until resizing. Holder copies share capture ownership, and disabling/releasing
the final wrapper releases each GPU attachment once. Allocation failure leaves
existing browser storage owned, reports the failure and permits a retry; the
native flags0 fallback has no browser render-target implementation.

Unchanged committed descendants reuse their captured surface. Preparation tracks
actor identities, property changes, child keys, clips and nested capture configuration;
a failed draw does not mark pending snapshots reusable. Parent geometry/alpha
updates can repaint a cached capture. Clear is lazy: the first eligible image
preparation clears the entire intermediate target before source clip rejection.
A capture containing no eligible image retains earlier pixels, including when
empty auto bounds fit an existing allocation. The main presentation clear remains
independent of this intermediate rule.

The synthetic browser pipeline checks actual RGBA for both formats, nested targets,
retention, effects, growth and empty captures. Mask loading/transition shaders,
current-view capture buffers and full native dirty-flag accounting remain
unsupported. This rendering service is not connected to a production Artemis
player or a complete game scheduler.

## Merged PSD images

`src/formats/artemis/psd.ts` implements the default CPsdLoader merged-image path
(`0x140187d00`), selected with matte recovery enabled by the exact stage initializer
(`0x14014d100`). It accepts PSD1, 8-bit RGB documents with three/four channels and
raw or RLE planar composite data. It skips color/resources/layer sections and
reads the merged image; the other engines' first-layer decoder is not used.

RLE preserves the native `0x80` repeat129 interpretation and channel-major row
counts. Three channels force opaque alpha. With four channels, nonzero partial
alpha recovers color with signed integer division toward zero:
`clamp(trunc((channel - 255) * 256 / alpha) + 255)`. Zero-alpha RGB is preserved;
an entirely zero alpha plane is instead treated as absent and forced opaque.
The reader validates source ranges before allocating output, and refuses
incomplete/overrunning rows or native unsafe signed row lengths rather than
publishing uninitialized pixels.

The shared image worker accepts `artemis-psd`; input is snapshotted and never
transferred away from archive/cache ownership. Worker failures rerun the same
in-thread decoder to report its original error. Synthetic checks compare raw/RLE
output, recovery and channel order, real worker transport and resulting WebGL
RGBA. Named layers, PSB, additional color/depth/compression layouts remain
unsupported. No real game image was decoded for verification.

## Browser JPEG owner

`createArtemisBrowserImageLoader` keeps the exact stage codec order and supplies
an opaque RGB JPEG owner using the shared `opaque-jpeg` worker service. The base
`createArtemisImageLoader` still permits an injected JPEG decoder for other hosts.
The native default CJpg file path (`0x140178e80` / `0x140179120`) has no alpha sidecar;
its grayscale format0 and paired-alpha path remain unsupported by this browser owner.

The shared marker reader strips APP1/APP2 metadata before browser decoding, so
EXIF orientation and ICC profiles do not change stored pixels/dimensions. It
preserves stuffed entropy bytes, restart markers and metadata between scans.
The decoder accepts 8-bit, three-component baseline/progressive frames and checks
that returned dimensions match the stored JPEG frame. Browser bitmap/readback
must preserve opaque alpha. Archive bytes are snapshotted for worker transfer,
and generic browser Blob construction copies exactly the supplied byte view.

The synthetic Chrome check encodes a2x3 solid JPEG, injects valid EXIF orientation6,
confirms the ordinary browser bitmap rotates to3x2, and verifies that the Artemis
owner keeps2x3 and paints expected RGB. This validates ownership and metadata
policy, not byte-exact equality to the native JPEG library's DCT/color rounding.
No real game JPEG was decoded or rendered.

## Nonvisual resource geometry probe

Image codecs/resources and layer hosts can select a logical image-dimensions type;
the ordinary raster owner retains the default straight-RGBA type. This permits an
explicit geometry-only owner without fake pixel buffers or GPU allocations.
`tools/probe-artemis.mjs --image-metadata --async-lua` uses such a record-only
fixture, reads encoded resource headers and drives the actual layer lifecycle,
property parser, scene commit and suspended Lua. It never decodes image pixels or
presents game media. Its JSON declares the fixture, nonvisual mode and resource
resumption count; unsupported services still stop the probe. PNG/PSD header checks
are geometry inspection, not evidence of full decode compatibility.

Creation keys `file`, `width`, `height`, `color` and `rule` forwarded to `lyprop`
are retained in its original command record and ignored by ordinary property
application, matching `0x1400d76d0` / `0x140115650`. The game forwards the table
used by `lyc`; property application does not reload or recolor its image.
Unknown/unimplemented actual property keys continue to refuse.

The real nonvisual probe, with explicit simulated dialog result and timed waits,
now creates the header-verified1920x1080 `:bg/black.png` layer and applies its
forwarded properties. It stops at missing `getMousePoint`. This is control-flow
progress through initialization, not playable game output or a rendered frame.

## Lua pointer query

`getMousePoint` is bound only when the Lua host supplies the shared
`PointerPositionHost`. Its owner supplies already-mapped window/input coordinates
without consuming pending input edges. Native `0x140134ca0` reads its provider twice:
firstx, theny; both are float32 values widened to Lua numbers (`0x140138f10`),
not integer coordinates. Each call returns a fresh table with namedx/y fields.
Nonfinite provider values refuse. Native input sampling and stage coordinate
mapping remain the input owner's responsibility.

The metadata-only probe explicitly selects simulated position0,0 and marks that
fixture in JSON. It now passes cursor resource creation, mouse configuration and
flip; the next unsupported boot command is `caption`. Lua aliasesx/y/zoom forwarded
by the game's lyc2 helper remain in recorded tags and do not override the normalized
left/top/xscale/yscale property names consumed by native115650.

## Window caption

`ArtemisCaption` implements the UTF-8 `caption` command (`0x1400c9870`) through
shared `WindowCaptionHost`. Missing data clears the caption; UTF-16 strings stop
at the first NUL as SetWindowTextW does. The native command ignores the host's
failure result. `BrowserWindowCaptionHost` changes only its selected document's
title and reports failure when no document is selected. Legacy ANSI caption
conversion remains unsupported.

The nonvisual probe records caption changes. Boot now advances past caption and
stops at `chgmsg id=name01 layered=1`, the first message-layer selection command.

## Message-layer selection

`ArtemisMessageLayers` implements the named stage store and independently retained
selected pointer (`0x14014f490`). Required owners construct/copy the complete
CLinkableTextLayer resource bundle, manage loans and attach/detach scene wrappers.
Selecting an existing layer with mode0 keeps its layered state. Explicit mode1/-1
first detaches and copies an already layered resource; mode1 attaches the new
copy, while mode-1 leaves it detached. Missing names create a new bundle. Scene
owners must retain earlier frame resources after detach. Shutdown releases its
logical loans; font/render/resource construction is not replaced with placeholders
in this production interface.

`ArtemisMessageSelection` handles `chgmsg` and `/chgmsg` (`0x1400d1c10` / `0x1400d20d0`).
Stacking defaults enabled; only exact `stack=0` disables it. Missing `layered`
selects mode0, exact0 selects mode-1, every other spelling selects mode1. An omitted
id requires the script owner's automatic-name allocator. The command reseeds
missing message history after a detach request, publishes `s.current_message_layer`,
emits INFO3 selection diagnostics and requires message wait/indicator updates.
The restore command pops the prior script name and selects mode0. Empty-stack
restore emits its INFO3 diagnostic only. Backlog's transient stage selection does
not alter this script selection stack or create script history.

Synthetic owners verify layer copies preserve their supplied font state, independent
map/current/scene loans, exact flag handling, history effects and restore behavior.
The nonvisual probe's message resources explicitly remain a simulation with no
text presentation. Its real Lua initialization now reaches `fontinit`; font/glyph
construction, style application and text rendering are still unimplemented.

## Font stack and properties

`ArtemisFontStack` implements native `fontinit`, `font` and `/font` history.
Initialization snapshots the current selected font; a normal font command pushes
a complete owner-created frame. Exact `stack=0` replaces a nonempty top frame.
Restore requires two frames, releases the current frame and applies the preceding
one. Empty restore emits a diagnostic. History recording can be disabled for replay.
Owners remain responsible for complete font resources and actual text rendering.

`artemisFontProperties` parses the 38 observed native attributes as partial patches,
preserving omitted defaults. Numeric conversions, double division before float32,
colors, modes, alignment and comma-separated style flags follow a74d0. Style spans
are not trimmed. Overflow belongs to the command frame rather than copied font
attributes. Unknown keys and out-of-range conversions are refused.

Display property revisions invalidate intermediate captures when an owner changes
a descendant directly; identical assignments and parent-only transforms reuse
captured pixels. The nonvisual boot probe now reaches `scetween type=show mode=init`
after simulated message/font control. This does not verify game text presentation.

## Text effect configuration

`ArtemisSceneTweens` implements `scetween` (cdae0): `init` clears the selected
vector, `add` appends a copied descriptor. In/out/show/hide are keyed by the script's
current message-layer name; four backlog vectors are shared across names. Snapshots
survive later mutations. Parameters distinguish whole-layer and per-character effects;
ease names retain native dispatch ids. Diff rounds to float32 before alpha/scale
division, and time wins over the legacy msec key even when explicitly empty.
Unknown modes/types do not modify vectors, matching the handler's explicit return.
This configures future text effects; a text/frame owner must actually apply them.

`ArtemisTextBreakControls` dispatches `indent`, `prohibit` and `wordparts` to the
selected text resource. UTF-8 characters form pairs; duplicate openings replace
previous closings and a trailing unmatched character is discarded. Range is int32;
logicalrange/nest use native exact-zero flags. History and remembered replay slots
are copied separately, with wordparts sharing the indent replay slot. Replay mode
suppresses both history writes. Owners must store the copied configuration and
apply it during actual layout. `artemisUtf8Prohibition` supplies the encoding2
native defaults independently for each empty prohibited-character set.

## File fonts and print dispatch

`ArtemisFileFonts` reconstructs the Unicode file-backed CFreeTypeFont subset.
An explicit owner reads font files and supplies FreeType2.4.8 worker faces. Exact
paths share face resources until their final loan closes. Sizes narrow to uint8;
zero-size error handling remains unsupported. Each glyph job applies the CELL size
atomically, preserving independent sizes/styles on a shared face. Baseline and
underline/strikeout metrics use the native signed integer formulas. Glyph advance
uses arithmetic shift of the 26.6 value; glyph top is relative to the font baseline.
The native post-render italic outline transform does not rerasterize its bitmap.
System fonts, legacy character conversion, renderer atlas/edge algorithms and text
layout remain distinct owners.

`ArtemisPrint` handles print/ruby-buffer/debug-skip routing, diagnostics, overflow
variable writes and consumed-prefix history. The required insertion owner returns
its native result and the first unconsumed UTF-8 byte offset. Overflow policy0
appends `@`, `rp` and the remaining print tag to the existing FIFO; other policies
keep only the consumed prefix in history. Replay suppresses history writes, not
native overflow effects. Async calls retain copied arguments and reject overlapping
prints. `cancelPending` discards stale script effects after script transfer; the
layout owner independently cancels its insertion job before reusing resources.
No recording-only print owner is supplied to the nonvisual boot probe.

`paintArtemisGrayGlyph` reconstructs the grayscale glyph branch of166420. It owns
RGBA storage with native outline/shadow padding and padded advance. Outline pixels
use a square maximum; nonzero foreground coverage mixes foreground/outline RGB
but writes opaque alpha, preserving the native float32 rounding and truncation.
Shadow copies painted alpha diagonally underneath existing pixels. Underline and
strikeout rows use required font-provider metrics, including whitespace and bearing
expansion. `ArtemisGlyphPainter` executes this work in a dedicated engine worker.
Coverage is copied, painted pixels are transferred and close rejects pending jobs.
Native atlas allocation is replaced by independent images; packed-bit/RGBA font
sources and oversized/negative edge cases remain explicitly unsupported.

A generated rectangle font verifies FreeType worker → native glyph paint worker →
GPU output in the browser. The integration still requires actual text blocks, line
layout, effects and production player wiring; no real game glyphs were displayed.

`layoutArtemisTextBlock` reconstructs normal/ruby stream placement from1971e0.
Advances add kerning only when painted advance is positive. Net-width comparison
removes each stream's last kerning; the longer stream supplies the stored full
block width and the shorter receives evenly distributed gaps. Empty ruby text
still reserves its configured vertical space. Glyph resources remain owner-supplied;
positions and layout snapshots are copied/frozen. `ArtemisTextLine` implements line
append/pop, native width/height counts, bottom-aligned block rows and four alignment
modes, including single-block equalize fallback. Wrapping, indentation/prohibition,
vertical display rotation and resource lifetimes remain text-layer owner work.

## Logical text insertion and frame ownership

`font-state.ts` supplies the complete37 native attributes from193720. It keeps
factory face labels as their original13 Shift-JIS bytes; file-font rendering must
receive an actual filename. A missing system/default font provider is refused when
that stream is used, not replaced by a browser font. Font command patches keep the
history frame's overflow extra separate from attributes.

`ArtemisTextInsertion` connects actual glyph blocks, UTF-8 runs, block flags and
full indentation/wrapping storage. It copies input bytes, reports native consumed
byte cursors, rolls back the global glyph counter on unprintable/overflow results,
and preserves line mutation already performed by recursive wrapping. Logical glyph
ids are new for every insertion even when painted pixels are shared. Counter520
includes normal and ruby glyphs; line90 counts normal glyphs only.

`ArtemisTextWrapping` retains paired closing-string/width stacks, range and logical
range, nest behavior, empty indent placeholders and the one-level pop-without-
replacement branch. Explicit configuration replacement preserves active stacks.
`ArtemisUnindentedTextWrapping` remains a facade that refuses active pair mappings.

`prepareFrame` follows14c5d0: finalize only the current nonempty line; keep closed
line placement and avoid reserving height on an empty current line. Frame row Y is
computed from stored heights separately from cached insertion Y. Auto anchors use
native maximum width, alignment and total line height. Each glyph retains its
captured font attributes; published frames retain logical resources after close.
The required publisher performs actual display effects. Tests use both real workers
and a generated font to publish an insertion frame through GPU drawing.

`measure` follows149d90/149e60/149ea0, including omission of current line height when
its main glyph count is zero. `copy` clones logical line/indent/font/glyph state and
preserves ids while sharing painted storage. It is not a complete CLinkableTextLayer
copy: the enclosing owner must additionally handle display state, in/out job handles
and native link-scope movement. Native full clones move link scope and active flag
out of the source; plain CTextLayer clones clear copied job lists instead.

`insertRuby` creates a single native main/annotation block, with global glyph ids
for both streams. `ArtemisRuby` follows the global buffers and end-command layer
selection. Automatic page overflow queues `@`, `rp`, `/ruby` while retaining active
buffers; inactive/nested/unprintable behavior and history follow the native branches.

`ArtemisTextCommands` implements `rt` (newline) and `rp` dispatch. Backlog capture
uses write-backlog mode, separately from the UI backlog-allowed flag. A replay
skips history/backlog maintenance but still calls the required resource-clear host.
`clearEmptyEffects` follows1962d0 only after that host has cancelled jobs and
confirmed no outgoing descriptors: it conditionally resets lines/counters while
retaining indentation stacks and newline state. It is not a replacement for
animation scheduling or a complete CLinkable clear.

The default real metadata-only probe continues to refuse print. Optional
`--glyph-layout` (requires `--async-lua --image-metadata`) uses the actual font and
glyph workers through the Node browser-worker adapter, returning metrics and hashes
without displaying game assets. Calibration print/rp pass, then `bindSurfaceAsync`
is refused. Lua exposes this strict-string/NUL-terminated void binding only when
an actual preload host is supplied; the probe supplies none. Optional
`unbindSurface` requires a strict NUL-terminated name; `isLoadingSurface` returns
a boolean for a string name or the whole queue for any non-string argument.
Their hosts must own the real queue and binding lifetimes. Native loading needs
FIFO preload jobs, prepared surfaces, promotion/wait behavior and cancellation.

Message-store/display wiring, links, text effects, vertical rotation and production
player integration remain separate work; diagnostic progression is not gameplay.

## Asynchronous surface preload ownership

`ArtemisSurfaceManager` connects native011a90 lookup/promotion,0128b0 worker FIFO
and012200 release policy. Its required host creates a fresh prepared surface,
decodes actual pixels into it, reports native storage size and disposes resources.
PNG headers or guessed widths cannot satisfy that host. Script bindings and
foreground image leases share active/idle resources; duplicate queued names add
no binding, while a cached bind adds one. Mode2 checks current usage against the
budget before decode; mode1 may exceed it. No room for the new surface is reserved
by native trimming. Background success holds a script binding until unbind/close.

An ordinary load waits/retries for the queue head or removes/promotes a later job.
Unsupported overlapping foreground loads are refused. Decode runs outside logical
queue selection. Completion revalidates the front **name**, preserving the native
same-name clear/requeue behavior; cancelled placeholders retain their resource
until the in-flight decoder releases it. Browser cancellation wakes pending calls,
an explicit adaptation from native condition-variable waiting. Close rejects new
operations, clears/joins background work and drops script bindings; held foreground
leases keep their decoded resources until released. Decoder null is an ordinary
miss; unsupported host exceptions remain available through `loadFailures` and the
diagnostic `waitForLoads` join.

Lua exposes optional strict-string bindSurfaceAsync/unbindSurface and no-argument
clearSurfaceLoadQueue hosts. isLoadingSurface(string) queries a name; any non-string
queries the whole queue and returns a boolean. No queue host is invented by default.

`probe-artemis --surface-preloads` additionally requires --glyph-layout and uses
a real shared image worker for RGB/RGBA PNG and merged PSD pixels. JPEG and other
PNG native format branches explicitly refuse in this Node diagnostic. Only metrics
and hashes are exported; it does not prepare GPU surfaces, display assets or claim
production rendering. The host's RGBA8 format and512MiB budget are explicit diagnostic
policies, not inferred settings of the original game. Existing metadata layer
fixtures remain simulated and are independent of these pixel resources.

`ArtemisLayers.attachActor` adopts a fresh stage wrapper into the same hierarchical
scene as image actors. `detachActor` removes its current attachment; retained child
maps and inner actor slots keep their own resources until commit. The supplied
copy/property/release hooks therefore apply to message wrappers as well. Stage
attachment does not reset script command history. Fresh/open/pending checks precede
ownership transfer; insertion failure releases an unadopted wrapper.

The metadata probe connects layered message selection to these APIs, with actual
resource-loan accounting. This repairs the diagnostic split between its message
store and graphical scene. Properties/deletion now find UI text actors; it still
does not publish their frames, implement links/effects, or claim text rendering.

`ArtemisSeStop` follows e3c60 for sestop/sefadeout: exact named slot lookup,
integer-prefix milliseconds, mandatory stop/fade service for an existing slot,
and normal-execution history deletion. A missing slot does not parse time or call
audio services; replay retains history. This is a command contract, not a playback
implementation. The diagnostic has an empty SE table until an actual play owner
is supplied; seplay remains unsupported.

`ArtemisSePlay` follows e3370 for seplay/sefadein: stop an existing named effect,
check skippable command mode, prepare a real sound, assign its index, set explicit
gain/pan and optional s.segain.id gain, then start with native time/loop arguments.
Debug skip bypasses audio while maintaining replay history; skippable command skip
returns before history. Non-loop sounds replace history with the native empty
block. Load failure reports without writing a new slot or history. Cancellation
releases a completed, unadopted sound and suppresses stale script effects.

The required prepare/gain/pan/start services own actual playback. Optional
`--sound-decode` requires --surface-preloads in the diagnostic and uses the shared
Vorbis worker to decode real PCM, exporting hashes and metadata. It opens no audio
graph/device and explicitly refuses startEffect. Decoding :sysse/none.ogg succeeds
at48000Hz/stereo/11685frames; this is not evidence of native PCM rounding parity or
game playback. `ArtemisVariables.lookup` supports non-inserting, owned-byte lookup
for optional named gains without inventing missing system variables.

## Effect voices and device attenuation

`ArtemisEffectVoices` owns real `AudioVoice` resources, signed-key gain factors,
per-factor/pan fade jobs and preparation-time inactive collection across managers.
Default integer fades use native first-tick/uint32 absolute-time behavior, float64
interpolation and int32 truncation. Gain projection uses float32 factor reduction
and native rounding, followed by the DirectSound centidB conversion. Fade-out
completion stops/rewinds the voice; its manager row remains until inactive cleanup.
Immediate stop disposes it. Close cancels jobs and retires all owned voices; a late
prepared voice is disposed before any stale script effect.

`createArtemisBrowserEffectVoices` joins a required PCM decoder with the shared
`BrowserAudioTransport`. The transport has optional loop/reset and independent
stereo attenuation controls. Mono is duplicated into both channels; stereo content
is attenuated without crossfeed. Offline contexts permit actual WebAudio processing
without device output. Ordinary callers retain their existing initial controls.
The codec owner remains responsible for native formats and buffer-mode semantics.

The synthetic browser smoke verifies real offline PCM gain/pan and mono behavior,
alongside text/GPU resources. Node diagnostic decoding still refuses playback;
no silent or timer voice substitutes are installed there. Native PCM16 quantization,
streaming modes and the production audio/scheduler/profile wiring remain separate.

### Native sound filename lookup

`ArtemisSoundLoader` follows Rev.3179 `190290`: it first tries codecs advertising
an exact case-sensitive suffix, then all registered codecs on the exact file,
then appended extension candidates in codec/extension order. Appended files are
only passed to their corresponding codec. Native char-pointer filenames stop at
NUL; buffer modes are forwarded unchanged as int32. Decode misses return null,
while unsupported services and decoder failures propagate. Independent byte
storage lets each asynchronous decoder begin at offset zero without detaching or
modifying subsequent attempts. The generic loader accepts an explicit codec list. Revision-selected
`createArtemisSoundLoader` installs native Vorbis (`ogg`, `OGG`) before WAVE
(`wav`, `WAV`), as verified in constructor `b9e80` and the codec extension methods.
Both decoder services are mandatory; their native formats and buffer modes are
separate responsibilities.

The nonvisual sound probe uses an explicit Ogg-only diagnostic registration and
the actual shared Vorbis worker, now including suffix lookup. A synthetic browser
fixture connects this loader to actual offline WebAudio voices. Neither check
opens audible game playback or proves native codec/streaming-mode completeness.

`ArtemisWaveSource` provides the actual encoded PCM resource owner from `19d570`,
`19e170` and `19e120`. It validates native PCM/channel/rate/alignment fields,
ignores the RIFF length boundary, and skips chunks without standard odd-byte
padding. Truncated payloads retain the advertised data size and return only bytes
actually available. Exact lowercase `_a` names attempt a paired `_b` resource;
reads cross the boundary, and reset stays on B once activated. Missing or invalid
paired resources leave the main source usable. It does not interpret PCM, create
a voice, or claim support for backward seeks from negative chunk sizes.
The sound codec receives the resolved filename to preserve this source behavior.

## Buffered sound codec services

`ArtemisVorbisPcmDecoder` runs the shared real libvorbis decoder and Rev.3179's
float32 scaling / signed32 conversion / PCM16 saturation in reusable module workers.
The installation supplies an explicit SSE rounding policy; no native FPU state is
inferred. PCM keeps encoded channel order. Encoded-data decode misses return null;
worker/host failures propagate. Closing stops workers and rejects pending adoption.

`ArtemisVorbisSource` retains actual decoded integer bytes and native paired-file
read/reset semantics. Unlike WAVE, reading exactly to A's end retains A until a
later nonzero read observes EOF. Sub-frame reads and progressive decoder error timing
are unsupported in this eager resource adaptation.

`createArtemisBufferedSoundDecoder` joins the revision-selected filename codecs,
WAVE/Vorbis resource owners and shared integer-PCM conversion worker with the browser
voice adapter. Only native `buffer=-1` is implemented: complete A+B storage, with
hardware repeat of the whole clip. Native source B-only reset is used by streaming,
not cached hardware looping. Zero/positive buffer modes still require the native
rolling-buffer service. The decoder does not create an audio context itself.
PCM8/16, aligned frames and complete payloads are supported; other bit depths and
truncated cached payloads are explicitly refused. No silence substitute is supplied.

Native references: `88340` (Vorbis integer samples), `19cb30/19d390/19d2f0`
(Vorbis resources), `163a80` (buffer sizing), `164410` (fill/play), `1640c0`
(rolling refill versus cached completion). Synthetic browser checks distinguish
A+B cached repeat from the B-only streaming-source reset behavior.

## Progressive PCM device voices

`ArtemisRollingSoundBuffer` owns the native two-half PCM ring, partial-read padding,
strict inactive-half cursor boundaries and trailing-half stop count. It reads real
PCM byte resources; it does not provide a voice by itself. `ArtemisPcmCursor` owns
transferred WAVE/Vorbis snapshots inside the audio processor without changing the
source owner's cursor.

`createArtemisBrowserSoundVoices` selects cached `buffer=-1` or actual progressive
AudioWorklet voices. `ArtemisEffectVoices.tick` pumps progressive buffers from the
engine scheduler; the device render callback advances playback position. A delayed
pump can replay stale ring data, matching the native buffer behavior. The shared
PCM host provides its real ScriptProcessor compatibility fallback where worklets
are unavailable. Mono duplicates into stereo, and per-side attenuation is independent.

The browser adapter prefills both halves before output; native fills its second
half during the first engine tick. Sources are eagerly decoded in codec workers.
Progressive decode timing, damaged/chained streams and DirectSound lost-buffer
recovery remain separate native services. Fractional device rates use browser
linear interpolation; no target-driver bit identity is claimed. Worklet control
commands have completion fences for tests and callers that must observe state.

## Offline PCM and sound completion

`createArtemisOfflineSoundVoices` uses actual decoded PCM and the same progressive
processor without opening an audio context or device. Its caller renders explicit
sample-frame blocks and supplies scheduler ticks. Cached clips use the shared
`PcmClipRenderer`; frame positions advance from consumed samples, not timers.
`--sound-render` enables this diagnostic after `--sound-decode`, reports PCM hashes
and explicit clock/rounding policy, and can pass real `seplay` control flow.

`ArtemisSoundFinish` captures copied set/del registrations. Missing `id` chooses
music; present empty `id` chooses that exact SE slot. Missing slots do nothing.
The voice owner's native playing flag settles on frame tick, then invokes its
finish callback once. Explicit stop and fade-out do not emit natural completion.
The required event dispatcher owns filter/scope/queue semantics of the captured
command. The probe currently refuses that script dispatcher if a callback fires;
registration itself is supported. It does not invent default event actions.

Graphics feature level is published only through an explicit revision-selected
owner callback. `--graphics-feature-level=NUMBER` is an optional simulated diagnostic
value, recorded as such; it is not a report about browser/Windows GPU capability.

## Named shader resources

`ArtemisShaderLibrary` implements `lyshader` file/compile/registry ownership with
mandatory compiler and diagnostic services. Shader IDs are independent of layer
existence. Actor leases retain compiled resources across replacement or library
shutdown. File misses and compiler errors preserve an existing named program;
unsupported compiler services propagate. Late compilation after close disposes
its resource before refusing adoption.

`compileArtemisRasterPreset` selects the reconstructed CPU/GPU raster executable
only for its exact input SHA-256 and engine revision. Original game shader text is
not shipped. The program displaces UV1.x by `sin(radians(UV1.y*inter-angle))*size`,
samples foreground and multiplies only alpha. Back/mask samples and color multiplier
have no observable contribution in this source. Sampler filtering/addressing belong
to the host. `ArtemisBrowserRasterShader` provides a real linked WebGL2 program on a
dedicated context; actor-specific scene binding is now wired as described below; parameter animation jobs remain separate.

`--shader-presets` adds actual known-source CPU executable registration to the
nonvisual probe. It does not display or shade game image pixels. Its optional
feature-level input remains explicitly simulated. Unknown HLSL sources are refused;
this is a verified preset port, not a general HLSL compiler.

The recognized `screen` shader screens foreground RGB against `user.rgb*user.a`
and scales foreground alpha independently. Its declared `param`, back/mask samples
and color multiplier are unused by the returned color. The exact source signature
selects its reconstructed executable through `compileArtemisShaderPreset`.
The dedicated WebGL helper accepts this preset with an explicit user texture;
synthetic checks compare GPU output against the CPU screen equation.

The exact-source selector also recognizes `sepia`, `sepia2`, `gray`, `blur_h`
and `blur_v`. Color luminance uses (.298912,.586611,.114478); sepia2 adds
its red coefficient while sepia multiplies it. Both multiply green/blue and
foreground alpha. Gray repeats luminance in RGB. Blur accumulates fifteen taps
in center, positive, negative order for offsets 1..7, with eight explicit weights
and a UV step on the selected axis. It scales accumulated alpha after filtering.
These presets have real CPU references and linked WebGL2 implementations;
GPU dot/FMA rounding and sampler policy can affect numerical results.

Nega inverts foreground RGB without changing its alpha before global alpha.
RGB sets a channel to zero for a negative coefficient, otherwise adds that
coefficient. Values are not clamped by the shader; output target format decides
clamping. Both presets require exact original-source signatures.

Radial uses an explicit center, size and fade. Seven inward samples receive1/8
weight; the original foreground receives1/8+7/8*(1-fade), then the inward sum
is multiplied by fade. Distance scales the inward step. Alpha scales only after
accumulation. Zero size and zero fade retain the original foreground. Values
are not clamped or inferred. CPU and actual GPU outputs are compared on synthetic
nonzero radial displacement as well as identity cases.

All twenty original DX11 source signatures now select executable CPU/WebGL2
presets. Additional programs cover add/mul, per-channel bright/dark composites,
color add/multiply, reset and mosaic. Compbr/compbrc and compdk/compdkc have
identical equations but retain separate signatures. Composite normalization uses
foreground/user combined alpha in RGB, then returns foreground alpha*alpha;
transparent division is not regularized. Cadd accepts negative channels, while
RGB zeros negative-coefficient channels. Mosaic uses floor(UV*grid)/grid with
w=size*ratio,h=size; grid inputs are not pixel dimensions. Caller/target own
filtering, addressing and clamping. These known presets are not a general HLSL
compiler; actor shader properties and constant/texture jobs require separate owners.

`shader-properties.ts` parses native shader/shaderconstant/shadertexture property
lists and owns the CLayer shader state. Constants preserve order, duplicate names,
float32 equality and copied state; texture assignments retain complete replacements
before releasing old resources, and always invalidate preparation. Native parsing
of nonfinite/hexadecimal floating literals is outside the finite-decimal subset.
The resource loader remains mandatory; parsing paths alone does not load textures.

`draw-shader.ts` adapts all twenty reconstructed programs to the shared DrawList
shade/atlas/tex/tint/parameters ABI, with explicit required named uniform values and
user texture index. Real synthetic GPU tests compare every adapted program against
the dedicated WebGL executable, including nonzero UV transforms and user texture
composites. This is executable renderer integration, not native reflection/constant
buffer packing: the explicit named calibration helper refuses missing coefficients. Native ordered
buffer preparation and retained ImageGraphics wiring are described below.

Native15d120 rendering ignores constant names after argument collection and
concatenates vectors in list order. `nativeParameters` preserves this order;
`bufferParameters` consumes already prepared native storage. `parameters` remains
an explicit named-value calibration convenience, not D3D reflection. Native
constant storage grows in16-byte units, initializes new memory to zero and keeps
old trailing coefficients on shorter writes. GPU-layer copies share existing
storage until one grows, matching verified15c850 pointer/refcount copies. Empty
lists do not update slot1; the graphics binding owner must preserve prior slot1.
Nonempty lists of empty vectors remain refused; API unbound/out-of-range reads are
now represented by zero, as described below.

Custom shader properties now connect to `ArtemisLayers` and `ImageGraphics`.
Supply an owned ShaderLibrary of DrawShaderResource objects through the optional
ImageGraphics shader-program provider. `createArtemisDrawShaderCompiler` selects
exact source signatures and requires actual target prepareTriangleShader to compile
both ordinary and captured variants. Unknown-source presets remain unsupported.

Lyprop parses shader names, ordered shaderconstant lists and shadertexture paths.
Texture jobs resolve asynchronously through the existing image source, retain
prepared raster resources, skip missing loads and release stale completions before
upload/edit. Missing shader providers refuse before scene mutation. Copied actors
retain independent property vectors and texture leases, plus shared native constant
storage. Renderer program loans and sampled texture loans remain held through draw
submission. Captures include shader-property revision in their invalidation signature.

Per-frame draws look up the current named program, reuse slot1 for empty constant
lists and apply native ordered packing. TextureUser selects the first surviving
texture entry regardless of its name. Ordinary draws use their native blend state;
captured custom programs replace RGBA before outer composition. Null user binding
returns zero in the shader, and unknown named programs produce no color pixels.
D3D constant-buffer out-of-range accesses are also zero; bufferParameters now models
that verified API behavior rather than refusing a missing/short buffer.

These API defaults follow the [Direct3D functional specification](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm),
sections7.5,7.18.17 and16.6. No game asset is synthesized to fill a missing resource.
Shader coefficient animation jobs, root/wildcard property modes and full production
runtime wiring remain distinct requirements.

`script-events.ts` reconstructs b73e0/c6730 registration dispatch: producer-owned
native modes, disabled/latch flags, copied deferred registrations, retained Lua
event filter and default file/label transfers followed by priority handler tags.
The concrete Script adapter installs an empty caret with a fresh local variable
scope for handler-only events, then restores the interrupted ready/waiting cursor.
A synthetic PCM EOF test exercises sound-finish capture, frame tick, event filter,
scoped handler queue and return to the waiting script without an audio device.

Native frame/timer/caret control and latch reset remain required production owners;
no JS state-to-native-mode mapping is guessed. Resource-suspended Lua events must
be deferred by that owner. Direct registered Lua Events callbacks remain distinct.

Lua include accepts an explicit prepared `readPlainFile` owner: plain CFile uses
Lua loadfile header/line framing and Windows CRT text input, then any open/load/
protected execution failure retries normal loose-first pack bytes. Empty plain
files succeed without fallback; first-attempt Lua side effects survive. Shared
Lua51 executeFile/compileFile operate on prepared raw/text bytes and preserve the
existing explicit bytecode refusal. Hosts without the plain provider retain the
pack-only subset. Final native error reporting and streaming I/O remain host work.
