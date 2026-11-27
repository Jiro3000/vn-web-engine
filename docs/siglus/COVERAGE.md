# SiglusEngine Multi-Layer Verification Coverage

Generated: `2026-11-27T05:07:12.143Z`

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
| **Overall** | 2,666 | 2,666 | 2,666 | 42 | 1,883 | 42 | 477 | 109 | 683 | 0 |
| `asset_decoder` | 7 | 7 | 7 | 0 | 7 | 0 | 6 | 3 | 7 | 0 |
| `native_function` | 48 | 48 | 48 | 14 | 48 | 14 | 34 | 20 | 48 | 0 |
| `command` | 1,492 | 1,492 | 1,492 | 28 | 975 | 28 | 100 | 76 | 228 | 0 |
| `property` | 749 | 749 | 749 | 0 | 484 | 0 | 6 | 10 | 112 | 0 |
| `gameexe_key` | 370 | 370 | 370 | 0 | 369 | 0 | 331 | 0 | 288 | 0 |

## Targeted Mutation Testing Summary

- Generated: `2026-11-27T05:07:39.344Z`
- Total Mutants: **39** | Killed: **39** | Surviving: **0** | Equivalent: **0** | Invalid: **0** | Timed Out: **0**
- Effective Kill Rate (killed / (killed + surviving + timed_out)): **100%**

## Top Priority Burn-Down Queue (Unverified / Stale / Modified in 1.1.141.3)

| Priority | Entry ID | Kind | Surface | Calls (8 games) | Games | Modified in 1.1.141.3 | Stale |
| ---: | --- | --- | --- | ---: | ---: | --- | --- |
| 1628 | `cmd:84` | `command` | `sel_or_text` | 1,384,401 | 8 | yes | no |
| 1525 | `cmd:14` | `command` | `r` | 423,281 | 8 | yes | no |
| 1467 | `cmd:5` | `command` | `farcall` | 217,252 | 8 | yes | no |
| 1451 | `cmd:18` | `command` | `p` | 179,448 | 8 | yes | no |
| 1414 | `prop:83.0.-1.*` | `property` | `cur_call` | 117,905 | 8 | yes | no |
| 1344 | `cmd:62` | `command` | `namae` | 93,260 | 7 | yes | no |
| 1270 | `prop:83.2097152000` | `property` | `cur_call` | 22,261 | 8 | yes | no |
| 1266 | `cmd:37.2.-1` | `command` | `stage.object` | 21,251 | 8 | yes | no |
| 1257 | `cmd:10` | `command` | `wait` | 19,334 | 8 | yes | no |
| 1253 | `prop:31.-1.*` | `property` | `Z` | 18,342 | 8 | yes | no |
| 1242 | `prop:83.1.-1.*` | `property` | `cur_call` | 16,154 | 8 | yes | no |
| 1241 | `cmd:38.2.-1` | `command` | `stage.object` | 16,086 | 8 | yes | no |
| 1241 | `cmd:55` | `command` | `koekoe` | 15,943 | 8 | yes | no |
| 1236 | `prop:83.2097152001` | `property` | `cur_call` | 15,110 | 8 | yes | no |
| 1225 | `cmd:44.-1.*.5` | `command` | `pcmch` | 13,357 | 8 | yes | no |
| 1224 | `cmd:44.-1.*.0` | `command` | `pcmch` | 13,142 | 8 | yes | no |
| 1185 | `cmd:42.0` | `command` | `bgm` | 8,437 | 8 | yes | no |
| 1182 | `cmd:13` | `command` | `nl` | 14,524 | 7 | yes | no |
| 1170 | `prop:83.2097152002` | `property` | `cur_call` | 7,053 | 8 | yes | no |
| 1144 | `prop:83.2097152003` | `property` | `cur_call` | 5,212 | 8 | yes | no |
| 1122 | `prop:38.2.-1.*.56` | `property` | `stage.object` | 4,045 | 8 | yes | no |
| 1121 | `cmd:37.2.-1.*.49` | `command` | `stage.object` | 4,033 | 8 | yes | no |
| 1113 | `cmd:42.4` | `command` | `bgm` | 3,666 | 8 | yes | no |
| 1111 | `cmd:46.0` | `command` | `input` | 3,599 | 8 | yes | no |
| 1106 | `prop:37.2.-1.*.2` | `property` | `stage.object` | 3,391 | 8 | yes | no |

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
