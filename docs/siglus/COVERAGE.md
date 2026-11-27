# SiglusEngine Multi-Layer Verification Coverage

Generated: `2026-11-27T14:19:52.767Z`

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

| Layer / Kind | total | discovered | cross_version_matched | understood | implemented | statically_verified | unit_tested | interaction_tested | mutation_tested | browser_verified | leaf_verified | wrapper_dispatch | platform_boundary | stale |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Overall** | 2,666 | 2,666 | 2,666 | 1,162 | 1,883 | 1,162 | 488 | 132 | 1,158 | 683 | 1,155 | 0 | 7 | 0 |
| `asset_decoder` | 7 | 7 | 7 | 7 | 7 | 7 | 6 | 3 | 4 | 7 | 7 | 0 | 0 | 0 |
| `native_function` | 48 | 48 | 48 | 37 | 48 | 37 | 35 | 28 | 8 | 48 | 37 | 0 | 0 | 0 |
| `command` | 1,492 | 1,492 | 1,492 | 843 | 975 | 843 | 106 | 90 | 834 | 228 | 836 | 0 | 7 | 0 |
| `property` | 749 | 749 | 749 | 275 | 484 | 275 | 8 | 11 | 312 | 112 | 275 | 0 | 0 | 0 |
| `gameexe_key` | 370 | 370 | 370 | 0 | 369 | 0 | 333 | 0 | 0 | 288 | 0 | 0 | 0 | 0 |

## Targeted Mutation Testing Summary

- Generated: `2026-11-27T14:15:15.658Z`
- Total Mutants: **51** | Killed: **51** | Surviving: **0** | Equivalent: **0** | Invalid: **0** | Timed Out: **0**
- Effective Kill Rate (killed / (killed + surviving + timed_out)): **100%**

## Top Priority Burn-Down Queue (Unverified / Stale / Modified in 1.1.141.3)

| Priority | Entry ID | Kind | Surface | Calls (8 games) | Games | Modified in 1.1.141.3 | Stale |
| ---: | --- | --- | --- | ---: | ---: | --- | --- |
| 1091 | `cmd:42.1` | `command` | `bgm` | 5,058 | 7 | yes | no |
| 1087 | `prop:83.2097152004` | `property` | `cur_call` | 2,720 | 8 | yes | no |
| 1082 | `prop:83.2097152005` | `property` | `cur_call` | 2,550 | 8 | yes | no |
| 1059 | `cmd:42.5` | `command` | `bgm` | 3,483 | 7 | yes | no |
| 1055 | `cmd:61` | `command` | `root_61` | 1,872 | 8 | yes | no |
| 1055 | `prop:83.2097152006` | `property` | `cur_call` | 1,872 | 8 | yes | no |
| 1050 | `cmd:83.1.-1.*.3` | `command` | `cur_call` | 1,762 | 8 | yes | no |
| 1046 | `cmd:131` | `command` | `root_131` | 5,382 | 6 | yes | no |
| 1037 | `cmd:53.-1.*.1` | `command` | `frame_action_ch` | 1,518 | 8 | yes | no |
| 1037 | `prop:32.-1.*` | `property` | `S` | 48,301 | 2 | yes | no |
| 1034 | `prop:30.-1.*` | `property` | `G` | 8,302 | 5 | yes | no |
| 1027 | `prop:27.-1.*` | `property` | `root_27` | 7,631 | 5 | yes | no |
| 1025 | `cmd:54` | `command` | `frame_action` | 1,329 | 8 | yes | no |
| 1012 | `cmd:158` | `command` | `root_158` | 3,618 | 6 | yes | no |
| 999 | `cmd:46.1` | `command` | `mouse` | 1,752 | 7 | yes | no |
| 997 | `cmd:83.1.-1.*.6` | `command` | `cur_call` | 1,715 | 7 | yes | no |
| 990 | `prop:83.2097152007` | `property` | `cur_call` | 884 | 8 | yes | no |
| 989 | `cmd:92.0` | `command` | `system` | 871 | 8 | yes | no |
| 981 | `cmd:4` | `command` | `jump` | 797 | 8 | yes | no |
| 979 | `cmd:37.6.-1.*.2` | `command` | `stage.objbtngroup` | 43,898 | 1 | yes | no |
| 979 | `cmd:44.-1.*.7` | `command` | `pcmch` | 774 | 8 | yes | no |
| 977 | `cmd:39.0` | `command` | `math` | 756 | 8 | yes | no |
| 975 | `cmd:7` | `command` | `root_7` | 741 | 8 | yes | no |
| 972 | `cmd:74` | `command` | `root_74` | 1,275 | 7 | yes | no |
| 970 | `prop:25.-1.*` | `property` | `root_25` | 22,300 | 2 | yes | no |

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
- `disc-009` [fixed]: 1-arg create_string/create_number/create_weather/create_save_thumb/create_movie default disp=0 (FUN_005f5010->0x5f5730), create_movie auto_free defaults true (0x55b415), and create_number sets type=5 for get_pat_cnt (0x55a94f).
- `disc-010` [fixed]: object.get_pixel_color_a/r/g/b (100..103, 0x55aa4b..0x55ab72) 2-arg overload pushes pat=0, not object.pattern.
- `disc-011` [fixed]: All 12 object color/transparency setters (27, 28..34, 23, 57..59) clamp strictly to [0, 255] via FUN_00558ad0..FUN_00558ce0.
- `disc-012` [fixed]: Added native object.init_param (37, FUN_005f5730(1)), get_string (135), get_number (136), clear_button_call (60), set_rotate (50), 3-arg z overloads, get_button_group/action/se/push_keep/alpha_test (189/190/191/119/176), get_size_z (47), child_sort_type (166/167).
- `disc-013` [fixed]: Added object 3D/flag properties (5/8/11/14/44/92/139/144/146/147/148/168/186/187), missing intevent channels (65/66/79/82/114), object.f sets/clear/init/bit-views (111), and x_rep/y_rep/z_rep/tr_rep clear (8).
- `disc-014` [fixed]: syscom message_speed upper clamp was 255 instead of native 100 (0x64), and auto_minimum_wait upper clamp was 10000 instead of native 5000 (0x1388).
- `disc-015` [fixed]: syscom set_koe_mode (148) did not clamp values outside {0, 1, 2} to 0 as native 0x56c7fd does.
- `disc-016` [fixed]: syscom get_quick_save_value (184) was missing from player.ts.
- `disc-017` [fixed]: Added uncalled Tier B syscom handlers: sound_onoff (280..282 with 0..31 bounds and playbackVolume gating), font_bold/shadow/init_font_name, local_extra_switch/mode, auto_mode_wait_onoff, mwnd_filter_mode, dialog confirm toggle, and msg_back getters.
