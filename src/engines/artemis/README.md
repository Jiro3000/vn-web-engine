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
RGBA decoder on the shared worker when available, with an in-thread fallback; JPEG and PSD require injected owners and refuse when selected without
one. Decoder null means native failure/fallback; host and unsupported-format errors
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
command require owner effects. Group/root/shader properties and the alternate
retained-actor editing mode remain unsupported. Native entries:
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

Empty hierarchy nodes expose their native identity property holder lazily through
`createGroupLayer`. Ordinary `lyprop` can update that group's geometry, alpha,
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

This implements direct groups whose intermediate surfaces are absent. Group clips,
layer modes, color effects, masks and `intermediate_render` remain refused pending
the intermediate composition owner (`0x140186770`). Shared persistent GPU surfaces
are available for that owner; see `docs/gpu-render-surfaces.md`. Their allocation
service alone does not implement native group capture policy, bounds or masking.
