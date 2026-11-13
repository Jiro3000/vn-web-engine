# SiglusEngine

Select the original FORTUNE×WORLD folder in the SiglusEngine player. The player
also accepts its `StartData/GameData` subdirectory. A fresh session follows the
game's startup and mandatory prologue before showing the title. The title's
New Game button continues at entry 2 of the first scene.

The SceneScript VM reads the bytecode in `Scene.pck` and resolves jumps and
scene calls against the pack tables. It dispatches browser graphics, message
windows and audio through the runtime services. Include commands for common
effects, scene setup and sound have browser implementations. The archive and
media readers are in `src/formats/siglus/`. Encrypted scene packs with an
embedded CP932 key can be opened directly from the installation.

Compatibility covers the verified startup, prologue, title and opening of New
Game for the tested installation. Other routes and save/configuration menus
are outside the verified scope. The recollection overlay and throb effect use
browser approximations. The tested executable's SHA-256 is
`5a8d3539530e73ad10c07a3757d2081ccb9265cb08455df998ac2a66d3da18a2`.

## Verification

Build with `npm run build`. Generate an independent disassembly using
[SiglusSceneScriptUtility](https://github.com/Jirehlov/SiglusSceneScriptUtility)
with `siglus-ssu --const-profile 2 -x --disam /path/to/GameData/Scene.pck /tmp/siglus-reference`.
Pass its timestamped output directory to the browser verifier.

```sh
node tools/verify-siglus.mjs /path/to/FORTUNE×WORLD /path/to/chromium /tmp/siglus-reference/output_...
```

The verifier selects the original game folder, clicks Play, advances the
prologue, clicks New Game, and stops at the pause following the 50th text tag.
It checks console errors, browser media state and tag positions against the
disassembly. The sequence from the New Game entry must match every script tag
through that pause.
