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
the listed state layout and operations agree. This is a confirmed subset of the
full map, which remains in progress.

| Rev.3179 | Rev.3257 | Checked operation |
| --- | --- | --- |
| `0x140015b50` | `0x140013140` | Theora constructor and BT.601 conversion table arithmetic |
| `0x14009d200` | `0x14009ff90` | INI shared-holder constructor, flags and map slots |
| `0x1400a3640` | `0x1400a6450` | Actor constructor, virtual-base layout and property defaults |
| `0x1400b1860` | `0x1400b4a90` | Scene node destruction, captures and map/actor release order |
| `0x1400ef000` | `0x1400fed50` | Float tween constructor, state offsets and callback ownership |
| `0x140149760` | `0x140152ea0` | Tween-id query across active and pending registries |
| `0x140171140` | `0x1401791d0` | Horizontal rule copies and vertical row wrapping |
| `0x140190920` | `0x140197920` | Sound manager load, inactive-handle pruning and index insertion |
| `0x14019aa00` | `0x1401a0f80` | Tween frame completion, destruction and pending-registry merge |
| `0x1400a54b0` | `0x1400a8580` | Tween finish lookup and virtual `+0x18` (cancel uses `+0x10`) |
| `0x1400adcf0` | `0x1400b0d80` | Sound handle lookup and playing query at virtual `+0x30` |
| `0x1400b6520` | `0x1400b9b10` | File/label jump, script load and caret transfer |
| `0x140138f10` | `0x140140230` | Lua float table setter, stack values and registry lookup |
| `0x14014f2a0` | `0x140158e80` | Capture enumeration/transfer and temporary identifier lifetime |
| `0x140178e80` | `0x140181900` | JPEG file read/rewind, buffer sizing and decode result |
| `0x1400a1060` | `0x1400a3d80` | Display base constructor, virtual-base adjustment and member defaults |
| `0x1400b5a30` | `0x1400b8cd0` | Caret constructor, wait fields and pending-command queue |
| `0x1400b5b20` | `0x1400b8dc0` | Caret destructor and string/map/queue release order |
| `0x1400b6cf0` | `0x1400ba2c0` | Pending capture restoration; text virtual `+0x1b0` becomes `+0x1c0` |
| `0x140057750` | `0x1400562e0` | Decoder read-context flags and callback setup; callback construction is inlined |
| `0x1400a0340` | `0x1400a2fd0` | Encoding-aware replacement for Shift-JIS, EUC and UTF-8 |
| `0x1400add70` | `0x1400b0e00` | Scoped sound gain query, missing-handle result and scope conversion |
| `0x1400ae110` | `0x1400b1220` | Pan tween cancellation, current-pan query and setter; registry insertion is inlined |
| `0x1400afc60` | `0x1400b2ee0` | Expression string read, empty result and temporary release |
| `0x1400b0e90` | `0x1400b40a0` | Save-state clone, maps and scalar fields |
| `0x1400b1690` | `0x1400b4890` | Scene-node construction, reference counts, actor arrays and inlined payload copy |
| `0x1400c6480` | `0x1400cb6d0` | Run-mode scope release, scheduler, pending queue and modes 5/6 |
| `0x140134ca0` | `0x14013b680` | Lua display-info float extraction and property setter |
| `0x14013ef10` | `0x140146c60` | String-map restoration |
| `0x1401593a0` | `0x140161f40` | Operator-byte classification, including punctuation predicates and result masks |
| `0x1401856c0` | `0x14018d0c0` | Integer-string predicate: empty rejection, leading minus and digit checks |
| `0x1401990e0` | `0x1401a0110` | Relative float tween construction, six properties and from/to reversal |
| `0x1400a5ac0` | `0x1400a89e0` | Property block assignment, scalar/flag fields and two strings |
| `0x1400c2400` | `0x1400c6bf0` | Tag copy constructor, string/map members and field `+0x58` |
| `0x1400adf30` | `0x1400b0fb0` | Scoped sound-volume tween, prior tween cancellation and default gain 1000 |
| `0x140144960` | `0x14014cfe0` | Layer history erase, argument subset matching, shifting and recursive removal |
| `0x140165bb0` | `0x14016de30` | Directory preparation, multibyte path stepping and A/W file open |
| `0x1400f53d0` | `0x140103010` | Shared-owner dynamic cast with identical RTTI source/destination descriptors |
| `0x1400f8820` | `0x1401063b0` | Second shared-owner dynamic cast and matching reference release |
| `0x140176b10` | `0x14017f5f0` | INI string query, section/key presence and missing empty result |
| `0x1400a4eb0` | `0x1400a7ec0` | Actor property assignment; base copy is outlined and shared transfers inlined |
| `0x1400a0770` | `0x1400a33a0` | Encoding-aware string splitting, empty fields and delimiter boundaries |
| `0x1400ae440` | `0x1400b1590` | Sound handle lookup and virtual `+0x70` query |
| `0x1400b8090` | `0x1400bbd80` | Command state assignment, three strings and unchanged scalar/flag offsets |
| `0x1400ecc70` | `0x1400fc9b0` | Curve member assignment and tagged callable transfer/release |
| `0x1400ae2e0` | `0x1400b1440` | Sound callback setter at virtual `+0x68`, callable copy and release |
| `0x1400ed9d0` | `0x1400fd750` | Integer tween constructor, from/to conversion and callable ownership |
| `0x1400f8050` | `0x1401058c0` | Script event callable construction, tag copies and temporary release |
| `0x1400acbb0` | `0x1400b0230` | Key-role binding, wheel flags and unique integer-key set insertion |
| `0x1400c9870` | `0x1400d0090` | Caption conversion, encoding guard and native window handle lookup |
| `0x14009d150` | `0x14009fe60` | Archive string length/bytes and field-id bookkeeping; bookkeeping is inlined |
| `0x1400b9cd0` | `0x1400bdfc0` | Empty history argument-map construction, copy and append |
| `0x1400ebf10` | `0x1400fbab0` | Automode indicator-map search/insert and default member layout |
| `0x14012d490` | `0x1401325e0` | Native report encoding guard, conversion and temporary release |
| `0x1400b5690` | `0x1400b8a10` | Key-role decide query, wheel/ordinary keys and Alt+Enter suppression |
| `0x140130350` | `0x140135db0` | Lua tag parsing, script-queue append and severity-1 report branch |


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
