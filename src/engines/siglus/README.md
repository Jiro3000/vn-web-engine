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

The browser defaults to Native text. Select DOM text in the player options
to highlight dialogue by dragging. Click or press Enter to reveal a page
that is still printing. Use the next input to advance the completed page.
Hold Control to skip where the script enables Control skip. The original Save
and Load controls in the message frame open the scripted slot browser, which
is also available from the title’s Load button. Saves and system flags are
stored in the browser under the SHA-256 of Scene.pck. Slots use IndexedDB.
The player migrates earlier browser-only slot records on first opening.

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
The final title plays one of the ending-specific voice lines and clears
the one-shot request G[1009]. The verifier then reopens the player in
the same temporary profile, checks the regular cleared-title voice,
enters the unlocked Music screen and returns to the title.
The page audit checks dialogue at the VM's input checkpoints, including
checkpoints reached with Control held. It checks the active text layer
against the stage bounds and inspects the alpha channel in the Native
dialogue area or the bounds of the base text in DOM Text. Ruby readings
are excluded from the DOM visibility check. Failures include
the scene, bytecode offset, page and font size. The full pass requires
at least one scripted `size()` reset to have been exercised.
Set `SIGLUS_TEXT_MODE=dom` on the full-route command to select DOM Text
before Play and verify that it stays active throughout the route.

Set `SIGLUS_OPENING_ONLY=1` for the first 50 text tags and the DOM selection
check. Set `SIGLUS_ALIGNMENT_ONLY=1` to compare the DOM and Native
first-line baselines on the same pages through the prologue and the first
20 input checkpoints after New Game. It measures dialogue and speaker
names in game pixels and reports the largest difference. It also checks
that ruby appears above its base, that the base text matches the
disassembly at chapter 01 offset `0x0f40`, and that a click at `pp()` at
`0x0fc2` appends the next fragment to the same message.
On `c8533a1`, the probe measured 87 checkpoints, including 29 with a
speaker name and two with ruby. The largest baseline difference was below
0.001 game pixels.
Set `SIGLUS_PAUSE_SAVE_ONLY=1` to save and load at `pp()` at `0x48c8`
through the original slot menu and verify the restored prefix and following
fragment by hash.
Set `SIGLUS_SLIDE_ONLY=1` to check the long message in chapter 02 that ends
at `0x344f8`. The probe starts from a cleared-title checkpoint and skips to
the message while checking page visibility. It compares the seven text hashes
to Scene.pck and checks the final row using Native canvas alpha or DOM
bounds with `SIGLUS_TEXT_MODE=dom`.
Set `SIGLUS_DIAGNOSTIC_PAGES=1000` for a focused regression check of the
first message size resets. The command advances the mandatory prologue
with normal input, starts New Game and holds Control to reach the target.
Set `SIGLUS_TYPING_ONLY=1` to measure character reveal on the first two
prologue replies governed by `script.set_message_speed(60)`. It checks
partial text, completion by click, natural completion in DOM Text and the
finished dialogue SHA-256 values at Scene.pck offsets `0x2bdc` and
`0x2c2f` in chapter 01. Configuration's text sample scales its counter
duration by the character count. The browser applies that interval to
story text, yields between characters and presents a ruby group together.
Set `SIGLUS_MUSIC_ONLY=1` for the Music check. It uses a cleared-title
checkpoint in the temporary browser profile and exercises track selection,
Next, Stop, Play, the volume slider, and the return button with mouse input.
It exits the game and reopens the player at the same origin in the same
browser profile, then checks the restored volume against the slider position.
The BGM16 selection verifies the configured source-sample start 44,100,
repeat start 853,475, and end 4,885,472 from Gameexe.dat.

