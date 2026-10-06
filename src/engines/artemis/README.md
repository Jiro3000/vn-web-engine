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
normalize slash spelling only. The host supplies filesystem case rules. Magic
paths, extra pack lists, embedded packs and other revisions are unsupported.
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
