# SiglusEngine Final Implementation-Coverage, Metric-Honesty & 8-Game Gameplay Readiness Audit

Generated: `2026-11-27` (branch `siglus`, repository `vn-web-engine`)

This document records the final bounded audit reconciling the previous 783-entry `implemented=false` gap, replacing proxy/broadcast metrics with strict per-entry accounting backed by live headless Brave telemetry, fixing every genuine missing engine-semantic implementation uncovered, and validating gameplay fidelity across all 8 corpus games.

---

## 1. Scanner Fix & Exact Reconciliation of the 783-Entry Gap

### Root Cause of the Prior 783-Entry Gap
Two defects in `tools/siglus-inventory/ledger.mjs` previously produced a misleading 783-entry `implemented=false` count (out of 2,666 raw entries):
1. **Linear `scanScenePackPaths()` stack desynchronization:** The prior linear scanner did not pop argument values/references on `CD_COMMAND` (op 48), `GOSUB`/`RETURN` (op 19/20/21), or `CD_TEXT`/`CD_NAME` (op 49/50), and did not track control-flow `points`/`declarations`. Nested expressions emitted truncated prefix paths (e.g., `cmd:37.2.-1`, `cmd:38`, `cmd:65`, `cmd:40`, `cmd:42`, `cmd:44`) and concatenated outer+inner phantom paths (e.g., `cmd:39.9.0.0.0.93.-1.*.24`, `prop:39.2.0.0.111.-1.*`).
2. **Naive `case ${leaf}:` / `case ${parts[0]}:` implementation check:** Most SiglusEngine handlers in `src/engines/siglus/player.ts` and `src/engines/siglus/vm.ts` use `if (root === ...)`, `if (member === ...)`, `if (command === ...)`, lookup tables (`systemOptions`, `soundLevels`, `soundSwitches`, `filterCommands`, `INTLIST_BIT_WIDTH`), or shared range dispatchers rather than `switch` `case` labels.

Replacing `scanScenePackPaths()` with a CFG-aware VM stack/points/declarations interpreter (`droppedDynMember = 0` across all 8 `Scene.pck` files) removed **593 phantom scanner artifacts** total (**239** commands + **354** properties) and exposed **13 previously hidden real commands** (`cmd:39.14`, `cmd:39.22`, `cmd:46.9`, `cmd:63.182`, `cmd:63.183`, `cmd:63.185`, `cmd:63.314`, `cmd:63.315`, `cmd:92.14`, and 4 nested object `*.41` commands).

### Exact Itemized Reconciliation of All 783 Previously Unimplemented Entries (`783 / 783`)

| Category | Count | Breakdown & Exact TS Handler / Disposition |
| --- | ---: | --- |
| **1. Scanner artifacts removed** | **162** | `101` phantom commands (`cmd:37.2.-1`, `cmd:38.2.-1`, `cmd:38`, `cmd:65`, `cmd:65.0.-1.*.2.-1.*.93.-1`, etc.) + `61` phantom properties (`prop:39.2.0.0.0.111.-1.*`, `prop:83.2097152003.0.0.93.-1.*.111.-1.*`, etc.) eliminated by the CFG scanner (593 total artifacts removed across the full ledger). |
| **2. Implemented via shared / non-`case` handler** | **619** | `src/engines/siglus/player.ts#objectCommand` (**247**: e.g. `cmd:37.2.-1.*.38`, `cmd:37.2.-1.*.48`, `cmd:37.2.-1.*.49`, `cmd:37.2.-1.*.121`), `player.ts#syscom` (**131**: e.g. `cmd:63.67`, `cmd:63.145`, `cmd:63.186`, `cmd:63.223`), `player.ts#property` (**122**: e.g. `prop:31.-1.*`, `prop:32.-1.*`, `prop:37.2.-1.*.27`, `prop:38.2.-1.*.56`), `src/engines/siglus/vm.ts#property` (**58**: e.g. `prop:25.-1.*`, `prop:83.0.-1.*`, `prop:83.1.-1.*`, `prop:83.2097152000`), `player.ts#mwnd` (**28**: e.g. `cmd:38.3.-1.*.34`, `cmd:38.3.-1.*.35`, `cmd:38.3.-1.*.44`, `cmd:38.3.-1.*.32.-1.*.124`), `player.ts#script` (**20**: e.g. `cmd:64.34`, `cmd:64.35`, `cmd:64.37`, `cmd:64.48`), `player.ts#effectCommand` (**9**: e.g. `prop:37.4.-1.*.29`, `prop:37.4.-1.*.31`, `prop:38.4.-1.*.31`), `player.ts` shared audio/screen (**3**: `cmd:42.19`, `cmd:70.31.-1.*.30`, `prop:70.31.-1.*.34`), `player.ts#excall` (**1**: `prop:65.7.-1.*`). |
| **3. Genuinely missing / broken & fixed** | **1** (+1 newly exposed) | `prop:31.6.-1.*` (`Z.bit16`, 30 occurrences in `tsukikana` & `ssr` — fixed in **`disc-025`** along with the swapped `6`/`7` bit-view widths in `object.f`). Separately, the CFG scanner uncovered **`cmd:39.22`** (`math.angle`, called in `fortune-world:__va_effect_ss_cmd_particle`) which was genuinely missing and fixed in **`disc-024`** alongside Tier B `math.asin`/`acos`/`atan` (`39.16`/`17`/`18`). |
| **4. Gameexe schema reconciled** | **1** | `gameexe:MSGBTN.CNT` (`anemoi`: `MSGBTN.CNT = 0`, parsed in `0x699d00` for `#MSGBTN.NNN.NORMAL/HIT/PUSH.COLOR`). No game in the 8-game corpus defines any `#MSGBTN.NNN.*` entries; added `MSGBTN` to the resource `.CNT` declaration allowlist in `tests/helpers/siglus-game-suite.mjs`. |
| **5. Remaining unimplemented engine-semantic entries** | **0** | **0 genuine engine-semantic gaps remain** across all 2,086 clean ledger entries. |
| **Total Reconciled** | **783** | Exact sum: `162 + 619 + 1 + 1 + 0 = 783`. |

