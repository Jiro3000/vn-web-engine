# SiglusEngine Multi-Layer Verification Coverage

Generated: `2026-11-27T13:35:29.946Z`

> Coverage layers are strictly separate. Matching hashes, CFG shape, or passing browser smoke tests never count as `statically_verified` without pinned Ghidra evidence.

## Binary Corpus (8 Revisions)

| ID | Title | FileVersion | Container | Discovered Functions | Analyzed SHA-256 (prefix) |
| --- | --- | --- | --- | ---: | --- |
| `angel-beats` | Angel Beats! -1st beat- | `1.1.80.7` | `packed-pe` | 5 | `c39fb9f8e9486d4f` |
| `hoshiori-rikka` | Hoshi Ori Yume Mirai - Rikka to Anata | `1.1.80.8` | `direct-pe` | 21,432 | `251c57cecde9613a` |
| `ginharu` | GinHaru | `1.1.102.1` | `direct-pe` | 26,011 | `da87e1ac7e7138de` |
| `tsukikana` | Tsuki no Kanata de Aimashou | `1.1.134.0` | `direct-pe` | 31,265 | `2fd87b8186d76849` |
| `ssr` | Tsuki no Kanata de Aimashou SweetSummerRainbow | `1.1.134.0` | `direct-pe` | 31,268 | `5b1eb99e8bc9c2f1` |
| `hoshiori-pe` | Hoshi Ori Yume Mirai - Perfect Edition | `1.1.137.0` | `direct-pe` | 31,231 | `e34f5b020a85e210` |
| `fortune-world` | FORTUNE×WORLD | `1.1.137.0` | `sdwrap-embedded-pe` | 31,231 | `3b04dfc1d4b1e0ab` |
| `anemoi` | anemoi | `1.1.141.3` | `direct-pe` | 21,067 | `778e27f4e629ce8b` |

## Multi-Layer Coverage Summary

| Layer / Kind | total | discovered | cross_version_matched | understood | implemented | statically_verified | unit_tested | interaction_tested | browser_verified | stale |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Overall** | 2,666 | 2,666 | 2,666 | 131 | 1,883 | 131 | 481 | 117 | 683 | 0 |
| `asset_decoder` | 7 | 7 | 7 | 7 | 7 | 7 | 6 | 3 | 7 | 0 |
| `native_function` | 48 | 48 | 48 | 35 | 48 | 35 | 34 | 25 | 48 | 0 |
| `command` | 1,492 | 1,492 | 1,492 | 82 | 975 | 82 | 102 | 79 | 228 | 0 |
| `property` | 749 | 749 | 749 | 7 | 484 | 7 | 6 | 10 | 112 | 0 |
| `gameexe_key` | 370 | 370 | 370 | 0 | 369 | 0 | 333 | 0 | 288 | 0 |

## Targeted Mutation Testing Summary

- Generated: `2026-11-27T13:50:16.766Z`
- Total Mutants: **42** | Killed: **42** | Surviving: **0** | Equivalent: **0** | Invalid: **0** | Timed Out: **0**
- Effective Kill Rate (killed / (killed + surviving + timed_out)): **100%**

## Top Priority Burn-Down Queue (Unverified / Stale / Modified in 1.1.141.3)

| Priority | Entry ID | Kind | Surface | Calls (8 games) | Games | Modified in 1.1.141.3 | Stale |
| ---: | --- | --- | --- | ---: | ---: | --- | --- |
| 1266 | `cmd:37.2.-1` | `command` | `stage.object` | 21,251 | 8 | yes | no |
| 1241 | `cmd:38.2.-1` | `command` | `stage.object` | 16,086 | 8 | yes | no |
| 1122 | `prop:38.2.-1.*.56` | `property` | `stage.object` | 4,045 | 8 | yes | no |
| 1121 | `cmd:37.2.-1.*.49` | `command` | `stage.object` | 4,033 | 8 | yes | no |
| 1106 | `prop:37.2.-1.*.2` | `property` | `stage.object` | 3,391 | 8 | yes | no |
| 1091 | `cmd:42.1` | `command` | `bgm` | 5,058 | 7 | yes | no |
| 1087 | `prop:83.2097152004` | `property` | `cur_call` | 2,720 | 8 | yes | no |
| 1084 | `cmd:38.2.-1.*.62` | `command` | `stage.object` | 2,607 | 8 | yes | no |
| 1082 | `prop:83.2097152005` | `property` | `cur_call` | 2,550 | 8 | yes | no |
| 1063 | `cmd:37.2.-1.*.48` | `command` | `stage.object` | 2,061 | 8 | yes | no |
| 1059 | `cmd:42.5` | `command` | `bgm` | 3,483 | 7 | yes | no |
| 1055 | `cmd:61` | `command` | `root_61` | 1,872 | 8 | yes | no |
| 1055 | `prop:83.2097152006` | `property` | `cur_call` | 1,872 | 8 | yes | no |
| 1050 | `cmd:83.1.-1.*.3` | `command` | `cur_call` | 1,762 | 8 | yes | no |
| 1046 | `cmd:131` | `command` | `root_131` | 5,382 | 6 | yes | no |
| 1045 | `cmd:63.95` | `command` | `syscom` | 1,678 | 8 | yes | no |
| 1037 | `cmd:53.-1.*.1` | `command` | `frame_action_ch` | 1,518 | 8 | yes | no |
| 1037 | `prop:32.-1.*` | `property` | `S` | 48,301 | 2 | yes | no |
| 1034 | `prop:30.-1.*` | `property` | `G` | 8,302 | 5 | yes | no |
| 1034 | `prop:37.2.-1.*.27` | `property` | `stage.object` | 1,463 | 8 | yes | no |
| 1027 | `prop:27.-1.*` | `property` | `root_27` | 7,631 | 5 | yes | no |
| 1025 | `cmd:54` | `command` | `frame_action` | 1,329 | 8 | yes | no |
| 1012 | `cmd:158` | `command` | `root_158` | 3,618 | 6 | yes | no |
| 1011 | `prop:37.2.-1.*.56` | `property` | `stage.object` | 1,120 | 8 | yes | no |
| 999 | `cmd:46.1` | `command` | `mouse` | 1,752 | 7 | yes | no |

