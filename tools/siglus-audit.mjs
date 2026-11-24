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

function resolveDataDir(dir) {
  if (fs.existsSync(join(dir, 'Scene.pck')) && fs.existsSync(join(dir, 'Gameexe.dat'))) return dir;
  const nested = join(dir, 'StartData', 'GameData');
  if (fs.existsSync(join(nested, 'Scene.pck')) && fs.existsSync(join(nested, 'Gameexe.dat'))) return nested;
  throw new Error(`Missing Scene.pck / Gameexe.dat under ${dir}`);
}

const DATA_DIR = resolveDataDir(GAME_DIR);
const pack = new SiglusScenePack(new Uint8Array(fs.readFileSync(join(DATA_DIR, 'Scene.pck'))));
const gameexe = pack.configuration(new Uint8Array(fs.readFileSync(join(DATA_DIR, 'Gameexe.dat'))));

const parseSceneName = (key, fallback) => gameexe.get(key)?.split('"')[1] ?? fallback;
const [SCREEN_W, SCREEN_H] = (gameexe.get('SCREEN_SIZE') ?? '1280, 720')
  .split(',')
  .map((v) => Number(v.trim()));
const MENU_SCENE = profileCfg.title?.scene ?? parseSceneName('MENU_SCENE', '_titlemenu');
const CANCEL_SCENE = parseSceneName('CANCEL_SCENE', null);
const SAVE_SCENE = parseSceneName('SAVE_SCENE', null);
const LOAD_SCENE = parseSceneName('LOAD_SCENE', null);
const CONFIG_SCENE = parseSceneName('CONFIG_SCENE', null);
const mwndBottom = Math.max(
  SCREEN_H,
  ...Array.from({length: Number(gameexe.get('MWND.CNT') ?? 0)}, (_, index) => {
    const {windowPos, windowSize} = parseMwndLayout(gameexe, index);
    return windowPos[1] + windowSize[1];
  }),
);
const SAVE_KEY = 'siglus:' + sha256File(join(DATA_DIR, 'Scene.pck'));
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
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
    await delay(25);
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
    await delay(25);
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
  };

  const rightClickStage = async () => {
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
  if (!(await waitFor("document.querySelector('#play')?.disabled === false", 60000))) {
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
  if (unlock) {
    await evaluate(`(() => {
      const k = ${JSON.stringify(SAVE_KEY)};
      const ex = ${JSON.stringify(unlock)};
      if (ex.systemFlags) localStorage.setItem(k + ':system', JSON.stringify(ex.systemFlags));
      if (ex.cgFlags) localStorage.setItem(k + ':cgtable', JSON.stringify(ex.cgFlags));
      if (ex.bgmListened) localStorage.setItem(k + ':bgmtable', JSON.stringify(ex.bgmListened));
    })()`);
  }

  const playPt = await evaluate(`(() => {
    const r = document.getElementById('play').getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`);
  await clickAt(playPt.x, playPt.y);

  if (!(await waitFor('Boolean(window.__runtime?.currentPlayer?.vm)', 25000))) {
    throw new Error('currentPlayer.vm did not initialize; errors=' + JSON.stringify(errors));
  }

  await evaluate(`(() => {
    const p = window.__runtime.currentPlayer;
    window.__audit = {scenes: [], sceneSet: new Set(), movies: [], movieActive: null, compositeInk: new WeakMap(), effects: [], playingOmvs: new Set(), pageWaits: 0, stagePause: null};
    window.__audit.frame = () => {
      const vm = window.__runtime?.currentPlayer?.vm;
      const frame = vm?.frames?.at(-1);
      return frame && (vm.sceneJumps?.get(frame) ?? frame);
    };
    const stagePageScenes = new Set(${JSON.stringify(profileCfg.gameplay?.stagePageScenes ?? [])});
    const ending = ${JSON.stringify(replay?.ending ?? null)};
    const expectedSpeaker = ${JSON.stringify(replay?.expectedSpeaker ?? null)};
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
      if (detail.channel === 'bgm') window.__audit.bgmPlayback = detail;
    });
    if (${MODE === 'extras'}) {
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
          window.__audit.pointer.push([event.type, button?.dataset.siglusGroup, button?.dataset.siglusButton]);
          if (window.__audit.pointer.length > 24) window.__audit.pointer.shift();
        }, true);
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
      const s = window.__audit.frame()?.scene.name;
      if (s && !window.__audit.sceneSet.has(s)) {
        window.__audit.sceneSet.add(s);
        window.__audit.scenes.push(s);
      }
      for (const effect of p.display?.activeEffects?.values() ?? []) {
        if (effect.layer?.isConnected && effect.movie?.presentedFrame > 0)
          window.__audit.playingOmvs.add(effect.checkpoint.name.toLowerCase());
      }
      recordObjectMovies(p.objects?.[0]);
      recordObjectMovies(p.systemObjects);
      recordObjectMovies(p.systemFrontObjects);
    }, 50);
  })()`);

  const inspectState = () =>
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
      const top = window.__audit.frame();
      const disp = p?.display;
      const layersEl = disp?.layers;
      const systemLayerEl = disp?.systemLayer;
      const messageEl = disp?.message;
      const controlsEl = disp?.controls;

      const visibleLayerVisuals = [];
      if (layersEl) {
        for (const el of layersEl.querySelectorAll('img, canvas, video')) {
          const r = el.getBoundingClientRect();
          let hidden = false;
          let cur = el;
          while (cur && cur !== layersEl) {
            const ccs = getComputedStyle(cur);
            if (cur.hidden || ccs.display === 'none' || ccs.visibility === 'hidden' || Number(ccs.opacity) <= 0.01) {
              hidden = true;
              break;
            }
            cur = cur.parentElement;
          }
          if (!hidden && r.width > 0 && r.height > 0) {
            const slot = el.closest('[data-siglus-object-id]')?.dataset.siglusObjectId;
            const key = el.dataset.siglusKey ?? el.dataset.siglusObject ?? el.getAttribute('alt') ?? slot ?? el.tagName;
            visibleLayerVisuals.push({tag: el.tagName, key});
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
          let hidden = b.disabled || b.hidden || b.inert || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05 || r.width <= 0 || r.height <= 0;
          let cur = b.parentElement;
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
            const st = toStage(b);
            const hit = document.elementFromPoint(st.cx, st.cy);
            const hitButton = hit?.closest('button');
            const sameScriptControl =
              b.dataset.siglusButton !== undefined &&
              b.dataset.siglusButton === hitButton?.dataset.siglusButton &&
              b.dataset.siglusGroup === hitButton.dataset.siglusGroup;
            const hitOk = Boolean((hit && b.contains(hit)) || sameScriptControl);
            buttons.push({
              aria: b.getAttribute('aria-label') ?? '',
              text: (b.textContent ?? '').trim().slice(0, 40),
              dataset: {...b.dataset},
              rect: st,
              hitOk,
              hitTag: hitButton ? (hitButton.getAttribute('aria-label') ?? hitButton.tagName) : hit?.tagName,
              hitGroup: hitButton?.dataset.siglusGroup,
              hitClip: hitOk ? undefined : b.style.clipPath.slice(0, 120),
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
            const tokens = obj.name.split('|').filter((t) => t.length > 0);
            const explicitDim = /^\\((\\d+),(\\d+)\\)$/.exec(tokens[0] ?? '');
            const partTokens = explicitDim ? tokens.slice(1) : tokens;
            let expectedW = explicitDim ? Number(explicitDim[1]) : 0;
            let expectedH = explicitDim ? Number(explicitDim[2]) : 0;
            let allCached = !explicitDim && partTokens.length > 0;
            let maxDx = 0;
            let maxDy = 0;
            for (let pi = 0; pi < partTokens.length; pi++) {
              const m = /^([^()]+?)(?:\\((-?\\d+),(-?\\d+)(?:,(\\d+))?(?:,blend=(\\d+))?\\))?$/.exec(partTokens[pi].trim());
              if (!m) { allCached = false; continue; }
              const pName = m[1].trim().toLowerCase();
              const dx = Number(m[2] ?? 0);
              const dy = Number(m[3] ?? 0);
              const pat = Number(m[4] ?? 0);
              if (dx > maxDx) maxDx = dx;
              if (dy > maxDy) maxDy = dy;
              const cached = disp?.graphicCache?.get(pName + '#' + pat)?.graphic;
              if (!cached) {
                allCached = false;
              } else if (!explicitDim) {
                if (pi === 0) {
                  expectedW = cached.width;
                  expectedH = cached.height;
                }
                const right = dx - cached.centerX + cached.width;
                const bottom = dy - cached.centerY + cached.height;
                if (right > expectedW) expectedW = right;
                if (bottom > expectedH) expectedH = bottom;
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
                  const [, name, , , cut] = /^([^()]+?)(?:\((-?\d+),(-?\d+)(?:,(-?\d+))?(?:,blend=\d+)?\))?$/.exec(part.trim()) ?? [];
                  const graphic = name && disp.graphicCache.get(name.toLowerCase() + '#' + (cut ?? 0))?.graphic;
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

      const dbg = top ? window.__siglusDebug?.snapshot?.() : undefined;
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
        backlogOpen: Boolean(historyEl),
        stageRect: sr ? {left: sr.left, top: sr.top, width: sr.width, height: sr.height} : null,
        movieActive: window.__audit?.movieActive ?? null,
        moviesSeen: window.__audit?.movies ?? [],
        scenesSeen: window.__audit?.scenes ?? [],
        playingOmvs: [...(window.__audit?.playingOmvs ?? [])],
        unhandledCommands: dbg?.unhandledCommands ?? [],
        unhandledProperties: dbg?.unhandledProperties ?? [],
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

  const quickButton = (state, id) =>
    matchButton(
      state.buttons.filter((button) => button.hitOk),
      {group: profileCfg.quickMenu?.group, id},
    );

  const currentScene = 'window.__audit.frame()?.scene.name';
  const waitForActiveScene = (name, timeout, group) => {
    const groups = 'window.__runtime?.currentPlayer?.activeGroups';
    const scene = JSON.stringify(name);
    const active = MODE === 'extras'
      ? `[...(${groups} ?? [])].some((id) => window.__audit.galleryGroups.get(id) === ${scene})`
      : group === undefined ? `${groups}?.size > 0` : `${groups}?.has(${Number(group)})`;
    const sceneMatches = group === undefined || MODE === 'extras'
      ? `${currentScene} === ${scene}`
      : `(() => {
        const vm = window.__runtime?.currentPlayer?.vm;
        return vm?.frames.some(frame => (vm.sceneJumps.get(frame) ?? frame).scene.name === ${scene});
      })()`;
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
      if (allowAutoHiddenBottomBar && b.dataset.siglusAction !== undefined && b.rect.top >= SCREEN_H - 2) continue;
      const expectedBottom = b.dataset.siglusAction === undefined ? SCREEN_H : mwndBottom;
      if (b.rect.left < -6 || b.rect.right > SCREEN_W + 6 || b.rect.top < -6 || b.rect.bottom > expectedBottom + 6) {
        failures.push(`Button clipped at ${SCREEN_W}x${SCREEN_H}: ${JSON.stringify({aria: b.aria, ds: b.dataset, rect: b.rect})}`);
      }
      if (checkHitTest && !b.hitOk) {
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

  const assertRoundTripClean = (label, before, after, {restored = false} = {}) => {
    const diffs = [];
    const previousLayers = layerKeys(before);
    const currentLayers = layerKeys(after);
    const missing = [...previousLayers].filter((key) => !currentLayers.has(key));
    const added = [...currentLayers].filter((key) => !previousLayers.has(key));
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
    return p?.systemCallActive && [...p.cancelGroups].some((group) =>
      group >= 100000 && p.activeGroups.has(group) &&
      p.display.stage.querySelector('[data-siglus-group="' + group + '"]'));
  })()`;
  const canCloseModal = `(() => {
    const p = window.__runtime?.currentPlayer;
    return p?.systemCallActive && [...p.cancelGroups].some((group) =>
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

  const closeSystemMenu = async (label) => {
    for (let remaining = 4; remaining > 0; remaining--) {
      if (!(await waitFor(`${readyForDialogue} || ${readyForModalCancel} || ${canCloseModal}`, 8000))) break;
      const before = await inspectState();
      if (!before.systemCallActive) return before;
      const closeId = profileCfg.quickMenu?.closeButtonId;
      const close = before.scene === CANCEL_SCENE && closeId !== undefined ? quickButton(before, closeId) : undefined;
      if (close) await clickAt(close.rect.cx, close.rect.cy);
      else await rightClickStage();
      if (process.env.TRACE_MODAL) {
        const input = await evaluate(`(() => {
          const p = window.__runtime.currentPlayer;
          return {ready: Boolean(p.decisionReady), decisions: [...p.decisions], dirty: p.systemObjectsDirty};
        })()`);
        console.log('Modal close:', JSON.stringify({label, scene: before.scene, line: before.line, active: before.activeGroups, controls: before.buttons.length, click: Boolean(close), ...input}));
      }
      await waitFor(`${readyForDialogue} || ${currentScene} !== ${JSON.stringify(before.scene)}`, 5000);
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
    const button = matchButton(state.buttons.filter((b) => b.hitOk), spec);
    if (!button) {
      const available = state.buttons.map(({aria, dataset, hitOk}) => ({aria, ...dataset, hitOk}));
      throw new Error(`[${label}] No clickable control in ${state.scene} matching ${JSON.stringify(spec)}; available=${JSON.stringify(available)}`);
    }
    await clickAt(button.rect.cx, button.rect.cy);
  };

  const confirm = async (dialog, label, accept) => {
    if (!(await waitForActiveScene(dialog.scene, 8000, dialog.group))) {
      const state = await inspectState();
      throw new Error(`[${label}] Expected confirmation scene ${dialog.scene} (scene=${state.scene}, groups=${state.activeGroups.join(',')})`);
    }
    await delay(300);
    await assertLayoutAndHitTests(`${label}-confirmation`, {buttonGroup: dialog.group});
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
    if (profileCfg.title?.skipPrologue) {
      await evaluate(`window.__runtime.currentPlayer.skipUnread = true;`);
    }
    for (let i = 0; i < 450; i++) {
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
        const startBtn = matchButton(s.buttons, profileCfg.title?.startButton);
        if (startBtn && startBtn.hitOk && (s.activeGroups.length > 0 || !profileCfg.title?.startButton?.group)) {
          await setCtrl(false);
          await delay(350);
          return await inspectState();
        }
      }
      if (profileCfg.title?.skipPrologue && s.pages > 0) {
        await setCtrl(true);
        if (i % 10 === 0) {
          await setCtrl(false);
          await pressKey('Enter', 'Enter', 13);
        }
      } else if (i > 3 && i % 4 === 0) {
        await pressKey('Enter', 'Enter', 13);
      }
    }
    await setCtrl(false);
    return await inspectState();
  };

  const startNewGameFromTitle = async (titleState) => {
    const startBtn = matchButton(titleState.buttons, profileCfg.title?.startButton);
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
      const routeBtn = matchButton(subState.buttons, sub);
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
            ? matchButton(state.buttons, prompt.button)
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
      errors.push(`Never reached ${MENU_SCENE} (in ${titleState.scene})`);
    } else {
      await assertLayoutAndHitTests('title-menu');
      if (profileCfg.title?.streamedBgm) {
        const name = JSON.stringify(profileCfg.title.streamedBgm);
        const streaming = `(() => {
          const playback = window.__audit.bgmPlayback;
          const audio = window.__runtime.currentPlayer.audio;
          return playback?.resource === ${name} && playback.streaming && playback.frames > 0 &&
            audio.context.state === 'running' && audio.bgmPlayPosition() > playback.startSample;
        })()`;
        if (!(await waitFor(streaming, 8000))) errors.push(`[title] BGM ${name} did not stream PCM`);
        else {
          const telemetry = await evaluate(`(() => {
            const source = window.__runtime.currentPlayer.audio.playing.get('bgm')?.source;
            const queuedFrames = [...(source?.nodes ?? [])].reduce((sum, node) => sum + (node.buffer?.length ?? 0), 0);
            return {...window.__audit.bgmPlayback, queuedFrames};
          })()`);
          // Include the full current chunk and the final chunk crossing the five-second look-ahead.
          if (!(telemetry.queuedFrames > 0 && telemetry.queuedFrames <= telemetry.sourceRate * 8))
            errors.push(`[title] BGM stream has ${telemetry.queuedFrames} queued PCM frames`);
          console.log('Title BGM streaming:', JSON.stringify(telemetry));
        }
      }
      if (profileCfg.title?.configButton && CONFIG_SCENE) {
        const cfgBtn = matchButton(titleState.buttons, profileCfg.title.configButton);
        if (cfgBtn) {
          await clickAt(cfgBtn.rect.cx, cfgBtn.rect.cy);
          await waitFor(`${currentScene} === ${JSON.stringify(CONFIG_SCENE)} && window.__runtime?.currentPlayer?.cancelGroups?.size > 0`, 12000);
          await delay(500);
          await assertLayoutAndHitTests('title-config');
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
          const back = await waitForActiveScene(MENU_SCENE, 10000);
          if (!back) errors.push('[title-config] Right-click did not return to title');
          await delay(400);
        }
      }
      await startNewGameFromTitle(await inspectState());
    }

    // Advance into live dialogue
    const gp = profileCfg.gameplay ?? {};
    const minPages = gp.minPages ?? 5;
    const minVisuals = gp.minVisuals ?? 1;
    let liveState = null;
    for (let i = 0; i < 400; i++) {
      await delay(120);
      const s = await inspectState();
      if (errors.length || s.errBanner) break;
      const inStory = s.scene && s.scene !== MENU_SCENE && !s.scene.startsWith('_00') && !s.scene.startsWith('__');
      if (
        inStory &&
        s.waitingForPage &&
        s.dialogue.length > 0 &&
        (!gp.requireSpeaker || s.speaker.length > 0) &&
        (!gp.requireBgm || Boolean(s.bgm)) &&
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
      errors.push('Did not reach live gameplay dialogue');
    } else {
      console.log('LIVE GAMEPLAY:', {scene: liveState.scene, line: liveState.line, pages: liveState.pages, speaker: liveState.speaker, bgm: liveState.bgm, visuals: liveState.visibleLayerVisuals.length});
      await assertLayoutAndHitTests('live-mwnd', {checkHitTest: true, checkText: true, allowAutoHiddenBottomBar: Boolean(gp.mwndAutoHideBar)});

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
        await rightClickStage();
        await waitFor("window.__runtime?.currentPlayer?.systemCallActive === false", 6000);
        await delay(350);
        console.log('RC->RC diffs:', assertRoundTripClean('rc->rc', b1, await inspectState()));

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
        if (qm?.closeButtonId !== undefined) {
          const b3 = await inspectState();
          await openQuickMenu();
          await delay(400);
          const closeBtn = quickButton(await inspectState(), qm.closeButtonId);
          if (closeBtn) await clickAt(closeBtn.rect.cx, closeBtn.rect.cy);
          else await rightClickStage();
          await waitFor("window.__runtime?.currentPlayer?.systemCallActive === false", 6000);
          await delay(350);
          console.log('RC->CloseBtn diffs:', assertRoundTripClean('rc->closebtn', b3, await inspectState()));
        }

        // Nested QM -> Save -> Cancel
        if (qm?.saveButtonId !== undefined && SAVE_SCENE) {
          const b4 = await inspectState();
          await openQuickMenu();
          await delay(400);
          const sb = quickButton(await inspectState(), qm.saveButtonId);
          if (sb) {
            await clickAt(sb.rect.cx, sb.rect.cy);
            if (!(await waitForActiveScene(SAVE_SCENE, 8000, qm.slotGroup)))
              throw new Error(`[nested-save] Expected ${SAVE_SCENE}, reached ${(await inspectState()).scene}`);
            await delay(500);
            if ((await inspectState()).visibleLayerVisuals.length === 0) errors.push('[nested-save] Main layers black');
            await assertLayoutAndHitTests('nested-save-open');
          } else errors.push('[nested-save] Missing clickable Save control');
          console.log('Nested QM->Save->Cancel diffs:', assertRoundTripClean('nested-save-cancel', b4, await closeSystemMenu('nested-save-cancel')));
        }

        // Nested QM -> Config -> Cancel
        if (qm?.configButtonId !== undefined && CONFIG_SCENE) {
          const b5 = await inspectState();
          await openQuickMenu();
          await delay(400);
          const cb = quickButton(await inspectState(), qm.configButtonId);
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
      } else if (qm?.saveButtonId !== undefined && qm?.loadButtonId !== undefined && SAVE_SCENE && LOAD_SCENE) {
        const preSave = await waitForDialogue('save-load');
        const confirmScene = qm.confirmDialog?.scene;
        const dialogOpen = confirmScene ? `${currentScene} === ${JSON.stringify(confirmScene)}` : 'false';
        await openQuickMenu();
        await delay(350);
        const sb = quickButton(await inspectState(), qm.saveButtonId);
        if (!sb) throw new Error('[save-load] Missing clickable Save control');
        await clickAt(sb.rect.cx, sb.rect.cy);
        if (!(await waitForActiveScene(SAVE_SCENE, 8000, qm.slotGroup)))
          throw new Error(`[save-load] Expected ${SAVE_SCENE}, reached ${(await inspectState()).scene}`);
        await delay(500);
        const sv0 = (await inspectState()).buttons.find((b) => {
          const id = Number(b.dataset.siglusButton);
          return b.hitOk && Number.isInteger(id) && id >= (qm.slotButtonMin ?? 0) && id <= (qm.slotButtonMax ?? 15);
        });
        if (sv0) {
          const stored = 'window.__runtime.currentPlayer.saves.size > 0';
          await clickAt(sv0.rect.cx, sv0.rect.cy);
          if (!(await waitFor(`${stored} || ${dialogOpen}`, 10000)))
            throw new Error('[save-load] Save slot did not write a checkpoint');
          if (await evaluate(dialogOpen)) await confirm(qm.confirmDialog, 'save-slot', true);
          if (!(await waitFor(stored, 10000))) throw new Error('[save-load] Save confirmation did not write a checkpoint');
          await closeSystemMenu('save-return');
          await advanceDialogue('save-load', preSave);
          await openQuickMenu();
          await delay(350);
          const lb = quickButton(await inspectState(), qm.loadButtonId);
          if (!lb) throw new Error('[save-load] Missing clickable Load control');
          await clickAt(lb.rect.cx, lb.rect.cy);
          if (!(await waitForActiveScene(LOAD_SCENE, 8000, qm.slotGroup)))
            throw new Error(`[save-load] Expected ${LOAD_SCENE}, reached ${(await inspectState()).scene}`);
          await delay(500);
          const ld0 = (await inspectState()).buttons.find((b) => b.hitOk && b.dataset.siglusButton === sv0.dataset.siglusButton);
          if (!ld0) throw new Error('[save-load] Saved slot cannot be loaded');
          const loaded = `window.__runtime.currentPlayer.root.dataset.loaded === 'true' && ${readyForDialogue}`;
          await clickAt(ld0.rect.cx, ld0.rect.cy);
          if (!(await waitFor(`(${loaded}) || ${dialogOpen}`, 10000)))
            throw new Error('[save-load] Load slot did not start restoring the checkpoint');
          if (await evaluate(dialogOpen)) await confirm(qm.confirmDialog, 'load-slot', true);
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
    const titleState = await waitUntilTitle();
    await assertLayoutAndHitTests('extras-title');
    const ex = profileCfg.extras;
    const extraBtn = matchButton(titleState.buttons, profileCfg.title?.extraButton);
    if (!extraBtn || !extraBtn.hitOk) {
      errors.push('[extras] Extra button not visible/clickable on unlocked title');
    } else {
      await clickAt(extraBtn.rect.cx, extraBtn.rect.cy);
      if (ex?.expectedScene) {
        if (!(await waitForActiveScene(ex.expectedScene, 12000)))
          throw new Error(`[extras] Expected ${ex.expectedScene}, reached ${(await inspectState()).scene}`);
        await delay(800);
      } else {
        await delay(1000);
      }
      await assertLayoutAndHitTests('extras-main');
      for (const tab of ex?.tabs ?? []) {
        await clickControl(`extras-${tab.expectedScene}`, {id: tab.buttonId});
        if (!(await waitForActiveScene(tab.expectedScene, 10000))) {
          const {scene, line, activeGroups} = await inspectState();
          const input = await evaluate('({pointer: window.__audit.pointer, decisions: window.__audit.galleryDecisions})');
          throw new Error(`[extras] Expected ${tab.expectedScene}, reached ${scene}:${line} with groups ${activeGroups}; input=${JSON.stringify(input)}`);
        }
        await delay(800);
        await assertLayoutAndHitTests(`extras-${tab.expectedScene}`);
      }
      await rightClickStage();
      if (!(await waitForActiveScene(MENU_SCENE, 10000)))
        errors.push(`[extras] Gallery did not return to ${MENU_SCENE}`);
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
        if (replay?.requireStagePage && stageObjectPauses > 0 &&
            (!replay.scenePrefix || s.scenesSeen.some((name) => name.startsWith(replay.scenePrefix)))) break;

        if (s.pages >= nextChaos && !s.systemCallActive && !s.movieActive) {
          await setCtrl(false);
          if (!s.waitingForPage) await delay(300);
          const s0 = await inspectState();
          if (s0.waitingForPage && !s0.systemCallActive && s0.messageVisible && s0.dialogue && s0.visibleLayerVisuals.length > 0) {
            const sequence = profileCfg.messageMenu ? [0, 3, 1, 2] : [0, 1, 2];
            const kind = sequence[chaosCount % sequence.length];
            chaosCount++;
            if (kind === 0 && CANCEL_SCENE) {
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
            } else {
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