Set `SIGLUS_CONFIG_ONLY=1` to diagnose the original Configuration scene. The
probe clicks the title button, enters the scene from Gameexe.dat, and checks
the wheel-to-advance and window/fullscreen controls in the System tab. It
checks window scaling, synchronous custom fullscreen scaling, position,
restoring defaults, and reopening at the selected window size.
It opens the movie dialog, changes the selected mode and checks the restored
choice and keyboard focus after reopening.
It switches the dialogue from the default Kosugi Maru to the bundled Kosugi
font through the Text tab and checks the detailed font selector, bold text
and outline with shadow. It plays the seven volume tests and the first
character's sample in the Sound tab, and returns to the title with a
right-click. It reopens the player in the same temporary profile and checks
that the selected font is still applied. Only that profile starts with
the character's Chapter 02 unlock flag set. Add `SIGLUS_CONFIG_FRESH=1` to
test from the first title after the mandatory prologue in a clean profile.
That run uses the original character voice availability. Audio checks cover the sample IDs,
volume types, applied gain, decoded frames, sample rate, peak and RMS. It compares command
offsets, opcodes and argument counts with the disassembly. For Configuration,
the trace uses offsets as source locations because branches can skip line markers.

The probe also changes text timing, the red component of the message
background, Auto timing and the amount and switch for BGM attenuation
under voice. After reopening it checks the original slider coordinates
against the stored settings and the script's interpolation. These preferences
are stored per installation independently of save slots. The Auto button
still controls the reading session's active mode.

The System and Text tabs execute `syscom.set_window_mode` (4) and
`syscom.set_font_name` (283) in `__sys_menu_config01`. The browser maps the
configured fullscreen mode to the shared window display host and stores
the selected mode and font with the installation's other options. The
advanced dialogs call separate engine commands (138, 142, 167). The
installed SiglusEngine.exe contains a second PE32 image from file offset
`0x1c000` to EOF, with SHA-256
`3b04dfc1d4b1e0abd6d1b526b82591acc5206c5054d0d07cfa2acb887092daf6`.
That image contains Japanese screen and movie dialog templates (PE
resources 127 and 124, language 1041). The outer PE resource 103 is the
SdWrap version dialog. StartData/Config.exe contains the support tool's
separate dialog. The embedded templates provide control labels and
bounds. The browser handles movie configuration command 167 using template
124, its original control IDs and dialog units. It persists the MCI or
Windows Media Player selection. Both choices play through the same browser
host, which chooses the decoder by the file format.
In the embedded image, the screen modal wrapper at `0x5481b0` uses the
`cfg_wnd_modal_screen` key and calls `DialogBoxParamW` with template 127
at `0x548248`. Commands at `0x540640` through `0x540679`
set the scale ranges to 50–300% and the position ranges to −100–100%.
The browser places these controls using the template's dialog units.
Window sizes are bounded by the available browser area. Physical display
resolution and monitor switching are unavailable to the web player, so that
section reports the current browser display with the native change controls
disabled. Custom offsets are percentages of the available viewport.
The font modal references `cfg_wnd_modal_font`
at `0x54757c` and opens the empty base template 240 at `0x5475cb`.
Initializer `0x5396e0` creates the font list, proportional filter, bold
control and four shadow controls. Handler `0x53a770` applies the settings
on input, including the four values for no shadow, shadow, outline and
outline plus shadow. The browser uses the recovered Japanese labels,
lists the bundled fonts, applies changes to Native and DOM Text, and
stores the settings in the installation profile. It uses browser controls
and CSS/Canvas effects, with approximate geometry and font rasterization.
The browser font list currently covers the installation's bundled fonts.

