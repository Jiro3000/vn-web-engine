#!/usr/bin/env node
/**
 * SiglusEngine (月の彼方で逢いましょう SweetSummerRainbow) ordinary-click benchmark
 * adapted from the Yu-RIS ordinary-click benchmark suite (brave-relirium-clicks.mjs /
 * full-route-performance.mjs / summarize-full-route-performance.py).
 *
 * Drives CLICKS ordinary dialogue clicks (default 1500) in muted headless Chrome with a
 * fixed READ_MS reading pause, collecting purely numeric telemetry + DOM text hashes
 * (zero screenshots, zero writes to the game folder).
 *
 * Usage:
 *   node tools/benchmark-siglus-ssr.mjs OUTPUT_DIR [--clicks 1500] [--read-ms 40]
 *     [--route 1] [--text-mode dom] [--profile] [--site site]
 *
 * Environment overrides:
 *   CLICKS, READ_MS, ROUTE, TEXT_MODE, PROFILE=1, SITE_ROOT, GAME, CHROME
 */
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DevToolsConnection} from './capture-browser-trace.mjs';
import {createStaticServer} from './serve-static.mjs';

const args = process.argv.slice(2);
const option = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const output = resolve(
  positional[0] ??
    (() => {
      throw new Error('Usage: node tools/benchmark-siglus-ssr.mjs OUTPUT_DIR [options]');
    })(),
);

const clicksTarget = Number(option('--clicks', process.env.CLICKS ?? 1500));
const readMs = Number(option('--read-ms', process.env.READ_MS ?? 40));
const route = String(option('--route', process.env.ROUTE ?? '1'));
const textMode = String(option('--text-mode', process.env.TEXT_MODE ?? 'dom'));
const profiling = args.includes('--profile') || process.env.PROFILE === '1';
const siteRoot = resolve(option('--site', process.env.SITE_ROOT ?? 'site'));
const gameDir = resolve(
  option('--game', process.env.GAME ?? '/Users/paul/Torrents/Games/tsuki no kanata fan disk'),
);
const chromePath = resolve(
  option(
    '--chrome',
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ),
);

await mkdir(output, {recursive: true});

async function fingerprint(dir) {
  const hash = createHash('sha256');
  let entries = 0;
  const walk = async (rel) => {
    for (const name of (await readdir(dir + rel)).sort()) {
      const full = dir + rel + '/' + name;
      const st = await lstat(full);
      hash.update(`${rel}/${name}\0${st.size}\0${st.mtimeMs}\0`);
      entries++;
      if (st.isDirectory()) await walk(rel + '/' + name);
    }
  };
  await walk('');
  return {entries, sha256: hash.digest('hex')};
}

function stats(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const p = (q) => Number(sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)].toFixed(3));
  const countGt = (limit) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] <= limit) lo = mid + 1;
      else hi = mid;
    }
    return sorted.length - lo;
  };
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const top10Slice = sorted.slice(-10);
  const top10 = top10Slice.reduce((acc, v) => acc + v, 0) / top10Slice.length;
  return {
    n: sorted.length,
    total: Number(sum.toFixed(2)),
    mean: Number((sum / sorted.length).toFixed(3)),
    gt16: countGt(16),
    gt16_67: countGt(1000 / 60),
    gt33_33: countGt(1000 / 30),
    gt50: countGt(50),
    gt100: countGt(100),
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    max: p(1),
    top10: Number(top10.toFixed(3)),
  };
}

/**
 * Injected into the browser page before clicking Play.
 * Instruments SiglusPlayer / SiglusDisplay / SiglusAudio with minimal numeric telemetry
 * mirroring Yu-RIS's full-route-performance.mjs + voice-timing.mjs.
 */
