# SiglusEngine

Build with `npm run build`, run `npm start`, and select the original
FORTUNE×WORLD folder in the SiglusEngine player. The player also accepts
`StartData/GameData`. The executable for the tested installation has SHA-256
`5a8d3539530e73ad10c07a3757d2081ccb9265cb08455df998ac2a66d3da18a2`.

## Route from a fresh profile

1. Click **Play**. Advance the startup prompts and mandatory prologue.
2. Click **New Game** at the first title screen.
3. Advance chapters 01 through 08. The chapters contain no interactive story
   choices. The first play of each of the five movies runs to completion.
4. After the ending credits, advance the fade if it is still running. The
   script selects the cleared title layout and plays the cleared title music.

The controlling scene is `00シナリオフロー`. It calls chapter 01 entry 0
for the prologue. That entry calls `_titlemenu_dmy`, where the New Game
button returns decision 1. The scenario then calls chapter 01 entry 2 and
chapters 02 through 08 entry 0. The first-view movie order is OP, CHAPTER1,
CHAPTER2, CHAPTER3, ED. Chapter 08 sets `G[1575]` after ED, and the controlling
scene sets `G[1007]=3` and `G[1009]=1` before `returnmenu`. The menu
configured in Gameexe.dat is `_titlemenu` entry 0.

Drag over dialogue text to select it. Click or press Enter to advance a page.
Hold Control to skip where the script enables Control skip. The original Save
and Load controls in the message frame open the scripted slot browser, which
is also available from the title’s Load button. Saves and system flags are
stored in the browser under the SHA-256 of Scene.pck.

## Verification