Set `SIGLUS_LOAD_ONLY=1` for the Save and Load round trip. It starts at the
cleared-title checkpoint and starts a new game. It uses the in-game Load
menu to enter Configuration, then switches to Save and saves a live page
in slot 0. It overwrites the slot on the next page, then goes from Save
through Configuration to Load. These transitions use the script's bottom
menu buttons and jumps within the current system call. The browser creates
the thumbnail when the original `capture` command runs in
`__sys_system_call.$excall_ready`, so the thumbnail is also available when
Save is reached from a different menu. The probe reopens
the player in the same private browser session and loads the same slot from the
original title menu. The probe confirms the three types of prompts and checks
thumbnail dimensions, dialogue hashes, stage identifiers and script tag offsets
against the disassembly. Both loads verify that Web Audio starts the saved
BGM track at the source sample configured in Gameexe.dat. After loading
from the title, the probe opens and closes both the message history and
the original Save menu on the restored page before advancing.
Gameexe.dat names `__sys_load_after` as `LOAD_AFTER_CALL`. The embedded
PE parser at `0x68f591` and `0x68f5cf` accepts the scene name with or
without a numeric label. The player runs that scene on the restored VM
stack before continuing dialogue. Both loads verify the callback's command
order and the 24 button offset list initializers in `__sys_scdata_init`
against Scene.pck.

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
lock persistence after reopening the player, exchange of occupied slots, and
deletion confirmation with test saves.

Set `SIGLUS_CANCEL_ONLY=1` to check right-click in dialogue. The probe opens
and dismisses the quick menu and saves through it. It starts and stops Auto
through the quick menu and through the message frame's two configured buttons,
then opens Configuration from the message frame and assigns right-click to
Hide. It verifies that a normal click reveals the same page. The probe checks
that Return to Selection is disabled on the linear route and that Read Skip
is disabled on an unread page.

Set `SIGLUS_READ_SKIP_ONLY=1` to verify the quick menu’s Read Skip. The probe
reads ahead of a save, reopens the player in the same profile, loads the save,
and checks that Read Skip advances over two read pages and stops at the first
unread page. It then loads the save after reading farther ahead, starts Read
Skip from the message frame, and stops it by clicking the active button.
Read flags are scoped to the scene and the installation’s Scene.pck.
Save records also restore the script’s menu and skip permissions.

The message frame uses the position, graphics, click sound and `CALL` from
`WAKU.000.BTN`. The embedded PE parses `read_skip`, `auto_mode` and
`return_sel` at `0x695f5e`, `0x695f9c` and `0x6960c2`. The Auto
variants execute `__sys_system_call` offsets `0xd6c6` and `0xd8a4`.
The Read Skip variants execute `0xda5d` and `0xdc16`. The browser
keeps the active Read Skip button available for one browser frame per
skipped page so a click can interrupt playback.

Set `SIGLUS_FRAME_LOCK_ONLY=1` to check the two message frame locks. The probe
clicks both Gameexe.dat `global_switch` variants, moves the pointer across
their scripted reveal regions, and checks that the positions and lock state
survive saving, reopening and loading. `__sys_system_call` updates switches
2 and 3 from G[1010] and G[1011] at `0x16a57` and `0x16baa`. The browser
runs the `__sys_scdata_init` watchers at `0xa3d8` and `0xb371` when the
pointer or lock state changes at a dialogue checkpoint. They move the
bottom row by 70 pixels and the side column by 150, with a 300 ms hide
and a 250 ms reveal. The browser maps easing mode 2 to CSS `ease-out`.

Set `SIGLUS_FRAME_EXIT_ONLY=1` to check Return to Title and Exit from the
message frame. The probe cancels both scripted confirmations, checks the
unchanged dialogue, then confirms Return to Title and confirms Exit after
starting another game. On Exit the browser returns to the player.
Gameexe.dat buttons 11 and 12 use `TYPE = "none"` with named calls to the
shared Scene.pck exports `$sys_returnmenu_btn` and `$sys_gameend_btn`.
The embedded PE resolves the two strings at `0x5f4620` and checks for a
registered named call at `0x5f4d16` before dispatching the button type.
The original confirmation scenes call `syscom.return_to_menu(0, 0, 0)`
at `0x1099d` and `syscom.end_game(0)` at `0x13816`.

Set `SIGLUS_PCM_LOAD_ONLY=1` to check which audio state a slot preserves.
The probe saves normally at the one-shot PCM effect `tin` in chapter 01
and checks that the effect is omitted from the slot. The reachable story
uses one-shot PCM, so the probe adds an active loop, a prepared sound
and non-default levels to its test slot. It reopens the player, loads
through the title menu, compares decoded length, sample start, RMS and
gain, then saves to a second slot and compares the restored state.