## Unresolved Coverage Gaps & Indirect-Call Frontiers

- **Packed binary blocker** (`angel-beats` `1.1.80.7`): On-disk executable is statically packed; static analysis cannot expose unpacked engine dispatchers without execution (prohibited).
- **Indirect-call frontier** (`hoshiori-rikka` `1.1.80.8`): reachable lower bound `>= 2913` functions; **551** reachable functions contain **2072** unresolved indirect-call / vtable / function-pointer sites.
- **Indirect-call frontier** (`ginharu` `1.1.102.1`): reachable lower bound `>= 2986` functions; **582** reachable functions contain **2139** unresolved indirect-call / vtable / function-pointer sites.
- **Indirect-call frontier** (`tsukikana` `1.1.134.0`): reachable lower bound `>= 3177` functions; **632** reachable functions contain **2334** unresolved indirect-call / vtable / function-pointer sites.
- **Indirect-call frontier** (`ssr` `1.1.134.0`): reachable lower bound `>= 3176` functions; **632** reachable functions contain **2335** unresolved indirect-call / vtable / function-pointer sites.
- **Indirect-call frontier** (`hoshiori-pe` `1.1.137.0`): reachable lower bound `>= 3168` functions; **640** reachable functions contain **2347** unresolved indirect-call / vtable / function-pointer sites.
- **Indirect-call frontier** (`fortune-world` `1.1.137.0`): reachable lower bound `>= 3168` functions; **640** reachable functions contain **2347** unresolved indirect-call / vtable / function-pointer sites.
- **Indirect-call frontier** (`anemoi` `1.1.141.3`): reachable lower bound `>= 2958` functions; **546** reachable functions contain **2472** unresolved indirect-call / vtable / function-pointer sites.
- **Cross-version unresolved** (`angel-beats` → `hoshiori-rikka`): **2913** functions left explicitly unresolved (packed binary blocker).
- **Cross-version unresolved** (`hoshiori-rikka` → `ginharu`): **613** functions left explicitly unresolved.
- **Cross-version unresolved** (`ginharu` → `tsukikana`): **769** functions left explicitly unresolved.
- **Cross-version unresolved** (`tsukikana` → `ssr`): **317** functions left explicitly unresolved.
- **Cross-version unresolved** (`ssr` → `hoshiori-pe`): **259** functions left explicitly unresolved.
- **Cross-version unresolved** (`fortune-world` → `anemoi`): **4055** functions left explicitly unresolved.

## Confirmed & Resolved Discrepancies

- `disc-001-database-member-ids` [fixed]: player.ts dispatched database.check_item_no on member 2 and check_column_no on member 3, and omitted members 5 (find_num), 6 (find_str case-insensitive, 0x5ca130), and 7 (find_str_real case-sensitive, 0x5ca2d0). Native 0x55fb30 maps 3=check_item_no, 4=check_column_no, 5=find_num, 6=find_str, 7=find_str_real.
- `disc-002-cgtable-disable-and-reverse-lookup` [fixed]: cgtable members 7 (set_disable) and 8 (set_enable) were no-ops instead of toggling automatic CG flag recording (+0x496), and member 10 (get_name_by_flag_no) was missing.
- `disc-003-counter-frame-and-check-value` [fixed]: counter handler omitted cases 10 (start_frame), 12 (start_frame_loop), and 7 (check_value: returns 1 iff current counter value >= target).
- `disc-004-math-tostr-tan-zen-zero-sqrt` [fixed]: math handler omitted 2-arg tostr(val, width) (0x55e8a0), tan (member 8 -> 0x562eb0), tostr_zen_zero (member 13), and sqrt (member 14, negative clamped to 0).
- `disc-005-pcmevent-random-tuple-and-stop-arg` [fixed]: player.ts parsed pcmevent.start_random (52.-1.*.2, 258 calls across 5 games) as [file, minTime, maxTime, probability] instead of native [file, probability, minTime, maxTime], and unconditionally stopped audio on pcmevent.stop (52.-1.*.3) instead of gating the 100ms fade-stop on arg0 != 0.
- `disc-006-global-call-stack-vs-backlog` [fixed]: player.ts mapped global commands 138/139/140/141 (0x8a..0x8d -> 0x5c71f0 on DAT_00ae1a68 call_list) to message backlog mutations, wiping dialogue history on del_call_stack/clear_call_stack instead of pruning VM farcall frames.
- `disc-007-msgbk-clear-member-6` [fixed]: msgbk dispatcher (root 145) omitted member 6 (msgbk.clear) which clears message history entries.
- `disc-008-database-cnt-member-1` [fixed]: database root 105 omitted member 1 (database.cnt, 0x54fc20 case 0x69 member 1).