### Intentionally Unsupported `platform_boundary` Entries (5 Runtime Stubs + 90 OS/Dialog Boundary Entries = 95 Total)
- **Runtime `implemented=false` OS-only stubs (5):**
  - `anchor:runtime.save_file` (`0x65dd70`): Win32 local `.sav` path formatter (`GetModuleFileName`/`SHGetFolderPath`); browser runtime persists saves in IndexedDB (`saveStore`).
  - `cmd:46.10` (`mouse.set_pos`, `0x552e20`): Win32 `ClientToScreen` + `SetCursorPos` hardware cursor warp (disallowed by browsers).
  - `cmd:92.2` (`system.check_dummy_file_once`): Physical CD/DVD disc check.
  - `cmd:92.7` (`system.debug_messagebox_ok`) & `cmd:92.11` (`system.debug_write_log`): Win32 debug-only modal dialog & host filesystem log writer (inert in release builds).
- **Explicit `platform_boundary` desktop UI/OAuth entries (90):** 83 Win32 desktop `Gameexe.dat` keys (`DIALOG*`, `SAVEINFO.*`, `LOADINFO.*`, `SAVELOAD_DIALOG.*`, `WARNINGINFO.*`, `DISCMARK`, `DUMMY_CHECK*`, `GAMEVERSION`, `MANUAL_PATH`, `TWITTER.API_*`, `TWITTER.CALLBACK_URL`, Win32 `SYSCOMMENU.*`) and 7 Win32 `syscom` desktop dialog/OAuth/exit entries (where browser equivalents exist in `configuration.ts` or are desktop-only).

---

## 2. Genuine Engine Semantic Fixes Added in This Audit (`disc-024`..`disc-025`)

- **`disc-024` (`math.angle` `39.22` + `asin/acos/atan` `39.16..18` — `anemoi 0x55f187..0x55f32e` + `0x55eea0`):**
  - Implemented `siglusAngle`, `siglusAsin`, `siglusAcos`, `siglusAtan` in `src/engines/siglus/math.ts` using exact native `Math.fround(180 / Math.PI)`, round-half-away-from-zero (`0x55eea0`), and `[0..3599]` tenths-of-degree modulo wrap (`idiv 0xe10`), wired in `src/engines/siglus/player.ts`.
  - Guarded by TDD tests in `tests/siglus-stateful-interactions.test.mjs` and mutant `math.angle-quadrant-wrap` in `tools/siglus-mutate.mjs`.
- **`disc-025` (`intlist` bit-view widths `3=1, 4=2, 5=4, 6=16, 7=8` — `anemoi 0x55d587..0x55d629` & `0x5d35f0`):**
  - Native `0x55d3d0` maps member `6` to unsigned 16-bit (`bit16`, `movzx`) and member `7` to unsigned 8-bit (`bit8`), NOT `1 << (m - 3)`.
  - Fixed `player.ts` to alias all 5 native bit views (`3..7`) onto `this.system` (`Z` = 31, persisting to `localStorage`), `this.galleryFlags` (`G` = 32), and `object.f` (`111`), and added story-flag bit-view aliasing (`A..F` = `25..30`) in `src/engines/siglus/vm.ts`.
  - Guarded by TDD tests and mutants `player.intlist-bit16-vs-bit8` and `player.z-bit16-alias`.