function installSiglusBenchmark(targetTextMode) {
  const button = document.getElementById('play');
  const nativeOnClick = button.onclick;
  button.onclick = function (event) {
    window.__playTime = performance.now();
    const res = nativeOnClick.call(this, event);
    const install = () => {
      const player = window.__runtime?.currentPlayer;
      if (!player?.display || !player?.audio || !player?.vm) {
        setTimeout(install, 0);
        return;
      }
      if (player.setTextMode) player.setTextMode(targetTextMode);
      const display = player.display;
      const audio = player.audio;
      const now = () => performance.now();

      const PHASE_NAMES = [
        'g00Decode',
        'composite',
        'drawObjects',
        'refreshObjects',
        'displayText',
        'audioVoice',
        'audioBgmSe',
        'saveCapture',
        'localStorage',
      ];
      const phases = new Float64Array(PHASE_NAMES.length);
      const totalPhases = new Float64Array(PHASE_NAMES.length);
      const phaseCounts = new Uint32Array(PHASE_NAMES.length);

      const responses = [];
      const g00Events = [];
      const voiceEvents = [];
      const longTasks = [];
      const rafFrames = [];
      const transitionGaps = [];
      const memory = [];

      let readyCount = 0;
      let waitingAtPage = false;
      let waitingForKey = false;
      let pageWaiter = null;
      let activeTransitionDepth = 0;
      let storyActive = false;
      let storyStartAt = 0;

      // Active click state
      let clickSeq = 0;
      let activeClick = null;
      let clickG00 = [];
      let clickVoices = [];
      let g00Needed = 0;
      let g00MediaCached = 0;
      let g00FrameCached = 0;
      let voiceStarts = 0;
      let bgmStarts = 0;
      let seStarts = 0;

      // Record direct duration per phase (safe under concurrent Promise.all and background audio).
      function recordPhase(slot, elapsed) {
        phases[slot] += elapsed;
        totalPhases[slot] += elapsed;
        phaseCounts[slot]++;
      }

      const currentWhere = () => {
        const top = player.vm?.frames?.at?.(-1);
        return [top?.scene?.name ?? '', top?.line ?? -1];
      };

      const fnv1a = (text) => {
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) {
          h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
        }
        return h.toString(16);
      };

      // Continuous rAF cadence monitor
      let lastRaf = now();
      const rafLoop = (ts) => {
        const dt = ts - lastRaf;
        lastRaf = ts;
        if (storyActive) {
          rafFrames.push(dt);
          if (activeTransitionDepth > 0 || activeClick !== null) {
            transitionGaps.push(dt);
          }
        }
        requestAnimationFrame(rafLoop);
      };
      requestAnimationFrame(rafLoop);

      // Long tasks observer
      if (
        typeof PerformanceObserver !== 'undefined' &&
        PerformanceObserver.supportedEntryTypes?.includes('longtask')
      ) {
        try {
          new PerformanceObserver((list) => {
            if (!storyActive) return;
            for (const entry of list.getEntries()) {
              longTasks.push([entry.startTime, entry.duration]);
            }
          }).observe({type: 'longtask'});
        } catch {}
      }

      // Memory sampling every 5s during story
      setInterval(() => {
        if (!storyActive) return;
        const heap = performance.memory?.usedJSHeapSize ?? null;
        if (heap !== null) memory.push([now(), heap]);
      }, 5000);

      // Hook display.graphic (G00 decode + cache hit/miss)
      const origGraphic = display.graphic.bind(display);
      display.graphic = async function (name, pattern = 0) {
        const key = String(name).toLowerCase();
        const mediaPath = `g00/${key}.g00`;
        const mediaHit = display.media?.has?.(mediaPath) ?? false;
        const frameKey = `${key}#${pattern}`;
        const frameHit = display.graphicCache?.has?.(frameKey) ?? false;
        if (storyActive) {
          g00Needed++;
          if (mediaHit) g00MediaCached++;
          if (frameHit) g00FrameCached++;
        }
        const t0 = now();
        try {
          return await origGraphic(name, pattern);
        } finally {
          const elapsed = Math.max(0, now() - t0);
          recordPhase(0, elapsed);
          if (storyActive) {
            g00Events.push([clickSeq, key, pattern, frameHit ? 1 : 0, Number(elapsed.toFixed(2))]);
            if (elapsed >= 1) clickG00.push([key, pattern, frameHit ? 1 : 0, Number(elapsed.toFixed(2))]);
          }
        }
      };

      // Hook display.compositeGraphic
      if (typeof display.compositeGraphic === 'function') {
        const origComp = display.compositeGraphic.bind(display);
        display.compositeGraphic = async function (...a) {
          const t0 = now();
          try {
            return await origComp(...a);
          } finally {
            recordPhase(1, Math.max(0, now() - t0));
          }
        };
      }

      // Hook display.drawObjects
      if (typeof display.drawObjects === 'function') {
        const origDraw = display.drawObjects.bind(display);
        display.drawObjects = async function (...a) {
          const t0 = now();
          try {
            return await origDraw(...a);
          } finally {
            recordPhase(2, Math.max(0, now() - t0));
          }
        };
      }

      // Hook display.refreshObjects
      if (typeof display.refreshObjects === 'function') {
        const origRefresh = display.refreshObjects.bind(display);
        display.refreshObjects = async function (...a) {
          const t0 = now();
          try {
            return await origRefresh(...a);
          } finally {
            recordPhase(3, Math.max(0, now() - t0));
          }
        };
      }

      // Hook display.show (track wipe transition duration as intentionalWaitMs, excluding drawObjects work)
      if (typeof display.show === 'function') {
        const origShow = display.show.bind(display);
        display.show = async function (objects, duration, buttonCb, fan) {
          const isWipe = Number(duration) > 0;
          const ownerClick = activeClick;
          if (isWipe) activeTransitionDepth++;
          const drawBefore = phases[2];
          const t0 = now();
          try {
            return await origShow(objects, duration, buttonCb, fan);
          } finally {
            if (isWipe) {
              activeTransitionDepth--;
              const wall = now() - t0;
              const workInside = phases[2] - drawBefore;
              const waitPart = Math.max(0, wall - workInside);
              if (ownerClick && ownerClick === activeClick) ownerClick.intentionalWaitMs += waitPart;
            }
          }
        };
      }

      // Hook display.closeMessageWithAnimation (intentional fade wait)
      if (typeof display.closeMessageWithAnimation === 'function') {
        const origCloseAnim = display.closeMessageWithAnimation.bind(display);
        display.closeMessageWithAnimation = async function (anime) {
          const isAnim = anime && anime.type > 0 && anime.time > 0;
          const ownerClick = activeClick;
          if (isAnim) activeTransitionDepth++;
          const t0 = now();
          try {
            return await origCloseAnim(anime);
          } finally {
            if (isAnim) {
              activeTransitionDepth--;
              if (ownerClick && ownerClick === activeClick) {
                ownerClick.intentionalWaitMs += Math.max(0, now() - t0);
              }
            }
          }
        };
      }

      // Hook display.paintMessageText & alignDomText
      if (typeof display.paintMessageText === 'function') {
        const origPaint = display.paintMessageText.bind(display);
        display.paintMessageText = function (...a) {
          const t0 = now();
          try {
            return origPaint(...a);
          } finally {
            recordPhase(4, Math.max(0, now() - t0));
          }
        };
      }

      // Hook audio.voice
      if (typeof audio.voice === 'function') {
        const origVoice = audio.voice.bind(audio);
        audio.voice = async function (id, channel = 'voice', ...rest) {
          if (storyActive && channel === 'voice') voiceStarts++;
          const t0 = now();
          try {
            return await origVoice(id, channel, ...rest);
          } finally {
            const elapsed = Math.max(0, now() - t0);
            recordPhase(5, elapsed);
            if (storyActive && channel === 'voice') {
              voiceEvents.push([clickSeq, id, Number(elapsed.toFixed(2))]);
              if (elapsed >= 1) clickVoices.push([id, Number(elapsed.toFixed(2))]);
            }
          }
        };
      }

      // Hook audio.bgm / readyBgm / pcm / soundEffect
      for (const method of ['bgm', 'readyBgm', 'pcm', 'effect']) {
        if (typeof audio[method] === 'function') {
          const orig = audio[method].bind(audio);
          audio[method] = async function (...a) {
            if (storyActive) {
              if (method === 'bgm' || method === 'readyBgm') bgmStarts++;
              else seStarts++;
            }
            const t0 = now();
            try {
              return await orig(...a);
            } finally {
              recordPhase(6, Math.max(0, now() - t0));
            }
          };
        }
      }

      // Hook player.captureSave
      if (typeof player.captureSave === 'function') {
        const origCapture = player.captureSave.bind(player);
        player.captureSave = function (...a) {
          const t0 = now();
          try {
            return origCapture(...a);
          } finally {
            recordPhase(7, Math.max(0, now() - t0));
          }
        };
      }

      // Hook localStorage.setItem
      const origSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (...a) {
        if (!storyActive) return origSetItem.apply(this, a);
        const t0 = now();
        try {
          return origSetItem.apply(this, a);
        } finally {
          recordPhase(8, Math.max(0, now() - t0));
        }
      };

      // Hook player.delay (intentional script waits during non-waitAtPage delays)
      if (typeof player.delay === 'function') {
        const origDelay = player.delay.bind(player);
        player.delay = async function (time, skippable, skipImmediately) {
          const isTimed = time !== undefined && time > 0 && !waitingAtPage;
          const isKeyWait = time === undefined && Boolean(skippable) && !waitingAtPage;
          const ownerClick = activeClick;
          if (isKeyWait) {
            waitingForKey = true;
            if (storyActive && activeClick && !activeClick.committed) commitClickResponse('to-keywait');
          }
          const t0 = now();
          try {
            return await origDelay(time, skippable, skipImmediately);
          } finally {
            if (isKeyWait) waitingForKey = false;
            if (isTimed && ownerClick && ownerClick === activeClick) {
              ownerClick.intentionalWaitMs += Math.max(0, now() - t0);
            }
          }
        };
      }

      // Finalize a click response when the next page commits or a choice appears
      function commitClickResponse(kindOverride) {
        if (!activeClick || activeClick.committed) return;
        const click = activeClick;
        click.committed = true;
        const commitAt = now();
        const commitMs = Math.max(0, commitAt - click.at);
        const waitMs = click.intentionalWaitMs;
        const workMs = Math.max(0, commitMs - waitMs);
        const phaseSnap = {};
        let measuredSum = 0;
        for (let i = 0; i < PHASE_NAMES.length; i++) {
          const v = phases[i];
          phaseSnap[PHASE_NAMES[i]] = Number(v.toFixed(3));
          measuredSum += v;
        }
        phaseSnap.vmAndOther = Number(Math.max(0, workMs - measuredSum).toFixed(3));
        const g00Copy = clickG00.slice(0, 8);
        const voiceCopy = clickVoices.slice(0, 4);
        const toWhere = currentWhere();
        requestAnimationFrame(() => {
          const rafAt = now();
          const rafMs = Math.max(0, rafAt - click.at);
          responses.push({
            index: click.index,
            kind: kindOverride ?? click.kind,
            from: click.from,
            to: toWhere,
            commitMs: Number(commitMs.toFixed(3)),
            rafMs: Number(rafMs.toFixed(3)),
            workMs: Number(workMs.toFixed(3)),
            intentionalWaitMs: Number(waitMs.toFixed(3)),
            hadWait: waitMs >= 5,
            phases: phaseSnap,
            g00: g00Copy,
            voices: voiceCopy,
          });
          if (activeClick === click) activeClick = null;
        });
      }

      // Hook player.waitAtPage (exact page-ready gate, analog of Yu-RIS H@1157 === 1)
      const origWaitAtPage = player.waitAtPage.bind(player);
      player.waitAtPage = async function () {
        waitingAtPage = true;
        readyCount++;
        if (storyActive && activeClick && !activeClick.committed) {
          commitClickResponse();
        }
        if (pageWaiter) {
          const w = pageWaiter;
          pageWaiter = null;
          w();
        }
        try {
          return await origWaitAtPage();
        } finally {
          waitingAtPage = false;
        }
      };

      // Hook display.showSelectionButtons so choice screens also resolve pending clicks
      if (typeof display.showSelectionButtons === 'function') {
        const origSel = display.showSelectionButtons.bind(display);
        display.showSelectionButtons = async function (...a) {
          const result = await origSel(...a);
          if (storyActive && activeClick && !activeClick.committed) {
            commitClickResponse('to-choice');
          }
          return result;
        };
      }

      // Capture trusted pointerdown on the stage to timestamp clicks accurately
      const surface = document.getElementById('siglus-surface');
      let pendingKind = 'dialogue';
      surface.addEventListener(
        'pointerdown',
        (ev) => {
          if (!ev.isTrusted || ev.button !== 0 || !storyActive) return;
          phases.fill(0);
          clickG00 = [];
          clickVoices = [];
          clickSeq++;
          activeClick = {
            index: clickSeq,
            kind: pendingKind,
            at: now(),
            from: currentWhere(),
            committed: false,
            intentionalWaitMs: 0,
          };
        },
        {capture: true},
      );

      window.__siglusBench = {
        startStory() {
          storyActive = true;
          storyStartAt = now();
          phases.fill(0);
          totalPhases.fill(0);
          phaseCounts.fill(0);
          responses.length = 0;
          g00Events.length = 0;
          voiceEvents.length = 0;
          longTasks.length = 0;
          rafFrames.length = 0;
          transitionGaps.length = 0;
          memory.length = 0;
          g00Needed = 0;
          g00MediaCached = 0;
          g00FrameCached = 0;
          voiceStarts = 0;
          bgmStarts = 0;
          seStarts = 0;
          clickSeq = 0;
          activeClick = null;
        },
        setClickKind(k) {
          pendingKind = k;
        },
        state() {
          const stage = surface?.firstElementChild;
          const dialogue = stage?.querySelector('[data-siglus-dialogue]')?.textContent ?? '';
          const speaker = stage?.querySelector('[data-siglus-speaker]')?.textContent ?? '';
          const canvases = stage ? stage.querySelectorAll('canvas').length : 0;
          const choices = stage
            ? [...stage.querySelectorAll('button[data-siglus-choice]')].filter(
                (b) => !b.disabled && b.getClientRects().length > 0,
              )
            : [];
          const objButtons = stage
            ? [...stage.querySelectorAll('button[data-siglus-button]')].filter(
                (b) => !b.disabled && b.getClientRects().length > 0,
              )
            : [];
          return {
            where: currentWhere(),
            pages: player.pages ?? 0,
            readyCount,
            waitingAtPage,
            waitingForKey,
            textMode: display.textMode,
            canvases,
            dialogueChars: dialogue.length,
            speakerHash: fnv1a(speaker),
            dialogueHash: fnv1a(dialogue),
            flatHash: fnv1a(speaker + '\u0001' + dialogue),
            choiceCount: choices.length,
            objButtonCount: objButtons.length,
          };
        },
        waitForNextReady(afterReadyCount, timeoutMs) {
          if (readyCount > afterReadyCount && waitingAtPage) return Promise.resolve(true);
          return new Promise((resolveWait) => {
            const finish = (ok) => {
              clearTimeout(timer);
              if (pageWaiter === onReady) pageWaiter = null;
              resolveWait(ok);
            };
            const onReady = () => {
              if (readyCount > afterReadyCount) finish(true);
            };
            const timer = setTimeout(() => finish(false), timeoutMs);
            pageWaiter = onReady;
          });
        },
        exportData() {
          const storyEndAt = now();
          const phaseTotals = {};
          for (let i = 0; i < PHASE_NAMES.length; i++) {
            phaseTotals[PHASE_NAMES[i]] = {
              totalMs: Number(totalPhases[i].toFixed(2)),
              count: phaseCounts[i],
            };
          }
          return {
            playAt: window.__playTime,
            storyStartAt,
            storyEndAt,
            storyWallMs: Number((storyEndAt - storyStartAt).toFixed(2)),
            viewport: [innerWidth, innerHeight, devicePixelRatio],
            responses,
            phaseTotals,
            g00: {
              needed: g00Needed,
              cached: g00FrameCached,
              mediaCached: g00MediaCached,
              decodes: g00Events.length,
              decodeMs: g00Events.map((e) => e[4]),
            },
            audio: {
              voiceStarts,
              bgmStarts,
              seStarts,
              voiceDecodeMs: voiceEvents.map((e) => e[2]),
            },
            rafFrames,
            transitionGaps,
            longTasks: longTasks.map((t) => t[1]),
            memory,
            end: {
              where: currentWhere(),
              pages: player.pages ?? 0,
              readyCount,
            },
          };
        },
      };
    };
    install();
    return res;
  };
}

