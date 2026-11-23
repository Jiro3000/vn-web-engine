#!/usr/bin/env node
/**
 * Unified, data-driven headless Brave programmatic verifier, layout/hit-test auditor,
 * interactive round-trip matrix runner, and invariant crawler for ANY SiglusEngine game.
 *
 * ZERO screenshots / ZERO visual inspection — 100% programmatic DOM, state,
 * hit-test, unhandled-opcode telemetry, and audio/video verification.
 *
 * Usage:
 *   node tools/siglus-audit.mjs <profile.json> [systems|extras|crawl] [choicePick] [maxSeconds] [chaosEvery]
 *
 * Environment:
 *   BROWSER_BIN   Path to Brave/Chrome binary (defaults to Brave on macOS, falls back to Chrome)
 *   TEXT_MODE     'dom' (default) or 'native'
 *   GAME_DIR      Optional override for profile.gameDir
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
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
const GAME_DIR = resolve(process.env.GAME_DIR ?? profileCfg.gameDir);

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
const SAVE_KEY = 'siglus:' + sha256File(join(DATA_DIR, 'Scene.pck'));
const BROWSER_BIN = resolveBrowserBin();

const tmpProfile = await mkdtemp(join(tmpdir(), 'siglus-audit-'));
const server = await createStaticServer();
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

  if (!(await waitFor("document.querySelector('#files') !== null"))) {
    throw new Error('Timed out waiting for #files');
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
  for (const name of await readdir(resolve('site/assets'))) {
    if (
      name.startsWith('siglus-') &&
      name.endsWith('.js') &&
      /export\s*\{[^}]*\bcurrentPlayer\b/.test(await readFile(resolve('site/assets', name), 'utf8'))
    ) {
      runtimePath = '/assets/' + name;
      break;
    }
  }
  if (!runtimePath) throw new Error('Could not find siglus runtime chunk exporting currentPlayer');
  await evaluate(`import(${JSON.stringify(origin + runtimePath)}).then(m => { window.__runtime = m; })`);

  // Seed extras unlock flags if running extras mode
  if (MODE === 'extras' && profileCfg.extras) {
    await evaluate(`(() => {
      const k = ${JSON.stringify(SAVE_KEY)};
      const ex = ${JSON.stringify(profileCfg.extras)};
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
    window.__audit = {scenes: [], sceneSet: new Set(), movies: [], movieActive: null};
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
    setInterval(() => {
      const s = p.vm?.frames?.at?.(-1)?.scene?.name;
      if (s && !window.__audit.sceneSet.has(s)) {
        window.__audit.sceneSet.add(s);
        window.__audit.scenes.push(s);
      }
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
      const top = p?.vm?.frames?.at?.(-1);
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
            const key = el.dataset.siglusKey ?? el.dataset.siglusObject ?? el.getAttribute('alt') ?? (el.tagName + ':' + Math.round(r.width) + 'x' + Math.round(r.height));
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
          let hidden = b.disabled || b.hidden || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.05 || r.width <= 0 || r.height <= 0;
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
            const hitOk = Boolean(hit && (hit === b || b.contains(hit) || hit.contains(b)));
            buttons.push({
              aria: b.getAttribute('aria-label') ?? '',
              text: (b.textContent ?? '').trim().slice(0, 40),
              dataset: {...b.dataset},
              rect: st,
              hitOk,
              hitTag: hit ? (hit.tagName + (hit.dataset?.siglusButton ? '#btn' + hit.dataset.siglusButton : '')) : null,
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
            if (fr.image && typeof fr.image.getContext === 'function' && fr.width > 0 && fr.height > 0) {
              // Sample a sparse grid across the composite canvas to ensure it isn't blank
              const ctx = fr.image.getContext('2d');
              const data = ctx?.getImageData(0, 0, fr.width, fr.height)?.data;
              if (data) {
                let opaque = 0;
                const step = Math.max(4, Math.floor(data.length / 4096) * 4);
                for (let bi = 3; bi < data.length; bi += step) if (data[bi] > 10) opaque++;
                if (opaque === 0) visualIntegrityErrors.push('composite_blank:' + obj.name.slice(0, 48));
              }
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

      const dbg = window.__siglusDebug?.snapshot?.();
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
      if (spec.action !== undefined && b.dataset.siglusAction !== spec.action) return false;
      if (spec.aria !== undefined && b.aria !== spec.aria) return false;
      return true;
    });
  };

  const assertLayoutAndHitTests = async (label, {checkHitTest = true, checkText = false, allowAutoHiddenBottomBar = false} = {}) => {
    const s = await inspectState();
    const failures = [];
    if (s.nanCount > 0) failures.push(`nanCount=${s.nanCount} els=${JSON.stringify(s.nanElements)}`);
    if (s.errBanner) failures.push(`errBanner=${s.errBanner}`);
    if (s.visualIntegrityErrors?.length > 0) {
      failures.push(`visualIntegrity=${JSON.stringify(s.visualIntegrityErrors)}`);
    }
    for (const b of s.buttons) {
      const fullyOffStage = b.rect.top >= SCREEN_H || b.rect.bottom <= 0 || b.rect.left >= SCREEN_W || b.rect.right <= 0;
      if (fullyOffStage) continue;
      if (allowAutoHiddenBottomBar && b.dataset.siglusAction !== undefined && b.rect.top >= SCREEN_H - 2) continue;
      if (b.rect.left < -6 || b.rect.right > SCREEN_W + 6 || b.rect.top < -6 || b.rect.bottom > SCREEN_H + 6) {
        failures.push(`Button clipped at ${SCREEN_W}x${SCREEN_H}: ${JSON.stringify({aria: b.aria, ds: b.dataset, rect: b.rect})}`);
      }
      if (checkHitTest && !b.hitOk) {
        failures.push(`Button failed hit-test: ${JSON.stringify({aria: b.aria, ds: b.dataset, rect: b.rect, hitTag: b.hitTag})}`);
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

  const layerSig = (s) => s.visibleLayerVisuals.map((v) => `${v.tag}:${v.key}`).sort().join('|');

  const assertRoundTripClean = (label, before, after) => {
    const diffs = [];
    if (layerSig(before) !== layerSig(after)) diffs.push(`layers: ${layerSig(before)} vs ${layerSig(after)}`);
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
      if (profileCfg.title?.configButton && CONFIG_SCENE) {
        const cfgBtn = matchButton(titleState.buttons, profileCfg.title.configButton);
        if (cfgBtn) {
          await clickAt(cfgBtn.rect.cx, cfgBtn.rect.cy);
          await waitFor(`window.__runtime?.currentPlayer?.vm?.frames?.at?.(-1)?.scene?.name === ${JSON.stringify(CONFIG_SCENE)} && window.__runtime?.currentPlayer?.cancelGroups?.size > 0`, 12000);
          await delay(500);
          await assertLayoutAndHitTests('title-config');
          await rightClickStage();
          const back = await waitFor(`window.__runtime?.currentPlayer?.vm?.frames?.at?.(-1)?.scene?.name === ${JSON.stringify(MENU_SCENE)} && window.__runtime?.currentPlayer?.activeGroups?.size > 0`, 10000);
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
      if (CANCEL_SCENE && qm) {
        // RC -> RC
        const b1 = await inspectState();
        await rightClickStage();
        await waitFor("window.__runtime?.currentPlayer?.systemCallActive === true && window.__runtime?.currentPlayer?.activeGroups?.size > 0", 6000);
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
        await waitFor("window.__runtime?.currentPlayer?.systemCallActive === true && window.__runtime?.currentPlayer?.activeGroups?.size > 0", 6000);
        await delay(400);
        await pressKey('Escape', 'Escape', 27);
        await waitFor("window.__runtime?.currentPlayer?.systemCallActive === false", 6000);
        await delay(350);
        console.log('RC->Esc diffs:', assertRoundTripClean('rc->esc', b2, await inspectState()));

        // RC -> Close btn
        if (qm.closeButtonId !== undefined) {
          const b3 = await inspectState();
          await rightClickStage();
          await waitFor("window.__runtime?.currentPlayer?.systemCallActive === true && window.__runtime?.currentPlayer?.activeGroups?.size > 0", 6000);
          await delay(400);
          const closeBtn = (await inspectState()).buttons.find((b) => b.dataset.siglusButton === String(qm.closeButtonId));
          if (closeBtn) await clickAt(closeBtn.rect.cx, closeBtn.rect.cy);
          else await rightClickStage();
          await waitFor("window.__runtime?.currentPlayer?.systemCallActive === false", 6000);
          await delay(350);
          console.log('RC->CloseBtn diffs:', assertRoundTripClean('rc->closebtn', b3, await inspectState()));
        }

        // Nested QM -> Save -> Cancel
        if (qm.saveButtonId !== undefined && SAVE_SCENE) {
          const b4 = await inspectState();
          await rightClickStage();
          await waitFor("window.__runtime?.currentPlayer?.systemCallActive === true && window.__runtime?.currentPlayer?.activeGroups?.size > 0", 6000);
          await delay(400);
          const sb = (await inspectState()).buttons.find((b) => b.dataset.siglusButton === String(qm.saveButtonId));
          if (sb) {
            await clickAt(sb.rect.cx, sb.rect.cy);
            await waitFor(`window.__runtime?.currentPlayer?.vm?.frames?.at?.(-1)?.scene?.name === ${JSON.stringify(SAVE_SCENE)} && window.__runtime?.currentPlayer?.activeGroups?.size > 0`, 8000);
            await delay(500);
            if ((await inspectState()).visibleLayerVisuals.length === 0) errors.push('[nested-save] Main layers black');
            await assertLayoutAndHitTests('nested-save-open');
          }
          for (let t = 0; t < 4 && (await inspectState()).systemCallActive; t++) {
            await rightClickStage();
            await delay(400);
          }
          console.log('Nested QM->Save->Cancel diffs:', assertRoundTripClean('nested-save-cancel', b4, await inspectState()));
        }

        // Nested QM -> Config -> Cancel
        if (qm.configButtonId !== undefined && CONFIG_SCENE) {
          const b5 = await inspectState();
          await rightClickStage();
          await waitFor("window.__runtime?.currentPlayer?.systemCallActive === true && window.__runtime?.currentPlayer?.activeGroups?.size > 0", 6000);
          await delay(400);
          const cb = (await inspectState()).buttons.find((b) => b.dataset.siglusButton === String(qm.configButtonId));
          if (cb) {
            await clickAt(cb.rect.cx, cb.rect.cy);
            await waitFor(`window.__runtime?.currentPlayer?.vm?.frames?.at?.(-1)?.scene?.name === ${JSON.stringify(CONFIG_SCENE)} && window.__runtime?.currentPlayer?.activeGroups?.size > 0`, 8000);
            await delay(500);
            if ((await inspectState()).visibleLayerVisuals.length === 0) errors.push('[nested-cfg] Main layers black');
            await assertLayoutAndHitTests('nested-config-open');
          }
          for (let t = 0; t < 4 && (await inspectState()).systemCallActive; t++) {
            await rightClickStage();
            await delay(400);
          }
          console.log('Nested QM->Config->Cancel diffs:', assertRoundTripClean('nested-config-cancel', b5, await inspectState()));
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
      }

      // 4. Verify 1 single left-click advances cleanly
      const before1 = await inspectState();
      await clickAt(Math.round(sr.left + sr.width * 0.5), Math.round(sr.top + sr.height * 0.35));
      await delay(500);
      const after1 = await inspectState();
      if (after1.pages <= before1.pages && after1.dialogue === before1.dialogue) {
        errors.push(`[1-click] Left-click did not advance (${before1.pages}->${after1.pages})`);
      } else {
        console.log('1 single left-click advanced cleanly:', before1.pages, '->', after1.pages);
      }

      // 5. Save/Load + QSave/QLoad parity (via Quick Menu UI or MWND action buttons)
      const snapFull = () =>
        evaluate(`(() => ({
          debug: window.__siglusDebug.snapshot(),
          dialogue: document.querySelector('[data-siglus-dialogue]')?.textContent?.trim() ?? '',
          speaker: document.querySelector('[data-siglus-speaker]')?.textContent?.trim() ?? '',
        }))()`);

      const confirmIfDialog = async () => {
        const dc = qm?.confirmDialog;
        if (!dc) return;
        const s = await inspectState();
        if (s.scene !== dc.scene) return;
        const yes = s.buttons.find((b) => (dc.yesAria && b.aria === dc.yesAria) || (b.dataset.siglusButton === '1' && b.dataset.siglusGroup === String(dc.group)));
        if (yes) {
          await clickAt(yes.rect.cx, yes.rect.cy);
          await delay(600);
        }
      };

      if (qm?.saveButtonId !== undefined && qm?.loadButtonId !== undefined && SAVE_SCENE && LOAD_SCENE) {
        const preSave = await snapFull();
        await rightClickStage();
        await waitFor("window.__runtime?.currentPlayer?.systemCallActive === true && window.__runtime?.currentPlayer?.activeGroups?.size > 0", 6000);
        await delay(350);
        const sb = (await inspectState()).buttons.find((b) => b.dataset.siglusButton === String(qm.saveButtonId));
        await clickAt(sb.rect.cx, sb.rect.cy);
        await waitFor(`window.__runtime?.currentPlayer?.vm?.frames?.at?.(-1)?.scene?.name === ${JSON.stringify(SAVE_SCENE)} && window.__runtime?.currentPlayer?.activeGroups?.size > 0`, 8000);
        await delay(500);
        const sv0 = (await inspectState()).buttons.find((b) => {
          const id = Number(b.dataset.siglusButton);
          return Number.isInteger(id) && id >= (qm.slotButtonMin ?? 0) && id <= (qm.slotButtonMax ?? 15);
        });
        if (sv0) {
          await clickAt(sv0.rect.cx, sv0.rect.cy);
          await delay(500);
          await confirmIfDialog();
          for (let t = 0; t < 4 && (await inspectState()).systemCallActive; t++) {
            await rightClickStage();
            await delay(400);
          }
          for (let k = 0; k < 4; k++) {
            await pressKey('Enter', 'Enter', 13);
            await delay(250);
          }
          await rightClickStage();
          await waitFor("window.__runtime?.currentPlayer?.systemCallActive === true && window.__runtime?.currentPlayer?.activeGroups?.size > 0", 6000);
          await delay(350);
          const lb = (await inspectState()).buttons.find((b) => b.dataset.siglusButton === String(qm.loadButtonId));
          await clickAt(lb.rect.cx, lb.rect.cy);
          await waitFor(`window.__runtime?.currentPlayer?.vm?.frames?.at?.(-1)?.scene?.name === ${JSON.stringify(LOAD_SCENE)} && window.__runtime?.currentPlayer?.activeGroups?.size > 0`, 8000);
          await delay(500);
          const ld0 = (await inspectState()).buttons.find((b) => b.dataset.siglusButton === sv0.dataset.siglusButton);
          if (ld0) {
            await clickAt(ld0.rect.cx, ld0.rect.cy);
            await delay(500);
            await confirmIfDialog();
          }
          await waitFor("window.__runtime?.currentPlayer?.waitingForPage === true && window.__runtime?.currentPlayer?.systemCallActive === false", 10000);
          await delay(400);
          const postLoad = await snapFull();
          const diffs = [];
          if (preSave.dialogue !== postLoad.dialogue) diffs.push('dialogue');
          if (preSave.speaker !== postLoad.speaker) diffs.push('speaker');
          if (preSave.debug.bgm !== postLoad.debug.bgm) diffs.push('bgm');
          if (preSave.debug.vm.frames.at(-1)?.scene !== postLoad.debug.vm.frames.at(-1)?.scene) diffs.push('scene');
          console.log('Save/Load UI parity diffs:', diffs);
          for (const d of diffs) errors.push(`[save-load] ${d} mismatch`);
        }
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
      if (wmvList.length || omvList.length) {
        const movieRes = await evaluate(`(async () => {
          const p = window.__runtime.currentPlayer;
          const out = [];
          for (const name of ${JSON.stringify(wmvList)}) {
            let err = null;
            const run = p.movie(name, true).catch((e) => { err = String(e); });
            await new Promise((r) => setTimeout(r, 900));
            const stage = document.getElementById('siglus-surface')?.firstElementChild;
            stage?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
            await Promise.race([run, new Promise((r) => setTimeout(r, 3000))]);
            out.push({name, kind: 'wmv', error: err});
          }
          for (const name of ${JSON.stringify(omvList)}) {
            let err = null;
            let dims = null;
            try {
              await p.display.stageMovieEffect({slot: 99, name, layer: 100, loop: false, scale: [1000, 1000], elapsed: 0});
              await new Promise((r) => setTimeout(r, 600));
              const eff = p.display.pendingEffects?.get(99);
              const cvs = eff?.layer?.querySelector('canvas');
              dims = cvs ? {w: cvs.width, h: cvs.height} : null;
              if (eff?.movie) eff.movie.close();
              p.display.pendingEffects?.delete(99);
            } catch (e) { err = String(e); }
            out.push({name, kind: 'omv', dims, error: err});
          }
          return out;
        })()`);
        console.log('Movie/OMV telemetry:', JSON.stringify(movieRes));
        for (const m of movieRes) {
          if (m.error) errors.push(`[movie:${m.name}] ${m.error}`);
          if (m.kind === 'omv' && (!m.dims || m.dims.w <= 0 || m.dims.h <= 0)) errors.push(`[movie:${m.name}] zero OMV dims`);
        }
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
        await waitFor(`window.__runtime?.currentPlayer?.vm?.frames?.at?.(-1)?.scene?.name === ${JSON.stringify(ex.expectedScene)} && window.__runtime?.currentPlayer?.activeGroups?.size > 0`, 12000);
        await delay(800);
      } else {
        await delay(1000);
      }
      await assertLayoutAndHitTests('extras-main');
      for (const tab of ex?.tabs ?? []) {
        const cur = await inspectState();
        const tabBtn = cur.buttons.find((b) => b.dataset.siglusButton === String(tab.buttonId));
        if (tabBtn) {
          await clickAt(tabBtn.rect.cx, tabBtn.rect.cy);
          await waitFor(`window.__runtime?.currentPlayer?.vm?.frames?.at?.(-1)?.scene?.name === ${JSON.stringify(tab.expectedScene)} && window.__runtime?.currentPlayer?.activeGroups?.size > 0`, 10000);
          await delay(800);
          await assertLayoutAndHitTests(`extras-${tab.expectedScene}`);
        }
      }
      await rightClickStage();
      await waitFor(`window.__runtime?.currentPlayer?.vm?.frames?.at?.(-1)?.scene?.name === ${JSON.stringify(MENU_SCENE)}`, 10000);
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
      const setCtrl = async (down) => {
        if (down === ctrlHeld) return;
        ctrlHeld = down;
        await send('Input.dispatchKeyEvent', {type: down ? 'keyDown' : 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17});
      };

      while (Date.now() - t0 < maxSeconds * 1000 && errors.length === 0) {
        await delay(170);
        const s = await inspectState();
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

        if (s.pages >= nextChaos && s.waitingForPage && !s.systemCallActive && s.dialogue && s.visibleLayerVisuals.length > 0) {
          await setCtrl(false);
          await delay(300);
          const s0 = await inspectState();
          if (s0.waitingForPage && !s0.systemCallActive && s0.dialogue && s0.visibleLayerVisuals.length > 0) {
            const kind = chaosCount % 3;
            chaosCount++;
            if (kind === 0 && CANCEL_SCENE) {
              await rightClickStage();
              if (await waitFor("window.__runtime?.currentPlayer?.systemCallActive === true && window.__runtime?.currentPlayer?.activeGroups?.size > 0", 5000)) {
                await delay(300);
                if ((await inspectState()).visibleLayerVisuals.length === 0) errors.push('[chaos:rc] black layers');
                await rightClickStage();
                await waitFor("window.__runtime?.currentPlayer?.systemCallActive === false", 5000);
                await delay(250);
                assertRoundTripClean(`chaos-${chaosCount}-rc`, s0, await inspectState());
              }
            } else if (kind === 1) {
              await pressKey(' ', 'Space', 32);
              await delay(200);
              if ((await inspectState()).messageVisible) errors.push('[chaos:space] still visible');
              await pressKey(' ', 'Space', 32);
              await delay(200);
              assertRoundTripClean(`chaos-${chaosCount}-space`, s0, await inspectState());
            } else {
              await wheelStage(-120);
              if (await waitFor("Boolean(document.querySelector('[data-siglus-history]'))", 4000)) {
                await delay(250);
                await pressKey('Escape', 'Escape', 27);
                await waitFor("!document.querySelector('[data-siglus-history]')", 4000);
                await delay(250);
                assertRoundTripClean(`chaos-${chaosCount}-backlog`, s0, await inspectState());
              }
            }
          }
          nextChaos = s.pages + chaosEvery;
          continue;
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
      console.log('CRAWL SUMMARY:', JSON.stringify({
        elapsedSec: Math.round((Date.now() - t0) / 1000),
        finalScene: fin.scene,
        pages: fin.pages,
        scenesCount: fin.scenesSeen.length,
        choicesTaken,
        chaosCount,
        watchdogChecks,
        compositesAudited,
        clippedContainersAudited,
        unhandledCommands: fin.unhandledCommands.length,
        unhandledProperties: fin.unhandledProperties.length,
      }));
    }
  }

  console.log(`\n=== RESULT [${profileCfg.name}:${MODE}] errors=${errors.length} warnings=${warnings.length} ===`);
  if (errors.length) console.log('Errors:', errors);
  if (warnings.length) console.log('Warnings:', warnings);
  if (errors.length > 0 || warnings.length > 0) process.exitCode = 1;
} finally {
  if (cdp) {
    try { await cdp.close(); } catch {}
  }
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