---

## 3. Strict, Non-Inflated 9-Layer Coverage Metrics

After removing 593 phantom scanner entries, stopping all dispatcher-level `unitTested`/`interactionTested`/`mutants` broadcasts, downgrading dispatcher-level pins to `wrapper_dispatch`, and replacing the static `totalCalls >= 50` proxy with live headless Brave telemetry (`docs/siglus/browser-observed.json` across 22 audit runs):

| Layer / Kind | Total | Discovered | Cross-Version Matched | Understood | Implemented | Statically Verified | Unit Tested | Interaction Tested | Mutation Tested | Browser Verified | `leaf_verified` | `wrapper_dispatch` | `platform_boundary` | Stale |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Overall** | **2,086** | **2,086** | **2,086** | **2,086** | **2,081** | **2,086** | **450** | **291** | **168** | **1,228** | **1,399** | **592** | **95** | **0** |
| `asset_decoder` | 7 | 7 | 7 | 7 | 7 | 7 | 6 | 3 | 5 | 7 | 7 | 0 | 0 | 0 |
| `native_function` | 48 | 48 | 48 | 48 | 47 | 48 | 35 | 30 | 19 | 30 | 47 | 0 | 1 | 0 |
| `command` | 1,266 | 1,266 | 1,266 | 1,266 | 1,262 | 1,266 | 217 | 134 | 39 | 751 | 920 | 335 | 11 | 0 |
| `property` | 395 | 395 | 395 | 395 | 395 | 395 | 112 | 100 | 94 | 271 | 253 | 142 | 0 | 0 |
| `gameexe_key` | 370 | 370 | 370 | 370 | 370 | 370 | 80 | 24 | 11 | 169 | 172 | 115 | 83 | 0 |

### Verification Gate Summary
- **`npm run build`**: 0 errors, 0 warnings (`svelte-check`, `tsc`, `vite build`).
- **Fast Node Siglus + tooling tests (12 files)**: **113 / 113 passed** (including new CFG scanner & dispatch-coverage resolver tests in `tests/tooling-siglus-inventory.test.mjs`).
- **Per-game corpus Node tests (9 files, `--test-concurrency=1`)**: **41 / 41 passed** across all 8 games.
- **Targeted semantic mutation testing (`tools/siglus-mutate.mjs --force`)**: **61 / 61 killed** (**100% kill rate**, 0 surviving, 0 equivalent, 0 invalid, 0 timed_out).
- **Strict ledger check (`node tools/siglus-inventory/ledger.mjs check --strict-stale`)**: `Entries=2086, Stale=0`.

---

## 4. Impact Assessment: Packed Binary & Indirect-Call Frontiers

- **`angel-beats` (`1.1.80.7`, `packed_binary_blocker`)**:
  - The on-disk executable is statically packed (5 stub functions discovered statically); static-only policy forbids unpacking via execution.
  - **Gameplay impact assessment: Low / Mitigated.** `angel-beats` sits one patch version behind unpacked `hoshiori-rikka` (`1.1.80.8`), and monotonic additive evolution is directly confirmed across all 7 unpacked revisions (`1.1.80.8 → 1.1.141.3`). Its real `Scene.pck`, `Gameexe.dat`, `CGTABLE2`, `DBS`, `G00`, `OMV`, `OVK`, and `WMV` assets pass 100% of Node corpus tests, and live headless Brave audits (`systems`, `extras`, and 45s `crawl` across 559 pages, 17 scenes, and 11 choices) ran with `errors=0 warnings=0`, `unhandledCommands=0`, `unhandledProperties=0`. Residual risk is limited to any hypothetical `1.1.80.7`-specific edge behavior not exercised in observed scenes.
- **Indirect-Call Frontiers (7 unpacked revisions, 546–640 reachable functions, 2,072–2,472 indirect sites per revision)**:
  - Almost all indirect calls inside SiglusEngine dispatchers are C++ virtual calls on Win32/D3D9/DirectSound COM interfaces, UI window class hierarchies (`Ccfg_wnd_*`), and `std::function`/vtable callbacks for platform rendering & audio wrappers.
  - Core VM bytecode dispatch (`0x67e9c0`) and all 47 engine-semantic structural anchors use direct jump tables and static function pointers, which were decompiled and verified directly. Residual risk is confined to rarely-used vtable-dispatched helper overrides in unvisited branches; every frontier remains preserved explicitly in `docs/siglus/verification-ledger.json`.

