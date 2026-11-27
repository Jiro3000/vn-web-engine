#!/usr/bin/env node
/**
 * Unified, data-driven headless Brave programmatic verifier, layout/hit-test auditor,
 * interactive round-trip matrix runner, and invariant crawler for ANY SiglusEngine game.
 *
 * ZERO screenshots / ZERO visual inspection — 100% programmatic DOM, state,
 * hit-test, unhandled-opcode telemetry, and audio/video verification.
 *
 * Usage:
 *   node tools/siglus-audit.mjs <profile.json> [systems|extras|crawl] [choicePick] [maxSeconds] [chaosEvery] [replay]
 *
 * Environment:
 *   BROWSER_BIN   Path to Brave/Chrome binary (defaults to Brave on macOS, falls back to Chrome)
 *   TEXT_MODE     'dom' (default) or 'native'
 *   GAME_DIR      Optional override for profile.gameDir
 *   SITE_DIR      Built site directory (defaults to site)
 *   TRACE_CRAWL   Log scene transitions and stalled script positions
 *   TRACE_MODAL   Log input and state transitions around modal menus
 *   SIGLUS_BENCH_DISPLAY=1  Report render costs during configured extras drags
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parseMwndAnimation, parseMwndLayout} from '../dist/engines/siglus/mwnd.js';
import {SiglusScenePack} from '../dist/formats/siglus/scene-pack.js';
import {sha256File} from '../tests/helpers/siglus-game-suite.mjs';
import {DevToolsConnection} from './capture-browser-trace.mjs';
import {createStaticServer} from './serve-static.mjs';

const PROFILE_PATH = process.argv[2];
const MODE = process.argv[3] ?? 'systems';
const TEXT_MODE = process.env.TEXT_MODE ?? 'dom';

if (!PROFILE_PATH) {
  console.error('Usage: node tools/siglus-audit.mjs <profile.json> [systems|extras|crawl]');
  process.exit(1);
}

const profileCfg = JSON.parse(fs.readFileSync(resolve(PROFILE_PATH), 'utf8'));
const replayName = MODE === 'crawl' ? process.argv[7] : undefined;
const replay = replayName === undefined ? undefined : profileCfg.crawlReplays?.[replayName];
if (replayName && !replay) throw new Error(`Unknown crawl replay ${replayName}`);
const GAME_DIR = resolve(process.env.GAME_DIR ?? profileCfg.gameDir);
const SITE_DIR = resolve(process.env.SITE_DIR ?? 'site');

function resolveBrowserBin() {
  if (process.env.BROWSER_BIN) return process.env.BROWSER_BIN;
  for (const candidate of [
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find Brave or Chrome; set BROWSER_BIN');
}

function findCaseInsensitiveFile(dir, targetLower) {
  if (!fs.existsSync(dir)) return undefined;
  const hit = fs.readdirSync(dir).find((name) => !name.startsWith('._') && name.toLowerCase() === targetLower);
  return hit ? join(dir, hit) : undefined;
}

function hasSiglusDataFiles(dir) {
  return Boolean(findCaseInsensitiveFile(dir, 'scene.pck') && findCaseInsensitiveFile(dir, 'gameexe.dat'));
}

function resolveDataDir(dir) {
  if (hasSiglusDataFiles(dir)) return dir;
  const nested = join(dir, 'StartData', 'GameData');
  if (hasSiglusDataFiles(nested)) return nested;
  const selectIni = findCaseInsensitiveFile(dir, 'select.ini');
  if (selectIni) {
    const first = fs.readFileSync(selectIni, 'utf8').split(/\r?\n/).find((line) => line.trim());
    const sub = first?.split('\t')[0]?.trim();
    if (sub && hasSiglusDataFiles(join(dir, sub))) return join(dir, sub);
  }
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = join(dir, entry.name);
      if (hasSiglusDataFiles(candidate)) return candidate;
    }
  }
  throw new Error(`Missing Scene.pck / gameexe.dat under ${dir}`);
}

const DATA_DIR = resolveDataDir(GAME_DIR);
const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(findCaseInsensitiveFile(DATA_DIR, 'scene.pck'))));
const gameexe = pack.configuration(new Uint8Array(fs.readFileSync(findCaseInsensitiveFile(DATA_DIR, 'gameexe.dat'))));

const parseSceneName = (key, fallback) => gameexe.get(key)?.split('"')[1] ?? fallback;
const [SCREEN_W, SCREEN_H] = (gameexe.get('SCREEN_SIZE') ?? '1280, 720')
  .split(',')
  .map((v) => Number(v.trim()));
const MENU_SCENE = profileCfg.title?.scene ?? parseSceneName('MENU_SCENE', '_titlemenu');
const CANCEL_SCENE = profileCfg.quickMenu?.scene ?? parseSceneName('CANCEL_SCENE', null);
const SAVE_SCENE =
  profileCfg.quickMenu?.saveScene ?? profileCfg.messageMenu?.saveScene ?? parseSceneName('SAVE_SCENE', null);
const LOAD_SCENE =
  profileCfg.quickMenu?.loadScene ?? profileCfg.messageMenu?.loadScene ?? parseSceneName('LOAD_SCENE', null);
const CONFIG_SCENE =
  profileCfg.title?.configScene ?? profileCfg.quickMenu?.configScene ?? parseSceneName('CONFIG_SCENE', null);
const USES_POINTER_MENUS = Boolean(profileCfg.pointerPolledMenus);
const mwndBottom = Math.max(
  SCREEN_H,
  ...Array.from({length: Number(gameexe.get('MWND.CNT') ?? 0)}, (_, index) => {
    const {windowPos, windowSize} = parseMwndLayout(gameexe, index);
    return windowPos[1] + windowSize[1];
  }),
);
const SAVE_KEY = 'siglus:' + sha256File(findCaseInsensitiveFile(DATA_DIR, 'scene.pck'));
const BROWSER_BIN = resolveBrowserBin();

const tmpProfile = await mkdtemp(join(tmpdir(), 'siglus-audit-'));
const server = await createStaticServer({root: SITE_DIR});
let child;
let cdp;

const errors = [];
const warnings = [];

try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  child = spawn(
    resolve(BROWSER_BIN),
    [
      '--headless=new',
      '--window-size=1280,800',
      '--incognito',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0',
      '--user-data-dir=' + tmpProfile,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    {stdio: ['ignore', 'ignore', 'pipe']},
  );

  const endpoint = await new Promise((done, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 25000);
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        done(m[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Browser exited ${code}\n${stderr}`));
    });
  });

  cdp = await DevToolsConnection.connect(endpoint);
  const {targetId} = await cdp.command('Target.createTarget', {url: `${origin}/siglus.html?siglus-trace`});
  const {sessionId} = await cdp.command('Target.attachToTarget', {targetId, flatten: true});
  const send = (method, params) => cdp.command(method, params, sessionId);
  await send('Page.bringToFront');

  cdp.on('event', ({method, params}) => {
    if (method === 'Runtime.exceptionThrown') {
      errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    } else if (method === 'Runtime.consoleAPICalled') {
      const msg = params.args.map((a) => a.description ?? a.value ?? '').join(' ');
      if (params.type === 'error') errors.push(`[console.error] ${msg}`);
      else if (params.type === 'warning') warnings.push(`[warn] ${msg}`);
    } else if (method === 'Log.entryAdded' && params.entry.level === 'error') {
      errors.push(`[log.error] ${params.entry.text}`);
    }
  });

  for (const domain of ['Page', 'DOM', 'Runtime', 'Log']) await send(domain + '.enable');
  await send('Emulation.setFocusEmulationEnabled', {enabled: true});

  const evaluate = async (expression) => {
    const {result, exceptionDetails} = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  };

  const waitFor = async (expr, timeoutMs = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await evaluate(`Boolean(${expr})`)) return true;
      const fatal = await evaluate(`(() => {
        const banner = document.getElementById('fatal-error');
        return banner && !banner.hidden ? banner.textContent : '';
      })()`);
      if (fatal) throw new Error(fatal);
      await delay(100);
    }
    return false;
  };

  const moveMouse = async (x, y) => {
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
  };

  const clickAt = async (x, y) => {
    const hold = USES_POINTER_MENUS ? 45 : 25;
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
    await delay(hold);
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
    await delay(hold);
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
  };

  const dragFrom = async ({cx: x, cy: y}, dx, dy) => {
    await moveMouse(x, y);
    await delay(50);
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
    try {
      await delay(100);
      for (let step = 1; step <= 8; step++) {
        await delay(35);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(x + dx * step / 8),
          y: Math.round(y + dy * step / 8),
          buttons: 1,
        });
      }
    } finally {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: Math.round(x + dx),
        y: Math.round(y + dy),
        button: 'left',
        clickCount: 1,
      });
    }
  };

  const rightClickStage = async (trusted = USES_POINTER_MENUS) => {
    if (trusted) {
      const pt = await evaluate(`(() => {
        const stage = document.getElementById('siglus-surface')?.firstElementChild;
        if (!stage) throw new Error('No stage for contextmenu');
        const r = stage.getBoundingClientRect();
        return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
      })()`);
      await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: pt.x, y: pt.y});
      await delay(30);
      await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: pt.x, y: pt.y, button: 'right', clickCount: 1});
      await delay(45);
      await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: pt.x, y: pt.y, button: 'right', clickCount: 1});
      return;
    }
    await evaluate(`(() => {
      const stage = document.getElementById('siglus-surface')?.firstElementChild;
      if (!stage) throw new Error('No stage for contextmenu');
      const r = stage.getBoundingClientRect();
      stage.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: Math.round(r.left + r.width / 2),
        clientY: Math.round(r.top + r.height / 2),
      }));
    })()`);
  };

  const wheelStage = async (deltaY) => {
    const pt = await evaluate(`(() => {
      const r = document.getElementById('siglus-surface').firstElementChild.getBoundingClientRect();
      return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
    })()`);
    await send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY});
  };

  const pressKey = async (key, code, vk, holdMs = 30) => {
    await send('Input.dispatchKeyEvent', {type: 'keyDown', key, code, windowsVirtualKeyCode: vk});
    await delay(holdMs);
    await send('Input.dispatchKeyEvent', {type: 'keyUp', key, code, windowsVirtualKeyCode: vk});
  };

  if (!(await waitFor("typeof document.querySelector('#files')?.onchange === 'function'"))) {
    throw new Error('Timed out waiting for the installation input handler');
  }
  const {root: doc} = await send('DOM.getDocument', {depth: -1, pierce: true});
  const {nodeId} = await send('DOM.querySelector', {nodeId: doc.nodeId, selector: '#files'});
  await send('DOM.setFileInputFiles', {nodeId, files: [GAME_DIR]});
  if (!(await waitFor("document.querySelector('#play')?.disabled === false", 180000))) {
    throw new Error('Play button never enabled: ' + (await evaluate("document.querySelector('#status')?.textContent")));
  }

  await evaluate(`(() => {
    const s = document.getElementById('text-mode');
    if (s) { s.value = ${JSON.stringify(TEXT_MODE)}; s.dispatchEvent(new Event('change')); }
  })()`);

  let runtimePath;
  for (const name of await readdir(join(SITE_DIR, 'assets'))) {
    if (
      name.startsWith('siglus-') &&
      name.endsWith('.js') &&
      /export\s*\{[^}]*\bcurrentPlayer\b/.test(await readFile(join(SITE_DIR, 'assets', name), 'utf8'))
    ) {
      runtimePath = '/assets/' + name;
      break;
    }
  }
  if (!runtimePath) throw new Error('Could not find siglus runtime chunk exporting currentPlayer');
  await evaluate(`import(${JSON.stringify(origin + runtimePath)}).then(m => { window.__runtime = m; })`);

  // This temporary browser profile can unlock bundled gallery and replay entry points.
  const unlock = MODE === 'extras' ? profileCfg.extras : replay;
  const systemFlags = unlock?.systemFlags ?? profileCfg.title?.systemFlags;
  const galleryFlags = new Map([...(profileCfg.title?.galleryFlags ?? []), ...(unlock?.galleryFlags ?? [])]);
  if (unlock || systemFlags || galleryFlags.size) {
    await evaluate(`(() => {
      const k = ${JSON.stringify(SAVE_KEY)};
      const ex = ${JSON.stringify(unlock ?? {})};
      const systemFlags = ${JSON.stringify(systemFlags ?? null)};
      const galleryFlags = ${JSON.stringify([...galleryFlags])};
      if (systemFlags) localStorage.setItem(k + ':system', JSON.stringify(systemFlags));
      if (galleryFlags.length) localStorage.setItem(k + ':gallery', JSON.stringify(galleryFlags));
      if (ex.cgFlags) localStorage.setItem(k + ':cgtable', JSON.stringify(ex.cgFlags));
      if (ex.bgmListened) localStorage.setItem(k + ':bgmtable', JSON.stringify(ex.bgmListened));
    })()`);
  }
  if (profileCfg.title?.skipPrologue) {
    await evaluate(`localStorage.setItem(${JSON.stringify(SAVE_KEY + ':options')}, JSON.stringify({
      SKIP_UNREAD_MESSAGE_ONOFF: true,
    }))`);
  }

  if (process.env.SIGLUS_OBSERVE_OUT) {
    await evaluate(`window.__siglusObserve = {commands: new Set(), properties: new Set(), gameexe: new Set()};`);
  }

  const playPt = await evaluate(`(() => {
    const r = document.getElementById('play').getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`);
  await clickAt(playPt.x, playPt.y);

  if (!(await waitFor('Boolean(window.__runtime?.currentPlayer?.vm)', 90000))) {
    const status = await evaluate("document.querySelector('#status')?.textContent");
    throw new Error(`currentPlayer.vm did not initialize (${status}); errors=${JSON.stringify(errors)}`);
  }

  await evaluate(`(() => {
    const p = window.__runtime.currentPlayer;
    window.__audit = {scenes: [], sceneSet: new Set(), movies: [], movieActive: null, compositeInk: new WeakMap(), effects: [], playingOmvs: new Set(), pageWaits: 0, stagePause: null};
    window.__audit.frame = () => {
      const vm = window.__runtime?.currentPlayer?.vm;
      const frame = vm?.frames?.at(-1);
      return frame && (vm.sceneJumps?.get(frame) ?? frame);
    };
    const recordScene = (scene) => {
      if (!scene || window.__audit.sceneSet.has(scene)) return;
      window.__audit.sceneSet.add(scene);
      window.__audit.scenes.push(scene);
    };
    const replayScene = ${JSON.stringify(replay?.scenePrefix ?? null)};
    if (replayScene) p.root.addEventListener('siglus-tag', ({detail}) => {
      if (detail.scene.startsWith(replayScene)) recordScene(detail.scene);
    });
    const auditedVoice = ${JSON.stringify(profileCfg.gameplay?.voice?.id ?? null)};
    if (auditedVoice !== null) {
      const voice = p.audio.voice.bind(p.audio);
      p.audio.voice = function(id, channel = 'voice', ...args) {
        if (id === auditedVoice && channel === 'voice') window.__audit.voiceRequestedAt = performance.now();
        return voice(id, channel, ...args);
      };
    }
    if (${Boolean(profileCfg.gameplay?.backlogJump)}) {
      const callScene = p.vm.callScene.bind(p.vm);
      p.vm.callScene = function(scene, entry, ...args) {
        if (p.historyTarget) (window.__audit.historyCalls ??= []).push([scene, entry]);
        return callScene(scene, entry, ...args);
      };
    }
    const stagePageScenes = new Set(${JSON.stringify(profileCfg.gameplay?.stagePageScenes ?? [])});
    const ending = ${JSON.stringify(replay?.ending ?? null)};
    const expectedSpeaker = ${JSON.stringify(replay?.expectedSpeaker ?? null)};
    const portraitChecks = ${JSON.stringify(replay?.portraitChecks ?? [])};
    window.__audit.portraitChecks = {};
    const promptScenes = new Set(${JSON.stringify(
      replay?.prompts
        ?.filter((p) => !p.advancePage || p.button || p.choice !== undefined || p.editValues !== undefined)
        ?.map(({scene}) => scene) ?? [],
    )});
    window.__audit.stageTiming = [];
    if (${Boolean(process.env.TRACE_CRAWL && MODE === 'crawl')}) {
      const delay = p.delay.bind(p);
      p.delay = async function(time, ...args) {
        const wait = {ms: time ?? null, started: performance.now()};
        window.__audit.delay = wait;
        try {
          return await delay(time, ...args);
        } finally {
          if (window.__audit.delay === wait) window.__audit.delay = null;
        }
      };
    }
    if (ending || stagePageScenes.size) {
      const command = p.command.bind(p);
      p.command = function(call) {
        if (ending && !window.__audit.playingOmvs.has(ending.movie) &&
            call.scene === ending.scene && call.line >= ending.fromLine) {
          window.__audit.endingPending = true;
          p.skip = false;
        }
        if (stagePageScenes.has(call.scene) && call.path.length === 1 && [14, 54, 55, 115].includes(call.path[0])) {
          const entries = window.__audit.stageTiming;
          entries.push({line: call.line, command: call.path[0], args: call.args, pendingText: p.pendingText});
          if (entries.length > 12) entries.shift();
        }
        if (${MODE === 'crawl'} && stagePageScenes.has(call.scene)) p.skip = false;
        return command(call);
      };
    }
    const waitAtPage = p.waitAtPage.bind(p);
    p.waitAtPage = async function() {
      window.__audit.pageWaits++;
      const frame = window.__audit.frame();
      for (const [index, check] of portraitChecks.entries()) {
        if (frame?.scene.name !== check.scene || frame.line !== check.line) continue;
        const {portrait, currentName} = p.display;
        window.__audit.portraitChecks[index] = {
          speaker: currentName,
          faces: [...portrait.querySelectorAll('[data-siglus-object]')].map((el) => el.dataset.siglusObject),
        };
      }
      if (${MODE === 'crawl'} && stagePageScenes.has(frame?.scene.name)) {
        // Let this real script wait consume a single click before resuming the fast crawl.
        p.skip = false;
        window.__audit.stagePause = {scene: frame.scene.name, line: frame.line};
      }
      try {
        if (expectedSpeaker && !promptScenes.has(frame?.scene.name) &&
            p.root.querySelector('[data-siglus-speaker]')?.textContent?.trim() === expectedSpeaker)
          window.__audit.expectedSpeakerSeen = true;
        await waitAtPage();
      } finally {
        window.__audit.stagePause = null;
      }
    };
    p.root.addEventListener('siglus-audio', ({detail}) => {
      if (detail.channel === 'se' && detail.frames > 0) window.__audit.effects.push(detail.resource);
      if (detail.channel !== 'bgm' && detail.channel !== 'voice' && detail.frames > 0) {
        (window.__audit.sfx ??= []).push({channel: detail.channel, resource: detail.resource});
      }
      if (detail.channel === 'bgm') window.__audit.bgmPlayback = detail;
      if (detail.channel === 'voice' && detail.resource === auditedVoice) {
        window.__audit.voicePlayback = {...detail, latencyMs: performance.now() - window.__audit.voiceRequestedAt};
      }
    });
    if (${MODE === 'extras' || Boolean(process.env.TRACE_MODAL)}) {
      window.__audit.pointer = [];
      window.__audit.galleryDecisions = [];
      window.__audit.galleryGroups = new Map();
      const choose = p.choose.bind(p);
      p.choose = function(target) {
        const frame = window.__audit.frame();
        window.__audit.pointer.push(['decision', target.group, target.id, frame?.scene.name, frame?.line, frame?.pc]);
        choose(target);
      };
      const groupCommand = p.groupCommand.bind(p);
      p.groupCommand = function(group, command) {
        const frame = window.__audit.frame();
        const pending = p.decisions.get(group);
        const result = groupCommand(group, command);
        if (command === 2 || command === 10) window.__audit.galleryGroups.set(group, frame?.scene.name);
        if (command === 4 || command === 5) window.__audit.galleryGroups.delete(group);
        if (pending !== undefined) {
          window.__audit.galleryDecisions.push([group, command, pending, result, frame?.scene.name, frame?.line]);
          if (window.__audit.galleryDecisions.length > 12) window.__audit.galleryDecisions.shift();
        }
        return result;
      };
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        p.display.stage.addEventListener(type, (event) => {
          const button = event.target.closest('button');
          window.__audit.pointer.push([event.type, button?.dataset.siglusGroup, button?.dataset.siglusButton, event.button]);
          if (window.__audit.pointer.length > 24) window.__audit.pointer.shift();
        }, true);
      }
      if (${Boolean(process.env.TRACE_MODAL)}) {
        for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) {
          p.display.stage.addEventListener(type, (event) => {
            const button = event.target.closest('button');
            window.__audit.pointer.push(['after-' + event.type, event.pointerId,
              button?.disabled, p.display.heldButton?.target, p.display.hovered]);
            if (window.__audit.pointer.length > 24) window.__audit.pointer.shift();
          });
        }
      }
    }
    const origMovie = p.movie?.bind(p);
    if (origMovie) {
      p.movie = async function(name, skippable) {
        const rec = {name, skippable, startedAt: Date.now(), endedAt: null, error: null};
        window.__audit.movies.push(rec);
        window.__audit.movieActive = name;
        try {
          return await origMovie(name, skippable);
        } catch (err) {
          rec.error = String(err);
          throw err;
        } finally {
          rec.endedAt = Date.now();
          if (window.__audit.movieActive === name) window.__audit.movieActive = null;
        }
      };
    }
    const recordObjectMovies = (objects) => {
      for (const object of objects?.values() ?? []) {
        if (!object.visible) continue;
        if (object.movie?.presentedFrame > 0)
          window.__audit.playingOmvs.add(object.name.toLowerCase());
        if (object.children) recordObjectMovies(object.children);
      }
    };
    setInterval(() => {
      recordScene(window.__audit.frame()?.scene.name);
      for (const effect of p.display?.activeEffects?.values() ?? []) {
        if (effect.layer?.isConnected && effect.movie?.presentedFrame > 0)
          window.__audit.playingOmvs.add(effect.checkpoint.name.toLowerCase());
      }
      recordObjectMovies(p.objects?.[0]);
      recordObjectMovies(p.systemObjects);
      recordObjectMovies(p.systemFrontObjects);
    }, 50);
  })()`);

  const inspectState = (framingObject) =>
    evaluate(`(() => {
      const p = window.__runtime?.currentPlayer;
      const surface = document.getElementById('siglus-surface');
      const stage = surface?.firstElementChild;
      const sr = stage ? stage.getBoundingClientRect() : null;
      const sw = ${SCREEN_W}, sh = ${SCREEN_H};
      const sx = sr && sr.width > 0 ? sw / sr.width : 1;
      const sy = sr && sr.height > 0 ? sh / sr.height : 1;
      const toStage = (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: Math.round((r.left - sr.left) * sx),
          top: Math.round((r.top - sr.top) * sy),
          right: Math.round((r.right - sr.left) * sx),
          bottom: Math.round((r.bottom - sr.top) * sy),
          w: Math.round(r.width * sx),
          h: Math.round(r.height * sy),
          cx: Math.round(r.left + r.width / 2),
          cy: Math.round(r.top + r.height / 2),
        };
      };
      const clipHitBounds = (bounds, el, style) => {
        const inset = /^inset\\(([^()]+)\\)$/.exec(style.clipPath);
        if (!inset) return;
        const edges = inset[1].trim().split(/\\s+/);
        if (edges.length > 4 || !edges.every((edge) => /^-?\\d+(?:\\.\\d+)?(?:px|%)$/.test(edge))) return;
        const [top, right = top, bottom = top, left = right] = edges;
        const r = el.getBoundingClientRect();
        const length = (edge, rendered, unscaled) => parseFloat(edge) *
          (edge.endsWith('%') ? rendered / 100 : rendered / (unscaled || rendered || 1));
        bounds.left = Math.max(bounds.left, r.left + length(left, r.width, el.offsetWidth));
        bounds.right = Math.min(bounds.right, r.right - length(right, r.width, el.offsetWidth));
        bounds.top = Math.max(bounds.top, r.top + length(top, r.height, el.offsetHeight));
        bounds.bottom = Math.min(bounds.bottom, r.bottom - length(bottom, r.height, el.offsetHeight));
      };
      const top = window.__audit.frame();
      const disp = p?.display;
      const layersEl = disp?.layers;
      const systemLayerEl = disp?.systemLayer;
      const messageEl = disp?.message;
      const controlsEl = disp?.controls;

      let framing;
      const framingObject = ${JSON.stringify(framingObject ?? null)};
      if (framingObject && layersEl && sr) {
        const object = [...layersEl.querySelectorAll('[data-siglus-object]')]
          .find((el) => el.dataset.siglusObject === framingObject);
        if (object) {
          const r = object.getBoundingClientRect();
          const bounds = {left: Math.max(sr.left, r.left), top: Math.max(sr.top, r.top),
            right: Math.min(sr.right, r.right), bottom: Math.min(sr.bottom, r.bottom)};
          for (let node = object; node && node !== stage; node = node.parentElement)
            clipHitBounds(bounds, node, getComputedStyle(node));
          framing = {
            visibleBounds: ['left', 'top', 'right', 'bottom'].map((edge, index) =>
              Math.round((bounds[edge] - (index % 2 ? sr.top : sr.left)) * (index % 2 ? sy : sx))),
          };
          if (stage.dataset.textMode === 'native') {
            const canvas = disp.nativeText;
            const aboveWindow = Math.max(0, Math.min(-canvas.offsetTop, canvas.height));
            const pixels = aboveWindow > 0
              ? canvas.getContext('2d').getImageData(0, 0, canvas.width, aboveWindow).data : [];
            framing.speakerAboveWindow = pixels.some((component, i) => i % 4 === 3 && component > 32);
          } else {
            framing.speakerAboveWindow = disp.speaker.getBoundingClientRect().top < messageEl.getBoundingClientRect().top;
          }
        }
      }

      const visibleLayerVisuals = [];
      if (layersEl) {
        for (const el of layersEl.querySelectorAll('img, canvas, video')) {
          const r = el.getBoundingClientRect();
          let hidden = false;
          let animated = false;
          let cur = el;
          while (cur && cur !== layersEl) {
            const ccs = getComputedStyle(cur);
            if (cur.hidden || ccs.display === 'none' || ccs.visibility === 'hidden' || Number(ccs.opacity) <= 0.01) {
              hidden = true;
              break;
            }
            if (!animated && cur.getAnimations?.().some((a) => a.playState === 'running')) animated = true;
            cur = cur.parentElement;
          }
          if (!hidden && r.width > 0 && r.height > 0) {
            const slot = el.closest('[data-siglus-object-id]')?.dataset.siglusObjectId;
            const key = el.dataset.siglusKey ?? el.dataset.siglusObject ?? el.getAttribute('alt') ?? slot ?? el.tagName;
            visibleLayerVisuals.push({tag: el.tagName, key, animated});
          }
        }
      }

      const spEl = stage?.querySelector('[data-siglus-speaker]');
      const dlgEl = stage?.querySelector('[data-siglus-dialogue]');
      const dlgText = dlgEl?.textContent?.trim() ?? '';
      const spText = spEl?.textContent?.trim() ?? '';
      let msgVisible = false;
      if (messageEl) {
        const mcs = getComputedStyle(messageEl);
        msgVisible = !messageEl.hidden && mcs.display !== 'none' && mcs.visibility !== 'hidden' && Number(mcs.opacity) > 0.05;
      }
      const spaceHideEls = stage ? [...stage.querySelectorAll('[data-siglus-space-hide="1"]')] : [];
      const spaceHideVisibleCount = spaceHideEls.filter((el) => getComputedStyle(el).visibility !== 'hidden').length;

      let nanCount = 0;
      const nanElements = [];
      if (stage) {
        for (const el of stage.querySelectorAll('*')) {
          const css = el.style?.cssText;
          if (css && /\\bNaN\\b/.test(css.replace(/url\\([^)]*\\)/g, ''))) {
            nanCount++;
            if (nanElements.length < 5) {
              nanElements.push({tag: el.tagName, ds: {...el.dataset}, cssText: css.replace(/url\\([^)]*\\)/g, 'url(...)')});
            }
          }
        }
      }

      const buttons = [];
      if (stage) {
        for (const b of stage.querySelectorAll('button')) {
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          const hitBounds = {left: r.left, right: r.right, top: r.top, bottom: r.bottom};
          clipHitBounds(hitBounds, b, cs);
          let hidden = b.disabled || b.hidden || b.inert || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05 || r.width <= 0 || r.height <= 0 || b.style.clipPath === 'inset(100%)';
          let cur = b.parentElement;
          while (!hidden && cur && cur !== stage) {
            const pcs = getComputedStyle(cur);
            clipHitBounds(hitBounds, cur, pcs);
            if (cur.hidden || cur.inert || pcs.display === 'none' || pcs.visibility === 'hidden' || Number(pcs.opacity) <= 0.05) {
              hidden = true;
            } else if (pcs.overflowY === 'auto' || pcs.overflowY === 'scroll') {
              const pr = cur.getBoundingClientRect();
              if (r.top < pr.top || r.bottom > pr.bottom) hidden = true;
            }
            cur = cur.parentElement;
          }
          if (!hidden && hitBounds.right > hitBounds.left && hitBounds.bottom > hitBounds.top) {
            const st = toStage(b);
            st.cx = Math.round((hitBounds.left + hitBounds.right) / 2);
            st.cy = Math.round((hitBounds.top + hitBounds.bottom) / 2);
            const hit = document.elementFromPoint(st.cx, st.cy);
            const hitButton = hit?.closest('button');
            const sameScriptControl =
              b.dataset.siglusButton !== undefined &&
              b.dataset.siglusButton === hitButton?.dataset.siglusButton &&
              b.dataset.siglusGroup === hitButton.dataset.siglusGroup;
            const hitOk = Boolean((hit && b.contains(hit)) || sameScriptControl);
            const shellObscured = Boolean(hit?.closest('#sidebar'));
            const stageHit = shellObscured
              ? document.elementsFromPoint(st.cx, st.cy).find((el) => !el.closest('#sidebar'))
              : hit;
            const stageHitButton = stageHit?.closest('button');
            const stageHitOk = Boolean(
              (stageHit && b.contains(stageHit)) ||
                (b.dataset.siglusButton !== undefined &&
                  b.dataset.siglusButton === stageHitButton?.dataset.siglusButton &&
                  b.dataset.siglusGroup === stageHitButton.dataset.siglusGroup),
            );
            let opaqueRect;
            if (sr && (st.left < -6 || st.right > sw + 6 || st.top < -6 || st.bottom > sh + 6 || b.dataset.siglusAction !== undefined)) {
              const canvas = b.children.length === 1 && b.firstElementChild?.tagName === 'CANVAS' ? b.firstElementChild : null;
              if (canvas && canvas.width > 0 && canvas.height > 0) {
                const px = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
                if (px) {
                  let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
                  for (let y = 0; y < canvas.height; y++) {
                    for (let x = 0; x < canvas.width; x++) {
                      if (px[(y * canvas.width + x) * 4 + 3] >= 16) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                      }
                    }
                  }
                  if (maxX >= minX && maxY >= minY) {
                    const cr = canvas.getBoundingClientRect();
                    const scaleX = cr.width / canvas.width;
                    const scaleY = cr.height / canvas.height;
                    opaqueRect = {
                      left: Math.round((cr.left + minX * scaleX - sr.left) * sx),
                      top: Math.round((cr.top + minY * scaleY - sr.top) * sy),
                      right: Math.round((cr.left + (maxX + 1) * scaleX - sr.left) * sx),
                      bottom: Math.round((cr.top + (maxY + 1) * scaleY - sr.top) * sy),
                    };
                  }
                }
              }
            }
            buttons.push({
              aria: b.getAttribute('aria-label') ?? '',
              text: (b.textContent ?? '').trim().slice(0, 40),
              dataset: {...b.dataset},
              rect: st,
              ...(opaqueRect ? {opaqueRect} : {}),
              hitOk,
              shellObscured,
              stageHitOk,
              hitTag: hitButton ? (hitButton.getAttribute('aria-label') ?? hitButton.tagName) : hit?.tagName,
              hitGroup: hitButton?.dataset.siglusGroup,
              hitClip: hitOk ? undefined : b.style.clipPath.slice(0, 120),
            });
          }
        }
      }

      const sprites = [];
      if (stage && sr) {
        for (const el of stage.querySelectorAll('[data-siglus-object]')) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          let hidden = el.hidden || el.inert || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05 || r.width <= 0 || r.height <= 0;
          let cur = el.parentElement;
          while (!hidden && cur && cur !== stage) {
            const pcs = getComputedStyle(cur);
            if (cur.hidden || cur.inert || pcs.display === 'none' || pcs.visibility === 'hidden' || Number(pcs.opacity) <= 0.05) {
              hidden = true;
            } else if (pcs.overflowY === 'auto' || pcs.overflowY === 'scroll') {
              const pr = cur.getBoundingClientRect();
              if (r.top < pr.top || r.bottom > pr.bottom) hidden = true;
            }
            cur = cur.parentElement;
          }
          if (!hidden) {
            const st = toStage(el);
            const insideStage = st.cx >= sr.left && st.cx <= sr.right && st.cy >= sr.top && st.cy <= sr.bottom;
            const hit = insideStage ? document.elementFromPoint(st.cx, st.cy) : null;
            const hitOk = Boolean(insideStage && stage.contains(hit));
            sprites.push({
              objectName: el.dataset.siglusObject ?? '',
              rect: st,
              hitOk,
            });
          }
        }
      }

      const activeGroups = p?.activeGroups ? [...p.activeGroups] : [];
      const cancelGroups = p?.cancelGroups ? [...p.cancelGroups] : [];
      const deadGroups = [];
      if (stage) {
        for (const g of new Set([...activeGroups, ...cancelGroups])) {
          const rawGroup = g >= 100000 ? g - 100000 : g;
          const found = stage.querySelector('[data-siglus-group="' + g + '"], [data-siglus-group="' + rawGroup + '"]');
          if (!found) deadGroups.push(g);
        }
      }

      const visualIntegrityErrors = [];
      let compositesCount = 0;
      let clippedContainersCount = 0;
      let stageTextCount = 0;
      if (disp?.graphicCache) {
        for (const [ck, entry] of disp.graphicCache.entries()) {
          if (entry?.graphic && (entry.graphic.x !== 0 || entry.graphic.y !== 0)) {
            visualIntegrityErrors.push('g00_nonzero_xy:' + ck + '=' + entry.graphic.x + ',' + entry.graphic.y);
            if (visualIntegrityErrors.length >= 10) break;
          }
        }
      }
      const domSynced = !p?.objectsDirty && !p?.systemObjectsDirty && !p?.systemFrontObjectsDirty;
      const walkVisualTree = (map, domRoot, isRootStage, checkDomClip) => {
        if (!map || !domRoot) return;
        const visit = (obj, slotId, isRoot) => {
          if (!obj || !obj.visible) return;
          const fr = obj.frames?.[obj.pattern];
          if (fr && obj.type !== 1 && obj.name && (fr.x !== 0 || fr.y !== 0)) {
            visualIntegrityErrors.push('frame_nonzero_xy:' + obj.name.slice(0, 40) + '=' + fr.x + ',' + fr.y);
          }
          if (obj.name && obj.name.includes('|') && fr) {
            compositesCount++;
            const tokens = obj.name.split('|').map((t) => t.trim()).filter((t) => t.length > 0);
            const explicitDim = /^\\(\\s*([+-]?\\d+)\\s*,\\s*([+-]?\\d+)\\s*\\)$/.exec(tokens[0] ?? '');
            const partTokens = explicitDim ? tokens.slice(1) : tokens;
            const layerRe = /^([^()]+?)(?:\\(\\s*([+-]?\\d+)\\s*,\\s*([+-]?\\d+)(?:\\s*,\\s*([+-]?\\d+))?(?:\\s*,\\s*blend\\s*=\\s*([+-]?\\d+))?\\s*\\))?$/;
            let expectedW = explicitDim ? Number(explicitDim[1]) : 0;
            let expectedH = explicitDim ? Number(explicitDim[2]) : 0;
            let baseCenterX = 0;
            let baseCenterY = 0;
            let allCached = !explicitDim && partTokens.length > 0;
            for (let pi = 0; pi < partTokens.length; pi++) {
              const m = layerRe.exec(partTokens[pi]);
              if (!m) { allCached = false; continue; }
              const pName = m[1].trim().toLowerCase();
              const dx = Number(m[2] ?? 0);
              const dy = Number(m[3] ?? 0);
              const pat = Number(m[4] ?? 0);
              const cached = disp?.graphicCache?.get(pName + '#' + pat)?.graphic;
              if (!cached) {
                allCached = false;
              } else if (!explicitDim) {
                if (pi === 0) {
                  expectedW = cached.width;
                  expectedH = cached.height;
                  baseCenterX = cached.centerX;
                  baseCenterY = cached.centerY;
                } else {
                  const right = dx + baseCenterX - cached.centerX + cached.width;
                  const bottom = dy + baseCenterY - cached.centerY + cached.height;
                  if (right > expectedW) expectedW = right;
                  if (bottom > expectedH) expectedH = bottom;
                }
              }
            }
            if (explicitDim && (fr.width !== expectedW || fr.height !== expectedH)) {
              visualIntegrityErrors.push('composite_explicit_dim_mismatch:' + fr.width + 'x' + fr.height + '!=' + expectedW + 'x' + expectedH);
            } else if (allCached && (fr.width !== expectedW || fr.height !== expectedH)) {
              visualIntegrityErrors.push('composite_dim_mismatch:' + obj.name.slice(0, 48) + ' got ' + fr.width + 'x' + fr.height + ' expected ' + expectedW + 'x' + expectedH);
            }
            if (fr.image && fr.width > 0 && fr.height > 0) {
              const cache = window.__audit.compositeInk;
              let visible = cache.get(fr.image);
              if (visible === undefined) {
                let context = fr.image.getContext?.('2d');
                if (!context) {
                  const probe = window.__audit.compositeProbe ??= new OffscreenCanvas(0, 0);
                  probe.width = fr.width;
                  probe.height = fr.height;
                  context = probe.getContext('2d', {willReadFrequently: true});
                  context?.drawImage(fr.image, 0, 0);
                }
                const data = context?.getImageData(0, 0, fr.width, fr.height)?.data;
                if (data) {
                  visible = false;
                  for (let byte = 3; byte < data.length; byte += 4) {
                    if (data[byte] === 0) continue;
                    visible = true;
                    break;
                  }
                  cache.set(fr.image, visible);
                }
              }
              if (visible === false) visualIntegrityErrors.push('composite_blank:' + JSON.stringify({
                name: obj.name,
                lostContext: fr.image.getContext?.('2d')?.isContextLost?.(),
                cachedSource: disp.compositeCache.get(obj.name)?.graphic?.image === fr.image,
                sourceDimensions: [fr.image.width, fr.image.height],
                cachedLayers: partTokens.map((part) => {
                  const [, name, , , cut] = layerRe.exec(part) ?? [];
                  const graphic = name && disp.graphicCache.get(name.trim().toLowerCase() + '#' + (cut ?? 0))?.graphic;
                  return graphic && {width: graphic.width, height: graphic.height, centerX: graphic.centerX, centerY: graphic.centerY, bounds: graphic.contentBounds};
                }),
              }));
            }
          }
          if (obj.clip?.[0] && obj.children && [...obj.children.values()].some((c) => c?.visible)) {
            clippedContainersCount++;
            if (checkDomClip && isRoot && slotId !== undefined) {
              const slotEl = domRoot.querySelector('[data-siglus-object-id="' + slotId + '"]');
              if (slotEl && getComputedStyle(slotEl).clipPath === 'none') {
                visualIntegrityErrors.push('clipped_container_missing_clipPath:slot=' + slotId);
              }
            }
          }
          if (obj.text && String(obj.text.value ?? '').trim().length > 0) {
            stageTextCount++;
            if (String(obj.text.value).includes('\ufffd'))
              visualIntegrityErrors.push('invalid_stage_text:slot=' + slotId);
          }
          if (obj.children) {
            for (const [ck, child] of obj.children.entries()) visit(child, ck, false);
          }
        };
        for (const [k, obj] of map.entries()) visit(obj, k, isRootStage);
      };
      walkVisualTree(p?.objects?.[0], layersEl, true, domSynced);
      if (p?.systemCallActive || p?.excallAllocated) {
        walkVisualTree(p?.systemObjects, systemLayerEl, false, domSynced);
        walkVisualTree(p?.systemFrontObjects, systemLayerEl, false, domSynced);
      }
      if (domSynced && clippedContainersCount > 0 && stage) {
        let domClipped = 0;
        for (const el of stage.querySelectorAll('div')) {
          if (el.style?.clipPath && el.style.clipPath !== 'none') domClipped++;
        }
        if (domClipped === 0) {
          visualIntegrityErrors.push('clipped_containers_dom_missing:expected>=' + clippedContainersCount);
        }
      }

      const historyEl = stage?.querySelector('[data-siglus-history]');
      const errBanner = document.getElementById('fatal-error')?.hidden === false ? document.getElementById('fatal-error').textContent : '';

      return {
        scene: top?.scene?.name ?? null,
        line: top?.line ?? -1,
        pc: top?.pc ?? -1,
        pages: p?.pages ?? 0,
        bgm: p?.audio?.bgmName?.() ?? surface?.dataset?.bgm ?? '',
        speaker: spText,
        dialogue: dlgText,
        messageVisible: msgVisible,
        userMessageHidden: Boolean(p?.userMessageHidden),
        spaceHideTotal: spaceHideEls.length,
        spaceHideVisibleCount,
        visibleLayerVisuals,
        stageFocused: Boolean(stage && (document.activeElement === stage || stage.contains(document.activeElement))),
        waitingForPage: Boolean(p?.waitingForPage),
        pageWaits: window.__audit.pageWaits,
        delay: window.__audit.delay,
        stagePause: window.__audit.stagePause,
        expectedSpeakerSeen: Boolean(window.__audit.expectedSpeakerSeen),
        endingPending: Boolean(window.__audit.endingPending) && !window.__audit.playingOmvs.has(${JSON.stringify(replay?.ending?.movie ?? null)}),
        pendingText: Boolean(p?.pendingText),
        excallAllocated: Boolean(p?.excallAllocated),
        systemCallActive: Boolean(p?.systemCallActive),
        systemLayerChildren: systemLayerEl?.children?.length ?? 0,
        layersInert: Boolean(layersEl?.inert),
        messageInert: Boolean(messageEl?.inert),
        controlsInert: Boolean(controlsEl?.inert),
        activeGroups,
        cancelGroups,
        deadGroups,
        skipping: Boolean(p?.skipping || p?.readSkipEnabled),
        autoMode: Boolean(p?.autoEnabled),
        nanCount,
        nanElements,
        visualIntegrityErrors,
        compositesCount,
        clippedContainersCount,
        stageTextCount,
        buttons,
        sprites,
        inputSampled: Boolean(p?.inputSampled || (p?.lastInputSampleAt >= 0 && p.lastInputSampleScene === top?.scene.name && performance.now() - p.lastInputSampleAt < 500)),
        backlogOpen: Boolean(historyEl),
        pointer: disp?.pointer,
        stageRect: sr ? {left: sr.left, top: sr.top, width: sr.width, height: sr.height} : null,
        framing,
        movieActive: window.__audit?.movieActive ?? null,
        voicePlayback: window.__audit?.voicePlayback ?? null,
        moviesSeen: window.__audit?.movies ?? [],
        scenesSeen: window.__audit?.scenes ?? [],
        portraitChecks: window.__audit.portraitChecks,
        playingOmvs: [...(window.__audit?.playingOmvs ?? [])],
        unhandledCommands: [...(p?.unhandledCommands ?? [])],
        unhandledProperties: [...(p?.unhandledProperties ?? [])],
        errBanner,
      };
    })()`);

  const matchButton = (buttons, spec) => {
    if (!spec) return undefined;
    return buttons.find((b) => {
      if (spec.group !== undefined && b.dataset.siglusGroup !== String(spec.group)) return false;
      if (spec.id !== undefined && b.dataset.siglusButton !== String(spec.id)) return false;
      if (spec.frameId !== undefined && b.dataset.siglusBtnId !== String(spec.frameId)) return false;
      if (spec.action !== undefined && b.dataset.siglusAction !== spec.action) return false;
      if (spec.aria !== undefined && b.aria !== spec.aria) return false;
      return true;
    });
  };

  const matchControl = (state, spec, onlyClickable = false) => {
    if (!spec) return undefined;
    if (spec.objectName !== undefined) {
      const target = spec.objectName.toLowerCase();
      const buttons = state.buttons.filter((button) => button.dataset.siglusObject?.toLowerCase() === target);
      const candidates = buttons.length ? buttons : (state.sprites ?? []).filter((sp) => sp.objectName.toLowerCase() === target);
      const matches = candidates.filter((sp) => {
        if (onlyClickable && !sp.hitOk) return false;
        if (spec.minX !== undefined && sp.rect.left < spec.minX) return false;
        if (spec.maxX !== undefined && sp.rect.left > spec.maxX) return false;
        if (spec.minY !== undefined && sp.rect.top < spec.minY) return false;
        if (spec.maxY !== undefined && sp.rect.top > spec.maxY) return false;
        return true;
      });
      return matches[spec.index ?? 0];
    }
    const pool = onlyClickable ? state.buttons.filter((b) => b.hitOk) : state.buttons;
    return matchButton(pool, spec);
  };

  const quickButton = (state, idOrSpec) =>
    typeof idOrSpec === 'object'
      ? matchControl(state, idOrSpec, true)
      : matchButton(
          state.buttons.filter((button) => button.hitOk),
          {group: profileCfg.quickMenu?.group, id: idOrSpec},
        );

  const currentScene = 'window.__audit.frame()?.scene.name';
  const inVmScene = (name) => `(() => {
    const vm = window.__runtime?.currentPlayer?.vm;
    return vm?.frames.some(frame => (vm.sceneJumps.get(frame) ?? frame).scene.name === ${JSON.stringify(name)});
  })()`;
  const sampledScene = (scene) => `(() => {
    const player = window.__runtime?.currentPlayer;
    return player?.lastInputSampleScene === ${scene} && performance.now() - player.lastInputSampleAt < 500;
  })()`;
  const ptrReady = (expr, sceneExpr = currentScene) => `(${expr}?.inputSampled === true || (${expr}?.lastInputSampleAt >= 0 && ${expr}?.lastInputSampleScene === ${sceneExpr} && performance.now() - ${expr}.lastInputSampleAt < 500))`;
  const waitForActiveScene = (name, timeout, group) => {
    const groups = 'window.__runtime?.currentPlayer?.activeGroups';
    const scene = JSON.stringify(name);
    const active = MODE === 'extras'
      ? `([...(${groups} ?? [])].some((id) => window.__audit.galleryGroups.get(id) === ${scene}) ||
          (${USES_POINTER_MENUS} && ${ptrReady('window.__runtime?.currentPlayer', scene)}))`
      : group === undefined
        ? USES_POINTER_MENUS
          ? `(${groups}?.size > 0 || ${ptrReady('window.__runtime?.currentPlayer', scene)})`
          : `${groups}?.size > 0`
        : `${groups}?.has(${Number(group)})`;
    const sceneMatches = group === undefined || MODE === 'extras'
      ? `(${currentScene} === ${scene} || (${USES_POINTER_MENUS} && ${sampledScene(scene)}))`
      : inVmScene(name);
    return waitFor(`${sceneMatches} && ${active}`, timeout);
  };

  const openQuickMenu = async () => {
    await waitForDialogue('quick-menu');
    await rightClickStage();
    if (!(await waitForActiveScene(CANCEL_SCENE, 6000)))
      throw new Error(`[quick-menu] ${CANCEL_SCENE} did not activate`);
  };

  const assertLayoutAndHitTests = async (label, {checkHitTest = true, checkText = false, allowAutoHiddenBottomBar = false, buttonGroup} = {}) => {
    const s = await inspectState();
    const failures = [];
    if (s.nanCount > 0) failures.push(`nanCount=${s.nanCount} els=${JSON.stringify(s.nanElements)}`);
    if (s.errBanner) failures.push(`errBanner=${s.errBanner}`);
    if (s.visualIntegrityErrors?.length > 0) {
      failures.push(`visualIntegrity=${JSON.stringify(s.visualIntegrityErrors)}`);
    }
    const buttons = buttonGroup === undefined
      ? s.buttons
      : s.buttons.filter((button) => button.dataset.siglusGroup === String(buttonGroup));
    if (buttonGroup !== undefined && buttons.length === 0)
      failures.push(`No visible buttons in active group ${buttonGroup}`);
    for (const b of buttons) {
      const fullyOffStage = b.rect.top >= SCREEN_H || b.rect.bottom <= 0 || b.rect.left >= SCREEN_W || b.rect.right <= 0;
      if (fullyOffStage) continue;
      const clipRect = b.opaqueRect ?? b.rect;
      if (allowAutoHiddenBottomBar && b.dataset.siglusAction !== undefined && clipRect.top >= SCREEN_H - 2) continue;
      const expectedBottom = b.dataset.siglusAction === undefined ? SCREEN_H : mwndBottom;
      if (clipRect.left < -6 || clipRect.right > SCREEN_W + 6 || clipRect.top < -6 || clipRect.bottom > expectedBottom + 6) {
        failures.push(`Button clipped at ${SCREEN_W}x${SCREEN_H}: ${JSON.stringify({aria: b.aria, ds: b.dataset, rect: b.rect, ...(b.opaqueRect ? {opaqueRect: b.opaqueRect} : {})})}`);
      }
      if (checkHitTest && !(b.hitOk || (b.shellObscured && b.stageHitOk))) {
        failures.push(`Button failed hit-test: ${JSON.stringify({aria: b.aria, ds: b.dataset, rect: b.rect, hitTag: b.hitTag, hitGroup: b.hitGroup, hitClip: b.hitClip})}`);
      }
    }
    if (checkText) {
      const textFails = await evaluate(`(() => {
        const stage = document.getElementById('siglus-surface')?.firstElementChild;
        const sr = stage.getBoundingClientRect();
        const sx = ${SCREEN_W} / sr.width, sy = ${SCREEN_H} / sr.height;
        const toStage = (el) => {
          const r = el.getBoundingClientRect();
          return {left: Math.round((r.left - sr.left) * sx), top: Math.round((r.top - sr.top) * sy), right: Math.round((r.right - sr.left) * sx), bottom: Math.round((r.bottom - sr.top) * sy)};
        };
        const fails = [];
        const isNative = ${JSON.stringify(TEXT_MODE)} === 'native';
        const spEl = stage.querySelector('[data-siglus-speaker]');
        const dlgEl = stage.querySelector('[data-siglus-dialogue]');
        if (!isNative) {
          if (spEl?.textContent?.trim()) {
            const r = toStage(spEl);
            if (r.left < 0 || r.right > ${SCREEN_W} || r.top < 0 || r.bottom > ${SCREEN_H}) fails.push('speaker OOB ' + JSON.stringify(r));
          }
          if (dlgEl?.textContent?.trim()) {
            const r = toStage(dlgEl);
            if (r.left < 0 || r.right > ${SCREEN_W} || r.top < 0 || r.bottom > ${SCREEN_H}) fails.push('dialogue OOB ' + JSON.stringify(r));
          }
        } else {
          const cvs = window.__runtime?.currentPlayer?.display?.nativeText;
          if (!cvs || cvs.width <= 0 || cvs.height <= 0) fails.push('nativeText canvas missing');
          else {
            const img = cvs.getContext('2d')?.getImageData(0, 0, cvs.width, cvs.height)?.data;
            let count = 0;
            if (img) for (let i = 3; i < img.length; i += 16) if (img[i] > 20) count++;
            if (count < 20) fails.push('nativeText pixel count too low: ' + count);
          }
        }
        return fails;
      })()`);
      failures.push(...textFails);
    }
    for (const f of failures) errors.push(`[layout:${label}] ${f}`);
    return {state: s, failures};
  };

  const layerKeys = (s) => new Set(s.visibleLayerVisuals.map((v) => `${v.tag}:${v.key}`));
  const animatedLayerKeys = (s) =>
    new Set(s.visibleLayerVisuals.filter((v) => v.animated).map((v) => `${v.tag}:${v.key}`));

  const assertRoundTripClean = (label, before, after, {restored = false} = {}) => {
    const diffs = [];
    const previousLayers = layerKeys(before);
    const currentLayers = layerKeys(after);
    const beforeAnimated = animatedLayerKeys(before);
    const afterAnimated = animatedLayerKeys(after);
    const missing = [...previousLayers].filter((key) => !currentLayers.has(key) && !beforeAnimated.has(key));
    const added = [...currentLayers].filter((key) => !previousLayers.has(key) && !afterAnimated.has(key));
    if (missing.length || added.length)
      diffs.push(`visible layer objects changed (missing ${missing.join(', ')}, added ${added.join(', ')})`);
    if (before.scene !== after.scene || before.line !== after.line || before.pc !== after.pc)
      diffs.push(`script position: ${before.scene}:${before.line}@${before.pc} vs ${after.scene}:${after.line}@${after.pc}`);
    if (!restored && before.pages !== after.pages) diffs.push(`advance count: ${before.pages} vs ${after.pages}`);
    if (before.dialogue !== after.dialogue) diffs.push(`dialogue mismatch`);
    if (before.messageVisible !== after.messageVisible) diffs.push(`messageVisible: ${before.messageVisible} vs ${after.messageVisible}`);
    if (before.speaker !== after.speaker) diffs.push(`speaker: "${before.speaker}" vs "${after.speaker}"`);
    if (before.bgm !== after.bgm) diffs.push(`bgm: "${before.bgm}" vs "${after.bgm}"`);
    if (!after.stageFocused) diffs.push('stage lost keyboard focus');
    if (!after.waitingForPage) diffs.push('waitingForPage false');
    if (after.excallAllocated) diffs.push('excallAllocated true');
    if (after.systemCallActive) diffs.push('systemCallActive true');
    if (after.systemLayerChildren !== 0) diffs.push(`systemLayer not empty (${after.systemLayerChildren})`);
    if (after.layersInert || after.messageInert || after.controlsInert) diffs.push('stuck inert');
    if (after.deadGroups.length > 0) diffs.push(`deadGroups=${JSON.stringify(after.deadGroups)}`);
    if (after.skipping || after.autoMode) diffs.push('skip/auto not cancelled');
    if (after.nanCount > 0) diffs.push(`nanCount=${after.nanCount}`);
    for (const d of diffs) errors.push(`[roundtrip:${label}] ${d}`);
    return diffs;
  };

  const readyForDialogue = `(() => {
    const p = window.__runtime?.currentPlayer;
    return p?.waitingForPage && p.savePoint && !p.systemCallActive;
  })()`;
  const readyForModalCancel = `(() => {
    const p = window.__runtime?.currentPlayer;
    if (!p?.systemCallActive) return false;
    if (${USES_POINTER_MENUS} && ${ptrReady('p')}) return true;
    return [...p.cancelGroups].some((group) =>
      group >= 100000 && p.activeGroups.has(group) &&
      p.display.stage.querySelector('[data-siglus-group="' + group + '"]'));
  })()`;
  const canCloseModal = `(() => {
    const p = window.__runtime?.currentPlayer;
    if (!p?.systemCallActive) return false;
    if (${USES_POINTER_MENUS} && ${ptrReady('p')}) return true;
    return [...p.cancelGroups].some((group) =>
      group >= 100000 && p.activeGroups.has(group));
  })()`;

  const waitForModalCancel = async (label) => {
    if (!(await waitFor(readyForModalCancel, 10000))) {
      const {scene, line, activeGroups, cancelGroups} = await inspectState();
      throw new Error(`[${label}] No ready cancel group at ${scene}:${line} (active=${activeGroups}, cancel=${cancelGroups})`);
    }
  };

  const waitForDialogue = async (label) => {
    if (!(await waitFor(readyForDialogue, 10000))) {
      const {scene, line, waitingForPage, systemCallActive, activeGroups, cancelGroups} = await inspectState();
      throw new Error(`[${label}] No dialogue checkpoint at ${scene}:${line} (wait=${waitingForPage}, modal=${systemCallActive}, active=${activeGroups}, cancel=${cancelGroups})`);
    }
    return inspectState();
  };

  const closeSystemMenu = async (label, useCloseButton = true) => {
    for (let remaining = 6; remaining > 0; remaining--) {
      if (!(await waitFor(`${readyForDialogue} || ${readyForModalCancel} || ${canCloseModal}`, 8000))) break;
      const before = await inspectState();
      if (!before.systemCallActive) return before;
      const closeId = profileCfg.quickMenu?.closeButton ?? profileCfg.quickMenu?.closeButtonId;
      const close = useCloseButton && before.scene === CANCEL_SCENE && closeId !== undefined
        ? quickButton(before, closeId)
        : undefined;
      if (close) await clickAt(close.rect.cx, close.rect.cy);
      else await rightClickStage();
      if (process.env.TRACE_MODAL) {
        const input = await evaluate(`(() => {
          const p = window.__runtime.currentPlayer;
          return {
            ready: Boolean(p.decisionReady), decisions: [...p.decisions], dirty: p.systemObjectsDirty,
            input: window.__audit.pointer.slice(-8), group: window.__audit.galleryDecisions.slice(-5),
          };
        })()`);
        console.log('Modal close:', JSON.stringify({label, scene: before.scene, line: before.line, active: before.activeGroups, controls: before.buttons.length, click: Boolean(close), ...input}));
      }
      await waitFor(`${readyForDialogue} || ${currentScene} !== ${JSON.stringify(before.scene)}`, 5000);
      if (await evaluate('Boolean(window.__runtime?.currentPlayer?.systemCallActive)')) await delay(250);
    }
    return waitForDialogue(label);
  };

  const clickControl = async (label, spec) => {
    let state = await inspectState();
    if (spec.frameId !== undefined && profileCfg.gameplay?.mwndAutoHideBar) {
      const {left, top, width, height} = state.stageRect;
      await moveMouse(Math.round(left + width * 0.5), Math.round(top + height * 0.97));
      await delay(400);
      state = await inspectState();
    }
    const control = matchControl(state, spec, true);
    if (!control) {
      const available = spec.objectName !== undefined
        ? [...new Set((state.sprites ?? []).map((sp) => `${sp.objectName}@${sp.rect.left},${sp.rect.top}(${sp.hitOk})`))]
        : state.buttons.map(({aria, dataset, hitOk}) => ({aria, ...dataset, hitOk}));
      throw new Error(`[${label}] No clickable control in ${state.scene} matching ${JSON.stringify(spec)}; available=${JSON.stringify(available)}`);
    }
    await clickAt(control.rect.cx, control.rect.cy);
  };

  const dialogOpenExpr = (dialog) => {
    if (!dialog) return 'false';
    if (dialog.objectName) {
      const target = JSON.stringify(dialog.objectName.toLowerCase());
      return `(() => {
        const stage = document.getElementById('siglus-surface')?.firstElementChild;
        if (!stage) return false;
        for (const el of stage.querySelectorAll('[data-siglus-object]')) {
          if ((el.dataset.siglusObject ?? '').toLowerCase() !== ${target}) continue;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (el.hidden || el.inert || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05 || r.width <= 0 || r.height <= 0) continue;
          let hidden = false;
          let cur = el.parentElement;
          while (cur && cur !== stage) {
            const pcs = getComputedStyle(cur);
            if (cur.hidden || cur.inert || pcs.display === 'none' || pcs.visibility === 'hidden' || Number(pcs.opacity) <= 0.05) { hidden = true; break; }
            cur = cur.parentElement;
          }
          if (!hidden) return true;
        }
        return false;
      })()`;
    }
    return dialog.scene ? `${currentScene} === ${JSON.stringify(dialog.scene)}` : 'false';
  };

  const confirm = async (dialog, label, accept) => {
    if (dialog.objectName) {
      if (!(await waitFor(dialogOpenExpr(dialog), 8000))) {
        const state = await inspectState();
        throw new Error(`[${label}] Expected confirmation object ${dialog.objectName} (scene=${state.scene}, groups=${state.activeGroups.join(',')})`);
      }
    } else if (!(await waitForActiveScene(dialog.scene, 8000, dialog.group))) {
      const state = await inspectState();
      throw new Error(`[${label}] Expected confirmation scene ${dialog.scene} (scene=${state.scene}, groups=${state.activeGroups.join(',')})`);
    }
    await delay(300);
    await assertLayoutAndHitTests(`${label}-confirmation`, dialog.group ? {buttonGroup: dialog.group} : {});
    const targetSpec = accept ? dialog.yesButton : dialog.noButton;
    if (targetSpec) {
      await clickControl(label, targetSpec);
      return;
    }
    const aria = accept ? dialog.yesAria : dialog.noAria;
    await clickControl(label, {group: dialog.group, ...(aria ? {aria} : {id: accept ? 1 : 2})});
  };

  const effectOffset = () => evaluate('window.__audit.effects.length');
  const assertSystemSound = async (label, offset, id) => {
    const name = gameexe.get(`SE.${String(id).padStart(3, '0')}`)?.split('"')[1];
    if (!name || !(await waitFor(`window.__audit.effects.slice(${offset}).includes(${JSON.stringify(name)})`, 3500)))
      errors.push(`[${label}] Expected decoded playback of SE.${String(id).padStart(3, '0')} (${name ?? 'unconfigured'})`);
  };

  const advanceDialogue = async (label, before) => {
    const {left, top, width, height} = before.stageRect;
    await clickAt(Math.round(left + width * 0.5), Math.round(top + height * 0.35));
    if (!(await waitFor(`${readyForDialogue} && window.__audit.pageWaits > ${before.pageWaits}`, 8000)))
      throw new Error(`[${label}] Single click did not produce a new dialogue checkpoint`);
    await waitFor(`(() => {
      const m = window.__runtime?.currentPlayer?.display?.message;
      return !m || m.hidden || Number(getComputedStyle(m).opacity) > 0.05;
    })()`, 1000);
    const after = await inspectState();
    if (after.pageWaits !== before.pageWaits + 1)
      errors.push(`[${label}] Single click passed ${after.pageWaits - before.pageWaits} input waits`);
    return after;
  };

  const testQuickSaveLoad = async (menu, label) => {
    const complete = async (action) => {
      const scene = JSON.stringify(menu.confirmDialog.scene);
      const idleOrConfirm = `${readyForDialogue} || ${currentScene} === ${scene}`;
      if (!(await waitFor(idleOrConfirm, 10000))) {
        const {scene, line, pc, waitingForPage, systemCallActive, activeGroups} = await inspectState();
        throw new Error(`[${action}] Quick action did not settle at ${scene}:${line}@${pc} (wait=${waitingForPage}, modal=${systemCallActive}, groups=${activeGroups})`);
      }
      if ((await inspectState()).scene === menu.confirmDialog.scene)
        await confirm(menu.confirmDialog, action, true);
      return waitForDialogue(action);
    };
    const before = await waitForDialogue(label);
    const saveSound = await effectOffset();
    await clickControl(`${label}-save`, menu.quickSave);
    await complete(`${label}-save`);
    await assertSystemSound(`${label}-save`, saveSound, 4);
    await advanceDialogue(label, before);
    const loadSound = await effectOffset();
    await clickControl(`${label}-load`, menu.quickLoad);
    const after = await complete(`${label}-load`);
    console.log(`${label} parity diffs:`, assertRoundTripClean(label, before, after, {restored: true}));
    await assertSystemSound(`${label}-load`, loadSound, 5);
  };

  const checkUnhandled = (state, label) => {
    const allowedCmds = new Set(profileCfg.allowedUnhandledCommands ?? []);
    const allowedProps = new Set(profileCfg.allowedUnhandledProperties ?? []);
    for (const [k, info] of state.unhandledCommands) {
      if (!allowedCmds.has(k)) errors.push(`[unhandled-cmd:${label}] ${k} (${info.count}x @ ${info.scene}:${info.line})`);
    }
    for (const [k, info] of state.unhandledProperties) {
      if (!allowedProps.has(k)) errors.push(`[unhandled-prop:${label}] ${k} (${info.count}x @ ${info.scene}:${info.line})`);
    }
  };

  const waitUntilTitle = async () => {
    const dlgCfg = profileCfg.title?.dismissDialog;
    let dismissed = false;
    let ctrlHeld = false;
    const setCtrl = async (down) => {
      if (down === ctrlHeld) return;
      ctrlHeld = down;
      await send('Input.dispatchKeyEvent', {type: down ? 'keyDown' : 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17});
    };
    const maxPolls = Math.ceil((profileCfg.title?.startupTimeoutMs ?? 81_000) / 180);
    for (let i = 0; i < maxPolls; i++) {
      await delay(180);
      const s = await inspectState();
      if (errors.length || s.errBanner) break;
      if (s.movieActive) {
        await setCtrl(false);
        if (i % 4 === 0) await pressKey('Enter', 'Enter', 13);
        continue;
      }
      if (dlgCfg && s.scene === dlgCfg.scene && !dismissed) {
        await setCtrl(false);
        const okBtn = s.buttons.find((b) => b.dataset.siglusButton === String(dlgCfg.confirmButtonId));
        if (okBtn) {
          await clickAt(okBtn.rect.cx, okBtn.rect.cy);
          dismissed = true;
          continue;
        }
      }
      if (s.scene === MENU_SCENE) {
        const startBtn = matchControl(s, profileCfg.title?.startButton);
        const readyLine = profileCfg.title?.readyLine;
        const ready = (readyLine === undefined || s.line === readyLine) &&
          (!USES_POINTER_MENUS || s.inputSampled) && (!profileCfg.title?.startButton?.group || s.activeGroups.length > 0);
        if (startBtn && startBtn.hitOk && ready) {
          await setCtrl(false);
          await delay(350);
          return await inspectState();
        }
      }
      const choice = profileCfg.title?.prologueChoices?.find((entry) =>
        entry.scene === s.scene && entry.line === s.line);
      if (choice) {
        const button = s.buttons.find((item) =>
          item.hitOk && item.dataset.siglusChoice === String(choice.index));
        if (button) {
          await setCtrl(false);
          await clickAt(button.rect.cx, button.rect.cy);
          continue;
        }
      }
      if (profileCfg.title?.skipPrologue && s.pages > 0) {
        await setCtrl(true);
        if (i % 10 === 0) {
          await setCtrl(false);
          await pressKey('Enter', 'Enter', 13);
        }
      } else if (s.scene !== MENU_SCENE && i > 3 && i % 4 === 0) {
        await pressKey('Enter', 'Enter', 13);
      }
    }
    await setCtrl(false);
    return await inspectState();
  };

  const startNewGameFromTitle = async (titleState) => {
    if (replay?.startButton) {
      await clickControl('replay-start', replay.startButton);
      return true;
    }
    const startBtn = matchControl(titleState, profileCfg.title?.startButton);
    if (!startBtn) {
      errors.push(`[title] Could not find startButton ${JSON.stringify(profileCfg.title?.startButton)}`);
      return false;
    }
    await clickAt(startBtn.rect.cx, startBtn.rect.cy);
    if (profileCfg.title?.routeSubmenu) {
      const sub = profileCfg.title.routeSubmenu;
      const ok = await waitFor(
        `Boolean([...document.querySelectorAll('#siglus-surface button')].find(b => b.dataset.siglusGroup === ${JSON.stringify(String(sub.group))} && b.dataset.siglusButton === ${JSON.stringify(String(sub.id))}))`,
        15000,
      );
      if (!ok) {
        errors.push(`[title] Route submenu button ${JSON.stringify(sub)} never appeared`);
        return false;
      }
      await delay(400);
      const subState = await inspectState();
      const routeBtn = matchControl(subState, sub);
      if (!routeBtn) {
        errors.push(`[title] Route submenu button not visible/clickable`);
        return false;
      }
      await clickAt(routeBtn.rect.cx, routeBtn.rect.cy);
    }
    for (const prompt of replay?.prompts ?? profileCfg.title?.newGamePrompts ?? []) {
      let button;
      let state;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        state = await inspectState();
        if (errors.length || state.errBanner) return false;
        if (state.scene === prompt.scene) {
          if (prompt.advancePage && state.waitingForPage) break;
          button = prompt.button
            ? matchControl(state, prompt.button)
            : state.buttons.find((item) => item.dataset.siglusChoice === String(prompt.choice));
          if (button?.hitOk) break;
        }
        await delay(100);
      }
      if (prompt.advancePage && state?.scene === prompt.scene && state.waitingForPage) {
        await pressKey('Enter', 'Enter', 13);
        await waitFor(
          `window.__audit.pageWaits !== ${state.pageWaits} || ${currentScene} !== ${JSON.stringify(prompt.scene)} || !window.__runtime?.currentPlayer?.waitingForPage`,
          5000,
        );
        await delay(120);
      } else if (button?.hitOk) {
        if (prompt.editValues) {
          const selector = '#siglus-surface input[type="text"]';
          if (!(await waitFor(`document.querySelectorAll(${JSON.stringify(selector)}).length === ${prompt.editValues.length}`, 8000)))
            throw new Error(`[new-game] Name inputs did not appear in ${prompt.scene}`);
          for (const [index, value] of prompt.editValues.entries()) {
            await evaluate(`(() => {
              const input = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
              input.focus();
              input.select();
            })()`);
            await send('Input.insertText', {text: value});
          }
        }
        await clickAt(button.rect.cx, button.rect.cy);
        await delay(180);
      } else {
        errors.push(`[new-game] Prompt control failed to appear: ${JSON.stringify(prompt)} at ${state?.scene}:${state?.line} (controls: ${JSON.stringify(state?.buttons.map(({aria, dataset, hitOk}) => ({aria, dataset, hitOk})))})`);
        return false;
      }
    }
    return true;
  };

  console.log(`=== SIGLUS AUDIT [${profileCfg.name}] mode=${MODE} text=${TEXT_MODE} (${SCREEN_W}x${SCREEN_H}) ===`);

  // =========================================================================
  // MODE: systems (Phase 2)
  // =========================================================================
  if (MODE === 'systems') {
    const titleState = await waitUntilTitle();
    console.log('TITLE:', {scene: titleState.scene, bgm: titleState.bgm, movies: titleState.moviesSeen.map((m) => m.name), btnCount: titleState.buttons.length});
    if (titleState.scene !== MENU_SCENE) {
      errors.push(`Never reached ${MENU_SCENE} (in ${titleState.scene}:${titleState.line}@${titleState.pc}, ${titleState.pages} pages)`);
    } else {
      await assertLayoutAndHitTests('title-menu');
      const hoverBtn = matchControl(titleState, profileCfg.title?.startButton, true);
      if (hoverBtn) {
        await moveMouse(1, 1);
        await delay(150);
        const beforeHover = await evaluate('(window.__audit.sfx ?? []).length');
        await moveMouse(hoverBtn.rect.cx, hoverBtn.rect.cy);
        await delay(1000);
        const afterHover = await evaluate(`(window.__audit.sfx ?? []).slice(${beforeHover})`);
        if (afterHover.length > 1) {
          errors.push(`[title-hover] Stationary hover over startButton fired ${afterHover.length} SFX sounds (${afterHover.map((e) => `${e.channel}:${e.resource}`).join(', ')})`);
        }
        await moveMouse(1, 1);
        await delay(150);
        const beforeRehover = await evaluate('(window.__audit.sfx ?? []).length');
        await moveMouse(hoverBtn.rect.cx, hoverBtn.rect.cy);
        await delay(300);
        const afterRehover = await evaluate(`(window.__audit.sfx ?? []).slice(${beforeRehover})`);
        if (afterHover.length === 1 && afterRehover.length !== 1) {
          errors.push(`[title-hover] Re-hover over startButton fired ${afterRehover.length} SFX sounds (expected 1)`);
        }
        console.log('Title hover SE check:', {stationary1s: afterHover.length, rehover: afterRehover.length, sounds: afterHover});
        await moveMouse(1, 1);
        await delay(100);
      }
      const bgmCheckName = profileCfg.title?.streamedBgm ?? profileCfg.title?.playedBgm;
      if (bgmCheckName) {
        const requireStream = Boolean(profileCfg.title?.streamedBgm);
        const name = JSON.stringify(bgmCheckName);
        const streaming = `(() => {
          const playback = window.__audit.bgmPlayback;
          const audio = window.__runtime.currentPlayer.audio;
          return playback?.resource === ${name} && (!${requireStream} || playback.streaming) && playback.frames > 0 &&
            audio.context.state === 'running' && audio.bgmPlayPosition() > playback.startSample;
        })()`;
        if (!(await waitFor(streaming, 8000))) errors.push(`[title] BGM ${name} did not ${requireStream ? 'stream PCM' : 'play'}`);
        else if (requireStream) {
          const telemetry = await evaluate(`(() => {
            const source = window.__runtime.currentPlayer.audio.playing.get('bgm')?.source;
            const queuedFrames = [...(source?.nodes ?? [])].reduce((sum, node) => sum + (node.buffer?.length ?? 0), 0);
            return {...window.__audit.bgmPlayback, queuedFrames};
          })()`);
          // Include the full current chunk and the final chunk crossing the five-second look-ahead.
          if (!(telemetry.queuedFrames > 0 && telemetry.queuedFrames <= telemetry.sourceRate * 8))
            errors.push(`[title] BGM stream has ${telemetry.queuedFrames} queued PCM frames`);
          console.log('Title BGM streaming:', JSON.stringify(telemetry));
        } else {
          const telemetry = await evaluate(`({
            ...window.__audit.bgmPlayback,
            pos: window.__runtime.currentPlayer.audio.bgmPlayPosition(),
          })`);
          console.log('Title BGM playback:', JSON.stringify(telemetry));
        }
      }
      if (profileCfg.title?.configButton && CONFIG_SCENE) {
        const cfgBtn = matchControl(titleState, profileCfg.title.configButton, true);
        if (cfgBtn) {
          await clickAt(cfgBtn.rect.cx, cfgBtn.rect.cy);
          const timeout = profileCfg.title.configTimeoutMs ?? 12000;
          if (!(await waitForActiveScene(CONFIG_SCENE, timeout))) {
            const {scene, line} = await inspectState();
            throw new Error(`[title-config] Expected ${CONFIG_SCENE}, reached ${scene}:${line}`);
          }
          if (profileCfg.title.configEntryScene && !(await evaluate(inVmScene(profileCfg.title.configEntryScene))))
            throw new Error(`[title-config] Expected configuration to enter via ${profileCfg.title.configEntryScene}`);
          await delay(500);
          const {state: configState} = await assertLayoutAndHitTests('title-config');
          if (process.env.TRACE_MODAL) console.log('Title config:', JSON.stringify({
            scene: configState.scene, line: configState.line,
            groups: configState.activeGroups, cancel: configState.cancelGroups,
            buttons: configState.buttons.filter((button) => button.hitOk).map(({dataset, aria}) => ({dataset, aria})),
            controls: configState.sprites.filter((item) => item.hitOk).map(({objectName}) => objectName),
          }));
          for (const tab of profileCfg.title.configTabs ?? []) {
            await clickControl(`title-config-${tab.scene}`, tab.button);
            if (!(await waitForActiveScene(tab.scene, timeout))) {
              const {scene, line} = await inspectState();
              throw new Error(`[title-config] Expected ${tab.scene}, reached ${scene}:${line}`);
            }
            await delay(400);
            await assertLayoutAndHitTests(`title-config-${tab.scene}`);
            console.log(`Title config tab: ${tab.scene}`);
          }
          const timing = profileCfg.title.messageWindowTiming;
          if (timing) {
            const defaults = Array.from({length: Number(gameexe.get('MWND.CNT') ?? 0)}, (_, index) =>
              ['open', 'close'].map((kind) => parseMwndAnimation(gameexe, index, kind).time));
            const timingsMatch = (shortened) => `(() => {
              const player = window.__runtime.currentPlayer;
              return ${JSON.stringify(defaults)}.every(([open, close], index) => {
                const opening = player.messageOpenAnimations.get(index)?.time;
                const closing = player.messageCloseAnimations.get(index)?.time;
                return ${shortened}
                  ? opening === Math.trunc(open / 2) && closing === Math.trunc(close / 2)
                  : opening === undefined && closing === undefined;
              });
            })()`;
            await clickControl('title-config-half-timing', timing.halfButton);
            if (!(await waitFor(timingsMatch(true), 8000)))
              throw new Error('[title-config] Half-duration control did not apply the configured timings');
            await clickControl('title-config-default-timing', timing.defaultButton);
            if (!(await waitFor(timingsMatch(false), 8000)))
              throw new Error('[title-config] Default-duration control did not restore the configured timings');
            console.log('Title config window animations: half durations applied and restored for all windows');
          }
          await rightClickStage();
          if (!(await waitForActiveScene(MENU_SCENE, Math.max(10000, timeout)))) {
            const {scene, line} = await inspectState();
            throw new Error(`[title-config] Right-click did not return to title (at ${scene}:${line})`);
          }
          await delay(400);
        } else {
          errors.push(`[title-config] Missing clickable Configuration control ${JSON.stringify(profileCfg.title.configButton)}`);
        }
      }
      await startNewGameFromTitle(await inspectState());
    }

    // Advance into live dialogue
    const gp = profileCfg.gameplay ?? {};
    const minPages = gp.minPages ?? 5;
    const minVisuals = gp.minVisuals ?? 1;
    let liveState = null;
    const gameplayDeadline = gp.waitTimeoutMs === undefined ? Infinity : Date.now() + gp.waitTimeoutMs;
    const gameplayPolls = gp.waitTimeoutMs === undefined ? 400 : Infinity;
    let lastState = null;
    for (let i = 0; i < gameplayPolls && Date.now() < gameplayDeadline; i++) {
      await delay(120);
      const s = await inspectState();
      lastState = s;
      if (errors.length || s.errBanner) break;
      const inStory = s.scene && s.scene !== MENU_SCENE && !s.scene.startsWith('_00') && !s.scene.startsWith('__');
      if (
        inStory &&
        s.waitingForPage &&
        s.dialogue.length > 0 &&
        (!gp.requireSpeaker || s.speaker.length > 0) &&
        (!gp.requireBgm || Boolean(s.bgm)) &&
        (!gp.voice?.waitForPlayback || Boolean(s.voicePlayback)) &&
        s.visibleLayerVisuals.length >= minVisuals &&
        s.pages >= minPages
      ) {
        await delay(300);
        liveState = await inspectState();
        break;
      }
      if (s.movieActive) await pressKey('Enter', 'Enter', 13);
      else if (s.waitingForPage || i % 3 === 0) await pressKey('Enter', 'Enter', 13);
    }

    if (!liveState) {
      errors.push(`Did not reach live gameplay dialogue (in ${lastState?.scene}:${lastState?.line}@${lastState?.pc}, ${lastState?.pages} pages)`);
    } else {
      console.log('LIVE GAMEPLAY:', {scene: liveState.scene, line: liveState.line, pages: liveState.pages, speaker: liveState.speaker, bgm: liveState.bgm, visuals: liveState.visibleLayerVisuals.length});
      await assertLayoutAndHitTests('live-mwnd', {checkHitTest: true, checkText: true, allowAutoHiddenBottomBar: Boolean(gp.mwndAutoHideBar)});

      if (gp.framing) {
        const {object, bounds, speakerAboveWindow} = gp.framing;
        const measured = (await inspectState(object)).framing;
        if (!measured || measured.visibleBounds.some((edge, i) => Math.abs(edge - bounds[i]) > 1))
          errors.push(`[framing] ${object} expected bounds ${bounds}, measured ${JSON.stringify(measured?.visibleBounds)}`);
        if (speakerAboveWindow && !measured?.speakerAboveWindow)
          errors.push('[framing] Speaker name did not draw above the message window');
        console.log('Scene framing:', JSON.stringify(measured));
      }

      if (gp.bundledFonts) {
        const fonts = await evaluate(`(() => {
          const display = window.__runtime.currentPlayer.display;
          return display.loadedFonts.map((face) => ({
            family: face.family,
            loaded: face.status === 'loaded' && document.fonts.has(face) && document.fonts.check('24px ' + face.family),
            aliases: [...display.fontNames].filter(([, family]) => family === face.family).map(([name]) => name),
          }));
        })()`);
        for (const [index, {file, name}] of gp.bundledFonts.entries()) {
          const configured = gameexe.get(`FONT_FILE.${String(index).padStart(3, '0')}.NAME`)?.split('"')[1];
          const face = fonts[index];
          if (configured !== file || face?.family !== `SiglusGame${index}` || !face.loaded || !face.aliases.includes(name.toLowerCase()))
            errors.push(`[font] ${file} (${name}) did not load as SiglusGame${index}`);
        }
        console.log('Bundled fonts:', JSON.stringify(fonts));
      }
      if (gp.voice) {
        const bank = `koe/z${String(Math.floor(gp.voice.id / 100000)).padStart(4, '0')}.ovk`;
        await waitFor('Boolean(window.__audit.voicePlayback)', 3500);
        const sample = await evaluate(`(() => {
          const audio = window.__runtime.currentPlayer.audio;
          return {bank: audio.indexes.has(${JSON.stringify(bank)}), ...window.__audit.voicePlayback};
        })()`);
        if (!(sample.bank && sample.frames > 0 && sample.rate > 0 && sample.gain > 0 && sample.rms > 0 &&
              sample.peak > 0 && sample.peak < 1 && sample.latencyMs >= 0 && sample.latencyMs <= gp.voice.maxLatencyMs))
          errors.push(`[voice] Invalid or late OVK playback ${JSON.stringify(sample)}`);
        console.log(`Story voice ${bank}:`, JSON.stringify(sample));
      }

      const sr = liveState.stageRect;
      if (gp.mwndAutoHideBar) {
        await moveMouse(Math.round(sr.left + sr.width * 0.5), Math.round(sr.top + sr.height * 0.97));
        await delay(450);
        await assertLayoutAndHitTests('live-mwnd-revealed', {checkHitTest: true, checkText: true});
        await moveMouse(Math.round(sr.left + sr.width * 0.5), Math.round(sr.top + sr.height * 0.4));
        await delay(350);
      }

      // 1. SPACE_HIDE (Space hide -> Space unhide, 0 advance)
      const beforeSpace = await inspectState();
      await pressKey(' ', 'Space', 32);
      await delay(250);
      const whileHidden = await inspectState();
      if (whileHidden.messageVisible || !whileHidden.userMessageHidden) errors.push('[space-hide] Message not hidden after Space');
      if (whileHidden.visibleLayerVisuals.length === 0) errors.push('[space-hide] Layers wiped to black');
      if (whileHidden.spaceHideTotal > 0 && whileHidden.spaceHideVisibleCount !== 0) errors.push('[space-hide] SPACE_HIDE objects still visible');
      await pressKey(' ', 'Space', 32);
      await delay(250);
      console.log('Space hide->unhide diffs:', assertRoundTripClean('space-hide', beforeSpace, await inspectState()));

      // 2. Quick Menu (CANCEL_SCENE) interactive matrix
      const qm = profileCfg.quickMenu;
      const messageMenu = profileCfg.messageMenu;
      if (CANCEL_SCENE && (qm || messageMenu)) {
        // RC -> RC
        const b1 = await inspectState();
        await rightClickStage();
        await waitForModalCancel('rc-open');
        await delay(400);
        if ((await inspectState()).visibleLayerVisuals.length === 0) errors.push('[rc-open] Main layers black');
        await assertLayoutAndHitTests('quick-menu-open');
        console.log('RC->RC diffs:', assertRoundTripClean('rc->rc', b1, await closeSystemMenu('rc-close', false)));

        // RC -> Esc
        const b2 = await inspectState();
        await rightClickStage();
        await waitForModalCancel('rc-escape-open');
        await delay(400);
        await pressKey('Escape', 'Escape', 27);
        await waitFor("window.__runtime?.currentPlayer?.systemCallActive === false", 6000);
        await delay(350);
        console.log('RC->Esc diffs:', assertRoundTripClean('rc->esc', b2, await inspectState()));

        // RC -> Close btn
        const qmCloseSpec = qm?.closeButton ?? qm?.closeButtonId;
        if (qmCloseSpec !== undefined) {
          const b3 = await inspectState();
          await openQuickMenu();
          await delay(400);
          const closeBtn = quickButton(await inspectState(), qmCloseSpec);
          if (closeBtn) await clickAt(closeBtn.rect.cx, closeBtn.rect.cy);
          else await rightClickStage();
          const closed = await waitFor("window.__runtime?.currentPlayer?.systemCallActive === false", 6000);
          if (!closed && process.env.TRACE_MODAL) console.log('Quick menu close input:', JSON.stringify({
            control: closeBtn,
            ...(await evaluate('({input: window.__audit.pointer.slice(-12), group: window.__audit.galleryDecisions.slice(-9)})')),
          }));
          await delay(350);
          console.log('RC->CloseBtn diffs:', assertRoundTripClean('rc->closebtn', b3, await inspectState()));
        }

        // Nested QM -> Save -> Cancel
        const qmSaveSpec = qm?.saveButton ?? qm?.saveButtonId;
        if (qmSaveSpec !== undefined && SAVE_SCENE) {
          const b4 = await inspectState();
          await openQuickMenu();
          await delay(400);
          const sb = quickButton(await inspectState(), qmSaveSpec);
          if (sb) {
            await clickAt(sb.rect.cx, sb.rect.cy);
            if (!(await waitForActiveScene(SAVE_SCENE, 8000, qm.slotGroup)))
              throw new Error(`[nested-save] Expected ${SAVE_SCENE}, reached ${(await inspectState()).scene}`);
            if (qm.slotButton) {
              const deadline = Date.now() + 15000;
              while (Date.now() < deadline) {
                const st = await inspectState();
                const ready =
                  st.scene === SAVE_SCENE &&
                  Boolean(matchControl(st, qm.slotButton, true)) &&
                  (!USES_POINTER_MENUS ||
                    (await evaluate(ptrReady('window.__runtime?.currentPlayer', JSON.stringify(SAVE_SCENE)))));
                if (ready) break;
                await delay(200);
              }
            }
            await delay(500);
            if ((await inspectState()).visibleLayerVisuals.length === 0) errors.push('[nested-save] Main layers black');
            await assertLayoutAndHitTests('nested-save-open');
          } else errors.push('[nested-save] Missing clickable Save control');
          console.log('Nested QM->Save->Cancel diffs:', assertRoundTripClean('nested-save-cancel', b4, await closeSystemMenu('nested-save-cancel')));
        }

        // Nested QM -> Config -> Cancel
        const qmConfigSpec = qm?.configButton ?? qm?.configButtonId;
        if (qmConfigSpec !== undefined && CONFIG_SCENE) {
          const b5 = await inspectState();
          await openQuickMenu();
          await delay(400);
          const cb = quickButton(await inspectState(), qmConfigSpec);
          if (cb) {
            await clickAt(cb.rect.cx, cb.rect.cy);
            if (!(await waitForActiveScene(CONFIG_SCENE, 8000)))
              throw new Error(`[nested-config] Expected ${CONFIG_SCENE}, reached ${(await inspectState()).scene}`);
            await delay(500);
            if ((await inspectState()).visibleLayerVisuals.length === 0) errors.push('[nested-cfg] Main layers black');
            await assertLayoutAndHitTests('nested-config-open');
          } else errors.push('[nested-config] Missing clickable Configuration control');
          console.log('Nested QM->Config->Cancel diffs:', assertRoundTripClean('nested-config-cancel', b5, await closeSystemMenu('nested-config-cancel')));
        }
      }

      // 3. Mouse wheel up -> Backlog -> Hit-test -> Close
      const beforeBl = await inspectState();
      await wheelStage(-120);
      await waitFor("Boolean(document.querySelector('[data-siglus-history]'))", 5000);
      await delay(350);
      const openBl = await inspectState();
      if (openBl.backlogOpen) {
        if (openBl.visibleLayerVisuals.length === 0) errors.push('[backlog] Main layers black');
        await assertLayoutAndHitTests('backlog-open');
        await pressKey('Escape', 'Escape', 27);
        await waitFor("!document.querySelector('[data-siglus-history]')", 5000);
        await delay(300);
        console.log('Wheel->Backlog->Close diffs:', assertRoundTripClean('wheel-backlog-close', beforeBl, await inspectState()));
      } else errors.push('[backlog] Mouse wheel did not open the backlog');

      // 4. Verify 1 single left-click advances cleanly
      const before1 = await inspectState();
      const after1 = await advanceDialogue('one-click', before1);
      console.log('Single left-click input waits:', before1.pageWaits, '->', after1.pageWaits);

      if (gp.backlogJump) {
        const [scene, rawEntry] = gameexe.get('MSGBK.LOAD_CALL')?.split(',') ?? [];
        const callback = [scene?.split('"')[1], rawEntry?.split('"')[1] ?? Number(rawEntry ?? 0)];
        if (!callback[0]) throw new Error('[backlog-jump] Missing MSGBK.LOAD_CALL');
        await wheelStage(-120);
        if (!(await waitFor("Boolean(document.querySelector('[data-siglus-history]'))", 5000)))
          throw new Error('[backlog-jump] Could not open history');
        const target = await evaluate(`(() => {
          const p = window.__runtime.currentPlayer;
          const expected = ${JSON.stringify({scene: before1.scene, line: before1.line, pc: before1.pc})};
          const index = p.backlog.findIndex((entry) => {
            const frame = p.historyPoints.get(entry)?.vm.frames.at(-1);
            return frame?.scene === expected.scene && frame.line === expected.line && frame.pc === expected.pc;
          });
          const row = document.querySelectorAll('[data-siglus-history-entry]')[index];
          const button = row?.querySelector('button[aria-label="Resume from this message"]');
          if (!button) return null;
          button.scrollIntoView({block: 'center'});
          const rect = button.getBoundingClientRect();
          const x = Math.round(rect.left + rect.width / 2);
          const y = Math.round(rect.top + rect.height / 2);
          return {x, y, hit: button.contains(document.elementFromPoint(x, y)),
            scrollX: p.display.stage.scrollLeft, scrollY: p.display.stage.scrollTop};
        })()`);
        if (target?.scrollX || target?.scrollY)
          errors.push(`[backlog-jump] History scroll moved the game viewport by ${target.scrollX},${target.scrollY}`);
        if (!target?.hit) throw new Error('[backlog-jump] Earlier checkpoint button could not receive input');
        const loadSound = await effectOffset();
        await clickAt(target.x, target.y);
        const called = `window.__audit.historyCalls?.some(([scene, entry]) => scene === ${JSON.stringify(callback[0])} && entry === ${JSON.stringify(callback[1])})`;
        if (gp.backlogJump.confirmDialog) {
          if (await waitFor(dialogOpenExpr(gp.backlogJump.confirmDialog), 4000)) {
            await confirm(gp.backlogJump.confirmDialog, 'backlog-jump', true);
          }
        }
        if (!(await waitFor(`${called} && ${readyForDialogue} && window.__audit.pageWaits > ${after1.pageWaits}`, 10000)))
          throw new Error('[backlog-jump] Configured callback did not restore a dialogue checkpoint');
        const restored = await inspectState();
        console.log('Backlog jump parity diffs:', assertRoundTripClean('backlog-jump', before1, restored, {restored: true}));
        if (gp.backlogJump.sound) await assertSystemSound('backlog-jump', loadSound, 5);
        const advanced = await advanceDialogue('after-backlog-jump', restored);
        assertRoundTripClean('after-backlog-jump', after1, advanced, {restored: true});
      }

      // 5. Save/Load + QSave/QLoad parity (via Quick Menu UI or MWND action buttons)
      const snapFull = () =>
        evaluate(`(() => ({
          debug: window.__siglusDebug.snapshot(),
          dialogue: document.querySelector('[data-siglus-dialogue]')?.textContent?.trim() ?? '',
          speaker: document.querySelector('[data-siglus-speaker]')?.textContent?.trim() ?? '',
        }))()`);

      if (messageMenu) {
        const open = async (action, scene) => {
          await clickControl(action, messageMenu[action]);
          if (!(await waitForActiveScene(scene, 8000)))
            throw new Error(`[${action}] Expected active scene ${scene}, reached ${(await inspectState()).scene}`);
          await delay(450);
          await assertLayoutAndHitTests(action);
          if ((await inspectState()).visibleLayerVisuals.length === 0)
            errors.push(`[${action}] Main layers black`);
        };
        const before = await waitForDialogue('save-load');
        await open('config', CONFIG_SCENE);
        console.log('Message controls -> Config -> Cancel diffs:',
          assertRoundTripClean('mwnd-config-cancel', before, await closeSystemMenu('config')));

        await open('save', SAVE_SCENE);
        const slot = (await inspectState()).buttons.find((button) => {
          const id = Number(button.dataset.siglusButton);
          return button.hitOk && id >= messageMenu.slotButtonMin && id <= messageMenu.slotButtonMax;
        });
        if (!slot) throw new Error('[save-load] No clickable save slot');
        const slotSpec = {group: slot.dataset.siglusGroup, id: slot.dataset.siglusButton};
        const saveSound = await effectOffset();
        await clickControl('save-slot', slotSpec);
        await assertSystemSound('save', saveSound, 4);
        await closeSystemMenu('save');

        const beforeOverwrite = await waitForDialogue('save-cancel');
        await open('save', SAVE_SCENE);
        await clickControl('save-overwrite', slotSpec);
        await confirm(messageMenu.confirmDialog, 'save-overwrite', false);
        console.log('Message controls -> Save -> Confirm -> Cancel diffs:',
          assertRoundTripClean('save-confirm-cancel', beforeOverwrite, await closeSystemMenu('save-cancel')));

        await advanceDialogue('save-load', before);
        await open('load', LOAD_SCENE);
        const loadSound = await effectOffset();
        await clickControl('load-slot', slotSpec);
        await confirm(messageMenu.confirmDialog, 'load-slot', true);
        console.log('Save/Load UI parity diffs:', assertRoundTripClean('save-load', before, await waitForDialogue('load'), {restored: true}));
        await assertSystemSound('load', loadSound, 5);
        await testQuickSaveLoad(messageMenu, 'quick-save-load');
      } else if ((qm?.saveButton ?? qm?.saveButtonId) !== undefined && (qm?.loadButton ?? qm?.loadButtonId) !== undefined && SAVE_SCENE && LOAD_SCENE) {
        const preSave = await waitForDialogue('save-load');
        const saveDialog = qm.saveConfirmDialog ?? qm.confirmDialog;
        const loadDialog = qm.loadConfirmDialog ?? qm.confirmDialog;
        const saveDialogOpen = dialogOpenExpr(saveDialog);
        const loadDialogOpen = dialogOpenExpr(loadDialog);
        await openQuickMenu();
        await delay(350);
        const sb = quickButton(await inspectState(), qm.saveButton ?? qm.saveButtonId);
        if (!sb) throw new Error('[save-load] Missing clickable Save control');
        const waitForSlotControl = async (sceneName, spec) => {
          const deadline = Date.now() + 15000;
          let st = await inspectState();
          while (Date.now() < deadline) {
            st = await inspectState();
            const found = spec
              ? matchControl(st, spec, true)
              : st.buttons.find((b) => {
                  const id = Number(b.dataset.siglusButton);
                  return b.hitOk && Number.isInteger(id) && id >= (qm.slotButtonMin ?? 0) && id <= (qm.slotButtonMax ?? 15);
                });
            const ready =
              Boolean(found) &&
              (!USES_POINTER_MENUS ||
                (st.scene === sceneName &&
                  (await evaluate(ptrReady('window.__runtime?.currentPlayer', JSON.stringify(sceneName))))));
            if (ready) return {state: st, control: found};
            await delay(200);
          }
          return {state: st, control: undefined};
        };
        await clickAt(sb.rect.cx, sb.rect.cy);
        if (!(await waitForActiveScene(SAVE_SCENE, 8000, qm.slotGroup)))
          throw new Error(`[save-load] Expected ${SAVE_SCENE}, reached ${(await inspectState()).scene}`);
        await delay(500);
        const {control: sv0} = await waitForSlotControl(SAVE_SCENE, qm.slotButton);
        if (sv0) {
          const stored = 'window.__runtime.currentPlayer.saves.size > 0';
          await clickAt(sv0.rect.cx, sv0.rect.cy);
          if (!(await waitFor(`${stored} || ${saveDialogOpen}`, 10000))) {
            const st = await inspectState();
            const hit = await evaluate(`(() => {
              const el = document.elementFromPoint(${sv0.rect.cx}, ${sv0.rect.cy});
              const b = el?.closest('button');
              return {tag: el?.tagName, obj: el?.dataset?.siglusObject, btn: b?.dataset?.siglusButton, grp: b?.dataset?.siglusGroup, dis: b?.disabled, inert: b?.inert};
            })()`);
            throw new Error(`[save-load] Save slot did not write a checkpoint (sv0=${JSON.stringify(sv0)}, hit=${JSON.stringify(hit)}, at=${st.scene}:${st.line}, groups=${st.activeGroups}, btns=${st.buttons.slice(0, 8).map(b => b.dataset.siglusObject + ':' + b.dataset.siglusButton).join(',')})`);
          }
          if (await evaluate(saveDialogOpen)) await confirm(saveDialog, 'save-slot', true);
          if (!(await waitFor(stored, 10000))) throw new Error('[save-load] Save confirmation did not write a checkpoint');
          await closeSystemMenu('save-return');
          await advanceDialogue('save-load', preSave);
          await openQuickMenu();
          await delay(350);
          const lb = quickButton(await inspectState(), qm.loadButton ?? qm.loadButtonId);
          if (!lb) throw new Error('[save-load] Missing clickable Load control');
          await clickAt(lb.rect.cx, lb.rect.cy);
          if (!(await waitForActiveScene(LOAD_SCENE, 8000, qm.slotGroup)))
            throw new Error(`[save-load] Expected ${LOAD_SCENE}, reached ${(await inspectState()).scene}`);
          await delay(500);
          const loadSlotSpec = qm.loadSlotButton ?? qm.slotButton;
          const {state: loadState, control: matchedLd0} = await waitForSlotControl(LOAD_SCENE, loadSlotSpec);
          const ld0 = loadSlotSpec
            ? matchedLd0
            : loadState.buttons.find((b) => b.hitOk && b.dataset.siglusButton === sv0.dataset.siglusButton);
          if (!ld0) throw new Error('[save-load] Saved slot cannot be loaded');
          const loaded = `window.__runtime.currentPlayer.root.dataset.loaded === 'true' && ${readyForDialogue}`;
          await clickAt(ld0.rect.cx, ld0.rect.cy);
          if (!(await waitFor(`(${loaded}) || ${loadDialogOpen}`, 10000)))
            throw new Error('[save-load] Load slot did not start restoring the checkpoint');
          if (await evaluate(loadDialogOpen)) await confirm(loadDialog, 'load-slot', true);
          if (!(await waitFor(loaded, 10000))) throw new Error('[save-load] No restored checkpoint after Load');
          console.log('Save/Load UI parity diffs:', assertRoundTripClean('save-load', preSave, await inspectState(), {restored: true}));
        } else errors.push('[save-load] No clickable save slots');
      } else {
        // Fallback for games using MWND qsave/qload buttons (e.g., FORTUNE×WORLD)
        // Advance once to ensure we're on a clean page boundary with a fresh savePoint
        await pressKey('Enter', 'Enter', 13);
        await delay(400);
        await waitFor("window.__runtime?.currentPlayer?.waitingForPage === true", 8000);
        const preQ = await snapFull();
        const didQSave = await evaluate(`(() => {
          const btn = document.querySelector('#siglus-surface button[data-siglus-action="qsave"]');
          if (!btn || btn.disabled) return false;
          btn.click();
          return true;
        })()`);
        if (didQSave) {
          await delay(500);
          for (let k = 0; k < 5; k++) {
            await pressKey('Enter', 'Enter', 13);
            await delay(250);
          }
          await evaluate(`document.querySelector('#siglus-surface button[data-siglus-action="qload"]')?.click()`);
          await waitFor(
            `(document.querySelector('[data-siglus-dialogue]')?.textContent?.trim() ?? '') === ${JSON.stringify(preQ.dialogue)} && window.__runtime?.currentPlayer?.waitingForPage === true`,
            10000,
          );
          await delay(300);
          const postQ = await snapFull();
          const diffs = [];
          if (preQ.dialogue !== postQ.dialogue) diffs.push('dialogue');
          if (preQ.speaker !== postQ.speaker) diffs.push('speaker');
          if (preQ.debug.bgm !== postQ.debug.bgm) diffs.push('bgm');
          console.log('MWND QSave/QLoad parity diffs:', diffs);
          for (const d of diffs) errors.push(`[qsave-qload] ${d} mismatch`);
        }
      }

      // 6. Live WMV & OMV playback checks
      const wmvList = profileCfg.movies?.wmv ?? [];
      const omvList = profileCfg.movies?.omv ?? [];
      const movieResults = [];
      for (const name of wmvList) {
        const progress = await evaluate(`(async () => {
          const p = window.__runtime.currentPlayer;
          const movies = p.movies;
          try {
            if (!(await movies.play({path: ${JSON.stringify(name)}, attenuation: 0, renderer: 0})))
              throw new Error('Missing movie');
            const deadline = performance.now() + 8000;
            let progress;
            while (performance.now() < deadline) {
              if (p.movieError) throw p.movieError;
              progress = movies.progress;
              if (progress?.frames >= 3 && progress.position > 0) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (!progress || progress.frames < 3 || progress.position <= 0)
              throw new Error('Movie clock or frame presentation did not advance');
            return {frames: progress.frames, position: progress.position};
          } finally {
            movies.close();
          }
        })()`).catch((error) => ({error: error.message}));
        movieResults.push({name, kind: 'wmv', ...progress});
      }
      for (const name of omvList) {
        const progress = await evaluate(`(async () => {
          const display = window.__runtime.currentPlayer.display;
          const slot = 0x7fffffff;
          await display.stageMovieEffect({slot, name: ${JSON.stringify(name)}, layer: 0, loop: false, scale: [1000, 1000], elapsed: 0});
          const effect = display.pendingEffects.get(slot);
          if (!effect?.movie || !effect.layer) throw new Error('Missing staged OMV');
          try {
            const canvas = effect.layer.querySelector('canvas');
            if (!canvas || canvas.width <= 0 || canvas.height <= 0)
              throw new Error('Invalid OMV dimensions');
            display.stage.append(effect.layer);
            const deadline = performance.now() + 5000;
            while (performance.now() < deadline && !(effect.movie.presentedFrame > 0)) {
              if (effect.movie.error) throw effect.movie.error;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const frame = effect.movie.presentedFrame;
            if (!(frame > 0)) throw new Error('OMV frame presentation did not advance');
            return {width: canvas.width, height: canvas.height, frame};
          } finally {
            effect.movie.close();
            effect.layer.remove();
            display.pendingEffects.delete(slot);
          }
        })()`).catch((error) => ({error: error.message}));
        movieResults.push({name, kind: 'omv', ...progress});
      }
      if (movieResults.length) console.log('Movie/OMV telemetry:', JSON.stringify(movieResults));
      for (const result of movieResults)
        if (result.error) errors.push(`[movie:${result.name}] ${result.error}`);

      if (profileCfg.autoModeDialog) {
        const beforeAutoMode = await waitForDialogue('auto-mode');
        const dialog = await evaluate(`(async () => {
          const player = window.__runtime.currentPlayer;
          const selector = '[data-siglus-configuration="auto-mode"]';
          const controls = (id) => document.querySelector(selector + ' [data-siglus-control="' + id + '"]');
          const elapsed = player.command({path: [63, 140], args: [], named: []});
          try {
            const until = performance.now() + 6000;
            while (!document.querySelector(selector)?.open && performance.now() < until)
              await new Promise((resolve) => setTimeout(resolve, 50));
            const character = controls(1177), minimum = controls(1176), sample = controls(1207);
            if (!character || !minimum || !sample) throw new Error('Auto Mode controls missing');
            character.value = '80';
            character.dispatchEvent(new Event('input', {bubbles: true}));
            minimum.value = '2500';
            minimum.dispatchEvent(new Event('input', {bubbles: true}));
            if (player.playback.autoCharacterWait !== 80 || player.playback.autoMinimumWait !== 2500 || Number.parseFloat(sample.value) !== 3.3)
              throw new Error('Auto Mode wait settings did not update');
            controls(1003).click();
            if (player.playback.autoCharacterWait !== player.playbackDefaults.autoCharacterWait ||
                player.playback.autoMinimumWait !== player.playbackDefaults.autoMinimumWait)
              throw new Error('Auto Mode defaults did not restore');
            controls(1002).click();
            await elapsed;
            return 'changed, reset and closed';
          } finally {
            document.querySelector(selector)?.close();
          }
        })()`);
        console.log('Native Auto Mode dialog:', dialog);
        assertRoundTripClean('auto-mode-dialog', beforeAutoMode, await waitForDialogue('auto-mode'));
      }
      checkUnhandled(await inspectState(), 'systems-end');
    }
  }

  // =========================================================================
  // MODE: extras (Phase 2B)
  // =========================================================================
  if (MODE === 'extras') {
    let titleState = await waitUntilTitle();
    const ex = profileCfg.extras;
    let extraBtn = matchControl(titleState, profileCfg.title?.extraButton, true);
    const extraDeadline = Date.now() + 15000;
    while (!extraBtn && !errors.length && Date.now() < extraDeadline) {
      await delay(250);
      titleState = await inspectState();
      extraBtn = matchControl(titleState, profileCfg.title?.extraButton, true);
    }
    await assertLayoutAndHitTests('extras-title');
    if (!extraBtn) {
      const controls = titleState.sprites.map(({objectName, hitOk}) => [objectName, hitOk]);
      errors.push(`[extras] Extra button is unreachable at ${titleState.scene}:${titleState.line}; controls=${JSON.stringify(controls)}`);
    } else {
      await clickAt(extraBtn.rect.cx, extraBtn.rect.cy);
      if (ex?.expectedScene) {
        if (!(await waitForActiveScene(ex.expectedScene, 12000)))
          throw new Error(`[extras] Expected ${ex.expectedScene}, reached ${(await inspectState()).scene}`);
      }
      if (ex?.entryScene && !(await evaluate(inVmScene(ex.entryScene))))
        throw new Error(`[extras] Expected gallery to enter via ${ex.entryScene}`);
      const tabToSpec = (item) =>
        item
          ? {
              ...(item.group !== undefined ? {group: item.group} : {}),
              ...(item.buttonId !== undefined ? {id: item.buttonId} : {}),
              ...(item.id !== undefined ? {id: item.id} : {}),
              ...(item.objectName !== undefined ? {objectName: item.objectName} : {}),
            }
          : undefined;
      const readySpec = tabToSpec(ex?.tabs?.[0]) ?? tabToSpec(ex?.exitButton);
      {
        const deadline = Date.now() + 20000;
        let ready = false;
        let lastState;
        while (Date.now() < deadline) {
          lastState = await inspectState();
          const ok = readySpec
            ? Boolean(matchControl(lastState, readySpec, true))
            : lastState.buttons.some((b) => b.hitOk);
          if (ok) {
            ready = true;
            break;
          }
          await delay(250);
        }
        if (!ready) {
          throw new Error(
            `[extras] Timed out waiting for ready controls: ${JSON.stringify({
              scene: lastState?.scene,
              line: lastState?.line,
              groups: lastState?.activeGroups,
              btnCount: lastState?.buttons?.length ?? 0,
              sprites: [...new Set((lastState?.sprites ?? []).map((s) => s.objectName))],
            })}`,
          );
        }
        await delay(300);
      }
      await assertLayoutAndHitTests('extras-main');
      console.log(`Extras landing scene: ${ex?.expectedScene ?? (await inspectState()).scene}`);
      for (const tab of ex?.tabs ?? []) {
        const tabLabel = tab.expectedScene ?? tab.expectedObject ?? 'tab';
        const tabSpec = tabToSpec(tab);
        await clickControl(`extras-${tabLabel}`, tabSpec);
        if (tab.expectedObject) {
          const ok = await waitFor(
            `Boolean([...document.querySelectorAll('#siglus-surface [data-siglus-object]')].find(el => el.dataset.siglusObject?.toLowerCase() === ${JSON.stringify(tab.expectedObject.toLowerCase())} && getComputedStyle(el).display !== 'none' && Number(getComputedStyle(el).opacity) > 0.05))`,
            10000,
          );
          if (!ok) {
            const {scene, line, sprites} = await inspectState();
            throw new Error(`[extras] Expected object ${tab.expectedObject} in ${scene}:${line}; sprites=${JSON.stringify([...new Set(sprites.map((s) => s.objectName))])}`);
          }
        } else if (!(await waitForActiveScene(tab.expectedScene, 10000))) {
          const {scene, line, activeGroups} = await inspectState();
          const input = await evaluate('({pointer: window.__audit.pointer, decisions: window.__audit.galleryDecisions})');
          throw new Error(`[extras] Expected ${tab.expectedScene}, reached ${scene}:${line} with groups ${activeGroups}; input=${JSON.stringify(input)}`);
        }
        await delay(800);
        await assertLayoutAndHitTests(`extras-${tabLabel}`);
        console.log(`Extras tab: ${tabLabel}`);
        if (tab.playback) {
          const {button, resource} = tab.playback;
          await clickControl(`extras-${tabLabel}-playback`, button);
          const played = `window.__audit.bgmPlayback?.resource === ${JSON.stringify(resource)} &&
            window.__audit.bgmPlayback.frames > 0 && window.__audit.bgmPlayback.rms > 0`;
          if (!(await waitFor(played, 10000)))
            throw new Error(`[extras] BGM ${resource} did not play from ${tabLabel}`);
          console.log('Extras BGM playback:', JSON.stringify(await evaluate('window.__audit.bgmPlayback')));
        }
        if (tab.drag) {
          const before = await inspectState();
          const thumb = matchControl(before, tab.drag.thumb, true);
          const start = matchControl(before, tab.drag.start, true);
          const visibleRows = (state) => state.buttons.flatMap((button) => {
            const id = Number(button.dataset.siglusButton);
            return button.hitOk && button.dataset.siglusGroup === tab.drag.rows.group &&
              id >= tab.drag.rows.min && id <= tab.drag.rows.max ? [id] : [];
          });
          const rowsBefore = visibleRows(before);
          if (!thumb || !start || !rowsBefore.length) throw new Error(`[extras-${tabLabel}] Slider or list is unreachable`);
          const dy = tab.drag.deltaY * before.stageRect.height / SCREEN_H;
          const benchmark = process.env.SIGLUS_BENCH_DISPLAY === '1';
          if (benchmark) await evaluate(`(() => {
            const p = window.__runtime.currentPlayer;
            const render = p.renderObjects;
            const samples = [];
            const record = async function (...args) {
              const dirty = this.objectsDirty;
              const start = performance.now();
              try {
                return await render.apply(this, args);
              } finally {
                if (dirty) samples.push(performance.now() - start);
              }
            };
            p.renderObjects = record;
            window.__audit.finishDragBenchmark = () => {
              if (p.renderObjects === record) p.renderObjects = render;
              return samples;
            };
          })()`);
          await dragFrom(start.rect, 0, dy);
          await delay(450);
          if (benchmark) {
            const samples = await evaluate('window.__audit.finishDragBenchmark()');
            const totalMs = samples.reduce((sum, value) => sum + value, 0);
            console.log('Drag animation work:', JSON.stringify({
              scene: tabLabel,
              updates: samples.length,
              totalMs,
              meanMs: samples.length ? totalMs / samples.length : null,
              samples,
            }));
          }
          const after = await inspectState();
          const rowsAfter = visibleRows(after);
          const moved = matchControl(after, tab.drag.thumb, true);
          if (!moved || moved.rect.top <= thumb.rect.top || !rowsAfter.some((id) => !rowsBefore.includes(id)))
            errors.push(`[extras-${tabLabel}] Drag did not move the slider and reveal later rows (${rowsBefore} -> ${rowsAfter})`);
          else console.log('Slider drag revealed later list buttons:', JSON.stringify({before: rowsBefore, after: rowsAfter}));
          await assertLayoutAndHitTests(`extras-${tabLabel}-scrolled`);
        }
        if (tab.returnToScene) {
          if (tab.returnButton) await clickControl(`extras-${tabLabel}-return`, tab.returnButton);
          else await rightClickStage();
          if (!(await waitForActiveScene(tab.returnToScene, 12000)))
            throw new Error(`[extras] ${tabLabel} did not return to ${tab.returnToScene}`);
        }
      }
      if (ex?.exitButton) await clickControl('extras-exit', ex.exitButton);
      else await rightClickStage();
      if (!(await waitForActiveScene(MENU_SCENE, 20000))) {
        const end = await inspectState();
        errors.push(`[extras] Gallery did not return to ${MENU_SCENE} (at ${end.scene}:${end.line})`);
      }
      checkUnhandled(await inspectState(), 'extras-end');
    }
  }

  // =========================================================================
  // MODE: crawl (Phase 3 — Always-on Watchdog + Periodic Chaos Menu Injection)
  // =========================================================================
  if (MODE === 'crawl') {
    const choicePick = Number(process.argv[4] ?? 0);
    const maxSeconds = Number(process.argv[5] ?? 90);
    const chaosEvery = Number(process.argv[6] ?? 300);
    const titleState = await waitUntilTitle();
    if (titleState.scene !== MENU_SCENE) {
      errors.push(`Crawl never reached ${MENU_SCENE}`);
    } else if (await startNewGameFromTitle(titleState)) {
      await evaluate(`window.__runtime.currentPlayer.skipUnread = true;`);
      if (replay?.scriptOptions) {
        await evaluate(`(() => {
          const player = window.__runtime.currentPlayer;
          for (const [slot, value] of ${JSON.stringify(replay.scriptOptions)})
            player.property([31, -1, slot], value);
        })()`);
      }
      const t0 = Date.now();
      let ctrlHeld = false;
      let lastPages = -1;
      let stall = 0;
      let nextChaos = 100;
      let chaosCount = 0;
      let choicesTaken = 0;
      let watchdogChecks = 0;
      let compositesAudited = 0;
      let clippedContainersAudited = 0;
      let stageObjectPauses = 0;
      let interactionsDone = 0;
      let dialogueSceneReached = false;
      let lastPosition;
      let lastPositionChange = t0;
      const setCtrl = async (down) => {
        if (down === ctrlHeld) return;
        ctrlHeld = down;
        await send('Input.dispatchKeyEvent', {type: down ? 'keyDown' : 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17});
      };

      while (Date.now() - t0 < maxSeconds * 1000 && errors.length === 0) {
        await delay(170);
        const s = await inspectState();
        if (process.env.TRACE_CRAWL) {
          const now = Date.now();
          if (s.scene !== lastPosition?.scene || now - lastPositionChange >= 15000) {
            console.log('Crawl position:', JSON.stringify({
              elapsedSec: Math.round((now - t0) / 1000), scene: s.scene, line: s.line, pc: s.pc,
              pages: s.pages, waitingForPage: s.waitingForPage, ctrlHeld, delay: s.delay,
            }));
            lastPositionChange = now;
          } else if (s.pc !== lastPosition?.pc || s.pages !== lastPosition?.pages) {
            lastPositionChange = now;
          }
          lastPosition = {scene: s.scene, pc: s.pc, pages: s.pages};
        }
        watchdogChecks++;
        compositesAudited += s.compositesCount ?? 0;
        clippedContainersAudited += s.clippedContainersCount ?? 0;
        if (s.errBanner) { errors.push(`[crawl:banner] ${s.errBanner}`); break; }
        if (s.nanCount > 0) errors.push(`[watchdog@${s.scene}:${s.line}] nanCount=${s.nanCount}`);
        if (s.visualIntegrityErrors?.length > 0) {
          errors.push(`[watchdog-visual@${s.scene}:${s.line}] ${JSON.stringify(s.visualIntegrityErrors)}`);
        }
        checkUnhandled(s, `watchdog@${s.scene}:${s.line}`);
        if (s.waitingForPage && !s.systemCallActive && !s.backlogOpen) {
          if (s.layersInert || s.messageInert || s.controlsInert) errors.push(`[watchdog@${s.scene}] stuck inert`);
          if (s.systemLayerChildren > 0) errors.push(`[watchdog@${s.scene}] non-empty systemLayer`);
          if (s.deadGroups.length > 0) errors.push(`[watchdog@${s.scene}] deadGroups=${JSON.stringify(s.deadGroups)}`);
          if (!s.stageFocused) errors.push(`[watchdog@${s.scene}] lost stage focus`);
        }

        if (s.pages > 50 && s.scene === MENU_SCENE) {
          await setCtrl(false);
          break;
        }
        if (s.expectedSpeakerSeen) break;
        if (replay?.portraitChecks && Object.keys(s.portraitChecks).length === replay.portraitChecks.length) break;
        if (s.scene === replay?.dialogueScene && s.waitingForPage && s.dialogue) {
          dialogueSceneReached = true;
          break;
        }
        if (replay?.requireStagePage && stageObjectPauses > 0 &&
            (!replay.scenePrefix || s.scenesSeen.some((name) => name.startsWith(replay.scenePrefix)))) break;

        const interaction = replay?.interactions?.[interactionsDone];
        if (interaction?.scene === s.scene &&
            (interaction.activeGroup === undefined || s.activeGroups.includes(interaction.activeGroup))) {
          const control = interaction.button && matchControl(s, interaction.button, true);
          const object = interaction.objectName && s.sprites.find((item) =>
            item.objectName.toLowerCase() === interaction.objectName.toLowerCase());
          if (control || object || (interaction.rightClick && !interaction.objectName && !interaction.button)) {
            await setCtrl(false);
            if (control && interaction.volumeSlider) {
              const {channel, deltaX} = interaction.volumeSlider;
              const level = `window.__runtime.currentPlayer.audio.level(${JSON.stringify(channel)})`;
              const initial = await evaluate(level);
              await dragFrom(control.rect, deltaX * s.stageRect.width / SCREEN_W, 0);
              if (!(await waitFor(`${level} !== ${JSON.stringify(initial)}`, 3000)))
                throw new Error(`[crawl] ${channel} volume stayed at ${initial} after slider drag`);
              const measured = await evaluate(level);
              if (!(deltaX < 0 ? measured < initial : measured > initial))
                throw new Error(`[crawl] ${channel} volume moved in the wrong direction (${initial} -> ${measured})`);
              await assertLayoutAndHitTests('crawl-volume-slider');
              console.log(`Crawl slider volume: ${channel} ${initial} -> ${measured}`);
            } else if (control) await clickAt(control.rect.cx, control.rect.cy);
            else if (interaction.rightClick) await rightClickStage(true);
            console.log('Crawl interaction:', JSON.stringify(interaction));
            interactionsDone++;
            if (interactionsDone === replay.interactions.length) {
              const destination = interaction.nextScene
                ? `${currentScene} === ${JSON.stringify(interaction.nextScene)}`
                : `${currentScene} !== ${JSON.stringify(interaction.scene)}`;
              if (!(await waitFor(destination, 6000)))
                errors.push(`[crawl] Interaction in ${interaction.scene} did not reach ${interaction.nextScene ?? 'the next scene'}`);
              break;
            }
            continue;
          }
          if (interaction.revealAt && s.waitingForPage && s.stageRect) {
            const [x, y] = interaction.revealAt;
            if (!s.pointer || Math.abs(s.pointer[0] - x) > 2 || Math.abs(s.pointer[1] - y) > 2) {
              await setCtrl(false);
              const {left, top, width, height} = s.stageRect;
              await moveMouse(Math.round(left + x * width / SCREEN_W), Math.round(top + y * height / SCREEN_H));
              continue;
            }
          }
        }
        if (interaction?.scene === s.scene && interaction.activeGroup !== undefined) {
          await setCtrl(false);
          continue;
        }
        if (interaction && replay?.startButton) continue;

        if (s.pages >= nextChaos && !s.systemCallActive && !s.movieActive) {
          await setCtrl(false);
          if (!s.waitingForPage) await delay(300);
          const s0 = await inspectState();
          if (s0.waitingForPage && !s0.systemCallActive && s0.messageVisible && s0.dialogue && s0.visibleLayerVisuals.length > 0) {
            const sequence = profileCfg.messageMenu ? [0, 3, 1, 2] : [0, 1, 2];
            const kind = sequence[chaosCount % sequence.length];
            chaosCount++;
            if (kind === 0 && CANCEL_SCENE && profileCfg.quickMenu !== null) {
              await rightClickStage();
              const label = `chaos-${chaosCount}-rc`;
              await waitForModalCancel(label);
              if ((await inspectState()).visibleLayerVisuals.length === 0) errors.push('[chaos:rc] black layers');
              await rightClickStage();
              assertRoundTripClean(label, s0, await waitForDialogue(label));
            } else if (kind === 1) {
              await pressKey(' ', 'Space', 32);
              await delay(200);
              if ((await inspectState()).messageVisible) errors.push('[chaos:space] still visible');
              await pressKey(' ', 'Space', 32);
              await delay(200);
              assertRoundTripClean(`chaos-${chaosCount}-space`, s0, await inspectState());
            } else if (kind === 2) {
              await wheelStage(-120);
              if (await waitFor("Boolean(document.querySelector('[data-siglus-history]'))", 4000)) {
                await delay(250);
                await pressKey('Escape', 'Escape', 27);
                await waitFor("!document.querySelector('[data-siglus-history]')", 4000);
                await delay(250);
                assertRoundTripClean(`chaos-${chaosCount}-backlog`, s0, await inspectState());
              }
            } else if (kind === 3 && profileCfg.messageMenu) {
              await testQuickSaveLoad(profileCfg.messageMenu, `chaos-${chaosCount}-quick-save-load`);
            }
            nextChaos = (await inspectState()).pages + chaosEvery;
            continue;
          }
        }

        const choiceBtns = s.scene === MENU_SCENE
          ? []
          : s.buttons
              .filter((b) => b.dataset.siglusChoice !== undefined || (b.dataset.siglusButton !== undefined && b.dataset.siglusGroup !== undefined && !s.scene?.startsWith('_03_')))
              .filter((b) => b.rect.top < SCREEN_H && b.rect.bottom > 0 && b.hitOk);
        if (choiceBtns.length > 0 && !s.waitingForPage) {
          await setCtrl(false);
          const pick = choiceBtns[choicePick % choiceBtns.length];
          choicesTaken++;
          await clickAt(pick.rect.cx, pick.rect.cy);
          stall = 0;
          continue;
        }
        if (s.movieActive) {
          await setCtrl(false);
          await pressKey('Enter', 'Enter', 13);
          continue;
        }
        if (s.endingPending) {
          await setCtrl(false);
          if (s.waitingForPage) await pressKey('Enter', 'Enter', 13);
          continue;
        }
        if (s.waitingForPage && !s.systemCallActive && (s.stagePause || (!s.pendingText && s.stageTextCount > 0))) {
          await setCtrl(false);
          await delay(200);
          const settled = await inspectState();
          if (settled.pageWaits === s.pageWaits && settled.waitingForPage && (!settled.pendingText || !settled.messageVisible)) {
            stageObjectPauses++;
            await assertLayoutAndHitTests(`stage-object:${s.scene}:${s.line}`);
            if (!settled.visibleLayerVisuals.length) errors.push(`[stage-object-pacing] Empty stage at ${s.scene}:${s.line}`);
            const {left, top, width, height} = settled.stageRect;
            await clickAt(Math.round(left + width * 0.75), Math.round(top + height * 0.3));
            await waitFor(`window.__audit.pageWaits > ${settled.pageWaits} || !window.__runtime.currentPlayer.waitingForPage`, 3500);
            const next = await inspectState();
            if (next.pageWaits > settled.pageWaits + 1 || (next.waitingForPage && next.pageWaits === settled.pageWaits))
              errors.push(`[stage-object-pacing] One click did not advance a single wait at ${s.scene}:${s.line}`);
            console.log('Stage-object wait:', JSON.stringify({
              scene: settled.scene, line: settled.line, pageWait: settled.pageWaits,
              followingWait: next.pageWaits, composites: settled.compositesCount,
              clippedContainers: settled.clippedContainersCount, textObjects: settled.stageTextCount,
            }));
            continue;
          }
          if (s.stagePause) errors.push(`[stage-object-pacing] Wait advanced without input at ${s.scene}:${s.line}`);
        }
        if ((profileCfg.gameplay?.stagePageScenes ?? []).includes(s.scene)) {
          await setCtrl(false);
          continue;
        }
        if (s.pages !== lastPages) {
          lastPages = s.pages;
          stall = 0;
          await setCtrl(true);
        } else if (++stall >= 8) {
          await setCtrl(false);
          await pressKey('Enter', 'Enter', 13);
          stall = 0;
        }
      }
      await setCtrl(false);
      const fin = await inspectState();
      if (replay?.scenePrefix && !fin.scenesSeen.some((name) => name.startsWith(replay.scenePrefix)))
        errors.push(`[crawl] Never reached replay ${replayName} (${replay.scenePrefix})`);
      if (replay?.interactions && interactionsDone !== replay.interactions.length)
        errors.push(`[crawl] Completed ${interactionsDone}/${replay.interactions.length} interactions in ${replayName}`);
      if (replay?.dialogueScene && !dialogueSceneReached)
        errors.push(`[crawl] Replay ${replayName} did not reach dialogue in ${replay.dialogueScene}`);
      for (const [index, check] of (replay?.portraitChecks ?? []).entries()) {
        const sample = fin.portraitChecks[index];
        if (!sample || sample.speaker !== check.speaker || JSON.stringify(sample.faces) !== JSON.stringify(check.faces))
          errors.push(`[portrait] ${check.scene}:${check.line} expected ${JSON.stringify(check.faces)}, measured ${JSON.stringify(sample)}`);
        else console.log(`Portrait ${check.scene}:${check.line}:`, JSON.stringify(sample));
      }
      if (replay?.ending && !fin.playingOmvs.includes(replay.ending.movie))
        errors.push(`[crawl] Replay ${replayName} did not present ending OMV ${replay.ending.movie}`);
      if (replay?.ending && fin.scene !== MENU_SCENE)
        errors.push(`[crawl] Replay ${replayName} did not return to ${MENU_SCENE}`);
      if (replay?.expectedSpeaker && !fin.expectedSpeakerSeen)
        errors.push(`[crawl] Replay ${replayName} never displayed speaker ${replay.expectedSpeaker}`);
      if (replay?.requireStagePage && stageObjectPauses === 0) {
        const timing = await evaluate('window.__audit.stageTiming');
        errors.push(`[crawl] Replay ${replayName} did not verify a stage-object input wait; timing=${JSON.stringify(timing)}`);
      }
      console.log('CRAWL SUMMARY:', JSON.stringify({
        replay: replayName,
        elapsedSec: Math.round((Date.now() - t0) / 1000),
        finalScene: fin.scene,
        finalLine: fin.line,
        finalPc: fin.pc,
        pages: fin.pages,
        scenesCount: fin.scenesSeen.length,
        choicesTaken,
        chaosCount,
        watchdogChecks,
        compositesAudited,
        clippedContainersAudited,
        stageObjectPauses,
        expectedSpeakerSeen: fin.expectedSpeakerSeen || undefined,
        playingOmvs: fin.playingOmvs,
        unhandledCommands: fin.unhandledCommands.length,
        unhandledProperties: fin.unhandledProperties.length,
      }));
    }
  }

  if (process.env.SIGLUS_OBSERVE_OUT && errors.length === 0) {
    try {
      const obs = await evaluate(`(() => {
        const o = window.__siglusObserve;
        if (!o) return null;
        return {
          commands: [...o.commands].sort(),
          properties: [...o.properties].sort(),
          gameexe: [...o.gameexe].sort(),
        };
      })()`);
      if (obs) {
        const outPath = resolve(process.env.SIGLUS_OBSERVE_OUT);
        const gameKey = PROFILE_PATH.replace(/^.*[\\/]/, '').replace(/\.json$/i, '');
        const doc = fs.existsSync(outPath)
          ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
          : {schema: 'siglus-browser-observed/v1', generatedAt: null, runs: {}, commands: {}, properties: {}, gameexe: {}};
        doc.generatedAt = new Date().toISOString();
        const runKey = `${gameKey}:${MODE}`;
        doc.runs[runKey] = {
          game: gameKey,
          mode: MODE,
          recordedAt: doc.generatedAt,
          commandsCount: obs.commands.length,
          propertiesCount: obs.properties.length,
          gameexeCount: obs.gameexe.length,
        };
        const merge = (bucket, items) => {
          for (const k of items) {
            const set = new Set(bucket[k] ?? []);
            set.add(gameKey);
            bucket[k] = [...set].sort();
          }
        };
        merge(doc.commands, obs.commands);
        merge(doc.properties, obs.properties);
        merge(doc.gameexe, obs.gameexe);
        fs.mkdirSync(resolve(outPath, '..'), {recursive: true});
        fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
        console.log(`[observe] Recorded ${obs.commands.length} cmds, ${obs.properties.length} props, ${obs.gameexe.length} gameexe keys -> ${process.env.SIGLUS_OBSERVE_OUT} (${runKey})`);
      }
    } catch (obsErr) {
      console.warn('[observe] Failed to record telemetry:', obsErr instanceof Error ? obsErr.message : String(obsErr));
    }
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
} finally {
  console.log(`\n=== RESULT [${profileCfg.name}:${MODE}] errors=${errors.length} warnings=${warnings.length} ===`);
  if (errors.length) console.log('Errors:', errors);
  if (warnings.length) console.log('Warnings:', warnings);
  if (errors.length > 0 || warnings.length > 0) process.exitCode = 1;
  if (cdp) cdp.socket.close();
  if (child) {
    try {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2000)]);
    } catch {}
  }
  server.close();
  await rm(tmpProfile, {recursive: true, force: true}).catch(() => {});
}