const gameBefore = await fingerprint(gameDir);
try {
  const repoRoot = resolve(siteRoot, '..');
  const rev = execFileSync('git', ['-C', repoRoot, 'describe', '--always', '--dirty'], {
    encoding: 'utf8',
  }).trim();
  await writeFile(join(output, 'revision.txt'), rev + '\n');
} catch {}

const profileDir = await mkdtemp(join(tmpdir(), 'ssr-bench-'));
const server = await createStaticServer({root: siteRoot});
let child;
let cdp;

const report = {
  site: siteRoot,
  route,
  clicks: clicksTarget,
  readMs,
  textMode,
  errors: [],
  console: [],
  decisions: [],
  domText: [],
};

try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  child = spawn(
    chromePath,
    [
      '--headless=new',
      '--mute-audio',
      '--incognito',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,800',
      '--use-angle=metal',
      '--user-data-dir=' + profileDir,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    {stdio: ['ignore', 'ignore', 'pipe']},
  );

  const endpoint = await new Promise((done, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 20000);
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
      reject(new Error(`Chrome exited ${code}\n${stderr}`));
    });
  });

  cdp = await DevToolsConnection.connect(endpoint);
  const {targetId} = await cdp.command('Target.createTarget', {url: `${origin}/siglus.html`});
  const {sessionId} = await cdp.command('Target.attachToTarget', {targetId, flatten: true});
  const send = (method, params) => cdp.command(method, params, sessionId);

  cdp.on('event', ({method, params}) => {
    if (method === 'Runtime.exceptionThrown') {
      report.errors.push(
        params.exceptionDetails.exception?.description ?? params.exceptionDetails.text,
      );
    } else if (
      method === 'Runtime.consoleAPICalled' &&
      ['warning', 'error'].includes(params.type)
    ) {
      report.console.push({
        type: params.type,
        args: params.args.map((a) => String(a.value ?? a.description ?? '').slice(0, 300)),
      });
    }
  });

  for (const domain of ['Runtime', 'DOM', 'Page']) await send(domain + '.enable');
  await send('Emulation.setFocusEmulationEnabled', {enabled: true});

  const evaluate = async (expression) => {
    const {result, exceptionDetails} = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  };

  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  };

  // Load game folder
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`Boolean(document.getElementById('files'))`)) break;
    await delay(100);
  }
  const {root: doc} = await send('DOM.getDocument', {depth: -1, pierce: true});
  const {nodeId} = await send('DOM.querySelector', {nodeId: doc.nodeId, selector: '#files'});
  await send('DOM.setFileInputFiles', {nodeId, files: [gameDir]});
  for (let i = 0; i < 600; i++) {
    if (await evaluate(`!document.getElementById('play').disabled`)) break;
    if (i === 599) throw new Error('Installation did not become ready');
    await delay(100);
  }

  // Locate built siglus runtime module exporting currentPlayer
  let runtimePath;
  for (const name of await readdir(join(siteRoot, 'assets'))) {
    if (
      name.startsWith('siglus-') &&
      name.endsWith('.js') &&
      /export\s*\{[^}]*\bcurrentPlayer\b/.test(await readFile(join(siteRoot, 'assets', name), 'utf8'))
    ) {
      runtimePath = '/assets/' + name;
      break;
    }
  }
  if (!runtimePath) throw new Error('Could not find siglus runtime chunk exporting currentPlayer');

  await evaluate(`import(${JSON.stringify(origin + runtimePath)}).then((m) => { window.__runtime = m; })`);
  await evaluate(`(${installSiglusBenchmark})(${JSON.stringify(textMode)})`);

  // Click Play
  const playBox = await evaluate(`(() => {
    const r = document.getElementById('play').getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`);
  await clickAt(playBox.x, playBox.y);

  // Boot through _00dialog -> _01menu -> START (2) -> Route select (group 2, button `route`)
  let dismissedDialog = false;
  let clickedStart = false;
  let clickedRoute = false;
  const bootDeadline = Date.now() + 60000;
  while (Date.now() < bootDeadline) {
    await delay(200);
    if (report.errors.length) throw new Error('Boot error: ' + report.errors.join('; '));
    const nav = await evaluate(`(() => {
      const bench = window.__siglusBench;
      const stage = document.querySelector('#siglus-surface')?.firstElementChild;
      if (!bench || !stage) return null;
      const st = bench.state();
      const btns = [...stage.querySelectorAll('button[data-siglus-button]')].filter((b) => {
        const r = b.getBoundingClientRect();
        const cs = getComputedStyle(b);
        return !b.disabled && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5 && r.width > 0 && r.height > 0;
      }).map((b) => {
        const r = b.getBoundingClientRect();
        return {id: b.dataset.siglusButton, group: b.dataset.siglusGroup, x: r.left + r.width / 2, y: r.top + r.height / 2};
      });
      return {st, btns};
    })()`);
    if (!nav) continue;
    if (nav.st.waitingAtPage && clickedRoute) break;

    if (!dismissedDialog) {
      const dlg = nav.btns.find((b) => b.group === '8' && b.id === '1');
      if (dlg) {
        await clickAt(dlg.x, dlg.y);
        dismissedDialog = true;
        await delay(300);
        continue;
      }
    }
    if (!clickedStart) {
      const startBtn = nav.btns.find((b) => b.group === '0' && b.id === '2');
      if (startBtn) {
        await delay(400); // let menu wipe finish cleanly
        await clickAt(startBtn.x, startBtn.y);
        clickedStart = true;
        await delay(400);
        continue;
      }
    }
    if (clickedStart && !clickedRoute) {
      const routeBtn = nav.btns.find((b) => b.group === '2' && b.id === route);
      if (routeBtn) {
        await delay(400);
        await clickAt(routeBtn.x, routeBtn.y);
        clickedRoute = true;
        await delay(400);
        continue;
      }
    }
  }

  // Wait for first dialogue page
  const firstReady = await evaluate(`window.__siglusBench.waitForNextReady(0, 30000)`);
  if (!firstReady) throw new Error('Never reached first dialogue page after selecting route ' + route);
  await delay(250);

  // Start measured 1,500-click benchmark window
  await evaluate(`window.__siglusBench.startStory()`);
  if (profiling) {
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', {interval: 500});
    await send('Profiler.start');
  }

  const stageCenter = await evaluate(`(() => {
    const r = document.querySelector('#siglus-surface').firstElementChild.getBoundingClientRect();
    return {x: r.left + r.width * 0.5, y: r.top + r.height * 0.5};
  })()`);
  await send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...stageCenter});

  const t0 = Date.now();
  let dialogueClicks = 0;
  let lastProgressAt = Date.now();
  let lastReadyCount = (await evaluate(`window.__siglusBench.state()`)).readyCount;
  let lastLogged = 0;

  while (dialogueClicks < clicksTarget) {
    if (report.errors.length) {
      throw new Error(`Runtime error at click ${dialogueClicks}: ${report.errors[0]}`);
    }
    const st = await evaluate(`window.__siglusBench.state()`);

    if (st.waitingAtPage) {
      lastProgressAt = Date.now();
      report.domText.push({
        click: dialogueClicks,
        page: st.pages,
        where: st.where,
        chars: st.dialogueChars,
        canvases: st.canvases,
        flat: st.flatHash,
      });
      if (readMs > 0) await delay(readMs);
      await evaluate(`window.__siglusBench.setClickKind('dialogue')`);
      const beforeReady = st.readyCount;
      await clickAt(stageCenter.x, stageCenter.y);
      dialogueClicks++;
      if (dialogueClicks >= lastLogged + 250 || dialogueClicks === clicksTarget) {
        lastLogged = dialogueClicks;
        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `PROGRESS click=${dialogueClicks}/${clicksTarget} page=${st.pages} scene=${st.where[0]}:${st.where[1]} wall=${elapsedSec}s`,
        );
      }
      // Wait for next page ready (or fall through if a choice / transition takes >1.2s)
      const gotNext = await evaluate(`window.__siglusBench.waitForNextReady(${beforeReady}, 1200)`);
      if (gotNext) {
        lastReadyCount = beforeReady + 1;
        continue;
      }
      continue;
    }

    // Handle SELBTN choice deterministically (always pick first enabled choice 0)
    if (st.choiceCount > 0) {
      const choicePt = await evaluate(`(() => {
        const b = [...document.querySelectorAll('button[data-siglus-choice]')].find((el) => !el.disabled && el.getClientRects().length > 0);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return {choice: Number(b.dataset.siglusChoice), x: r.left + r.width / 2, y: r.top + r.height / 2};
      })()`);
      if (choicePt) {
        report.decisions.push({click: dialogueClicks, where: st.where, choice: choicePt.choice});
        console.log('CHOICE', JSON.stringify(report.decisions.at(-1)));
        await evaluate(`window.__siglusBench.setClickKind('choice')`);
        await clickAt(choicePt.x, choicePt.y);
        await send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...stageCenter});
        lastProgressAt = Date.now();
        await delay(150);
        continue;
      }
    }

    // Explicit key-wait pause (non-dialogue click-to-continue)
    if (st.waitingForKey) {
      if (readMs > 0) await delay(readMs);
      await evaluate(`window.__siglusBench.setClickKind('keywait')`);
      await clickAt(stageCenter.x, stageCenter.y);
      lastProgressAt = Date.now();
      await delay(100);
      continue;
    }

    // Wait briefly for wipe / animation / timed delay to finish
    const gotReady = await evaluate(`window.__siglusBench.waitForNextReady(${lastReadyCount}, 1000)`);
    if (gotReady) {
      lastReadyCount++;
      lastProgressAt = Date.now();
      continue;
    }

    // If stuck >15s (e.g., an unskippable/skippable wait or movie or click-to-continue overlay), nudge once
    if (Date.now() - lastProgressAt > 15000) {
      await evaluate(`window.__siglusBench.setClickKind('nudge')`);
      await clickAt(stageCenter.x, stageCenter.y);
      lastProgressAt = Date.now();
    }
    if (Date.now() - t0 > 900000) {
      throw new Error(`Benchmark timed out at click ${dialogueClicks} (${JSON.stringify(st)})`);
    }
  }

  // Wait 2 frames so the final click's rAF callback records cleanly
  await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  report.wallSeconds = Number(((Date.now() - t0) / 1000).toFixed(3));
  report.complete = dialogueClicks === clicksTarget && report.errors.length === 0;

  if (profiling) {
    const {profile} = await send('Profiler.stop');
    await writeFile(join(output, 'profile.cpuprofile'), JSON.stringify(profile));
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    const dt = profile.timeDeltas ?? [];
    for (let i = 0; i < profile.samples.length; i++) {
      const node = byId.get(profile.samples[i]);
      const f = node.callFrame;
      const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
    }
    const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
    report.profileTop = [...self]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([k, v]) => [k, Math.round(v), Number(((100 * v) / total).toFixed(1))]);
  }

  const exported = await evaluate(`window.__siglusBench.exportData()`);
  const dialogueResponses = exported.responses.filter((r) => r.kind === 'dialogue');
  const ordinaryResponses = dialogueResponses.filter((r) => !r.hadWait);

  const gameAfter = await fingerprint(gameDir);
  report.game = {
    before: gameBefore,
    after: gameAfter,
    unchanged: gameBefore.sha256 === gameAfter.sha256,
  };
  report.domSummary = {
    clicks: report.domText.length,
    withText: report.domText.filter((r) => r.chars > 0).length,
    changed: report.domText.filter((r, i) => i > 0 && r.flat !== report.domText[i - 1].flat).length,
  };

  const summary = {
    complete: Boolean(report.complete && report.game.unchanged),
    route,
    clickLimit: {clicks: clicksTarget, readMs, textMode},
    revision: (await readFile(join(output, 'revision.txt'), 'utf8').catch(() => '')).trim() || null,
    storyWallMs: exported.storyWallMs,
    clicksPerSecond: Number((dialogueClicks / (exported.storyWallMs / 1000)).toFixed(2)),
    end: exported.end,
    decisions: report.decisions,
    counts: {
      totalResponses: exported.responses.length,
      dialogueClicks: dialogueResponses.length,
      ordinaryClicks: ordinaryResponses.length,
      transitionClicks: dialogueResponses.length - ordinaryResponses.length,
    },
    clickToCommit: stats(ordinaryResponses.map((r) => r.commitMs)),
    clickToRenderOpportunity: stats(ordinaryResponses.map((r) => r.rafMs)),
    allClicksWork: stats(dialogueResponses.map((r) => r.workMs)),
    rafFrames: stats(exported.rafFrames),
    transitionGaps: stats(exported.transitionGaps),
    mainThreadLongTasks: stats(exported.longTasks),
    phaseTotals: exported.phaseTotals,
    g00: {
      needed: exported.g00.needed,
      cached: exported.g00.cached,
      mediaCached: exported.g00.mediaCached,
      hitRate: exported.g00.needed
        ? Number(((exported.g00.cached / exported.g00.needed) * 100).toFixed(2))
        : 100,
      mediaHitRate: exported.g00.needed
        ? Number(((exported.g00.mediaCached / exported.g00.needed) * 100).toFixed(2))
        : 100,
      decodeMs: stats(exported.g00.decodeMs),
    },
    audio: {
      voiceStarts: exported.audio.voiceStarts,
      bgmStarts: exported.audio.bgmStarts,
      seStarts: exported.audio.seStarts,
      voiceDecodeMs: stats(exported.audio.voiceDecodeMs),
    },
    peakJsHeapMiB: exported.memory.length
      ? Number((Math.max(...exported.memory.map((m) => m[1])) / (1024 * 1024)).toFixed(2))
      : null,
    worstResponses: [...dialogueResponses]
      .sort((a, b) => b.workMs - a.workMs)
      .slice(0, 20),
    worstOrdinaryRaf: [...ordinaryResponses]
      .sort((a, b) => b.rafMs - a.rafMs)
      .slice(0, 20),
    console: {
      exceptions: report.errors.length,
      warningsAndErrors: report.console.length,
    },
    gameUnchanged: report.game.unchanged,
    viewport: exported.viewport,
  };

  await writeFile(join(output, 'responses.json'), JSON.stringify(exported.responses) + '\n');
  await writeFile(join(output, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log('\n=== SIGLUS SSR BENCHMARK SUMMARY ===');
  console.log(
    JSON.stringify(
      {
        complete: summary.complete,
        storyWallMs: summary.storyWallMs,
        clicksPerSecond: summary.clicksPerSecond,
        end: summary.end,
        counts: summary.counts,
        clickToRenderOpportunity: summary.clickToRenderOpportunity,
        allClicksWork: summary.allClicksWork,
        transitionGaps: summary.transitionGaps,
        mainThreadLongTasks: summary.mainThreadLongTasks,
        phaseTotals: summary.phaseTotals,
        g00: {
          needed: summary.g00.needed,
          cached: summary.g00.cached,
          hitRate: summary.g00.hitRate,
          totalMs: summary.g00.decodeMs?.total ?? 0,
        },
        audio: {
          voiceStarts: summary.audio.voiceStarts,
          bgmStarts: summary.audio.bgmStarts,
          seStarts: summary.audio.seStarts,
          voiceTotalMs: summary.audio.voiceDecodeMs?.total ?? 0,
        },
        peakJsHeapMiB: summary.peakJsHeapMiB,
        console: summary.console,
        gameUnchanged: summary.gameUnchanged,
      },
      null,
      2,
    ),
  );
  if (!summary.complete || summary.console.exceptions > 0) {
    process.exitCode = 1;
  }
} finally {
  try {
    cdp?.close();
  } catch {}
  try {
    child?.kill('SIGKILL');
  } catch {}
  server.close();
  await delay(300);
  await rm(profileDir, {recursive: true, force: true});
}
