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

Click the game or press Enter to advance a page. Hold Control to skip where
the script enables Control skip. At a page wait the browser player offers one
Save slot and a Load button. It keeps that slot and system flags in browser
storage keyed by the SHA-256 of Scene.pck.

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
movie completion, chapter order, and the return to the cleared title.
Set `SIGLUS_OPENING_ONLY=1` for the original 50-text check or set
`SIGLUS_DIAGNOSTIC_PAGES=240` for a short skip check from New Game.

## Known differences

- The browser uses a single local slot with Save and Load buttons at message
  waits. The original uses scripted save and load menus with multiple slots,
  thumbnails and day-based autosaves.
- Loading restores the VM, current message, background and cast. BGM restarts
  from its configured start sample. In-flight animations and voice playback
  resume with the next script command.
- The browser's character layout, text layout, day cards, transition masks,
  recollection, shake, dizziness and motion effects approximate the script's
  native compositing. Effect timing and rendering have not been compared
  frame by frame.
- Browser title buttons currently expose New Game, Prologue, Load and Exit.
  The original title also offers configuration and music screens.