Use [SiglusSceneScriptUtility](https://github.com/Jirehlov/SiglusSceneScriptUtility)
to disassemble the original archive independently.

```sh
siglus-ssu --const-profile 2 -x --disam /path/to/GameData/Scene.pck /tmp/siglus-reference
npm run build
node tools/verify-siglus.mjs /path/to/FORTUNE×WORLD "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" /tmp/siglus-reference/output_...
```

The verifier launches headless Chromium-compatible Brave with a temporary
profile, `--incognito`, and `--mute-audio`. It uses browser input events,
checks browser errors, and compares script tag positions and text SHA-256
values against the disassembly. The route check includes save and load,
movie completion, chapter order, and the return to the cleared title. It
also checks that the saved page's dialogue hash matches after loading and
that the prologue, movie and cleared-title flags were written to browser
storage. Audio checks use decoded PCM lengths, sample rates, peak amplitudes
and RMS levels with browser output muted.
Set `SIGLUS_OPENING_ONLY=1` for the original 50-text check or set
`SIGLUS_DIAGNOSTIC_PAGES=240` for a short skip check from New Game.
Set `SIGLUS_MUSIC_ONLY=1` for the Music check. It uses a cleared-title
checkpoint in the temporary browser profile and exercises track selection,
Next, Stop, Play, the volume slider, and the return button with mouse input.
It exits the game and reopens the player at the same origin in the same
browser profile, then checks the restored volume against the slider position.

Set `SIGLUS_CONFIG_ONLY=1` to diagnose the original Configuration scene. This
enables its title button for the probe, enters the scene from Gameexe.dat, and
checks the wheel-to-advance option from the System tab, opens the Text and
Sound tabs, plays the seven volume tests and the first character's sample, and
returns to the title with a right-click. Only the temporary profile starts with
the character's Chapter 02 unlock flag set. Audio checks cover the sample IDs,
volume types, applied gain, decoded frames, sample rate, peak and RMS. It compares command
offsets, opcodes and argument counts with the disassembly. For Configuration,
the trace uses offsets as source locations because branches can skip line markers.
The regular title keeps Configuration disabled while its other actions are
incomplete, including the detailed display and movie dialogs and transitions
to Save and Load.

Set `SIGLUS_LOAD_ONLY=1` for the Save and Load round trip. It starts at the
cleared-title checkpoint, starts a new game, saves a live page in slot 0,
overwrites it on the next page and loads it from the message frame. It reopens
the player in the same private browser session and loads the same slot from the
original title menu. The probe confirms the three types of prompts and checks
thumbnail dimensions, dialogue hashes, stage identifiers and script tag offsets
against the disassembly.

Set `SIGLUS_QUICK_ONLY=1` to check the original frame’s Quick Save and Quick
Load controls. The probe uses the cleared-title checkpoint, confirms two
quick saves on distinct pages and checks the stored slot order. Quick Load
restores the newest entry. The scripted Quick tab draws both thumbnails and
loads the older entry through its confirmation dialog. Gameexe.dat places
quick slots after the 1,010 regular and automatic slots in the menu’s numbering.

Set `SIGLUS_AUTOSAVE_ONLY=1` to check the first two day saves. The probe uses
the cleared-title checkpoint and Control skip to reach both day changes. It
checks slot rotation and opens the original Auto tab to load slot 1000, then
compares the resumed scene position and the next text hash with the disassembly.

Set `SIGLUS_SLOT_MANAGEMENT_ONLY=1` to check the original comment editor,
locking, slot movement, and deletion confirmation with test saves.

The clean-profile route matched 130,121 command and message tags and
checked 8,540 decoded audio buffers with zero browser console errors.
Save and load were exercised on page 67. `npm test` reported the same
48 failing test names as `main` at `15f2bee` (2,518 passed, 3 skipped).

## Scripted interface in the original

The following entries identify the UI in the tested archive. The table
describes the original scripts and configuration.

| Entry point                                | Access and state                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_start:0` → `00シナリオフロー:0`          | First startup runs the prologue. Once the prologue flag is set, startup goes to `_titlemenu:0`.                                                                                                                                                                                                 |
| `_titlemenu_dmy:0`                         | New Game (button 1) resumes the opening flow. Configuration (3) returns to this title. Exit (4) requests game shutdown.                                                                                                                                                                         |
| `_titlemenu:0/1/2`                         | Prologue (0), New Game (1), Load (2), Configuration (3), Music (4), Exit (5). Layout state 0 shows Start, Configuration and Exit; states 1 and 2 add Prologue and Load; state 3 also shows Music. Load is disabled when there is no save. New Game from startup enters the scenario flow at 90. |
| `_extra_music:0`                           | Music opens from the cleared title. Its exit jumps to `_titlemenu:1`.                                                                                                                                                                                                                           |
| `__sys_menu_cancel00:0`                    | In-game cancel action uses the current configuration: quick menu, hide message window, Save, Load, or Configuration. The script checks title state, map/replay state, and save/load permission.                                                                                                 |
| `__sys_menu_config00:0`                    | Starts a system call and transfers to `__sys_menu_config01:0`.                                                                                                                                                                                                                                  |
| `__sys_menu_save_load00:0/1`               | Save and Load select their mode, then transfer to `__sys_menu_save_load01:0`. Save checks title and replay state; Load checks replay state.                                                                                                                                                     |
| `WAKU.000.BTN` in Gameexe.dat              | Message frame actions include quick save/load, slot save/load, return to selection, auto, read skip, title, exit, configuration, hide, replay voice and backlog. Button resources and positions are in the configuration.                                                                       |
| `__sys_system_call` and `__sys_day_change` | Quick saves rotate through numbered positions. Day changes can invoke the scripted day save, gated by script state and configuration.                                                                                                                                                           |

These entry points are from Scene.pck SHA-256
`98ce9b7f4e16b65f47871af6068b43a07b8717ddf22a4e49ccd6a312979cd523`
and Gameexe.dat SHA-256
`492bccbb33ca3ce6e6ff074fe66d52281bb1e80dca5d528696494574b3cb892f`.

## Known differences

- Day saves run the script’s rotation routine and resume after
  the browser’s day transition. The native savepoint is inside the transition.
  Thumbnails composite the visible graphical layers
  at the configured size. Dialogue and native capture effects are absent from
  that composite.
- Loading restores the VM, current message, background and cast. BGM restarts
  from its configured start sample. In-flight animations and voice playback
  resume with the next script command.
- The browser's character layout, text layout, day cards, transition masks,
  recollection, shake, dizziness and motion effects approximate the script's
  native compositing. Effect timing and rendering have not been compared
  frame by frame.
- Browser title buttons expose New Game, Prologue, Load, Exit, and the
  original scripted Music screen on the cleared title. Configuration is
  still unavailable. Alpha-tested button hit areas use the bounds of the
  nontransparent pixels.

The browser renders system-call objects above the retained game stage. This
keeps scene animations and message visibility separate from the system menu.
The capture commands used by Configuration retain the scene for this overlay.
Standalone capture surfaces and save thumbnails still need implementation.