---

## 5. Per-Game 8-Game Gameplay Compatibility Matrix (22 / 22 Sequential Headless Brave Audits Passed)

All 22 sequential headless Brave audits ran with zero screenshots (`SIGLUS_OBSERVE_OUT=docs/siglus/browser-observed.json`, total observed across 22 runs: **906 unique commands**, **340 unique properties**, **178 unique Gameexe schemas**):

| Game ID | Version | `systems` | `extras` | `crawl` (45s) | Crawl Pages / Scenes / Choices / Chaos | Unhandled Cmd / Prop |
| --- | --- | --- | --- | --- | --- | --- |
| `anemoi` | `1.1.141.3` | **PASS** (`0 err`, `383c/152p/143g`) | **PASS** (`0 err`, `204c/103p/89g`) | **PASS** (`0 err`, `152c/84p/93g`) | `0*` / `10` / `0` / `0` (5 live OMV layers, 239 watchdogs) | `0 / 0` |
| `angel-beats` | `1.1.80.7` | **PASS** (`0 err`, `202c/68p/150g`) | **PASS** (`0 err`, `160c/48p/98g`) | **PASS** (`0 err`, `260c/104p/126g`) | `559` / `17` / `11` / `2` (166 composites, 223 watchdogs) | `0 / 0` |
| `fortune-world` | `1.1.137.0` | **PASS** (`0 err`, `116c/18p/141g`) | n/a (`extras: false`) | **PASS** (`0 err`, `117c/19p/138g`) | `1,605` / `6` / `0` / `5` (218 watchdogs) | `0 / 0` |
| `ginharu` | `1.1.102.1` | **PASS** (`0 err`, `190c/54p/163g`) | **PASS** (`0 err`, `70c/35p/88g`) | **PASS** (`0 err`, `254c/115p/123g`) | `1,065` / `16` / `1` / `3` (98 composites, 192 watchdogs) | `0 / 0` |
| `hoshiori-pe` | `1.1.137.0` | **PASS** (`0 err`, `203c/56p/148g`) | **PASS** (`0 err`, `97c/55p/92g`) | **PASS** (`0 err`, `301c/110p/125g`) | `741` / `17` / `1` / `2` (3 OMV layers, 196 watchdogs) | `0 / 0` |
| `hoshiori-rikka` | `1.1.80.8` | **PASS** (`0 err`, `223c/69p/157g`) | n/a (`extras: false`) | **PASS** (`0 err`, `187c/67p/122g`) | `336` / `11` / `0` / `1` (12s complete loop to title) | `0 / 0` |
| `ssr` | `1.1.134.0` | **PASS** (`0 err`, `196c/53p/143g`) | **PASS** (`0 err`, `87c/38p/91g`) | **PASS** (`0 err`, `264c/111p/158g`) | `1,233` / `17` / `1` / `4` (52 composites, 204 watchdogs) | `0 / 0` |
| `tsukikana` | `1.1.134.0` | **PASS** (`0 err`, `167c/46p/143g`) | **PASS** (`0 err`, `73c/36p/91g`) | **PASS** (`0 err`, `265c/131p/158g`) | `964` / `14` / `1` / `3` (226 composites, 207 watchdogs) | `0 / 0` |

*\*`anemoi` opens with an animated multi-OMV prologue sequence before the first dialogue page wait; live dialogue gameplay (`38+` pages, voice OVK, save/load, backlog jump, nested menus) is verified in `anemoi:systems`.*

### Remaining Known Limitations
1. **OS/Desktop `platform_boundary` features (95 entries):** Hardware cursor warping (`mouse.set_pos`), Win32 desktop `.sav` file dialogs, physical disc checks, debug `MessageBox`/log writers, and deprecated desktop Twitter OAuth remain explicitly classified as `platform_boundary`.
2. **Dispatcher-level `wrapper_dispatch` backlog (592 entries):** 592 lower-risk entries (primarily generic `global` wrappers, local `cur_call` variable slots, and parser-verified non-core `Gameexe.dat` schemas) are verified at the dispatcher/parser level rather than individual leaf level and remain visible in `COVERAGE.md`'s burn-down queue.
3. **`FORTUNE×WORLD` polling quick menu (`__sys_menu_cancel00`):** Uses manual `input.next` / `get_pixel_color_a` polling rather than `objbtngroup`, so `fortune-world.json` sets `"quickMenu": null`; `siglus-audit.mjs` now respects `quickMenu !== null` consistently in both `systems` and `crawl` modes.