Set `SIGLUS_HISTORY_ONLY=1` to open the original message history button,
compare displayed text with script hashes, replay a stored voice, and verify
that closing history restores keyboard focus to the same page. The browser
uses the original MSGBK resources and stores recent history and rewind
checkpoints in each save. The probe reloads the slot after reopening the player
and checks both No and Yes in the original resume confirmation.

The clean-profile DOM Text route on `d31134d` checked 21,210 input
checkpoints, including nine scrolled messages and 40 size resets. It
matched 147,119 tags and checked 8,552 audio buffers. The run completed
all five movies, checked the clear flags and entered Music after
reopening. It reported zero browser console errors and zero text failures.

The clean-profile Native route on `c8533a1` matched 148,655 command and message
tags and checked 8,553 decoded audio buffers with zero browser console errors.
All 21,210 dialogue checkpoints passed the Native render check, including
the pages following 40 scripted size resets. Save and load were exercised
on page 70. The run finished all five movies, verified the clear flags and
entered Music after reopening. `npm test` reported the same
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

- The return and exit confirmations use the script's original objects,
  coordinates and input loop. The browser approximates object blending
  and waits out the scripted fade duration in the confirmation scene.

- History can resume a stored checkpoint from the current runtime or a newer
  browser save. The browser keeps checkpoints per page within the configured
  history limit. Native checkpoint sampling and line breaking still need
  comparison.

- Day saves run the script’s rotation routine and resume after
  the browser’s day transition. The native savepoint is inside the transition.
  Thumbnails composite the visible graphical layers
  at the configured size. Dialogue and native capture effects are absent from
  that composite.
- Loading restores the VM, current message, background and cast. Browser
  saves record the active BGM track, loop mode and channel level. Playback
  starts at the configured sample, including for older browser records
  with a playback cursor. The embedded Windows PE writes the
  track name at `0x6009f3`, followed by the level, stop countdown and
  two playback flags. The reader at `0x600ae0` starts the saved track
  with sample argument `-1` at `0x600c06`. The player resolves that
  argument at `0x60527c` to the start sample from the BGM table populated
  by the Gameexe.dat parser at `0x695112`. The Windows sound loader
  applies the saved voice level at `0x5ff350`. The PCM reader at
  `0x604440` restores levels and checks the saved loop and ready flags
  at `0x604759` and `0x60476a`. The file playback helper skips
  starting a prepared source at `0x604bb1`. The browser saves the
  voice and PCM levels along with active loops and prepared PCM.
  Loops restart at the beginning and prepared PCM stays silent until
  the script resumes it. The browser still lacks the native pending
  BGM stop state and delayed PCM resume state. In-flight animations
  and transient voice playback continue with the next script command.
- The browser's character layout, text layout, day cards, transition masks,
  recollection, shake, dizziness and motion effects approximate the script's
  native compositing. Effect timing and rendering have not been compared
  frame by frame.
  The embedded PE sets the message slide flag and duration at `0x550813`
  and schedules a line offset at `0x5da999`. The browser slides the text
  within the configured row count and keeps the full message for history.
  The browser settles the offset at its input checkpoint. The embedded
  PE dispatches `pp()` at `0x54d4dd` to the message wait handler at
  `0x672a20`. The browser waits on the current text and keeps the current
  message open for the next fragment.
- Browser title buttons expose New Game, Prologue, Load, Exit, Configuration,
  and the original scripted Music screen on the cleared title. Alpha-tested
  button hit areas use the bounds of the
  nontransparent pixels.

The browser renders system-call objects above the retained game stage. This
keeps scene animations and message visibility separate from the system menu.
The capture commands used by Configuration retain the scene for this overlay.
Standalone capture surfaces still need implementation. Save thumbnails
composite the retained scene layers as described above.
