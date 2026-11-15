import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DevToolsConnection} from './capture-browser-trace.mjs';
import {createStaticServer} from './serve-static.mjs';

const [folder, browser, disassemblyDirectory] = process.argv.slice(2);
const diagnosticPages = Number(process.env.SIGLUS_DIAGNOSTIC_PAGES ?? 0);
const domRoute = process.env.SIGLUS_TEXT_MODE === 'dom';
const slideOnly = process.env.SIGLUS_SLIDE_ONLY === '1';
const pauseSaveOnly = process.env.SIGLUS_PAUSE_SAVE_ONLY === '1';
const musicOnly = process.env.SIGLUS_MUSIC_ONLY === '1';
const autoOnly = process.env.SIGLUS_AUTOSAVE_ONLY === '1';
const quickOnly = process.env.SIGLUS_QUICK_ONLY === '1';
const historyOnly = process.env.SIGLUS_HISTORY_ONLY === '1';
const skipOnly = process.env.SIGLUS_READ_SKIP_ONLY === '1';
const cancelOnly = process.env.SIGLUS_CANCEL_ONLY === '1';
const frameLockOnly = process.env.SIGLUS_FRAME_LOCK_ONLY === '1';
const manageOnly = process.env.SIGLUS_SLOT_MANAGEMENT_ONLY === '1';
const loadOnly = process.env.SIGLUS_LOAD_ONLY === '1';
const configOnly = process.env.SIGLUS_CONFIG_ONLY === '1';
const freshConfiguration = configOnly && process.env.SIGLUS_CONFIG_FRESH === '1';
const openingOnly = process.env.SIGLUS_OPENING_ONLY === '1';
const alignmentOnly = process.env.SIGLUS_ALIGNMENT_ONLY === '1';
const typingOnly = process.env.SIGLUS_TYPING_ONLY === '1';
const digest = (value) => createHash('sha256').update(value).digest('hex');
if (!folder || !browser || !disassemblyDirectory)
  throw new Error('Usage: node tools/verify-siglus.mjs GAME_FOLDER CHROMIUM DISASSEMBLY_DIRECTORY');

async function referenceScripts(directory) {
  const scripts = new Map();
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.dat.txt')) continue;
    const lines = (await readFile(join(directory, file), 'utf8')).split(/\r?\n/);
    const name = lines.find((line) => line.startsWith('scene_name: '))?.slice(12);
    const start = lines.indexOf('---- scn_bytes disassembly ----');
    if (!name || start < 0) continue;
    let line = 0;
    const tags = new Map();
    const edges = new Map();
    const instructions = [];
    for (const instruction of lines.slice(start + 1)) {
      const match = /^([\dA-F]{8}): CD_(\w+)(?: (.*))?$/.exec(instruction);
      if (!match) continue;
      const [, offset, op, body = ''] = match;
      const address = Number.parseInt(offset, 16);
      const target = / -> ([\dA-F]{8})/.exec(body)?.[1];
      instructions.push({address, op, target: target ? Number.parseInt(target, 16) : undefined});
      if (op === 'NL') {
        line = Number(body);
        continue;
      }
      if (!['COMMAND', 'TEXT', 'NAME'].includes(op)) continue;
      const flag = /\bread_flag=(\d+)/.exec(body);
      const entry = {
        offset: Number.parseInt(offset, 16),
        line,
        tag: op.toLowerCase(),
        readFlag: flag ? Number(flag[1]) : undefined,
      };
      if (op === 'COMMAND') {
        entry.code = Number.parseInt(/\bec=0x([\dA-F]+)/.exec(body)?.[1], 16);
        entry.argc = Number(/\bargc=(\d+)/.exec(body)?.[1]);
      } else {
        const quoted = /"(.*)"$/.exec(body)?.[1];
        const value = quoted?.replace(
          /\\([\\rnt])/g,
          (_, c) => ({r: '\r', n: '\n', t: '\t', '\\': '\\'})[c],
        );
        if (value !== undefined) entry.hash = digest(value);
      }
      tags.set(entry.offset, entry);
    }
    const entries = new Map(
      lines
        .filter((line) => /^Z\d+ = /.test(line))
        .map((line) => {
          const [id, offset] = line.slice(1).split(' = ');
          return [Number(id), Number.parseInt(offset, 16)];
        }),
    );
    for (const [i, {address, op, target}] of instructions.entries()) {
      if (op === 'RETURN' || op === 'EOF') edges.set(address, []);
      else if (op === 'GOTO') edges.set(address, [target]);
      else edges.set(address, [instructions[i + 1]?.address, target].filter(Number.isInteger));
    }
    scripts.set(name, {tags, entries, edges});
  }
  return scripts;
}

function compareTags(trace, scripts, {compareSourceLine = true} = {}) {
  for (const tag of trace) {
    const {tags} = scripts.get(tag.scene) ?? {};
    const expected = tags?.get(tag.offset);
    assert.ok(expected, `Missing reference tag at ${tag.scene}:${tag.offset.toString(16)}`);
    const {offset, line, readFlag} = tag;
    const fields = {offset, line: compareSourceLine ? line : expected.line, tag: tag.tag, readFlag};
    assert.deepEqual(
      tag.tag === 'command'
        ? {...fields, code: tag.path.at(-1), argc: tag.args.length}
        : {...fields, hash: digest(tag.value)},
      expected,
    );
  }
}

function compareOpening(trace, scripts, scene, entry, lineCount) {
  compareTags(trace, scripts);
  const actual = trace.filter((tag) => tag.scene === scene && tag.offset >= entry);
  const expected = [];
  let text = 0;
  for (const tag of scripts.get(scene).tags.values()) {
    if (tag.offset < entry) continue;
    expected.push(tag.offset);
    if (tag.tag === 'text') text++;
    if (text === lineCount && tag.tag === 'command' && tag.code === 14) break;
  }
  assert.equal(text, lineCount);
  assert.deepEqual(
    actual.map(({offset}) => offset),
    expected,
    'New Game tags follow the contiguous script stream',
  );
  return actual.length;
}

const scripts = await referenceScripts(disassemblyDirectory);
const scene = [...scripts.keys()].find((name) => name.startsWith('01_'));
const entry = scripts.get(scene)?.entries.get(2);
assert.ok(entry, 'Missing first New Game scene entry in Siglus disassembly');

function compareChapterOrder(trace, scripts, chapters, firstEntry) {
  for (const [index, chapter] of chapters.entries()) {
    const script = scripts.get(chapter);
    const entry = script.entries.get(index === 0 ? firstEntry : 0);
    const tags = trace.filter((tag) => tag.scene === chapter && tag.offset >= entry);
    assert.ok(tags.length > 0, 'No tags in ' + chapter);
    const {edges} = script;
    let candidates = [entry];
    for (const {offset} of tags) {
      const queue = [...candidates];
      const visited = new Set();
      let found = false;
      while (queue.length) {
        const address = queue.pop();
        if (address === offset) {
          found = true;
          break;
        }
        if (visited.has(address) || script.tags.has(address)) continue;
        visited.add(address);
        queue.push(...(edges.get(address) ?? []));
      }
      assert.ok(found, chapter + ': unexpected tag at ' + offset.toString(16));
      candidates = edges.get(offset) ?? [];
    }
    const expectedText = [...script.tags.values()].filter(
      (tag) => tag.offset >= entry && tag.tag === 'text',
    );
    assert.deepEqual(
      tags.filter((tag) => tag.tag === 'text').map((tag) => digest(tag.value)),
      expectedText.map((tag) => tag.hash),
      chapter + ': text order and SHA-256',
    );
  }
}

const profile = await mkdtemp(join(tmpdir(), 'vn-siglus-'));
const server = await createStaticServer();
let child;
let cdp;
let browserClosed;
const errors = [];
verification: try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  child = spawn(
    resolve(browser),
    [
      '--headless=new',
      '--incognito',
      '--mute-audio',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    {stdio: ['ignore', 'ignore', 'pipe']},
  );
  browserClosed = new Promise((done) => {
    child.once('exit', done);
    child.once('error', done);
  });
  const endpoint = await new Promise((done, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Chromium DevTools startup timed out')), 15000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      callback(value);
    };
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-8192);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(done, match[1]);
    });
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code) => finish(reject, new Error(`Chromium exited ${code}\n${stderr}`)));
  });
  cdp = await DevToolsConnection.connect(endpoint);
  let {targetId} = await cdp.command('Target.createTarget', {url: 'about:blank'});
  let {sessionId} = await cdp.command('Target.attachToTarget', {targetId, flatten: true});
  const send = (method, params) => cdp.command(method, params, sessionId);
  cdp.on('event', ({method, params}) => {
    if (method === 'Runtime.exceptionThrown')
      errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error')
      errors.push(params.args.map((arg) => arg.description ?? arg.value).join(' '));
    if (method === 'Log.entryAdded' && params.entry.level === 'error')
      errors.push(params.entry.text);
  });
  async function evaluate(expression) {
    const {result, exceptionDetails} = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    assert.deepEqual(errors, [], 'Browser console errors');
    return result.value;
  }
  async function waitFor(expression, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await evaluate(expression);
      if (value) return value;
      await delay(70);
    }
    throw new Error('Timed out waiting for ' + expression);
  }
  async function click(selector) {
    const [x, y] = await waitFor(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled || !element.getClientRects().length) return false;
      const {x, y, width, height} = element.getBoundingClientRect();
      const cx = x + width / 2;
      const cy = y + height / 2;
      return element.contains(document.elementFromPoint(cx, cy)) ? [cx, cy] : false;
    })()`);
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
  }
  async function clickScriptMenu(loop, gameX, gameY, button = 'left') {
    const [x, y] = await evaluate(`(() => {
      const rect = siglusSurface.querySelector('div[tabindex="0"]').getBoundingClientRect();
      return [rect.left + rect.width * ${gameX} / 1920, rect.top + rect.height * ${gameY} / 1080];
    })()`);
    const frame = loop ? await evaluate(loop) : 0;
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount: 1,
    });
    if (loop) await waitFor(`${loop} > ${frame}`);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount: 1,
    });
  }
  const slotScene = '__sys_menu_save_load01';
  const slotLoop = `siglusTags.filter(({scene, path}) => scene === '${slotScene}' && path?.join('.') === '86.3').length`;
  async function selectSlot(mode, slot = 0) {
    const start = await evaluate('siglusTags.length');
    const frame = await evaluate(slotLoop);
    await click(`[data-siglus-action="${mode}"]`);
    await waitFor(`${slotLoop} > ${frame}`);
    return chooseSlot(mode, start, slot);
  }
  async function chooseSlot(mode, start, slot = 0) {
    const confirmGraphic = mode === 'save' ? '__sys_sa_setbtn_bg00' : '__sys_lo_setbtn_bg00';
    const confirm = `siglusTags.slice(${start}).some(({scene, args}) =>
      scene === '${slotScene}' && args?.[0] === '${confirmGraphic}')`;
    const field = mode === 'save' ? 'savedPage' : 'loaded';
    const previous = await evaluate(`siglusSurface.dataset.${field} ?? null`);
    const done = `(siglusSurface.dataset.${field} ?? null) !== ${JSON.stringify(previous)}`;
    await clickScriptMenu(slotLoop, 140 + 375 * (slot % 5), 240 + 414 * Math.floor(slot / 5));
    const action = await waitFor(`${done} ? 'done' : (${confirm}) ? 'confirm' : ''`);
    if (action === 'confirm') await clickScriptMenu(slotLoop, 883, 557);
    return action;
  }
  async function closeSlotMenu() {
    for (const type of ['keyDown', 'keyUp'])
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
    await waitForDialogueControls();
  }
  async function waitForDialogueControls() {
    await waitFor(
      "document.querySelector('[data-siglus-action=save]')?.parentElement.hidden === false",
    );
  }
  async function clickStage() {
    await click('#siglus-surface > div[tabindex="0"]');
  }
  async function advance() {
    for (const type of ['keyDown', 'keyUp'])
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
  }
  async function control(type) {
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      modifiers: type === 'keyDown' ? 2 : 0,
    });
  }
  for (const domain of ['Page', 'DOM', 'Runtime', 'Log']) await send(domain + '.enable');
  async function openPlayer() {
    if (configOnly)
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
    await send('Page.navigate', {
      url: `http://127.0.0.1:${server.address().port}/siglus.html?siglus-trace`,
    });
    await waitFor("document.querySelector('#files') !== null && !window.siglusSurface");
    const {root} = await send('DOM.getDocument');
    const {nodeId} = await send('DOM.querySelector', {nodeId: root.nodeId, selector: '#files'});
    await send('DOM.setFileInputFiles', {nodeId, files: [resolve(folder)]});
    await waitFor("document.querySelector('#play')?.disabled === false");
    if (domRoute) {
      await evaluate(`(() => {
        const selector = document.querySelector('#text-mode');
        selector.value = 'dom';
        selector.dispatchEvent(new Event('change'));
        return selector.value;
      })()`).then((mode) => assert.equal(mode, 'dom'));
    }
    await evaluate(`window.siglusTags = [];
    window.siglusAudio = [];
    window.siglusMovies = [];
    window.siglusSurface = document.querySelector('#siglus-surface');
    window.siglusPageAudit = {pages: 0, native: 0, dom: 0, skipped: 0, slides: 0, textSizeResets: 0, failures: []};
    let sizeOverride = false;
    let resetPending = false;
    siglusSurface.addEventListener('siglus-tag', (event) => siglusTags.push(event.detail));
    siglusSurface.addEventListener('siglus-tag', ({detail: tag}) => {
      if (tag.path?.length !== 1 || tag.path[0] !== 16) return;
      resetPending = sizeOverride && tag.args.length === 0;
      sizeOverride = tag.args.length > 0;
    });
    siglusSurface.addEventListener('siglus-page', ({detail: {skipping}}) => {
      const audit = siglusPageAudit;
      audit.pages++;
      if (skipping) audit.skipped++;
      if (resetPending) {
        audit.textSizeResets++;
        resetPending = false;
      }
      const stage = siglusSurface.firstElementChild;
      const text = stage.querySelector('[data-siglus-dialogue]');
      const native = stage.dataset.textMode === 'native';
      const slideCheckpoint = ${slideOnly} && siglusTags.at(-1)?.offset === 0x344f8 &&
        siglusTags.at(-1)?.scene.startsWith('02_');
      audit[native ? 'native' : 'dom']++;
      const rendered = native ? stage.querySelector('[data-siglus-native-text]') : text;
      const size = Number.parseFloat(text.style.fontSize);
      const viewport = stage.getBoundingClientRect();
      const rect = rendered.getBoundingClientRect();
      const intersects = (bounds) => bounds.width > 0 && bounds.height > 0 &&
        bounds.right > viewport.left && bounds.bottom > viewport.top &&
        bounds.left < viewport.right && bounds.top < viewport.bottom;
      let reason;
      let finalRowInk = 0;
      if (text.textContent.trim()) {
        if (!size || !intersects(rect) || !rendered.checkVisibility({visibilityProperty: true}))
          reason = 'text or message window is invisible';
        else if (native) {
          // Read only the dialogue area, below the separate speaker name.
          const x = Math.max(0, Math.floor((viewport.left - rect.left) * rendered.width / rect.width));
          const y = Math.max(Number.parseFloat(text.style.top),
            Math.floor((viewport.top - rect.top) * rendered.height / rect.height), 0);
          const right = Math.min(rendered.width, Math.ceil((viewport.right - rect.left) * rendered.width / rect.width));
          const bottom = Math.min(rendered.height, Math.ceil((viewport.bottom - rect.top) * rendered.height / rect.height));
          if (right <= x || bottom <= y) reason = 'dialogue area is clipped';
          else {
            const alpha = rendered.getContext('2d').getImageData(x, y, right - x, bottom - y).data;
            let visible = false;
            const finalRow = Number.parseFloat(text.style.top) + 2 * Number.parseFloat(text.style.lineHeight);
            for (let i = 3; i < alpha.length; i += 4) {
              if (alpha[i] < 32) continue;
              visible = true;
              if (!slideCheckpoint) break;
              if (y + Math.floor(i / (4 * (right - x))) >= finalRow) finalRowInk++;
            }
            if (!visible) reason = 'dialogue canvas has no visible ink';
          }
        } else {
          const range = document.createRange();
          const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
          let node;
          let visible = false;
          let lastVisible = false;
          const offset = text.hasAttribute('data-siglus-slide')
            ? -(Number.parseFloat(text.style.translate.split(' ')[1]) || 0)
            : 0;
          const slideTop = rect.top + offset * rect.height / text.clientHeight;
          const slideBottom = slideTop + rect.height;
          if (offset > 0) audit.slides++;
          while ((node = walker.nextNode())) {
            if (!node.data.trim() || node.parentElement.closest('rt')) continue;
            range.selectNodeContents(node);
            const bounds = [...range.getClientRects()];
            const inSlideWindow = ({bottom, top}) => bottom > slideTop && top < slideBottom;
            const activeBounds = offset > 0 ? bounds.filter(inSlideWindow) : bounds;
            const finalBounds = bounds.at(-1);
            lastVisible = Boolean(finalBounds && activeBounds.at(-1) === finalBounds && intersects(finalBounds));
            if (!bounds.length || !activeBounds.every(intersects)) {
              reason = 'base text has clipped or empty character bounds';
              break;
            }
            visible ||= activeBounds.length > 0;
          }
          if (!reason && (!visible || !lastVisible)) reason = 'dialogue has no visible final row';
        }
      } else reason = 'dialogue is empty';
      if (slideCheckpoint) {
        window.siglusSlideProof = {text: text.textContent, translate: text.style.translate, finalRowInk, reason};
      }
      if (reason) {
        const {scene, offset, line} = siglusTags.at(-1) ?? {};
        audit.failures.push({page: Number(siglusSurface.dataset.page), scene, offset, line,
          mode: stage.dataset.textMode, size, reason});
      }
    });
    siglusSurface.addEventListener('siglus-audio', (event) => siglusAudio.push(event.detail));
    siglusSurface.addEventListener('siglus-movie-ended', (event) => siglusMovies.push(event.detail)); true`);
  }
  async function playInstallation() {
    await click('#play');
    await waitFor("siglusTags.some((tag) => tag.scene === '_start' && tag.path?.[0] === 55)");
    if (domRoute)
      assert.equal(await evaluate('siglusSurface.firstElementChild.dataset.textMode'), 'dom');
    await delay(180);
    await advance();
  }
  const slotRecords = (kind = 'saves') => `(await (async () => {
    const database = (await indexedDB.databases()).find(({name}) => name?.startsWith('vn-runtime:["siglus:') && name.endsWith(',"slots"]'));
    if (!database) return [];
    const open = indexedDB.open(database.name);
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const records = db.transaction('records').objectStore('records');
      const keys = records.getAllKeys();
      const values = records.getAll();
      return await new Promise((resolve, reject) => {
        values.onerror = () => reject(values.error);
        values.onsuccess = () => resolve(keys.result.flatMap((key, index) =>
          key.startsWith('${kind}:') ? [[Number(key.split(':')[1]), JSON.parse(new TextDecoder().decode(values.result[index]))]] : []));
      });
    } finally {
      db.close();
    }
  })())`;
  const asyncExpression = (expression) => `(async () => (${expression}))()`;
  async function reopenPlayer() {
    const previousTab = targetId;
    ({targetId} = await cdp.command('Target.createTarget', {url: 'about:blank'}));
    ({sessionId} = await cdp.command('Target.attachToTarget', {targetId, flatten: true}));
    for (const domain of ['Page', 'DOM', 'Runtime', 'Log']) await send(domain + '.enable');
    await cdp.command('Target.closeTarget', {targetId: previousTab});
    await openPlayer();
    await playInstallation();
  }
  await openPlayer();
  if (
    musicOnly ||
    (configOnly && !freshConfiguration) ||
    slideOnly ||
    pauseSaveOnly ||
    loadOnly ||
    quickOnly ||
    autoOnly ||
    manageOnly ||
    cancelOnly ||
    frameLockOnly ||
    skipOnly ||
    historyOnly
  ) {
    const pack = await readFile(join(resolve(folder), 'StartData', 'GameData', 'Scene.pck')).catch(
      () => readFile(join(resolve(folder), 'Scene.pck')),
    );
    const key = 'siglus:' + digest(pack);
    const flags = [
      [1006, 1],
      [1007, 3],
      [1571, 1],
      [1575, 1],
    ];
    // Chapter 02 unlocks the first character voice control.
    if (configOnly) flags.push([1600, 1]);
    await evaluate(
      `localStorage.setItem(${JSON.stringify(key + ':system')}, ${JSON.stringify(JSON.stringify(flags))})`,
    );
  }
  await playInstallation();
  async function verifyRenderedPages({requireReset = false} = {}) {
    const audit = await evaluate(`({...siglusPageAudit,
      failures: siglusPageAudit.failures.slice(0, 12),
      failureCount: siglusPageAudit.failures.length})`);
    console.log('Dialogue render audit:', audit);
    assert.ok(audit.pages > 0, 'No dialogue checkpoints observed');
    if (domRoute)
      assert.equal(audit.dom, audit.pages, 'DOM Text stayed active throughout playback');
    assert.equal(audit.failureCount, 0, 'Invisible dialogue checkpoints');
    if (requireReset) assert.ok(audit.textSizeResets > 0, 'No size() reset was exercised');
  }
  const state = () =>
    evaluate(`({
    ...siglusSurface.dataset,
    title: !!siglusSurface.querySelector('button[aria-label="New Game"]'),
    dialogue: !!siglusSurface.querySelector('[data-siglus-dialogue]')?.textContent,
    lines: siglusTags.filter((tag) => tag.tag === 'text' && tag.scene === ${JSON.stringify(scene)} && tag.offset >= ${entry}).length
  })`);
  let page = 0;
  const backgrounds = new Set();
  const voices = new Set();
  const sprites = new Set();
  let music;
  async function runUntil(finished) {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const current = await state();
      if (await finished(current)) return current;
      if (Number(current.page) > page) {
        page = Number(current.page);
        assert.ok(current.dialogue);
        assert.equal(current.audioState, 'running');
        if (current.background) backgrounds.add(current.background);
        if (current.voice && Number(current.voiceDuration) > 0) voices.add(current.voice);
        if (current.sprite) sprites.add(current.sprite);
        if (current.bgm) music = current.bgm;
        await advance();
      }
      await delay(70);
    }
    throw new Error('Siglus playback timed out');
  }
  if (alignmentOnly) {
    assert.ok(!domRoute, 'The alignment probe must start in Native mode');
    const measureBaselines = () =>
      evaluate(`(() => {
      const stage = siglusSurface.firstElementChild;
      const text = stage.querySelector('[data-siglus-dialogue]');
      const speaker = text.previousElementSibling;
      const canvas = stage.querySelector('[data-siglus-native-text]');
      const selector = document.querySelector('#text-mode');
      const originalMode = selector.value;
      const setMode = (mode) => {
        selector.value = mode;
        selector.dispatchEvent(new Event('change'));
      };
      const context = canvas.getContext('2d');
      const canvasRect = canvas.getBoundingClientRect();
      const scale = canvasRect.height / canvas.height;
      const {scene, offset} = siglusTags.at(-1);
      if (!(scale > 0)) throw new Error('Native dialogue is hidden at the alignment checkpoint ' +
        JSON.stringify({scene, offset, page: siglusSurface.dataset.page, mode: stage.dataset.textMode,
          selected: originalMode, canvas: canvas.height, canvasHidden: canvas.hidden, windowHidden: canvas.parentElement.hidden}));
      context.save();
      context.textBaseline = 'top';
      const nativeBaseline = (element) => {
        const style = getComputedStyle(element);
        context.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
        return parseFloat(element.style.top) - context.measureText('国').alphabeticBaseline;
      };
      const native = [nativeBaseline(text), speaker.textContent ? nativeBaseline(speaker) : null];
      context.restore();
      setMode('dom');
      try {
        const domBaseline = (element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let first;
          while ((first = walker.nextNode())) {
            if (first.data.trim() && !first.parentElement.closest('rt')) break;
          }
          if (!first) throw new Error('Missing base text for baseline measurement');
          const marker = document.createElement('span');
          marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
          first.before(marker);
          const y = (marker.getBoundingClientRect().top - canvasRect.top) / scale;
          marker.remove();
          return y;
        };
        const dom = [domBaseline(text), speaker.textContent ? domBaseline(speaker) : null];
        const ruby = text.querySelector('ruby');
        let readingAbove;
        if (ruby) {
          const range = document.createRange();
          range.selectNodeContents(ruby.firstChild);
          const reading = ruby.querySelector('rt').getBoundingClientRect();
          readingAbove = reading.height > 0 && reading.top < range.getBoundingClientRect().top;
        }
        return {scene, offset, page: Number(siglusSurface.dataset.page), native, dom,
          size: parseFloat(text.style.fontSize), ruby: Boolean(ruby), readingAbove};
      } finally {
        setMode(originalMode);
      }
    })()`);
    const results = [];
    async function compareBaselines() {
      const result = await measureBaselines();
      results.push(result);
      for (const [index, native] of result.native.entries()) {
        if (native === null) continue;
        const difference = result.dom[index] - native;
        assert.ok(Math.abs(difference) <= 1, JSON.stringify({...result, difference}));
      }
      if (result.ruby) assert.ok(result.readingAbove, JSON.stringify(result));
    }
    // Prologue: the first ruby annotates the text at 0xf40 in chapter 01.
    const offset = 0xf40;
    const firstRuby = `siglusTags.find(({scene, tag, offset}) =>
      scene === ${JSON.stringify(scene)} && tag === 'text' && offset === ${offset})`;
    await runUntil(async (current) => {
      if (!(Number(current.page) > page)) return false;
      await compareBaselines();
      return evaluate(
        `siglusTags.at(-1)?.offset === 0xfc2 && siglusTags.at(-1)?.scene === ${JSON.stringify(scene)}`,
      );
    });
    const pausePage = await evaluate('Number(siglusSurface.dataset.page)');
    assert.equal(
      digest(
        await evaluate(
          `siglusSurface.querySelector('[data-siglus-dialogue] ruby').firstChild.textContent`,
        ),
      ),
      scripts.get(scene).tags.get(offset).hash,
    );
    assert.equal(
      await evaluate(
        `siglusTags.some(({scene, offset}) => scene === ${JSON.stringify(scene)} && offset === 0x1001)`,
      ),
      false,
    );
    await clickStage();
    await runUntil(() =>
      evaluate(`siglusTags.some(({scene, offset}) =>
        scene === ${JSON.stringify(scene)} && offset === 0x1015)`),
    );
    assert.equal(await evaluate('Number(siglusSurface.dataset.page)'), pausePage + 1);
    assert.equal(
      await evaluate(
        `siglusSurface.querySelector('[data-siglus-dialogue]').textContent.includes('\\n')`,
      ),
      false,
    );
    assert.equal(
      await evaluate(`siglusSurface.querySelector('[data-siglus-dialogue] rt')?.textContent`),
      'スリーポイント',
      'The prologue reading must survive the first text command of the page',
    );
    await compareBaselines();
    compareTags(await evaluate(`[${firstRuby}]`), scripts);
    page = Number(await evaluate('siglusSurface.dataset.page'));
    await clickStage();
    await runUntil(async (current) => {
      if (current.title) return true;
      if (Number(current.page) > page) await compareBaselines();
      return false;
    });
    await click('#siglus-surface button[aria-label="New Game"]');
    const openingStart = page;
    await runUntil(async (current) => {
      if (Number(current.page) > page) await compareBaselines();
      return Number(current.page) >= openingStart + 20;
    });
    const maxDifference = Math.max(
      ...results.flatMap(({native, dom}) =>
        native.flatMap((baseline, index) =>
          baseline === null ? [] : [Math.abs(dom[index] - baseline)],
        ),
      ),
    );
    console.log('Native and DOM baselines:', {
      pages: results.length,
      maxDifference,
      rubyPages: results.filter(({ruby}) => ruby).length,
      speakerPages: results.filter(({native}) => native[1] !== null).length,
    });
    assert.ok(results.length >= 80, 'Alignment probe did not cover the opening checkpoints');
    compareTags(
      await evaluate("siglusTags.filter(({tag}) => tag === 'text' || tag === 'name')"),
      scripts,
    );
    assert.equal(errors.length, 0);
    break verification;
  }
  if (typingOnly) {
    // The first prologue message_speed(60) covers these two consecutive replies.
    const offsets = [0x2bdc, 0x2c2f];
    const currentText = 'siglusSurface.querySelector("[data-siglus-dialogue]").textContent';
    const textTag = (offset) => `siglusTags.find(({scene, tag, offset}) =>
      scene === ${JSON.stringify(scene)} && tag === 'text' && offset === ${offset})`;
    const partial = (offset) => `(() => {
      const tag = ${textTag(offset)};
      const text = ${currentText};
      return tag && text.length > 0 && text.length < tag.value.length &&
        tag.value.startsWith(text) && text.length;
    })()`;
    const before = await runUntil(() => evaluate(partial(offsets[0])));
    const shown = await evaluate(partial(offsets[0]));
    assert.ok(shown, 'Native text should still be printing');
    await waitFor(`${partial(offsets[0])} > ${shown}`);
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) === ${Number(before.page) + 1}`);
    assert.equal(digest(await evaluate(currentText)), scripts.get(scene).tags.get(offsets[0]).hash);
    assert.equal(
      await evaluate(textTag(offsets[1])),
      undefined,
      'The first click only reveals the text',
    );
    await evaluate(`(() => {
      const select = document.querySelector('#text-mode');
      select.value = 'dom';
      select.dispatchEvent(new Event('change'));
    })()`);
    const started = await evaluate('performance.now()');
    await clickStage();
    await waitFor(partial(offsets[1]));
    const partialPage = await evaluate('Number(siglusSurface.dataset.page)');
    assert.equal(partialPage, Number(before.page) + 1);
    await waitFor(`Number(siglusSurface.dataset.page) === ${partialPage + 1}`);
    const written = await evaluate(currentText);
    const elapsed = (await evaluate('performance.now()')) - started;
    assert.equal(digest(written), scripts.get(scene).tags.get(offsets[1]).hash);
    assert.ok(elapsed >= Array.from(written).length * 60 - 20, `Natural reveal took ${elapsed} ms`);
    const trace = await evaluate(`[${textTag(offsets[0])}, ${textTag(offsets[1])}]`);
    compareTags(trace, scripts);
    await verifyRenderedPages();
    console.log(
      `Prologue: click completed the Native line without advancing. The next DOM line printed for ${Math.round(elapsed)} ms.`,
    );
    break verification;
  }
  await runUntil((current) => current.title);
  console.log(`Reached title after ${page} advances`);
  if (historyOnly) {
    await click('#siglus-surface button[aria-label="New Game"]');
    await runUntil((current) => Number(current.page) >= 7);
    const page = await evaluate('siglusSurface.dataset.page');
    const overlay = '[data-siglus-history]';
    await click('[data-siglus-action="msg_log"]');
    await waitFor(`document.querySelector('${overlay}')`);
    const entries =
      await evaluate(`Array.from(document.querySelectorAll('[data-siglus-history-text]'),
      (node) => Array.from(node.childNodes)
        .filter((part) => part.nodeName !== 'BUTTON')
        .map((part) => part.nodeName === 'RUBY' ? part.firstChild.textContent : part.textContent).join(''))`);
    const trace = await evaluate("siglusTags.filter(({tag}) => tag === 'text')");
    compareTags(trace, scripts);
    assert.ok(entries.length >= 7);
    assert.ok(entries.some((entry) => trace.some(({value}) => digest(value) === digest(entry))));
    const before = await evaluate('siglusAudio.length');
    await evaluate(`(() => {
      const buttons = document.querySelectorAll('${overlay} button[aria-label="Replay history voice"]');
      if (buttons.length) {
        buttons[buttons.length - 1].scrollIntoView({block: 'nearest'});
        buttons[buttons.length - 1].dataset.replayProbe = '';
      }
      return buttons.length;
    })()`).then((count) => assert.ok(count > 0));
    await click(`${overlay} [data-replay-probe]`);
    const voice = await waitFor(
      `siglusAudio.slice(${before}).find(({channel}) => channel === 'history-voice')`,
    );
    assert.ok(voice.frames > 0 && voice.rms > 0);
    await click(`${overlay} button[aria-label="Close message history"]`);
    await waitFor(`!document.querySelector('${overlay}')`);
    assert.equal(await evaluate('siglusSurface.dataset.page'), page);
    await advance();
    await waitFor(`Number(siglusSurface.dataset.page) > ${page}`);
    console.log(
      'Message history displayed script text, replayed a voice and returned focus to the same page.',
    );
    assert.equal(await selectSlot('save'), 'confirm');
    await waitFor('siglusSurface.dataset.savedPage');
    await closeSlotMenu();
    await reopenPlayer();
    await click('#siglus-surface button[aria-label="Load Game"]');
    await waitFor(slotLoop);
    assert.equal(await chooseSlot('load', 0), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    await clickStage();
    await waitForDialogueControls();
    const jumpStart = await evaluate('siglusTags.length');
    const currentPage = Number(await evaluate('siglusSurface.dataset.page'));
    await click('[data-siglus-action="msg_log"]');
    await waitFor(`document.querySelector('${overlay}')`);
    const jump = `${overlay} button[aria-label="Resume from this message"]`;
    const target = await evaluate(`(() => {
      const buttons = document.querySelectorAll(${JSON.stringify(jump)});
      const button = buttons[buttons.length - 3];
      if (!button) return '';
      button.scrollIntoView({block: 'nearest'});
      button.dataset.jumpProbe = '';
      return Array.from(button.parentElement.childNodes)
        .filter((part) => part.nodeName !== 'BUTTON')
        .map((part) => part.nodeName === 'RUBY' ? part.firstChild.textContent : part.textContent).join('');
    })()`);
    assert.ok(target);
    const confirm =
      "siglusTags.filter(({scene, path}) => scene === '__sys_system_call' && path?.join('.') === '6').length";
    let confirmations = await evaluate(confirm);
    await click('[data-jump-probe]');
    await waitFor(`${confirm} > ${confirmations}`);
    await clickScriptMenu(confirm, 1008, 557);
    await waitFor(`document.querySelector('${overlay}')`);
    assert.equal(Number(await evaluate('siglusSurface.dataset.page')), currentPage);
    assert.equal(
      await evaluate(
        `siglusTags.slice(${jumpStart}).some(({path}) => path?.join('.') === '63.310')`,
      ),
      false,
    );
    confirmations = await evaluate(confirm);
    await click(`${jump}[data-history-selected]`);
    await waitFor(`${confirm} > ${confirmations}`);
    await clickScriptMenu(confirm, 883, 557);
    await waitFor(
      `siglusSurface.dataset.loaded === 'true' && Number(siglusSurface.dataset.page) > ${currentPage}`,
    );
    assert.equal(
      digest(await evaluate("siglusSurface.querySelector('[data-siglus-dialogue]').textContent")),
      digest(target),
    );
    const jumpTags = await evaluate(
      `siglusTags.slice(${jumpStart}).filter(({scene}) => scene === '__sys_system_call')`,
    );
    assert.ok(jumpTags.some(({path}) => path?.join('.') === '63.310'));
    compareTags(jumpTags, scripts, {compareSourceLine: false});
    console.log(
      `Message history resumed the selected dialogue. Matched ${jumpTags.length} confirmation tags.`,
    );
  } else if (skipOnly) {
    await click('#siglus-surface button[aria-label="New Game"]');
    const first = await runUntil((current) => Number(current.page) >= 3);
    assert.equal(await selectSlot('save'), 'confirm');
    await waitFor('siglusSurface.dataset.savedPage');
    await closeSlotMenu();
    await runUntil((current) => Number(current.page) >= Number(first.page) + 3);
    await reopenPlayer();
    await click('#siglus-surface button[aria-label="Load Game"]');
    await waitFor(slotLoop);
    assert.equal(await chooseSlot('load', 0), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    await clickStage();
    await waitForDialogueControls();
    const readPage = Number(await evaluate('siglusSurface.dataset.page'));
    const start = await evaluate('siglusTags.length');
    const loop = `siglusTags.filter(({scene, path}) => scene === '__sys_menu_cancel00' && path?.join('.') === '86.3').length`;
    await clickScriptMenu(undefined, 960, 540, 'right');
    await waitFor(loop);
    const frame = await evaluate(loop);
    await clickScriptMenu(loop, 975, 635);
    await waitFor(`${loop} >= ${frame + 4}`);
    await clickScriptMenu(loop, 960, 540, 'right');
    await waitFor(`siglusTags.slice(${start}).some(({scene, path, args}) =>
      scene === '__sys_menu_cancel00' && path?.join('.') === '63.200' && args[0] === 1)`);
    await waitFor(`Number(siglusSurface.dataset.page) === ${readPage + 3}`);
    await waitForDialogueControls();
    const skipped = await evaluate(`siglusTags.slice(${start}).filter(({tag}) => tag === 'text')`);
    assert.ok(skipped.length >= 3);
    compareTags(skipped, scripts, {compareSourceLine: false});
    console.log(
      'Read Skip used persisted flags after reopening, skipped two read pages and stopped at the first unread page.',
    );
    page = 0;
    const readThrough = readPage + 32;
    await runUntil((current) => Number(current.page) >= readThrough);
    await reopenPlayer();
    await click('#siglus-surface button[aria-label="Load Game"]');
    await waitFor(slotLoop);
    assert.equal(await chooseSlot('load', 0), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    await clickStage();
    await waitForDialogueControls();
    const frameTags = await evaluate('siglusTags.length');
    await click('[data-siglus-action="read_skip"][aria-pressed="false"]');
    await waitFor(`Number(siglusSurface.dataset.page) >= ${readPage + 2}`);
    await click('[data-siglus-action="read_skip"][aria-pressed="true"]');
    await waitFor(
      `siglusTags.slice(${frameTags}).some(({scene, offset}) =>
      scene === '__sys_system_call' && offset === 0xdc16)`,
      3000,
    );
    await waitForDialogueControls();
    const stopped = Number(await evaluate('siglusSurface.dataset.page'));
    assert.ok(stopped > readPage && stopped < readThrough, `Read Skip stopped on page ${stopped}`);
    await delay(300);
    assert.equal(Number(await evaluate('siglusSurface.dataset.page')), stopped);
    const frameCommands = await evaluate(`siglusTags.slice(${frameTags}).filter(({scene, path}) =>
      scene === '__sys_system_call' && path?.join('.') === '63.200')`);
    assert.deepEqual(
      frameCommands.map(({offset, args}) => [offset, ...args]),
      [
        [0xda5d, 1],
        [0xdc16, 0],
      ],
    );
    compareTags(frameCommands, scripts);
    console.log(
      'The message frame started and stopped Read Skip through its configured script calls.',
    );
  } else if (frameLockOnly) {
    const lock = (slot, enabled) => `[data-siglus-switch="${slot}"][aria-pressed="${enabled}"]`;
    const bottom = '[data-siglus-action="save"]';
    const side = '[data-siglus-action="msg_log"]';
    async function startGame() {
      await click('#siglus-surface button[aria-label="New Game"]');
      await waitForDialogueControls();
    }
    async function move(gameX, gameY) {
      const [x, y] = await evaluate(`(() => {
        const rect = siglusSurface.firstElementChild.getBoundingClientRect();
        return [rect.left + rect.width * ${gameX} / 1920, rect.top + rect.height * ${gameY} / 1080];
      })()`);
      await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
    }
    const settled = (selector, x, y) =>
      waitFor(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button || button.parentElement.hidden) return false;
      const [x, y] = getComputedStyle(button).translate.split(' ').map(parseFloat);
      return (x || 0) === ${x} && (y || 0) === ${y} &&
        button.getAnimations().every(({playState}) => playState === 'finished');
    })()`);
    const frameCommands = (start = 0) =>
      evaluate(`siglusTags.slice(${start}).filter(({scene, path}) =>
      (scene === '__sys_system_call' && path?.join('.') === '63.14') ||
      (scene === '__sys_scdata_init' && path?.length === 11 && path[4] === 32))`);
    await startGame();
    const initial = await evaluate('siglusSurface.dataset.page');
    await click(lock(2, true));
    await move(960, 540);
    await settled(bottom, 0, 70);
    await move(950, 1040);
    await settled(bottom, 0, 0);
    await click(lock(3, true));
    await move(960, 540);
    await settled(side, 150, 0);
    await move(1830, 900);
    await settled(side, 0, 0);
    assert.equal(await evaluate('siglusSurface.dataset.page'), initial);
    const unlocked = await frameCommands();
    compareTags(unlocked, scripts);
    assert.deepEqual(
      unlocked
        .filter(({scene}) => scene === '__sys_system_call')
        .map(({offset, args}) => [offset, ...args]),
      [
        [0x16a57, 2, 0],
        [0x16baa, 3, 0],
      ],
    );
    for (const [axis, displacement, elapsed] of [
      [113, 70, 300],
      [112, 150, 300],
    ]) {
      assert.ok(
        unlocked.some(
          ({path, args}) => path[7] === axis && args[0] === displacement && args[1] === elapsed,
        ),
      );
      assert.ok(
        unlocked.some(({path, args}) => path[7] === axis && args[0] === 0 && args[1] === 250),
      );
    }
    await move(950, 1040);
    await settled(bottom, 0, 0);
    assert.equal(await selectSlot('save'), 'confirm');
    await waitFor('siglusSurface.dataset.savedPage');
    await reopenPlayer();
    await click('#siglus-surface button[aria-label="Load Game"]');
    await waitFor(slotLoop);
    assert.equal(await chooseSlot('load', 0), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    await clickStage();
    await waitForDialogueControls();
    await move(960, 540);
    await settled(bottom, 0, 70);
    await settled(side, 150, 0);
    await move(950, 1040);
    await settled(bottom, 0, 0);
    await click(lock(2, false));
    await move(1830, 900);
    await settled(side, 0, 0);
    await click(lock(3, false));
    await move(960, 540);
    await settled(bottom, 0, 0);
    await settled(side, 0, 0);
    const locked = await frameCommands();
    compareTags(locked, scripts);
    assert.deepEqual(
      locked
        .filter(({scene}) => scene === '__sys_system_call')
        .map(({offset, args}) => [offset, ...args]),
      [
        [0x16a57, 2, 1],
        [0x16baa, 3, 1],
      ],
    );
    console.log(
      'Message frame locks persisted. Both script watchers moved the controls to their configured positions.',
    );
  } else if (cancelOnly) {
    await click('#siglus-surface button[aria-label="New Game"]');
    await runUntil((current) => Number(current.page) >= 3);
    const pageBeforeMenu = await evaluate('siglusSurface.dataset.page');
    const scene = '__sys_menu_cancel00';
    const loop = `siglusTags.filter(({scene, path}) => scene === '__sys_menu_cancel00' && path?.join('.') === '86.3').length`;
    await clickScriptMenu(undefined, 960, 540, 'right');
    await waitFor(loop);
    await clickScriptMenu(loop, 960, 540, 'right');
    await waitFor("!document.querySelector('[data-siglus-action=save]')?.parentElement.hidden");
    assert.equal(await evaluate('siglusSurface.dataset.page'), pageBeforeMenu);
    const secondOpen = await evaluate(loop);
    await clickScriptMenu(undefined, 960, 540, 'right');
    await waitFor(`${loop} > ${secondOpen}`);
    await clickScriptMenu(loop, 690, 400);
    await waitFor(slotLoop);
    assert.equal(await chooseSlot('save', 0), 'confirm');
    await waitFor(`siglusSurface.dataset.savedPage === '${pageBeforeMenu}'`);
    await closeSlotMenu();
    assert.equal(await evaluate('siglusSurface.dataset.page'), pageBeforeMenu);
    async function quickMenu() {
      const frame = await evaluate(loop);
      await clickScriptMenu(undefined, 960, 540, 'right');
      await waitFor(`${loop} > ${frame}`);
    }
    async function toggleAuto(enabled) {
      const start = await evaluate('siglusTags.length');
      await quickMenu();
      const effect = await evaluate(loop);
      await clickScriptMenu(loop, 735, 635);
      await waitFor(`${loop} >= ${effect + 4}`);
      await clickScriptMenu(loop, 960, 540, 'right');
      await waitFor(`siglusTags.slice(${start}).some(({scene, path, args}) =>
        scene === '__sys_menu_cancel00' && path?.join('.') === '63.214' && args[0] === ${Number(enabled)})`);
    }
    await toggleAuto(true);
    await waitFor(`Number(siglusSurface.dataset.page) > ${pageBeforeMenu}`);
    await toggleAuto(false);
    await waitForDialogueControls();
    const pageAfterAuto = await evaluate('siglusSurface.dataset.page');
    await delay(2200);
    assert.equal(await evaluate('siglusSurface.dataset.page'), pageAfterAuto);
    assert.equal(
      await evaluate("document.querySelector('[data-siglus-action=return_sel]').disabled"),
      true,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('[data-siglus-action=read_skip][aria-pressed=false]').disabled",
      ),
      true,
    );
    const frameTags = await evaluate('siglusTags.length');
    await click('[data-siglus-action="auto_mode"][aria-pressed="false"]');
    await waitFor(`Number(siglusSurface.dataset.page) > ${pageAfterAuto}`);
    await click('[data-siglus-action="auto_mode"][aria-pressed="true"]');
    await waitForDialogueControls();
    const stopped = await evaluate('siglusSurface.dataset.page');
    await delay(2200);
    assert.equal(await evaluate('siglusSurface.dataset.page'), stopped);
    const frameCommands = await evaluate(`siglusTags.slice(${frameTags}).filter(({scene, path}) =>
      scene === '__sys_system_call' && path?.join('.') === '63.214')`);
    assert.deepEqual(
      frameCommands.map(({offset, args}) => [offset, ...args]),
      [
        [0xd6c6, 1],
        [0xd8a4, 0],
      ],
    );
    compareTags(frameCommands, scripts);
    const configLoop = `siglusTags.filter(({scene, path}) =>
      scene === '__sys_menu_config01' && path?.join('.') === '86.3').length`;
    await click('[data-siglus-action="config"]');
    await waitFor(configLoop);
    await clickScriptMenu(configLoop, 628, 849);
    await waitFor(`Object.keys(localStorage).some(key => key.endsWith(':system')
      && new Map(JSON.parse(localStorage.getItem(key))).get(1307) === 1)`);
    await clickScriptMenu(configLoop, 960, 540, 'right');
    await waitForDialogueControls();
    const dialogue = "siglusSurface.querySelector('[data-siglus-dialogue]')";
    await clickScriptMenu(undefined, 960, 540, 'right');
    await waitFor(`getComputedStyle(${dialogue}).visibility === 'hidden'`);
    await clickStage();
    await waitFor(`getComputedStyle(${dialogue}).visibility === 'visible'`);
    assert.equal(await evaluate('siglusSurface.dataset.page'), stopped);
    const tags = await evaluate(`siglusTags.filter((tag) => tag.scene === '${scene}')`);
    compareTags(tags, scripts, {compareSourceLine: false});
    console.log(
      `Verified the quick menu, frame Auto and Configuration buttons, and hiding and restoring dialogue. Matched ${tags.length} quick-menu tags.`,
    );
  } else if (manageOnly) {
    await click('#siglus-surface button[aria-label="New Game"]');
    await runUntil((current) => Number(current.page) >= 3);
    assert.equal(await selectSlot('save'), 'confirm');
    const slot = (no) => `(${slotRecords()}).find(([slot]) => slot === ${no})?.[1]`;
    await waitFor(`siglusTags.some(({scene, path}) =>
      scene === '${slotScene}' && path?.join('.') === '63.180')`);
    async function clickAction(x, y) {
      await clickScriptMenu(slotLoop, x, y);
      const frame = await evaluate(slotLoop);
      await waitFor(`${slotLoop} > ${frame}`);
    }
    const comment = 'テスト保存';
    await clickScriptMenu(slotLoop, 105, 446);
    await waitFor(`document.activeElement?.getAttribute('aria-label') === 'Save comment'`);
    await send('Input.insertText', {text: comment});
    await advance();
    await waitFor(asyncExpression(`${slot(0)}?.comment === ${JSON.stringify(comment)}`));
    const original = await evaluate(asyncExpression(slot(0)));
    await closeSlotMenu();
    const firstPage = await evaluate('Number(siglusSurface.dataset.page)');
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) > ${firstPage}`);
    const afterFirstSave = await evaluate('siglusTags.length');
    assert.equal(await selectSlot('save', 1), 'confirm');
    await waitFor(`siglusTags.slice(${afterFirstSave}).some(({path, args}) =>
      path?.join('.') === '63.180' && args[0] === 1)`);
    const second = await evaluate(asyncExpression(slot(1)));
    assert.notDeepEqual(second.message, original.message);
    const lock = `(() => {
      const key = Object.keys(localStorage).find((key) => key.endsWith(':system'));
      return new Map(JSON.parse(localStorage.getItem(key))).get(1200) & 1;
    })()`;
    await clickAction(90, 480);
    await waitFor(lock);
    const initialTags = await evaluate(`siglusTags.filter(({scene}) => scene === '${slotScene}')`);
    await reopenPlayer();
    await click('#siglus-surface button[aria-label="New Game"]');
    await waitFor("!document.querySelector('[data-siglus-action=save]')?.parentElement.hidden");
    await click('[data-siglus-action="save"]');
    await waitFor(slotLoop);
    await waitFor(lock);
    await clickAction(310, 480);
    assert.equal(
      await evaluate(`siglusTags.some(({path, args}) =>
      path?.join('.') === '63.19' || args?.[0] === '__sys_sa_setbtn_bg00')`),
      false,
    );
    assert.deepEqual(
      await evaluate(asyncExpression(slot(0))),
      original,
      'The lock survived reopening the player',
    );
    await clickAction(90, 480);
    await waitFor(`!(${lock})`);
    async function confirmMutation(trigger, accept) {
      const start = await evaluate('siglusTags.length');
      await trigger();
      await waitFor(`siglusTags.slice(${start}).some(({scene, args}) =>
        scene === '${slotScene}' && args?.[0] === '__sys_sa_setbtn_bg00')`);
      await clickAction(accept ? 883 : 1008, 557);
    }
    await clickAction(201, 480);
    await confirmMutation(() => clickAction(515, 240), true);
    await waitFor(asyncExpression(`${slot(1)}?.comment === ${JSON.stringify(comment)}`));
    assert.deepEqual(await evaluate(asyncExpression(slot(1))), original);
    assert.deepEqual(await evaluate(asyncExpression(slot(0))), second);
    await confirmMutation(() => clickAction(685, 480), false);
    assert.deepEqual(
      await evaluate(asyncExpression(slot(1))),
      original,
      'No leaves the exchanged record intact',
    );
    await confirmMutation(() => clickAction(685, 480), true);
    await waitFor(asyncExpression(`!${slot(1)}`));
    const tags = await evaluate(`siglusTags.filter(({scene}) => scene === '${slotScene}')`);
    compareTags([...initialTags, ...tags], scripts, {compareSourceLine: false});
    console.log(
      `Slot management: persisted lock, occupied-slot exchange, comment and delete confirmation. Matched ${initialTags.length + tags.length} tags.`,
    );
  } else if (autoOnly) {
    await click('#siglus-surface button[aria-label="New Game"]');
    await runUntil((current) => Number(current.page) >= 1);
    const slotsExpression = slotRecords();
    await control('keyDown');
    try {
      await waitFor(asyncExpression(`${slotsExpression}.some(([slot]) => slot === 1001)`), 120000);
    } finally {
      await control('keyUp');
    }
    const slots = await evaluate(
      asyncExpression(`${slotsExpression}.map(([no, save]) =>
      [no, {timestamp: save.timestamp, background: save.background, frame: save.vm.frames.at(-1)}])`),
    );
    const records = new Map(slots);
    assert.ok(records.get(1000).timestamp >= records.get(1001).timestamp);
    assert.notEqual(records.get(1000).frame.pc, records.get(1001).frame.pc);
    assert.equal(records.get(1000).frame.scene, records.get(1001).frame.scene);
    await waitFor(
      "!document.querySelector('[data-siglus-action=load]')?.parentElement.hidden",
      60000,
    );
    const dialogue = "siglusSurface.querySelector('[data-siglus-dialogue]').textContent";
    const beforeLoad = await evaluate('Number(siglusSurface.dataset.page)');
    const start = await evaluate('siglusTags.length');
    await click('[data-siglus-action="load"]');
    await waitFor(slotLoop);
    const frame = await evaluate(slotLoop);
    await clickScriptMenu(slotLoop, 1654, 34);
    await waitFor(`${slotLoop} > ${frame} && siglusTags.slice(${start}).some(
      ({path, args}) => path?.join('.') === '63.69' && args[0] === 1000)`);
    assert.equal(await chooseSlot('load', start), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    await waitFor(`Number(siglusSurface.dataset.page) > ${beforeLoad}`);
    const restored = await evaluate(`({text: ${dialogue},
      command: siglusTags.slice(${start}).find(({path}) => path?.join('.') === '63.256'),
      firstText: siglusTags.slice(${start}).find(({tag}) => tag === 'text')})`);
    assert.equal(restored.command.args[0], 1000);
    assert.ok(restored.firstText.offset >= records.get(1000).frame.pc);
    assert.equal(restored.firstText.scene, records.get(1000).frame.scene);
    assert.ok(restored.text.includes(restored.firstText.value));
    compareTags([restored.firstText], scripts, {compareSourceLine: false});
    console.log('Autosave: the original Auto tab restored slot 1000 and resumed the day.');
    const tags = await evaluate("siglusTags.filter(({scene}) => scene === '__sys_system_call')");
    compareTags(tags, scripts, {compareSourceLine: false});
    console.log(
      'Autosave: authored rotation retained two distinct day checkpoints.',
      slots.map(([slot, {background, frame}]) => [slot, background, frame.pc]),
    );
  } else if (quickOnly) {
    await click('#siglus-surface button[aria-label="New Game"]');
    await runUntil((current) => Number(current.page) >= 3);
    const dialogue = "siglusSurface.querySelector('[data-siglus-dialogue]').textContent";
    const quickLoop = `siglusTags.filter(({scene, path}) =>
      scene === '__sys_system_call' && path?.join('.') === '6').length`;
    async function quickAction(type) {
      const frame = await evaluate(quickLoop);
      await click(`[data-siglus-action="${type}"]`);
      await waitFor(`${quickLoop} > ${frame}`);
      await clickScriptMenu(quickLoop, 883, 557);
    }
    const first = digest(await evaluate(dialogue));
    await quickAction('qsave');
    const saved = await waitFor('siglusSurface.dataset.savedPage');
    await waitFor("!document.querySelector('[data-siglus-action=save]')?.parentElement.hidden");
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) > ${saved}`);
    const second = digest(await evaluate(dialogue));
    assert.notEqual(second, first);
    await quickAction('qsave');
    await waitFor(`siglusSurface.dataset.savedPage !== '${saved}'`);
    await waitFor("!document.querySelector('[data-siglus-action=save]')?.parentElement.hidden");
    const slots = await evaluate(
      asyncExpression(`${slotRecords('quick-saves')}.map(([slot, save]) =>
      [slot, save.message.text.map(({text}) => text).join('')])`),
    );
    assert.deepEqual(
      new Map(slots.map(([slot, text]) => [slot, digest(text)])),
      new Map([
        [0, second],
        [1, first],
      ]),
    );
    const quickPage = await evaluate('Number(siglusSurface.dataset.page)');
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) > ${quickPage}`);
    assert.notEqual(digest(await evaluate(dialogue)), second);
    await quickAction('qload');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    assert.equal(digest(await evaluate(dialogue)), second);
    const restoredPage = await evaluate('Number(siglusSurface.dataset.page)');
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) > ${restoredPage}`);
    const start = await evaluate('siglusTags.length');
    await click('[data-siglus-action="load"]');
    await waitFor(slotLoop);
    const frame = await evaluate(slotLoop);
    await clickScriptMenu(slotLoop, 1715, 34);
    await waitFor(`${slotLoop} > ${frame} && siglusTags.slice(${start}).some(
      ({path, args}) => path?.join('.') === '63.69' && args[0] === 1011)`);
    await waitFor(`Array.from(siglusSurface.querySelectorAll('canvas'))
      .filter(({width, height}) => width === 354 && height === 199).length === 2`);
    assert.equal(await chooseSlot('load', start, 1), 'confirm');
    await waitFor(`siglusTags.slice(${start}).some(({path, args}) =>
      path?.join('.') === '63.256' && args[0] === 1011)`);
    await waitFor(`Number(siglusSurface.dataset.page) > ${restoredPage + 1}`);
    assert.equal(
      digest(await evaluate(dialogue)),
      first,
      'Quick tab restored the older quick slot',
    );
    const menuTags = await evaluate(
      `siglusTags.slice(${start}).filter(({scene}) => scene === '${slotScene}')`,
    );
    compareTags(menuTags, scripts, {compareSourceLine: false});
    console.log(`Quick tab loaded history slot 1. Matched ${menuTags.length} tags.`);
    const tags = await evaluate("siglusTags.filter(({scene}) => scene === '__sys_system_call')");
    compareTags(tags, scripts, {compareSourceLine: false});
    console.log(
      `Quick Save rotated two slots and Quick Load restored the newest one. Matched ${tags.length} tags.`,
    );
  } else if (loadOnly) {
    const newGame = '#siglus-surface button[aria-label="New Game"]';
    await click(newGame);
    let savedState = await runUntil((current) => Number(current.page) >= 3);
    const dialogue = "siglusSurface.querySelector('[data-siglus-dialogue]').textContent";
    const originalText = digest(await evaluate(dialogue));
    const configScene = '__sys_menu_config01';
    const configLoop = `siglusTags.filter(({scene, path}) =>
      scene === '${configScene}' && path?.join('.') === '86.3').length`;
    async function switchToConfiguration(from) {
      const slotFrame = await evaluate(slotLoop);
      await click(`[data-siglus-action="${from}"]`);
      await waitFor(`${slotLoop} > ${slotFrame}`);
      const configFrame = await evaluate(configLoop);
      await clickScriptMenu(slotLoop, 745, 1023);
      await waitFor(`${configLoop} > ${configFrame}`);
    }
    async function switchToSlots(mode) {
      const frame = await evaluate(slotLoop);
      const start = await evaluate('siglusTags.length');
      await clickScriptMenu(configLoop, mode === 'save' ? 225 : 485, 1023);
      await waitFor(`${slotLoop} > ${frame}`);
      return chooseSlot(mode, start);
    }
    const fromLoad = await evaluate('siglusTags.length');
    await switchToConfiguration('load');
    assert.equal(await switchToSlots('save'), 'confirm');
    await waitFor('siglusSurface.dataset.savedPage');
    const thumbnail = async () =>
      evaluate(asyncExpression(`${slotRecords()}.find(([slot]) => slot === 0)?.[1].thumbnail`));
    assert.match(await thumbnail(), /^data:image\/jpeg;base64,/);
    await clickScriptMenu(slotLoop, 1540, 1023);
    await waitForDialogueControls();
    assert.equal(digest(await evaluate(dialogue)), originalText);
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) > ${savedState.page}`);
    savedState = await state();
    const savedText = digest(await evaluate(dialogue));
    assert.notEqual(savedText, originalText);
    assert.equal(savedState.bgm, 'bgm02');
    await delay(400);
    assert.equal(await selectSlot('save'), 'confirm', 'Overwriting the slot requires confirmation');
    await waitFor(`siglusSurface.dataset.savedPage === '${savedState.page}'`);
    const savedBgm = await evaluate(
      asyncExpression(`${slotRecords()}.find(([slot]) => slot === 0)?.[1].bgmPlayback`),
    );
    assert.equal(savedBgm?.name, savedState.bgm);
    assert.equal(savedBgm.level, 255);
    assert.equal(savedBgm.sample, undefined);
    const restoredBgm = async (start) => {
      const played = await evaluate(`siglusAudio.slice(${start}).findLast(({channel, resource}) =>
        channel === 'bgm' && resource === ${JSON.stringify(savedBgm.name)})`);
      assert.equal(played.startSample, 0, 'BGM02 starts at its configured Gameexe.dat sample');
      assert.equal(played.loop, savedBgm.loop);
      assert.ok(played.startSample < played.loopEndSample);
      return played;
    };
    const checkLoadHook = async (start) => {
      const trace = await evaluate(`siglusTags.slice(${start}).filter(({scene}) =>
        scene === '__sys_load_after' || scene === '__sys_scdata_init')`);
      compareTags(trace, scripts, {compareSourceLine: false});
      assert.deepEqual(
        trace.filter(({scene}) => scene === '__sys_load_after').map(({offset}) => offset),
        [0x39, 0x5e, 0x83, 0xc4, 0x1d3],
      );
      const positions = trace.filter(
        ({scene, path}) =>
          scene === '__sys_scdata_init' && path?.length === 9 && path[4] === 32 && path[8] === 2,
      );
      assert.equal(positions.length, 24, 'Load hook initializes both groups of message buttons');
    };
    await clickScriptMenu(slotLoop, 1540, 1023);
    await waitForDialogueControls();
    const saveCommands = await evaluate(`siglusTags.filter(({scene}) => scene === '${slotScene}')`);
    compareTags(saveCommands, scripts, {compareSourceLine: false});
    assert.match(await thumbnail(), /^data:image\/jpeg;base64,/);
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) > ${savedState.page}`);
    const nextText = digest(await evaluate(dialogue));
    assert.notEqual(nextText, savedText);
    const beforeRestoreAudio = await evaluate('siglusAudio.length');
    const beforeRestoreTags = await evaluate('siglusTags.length');
    await switchToConfiguration('save');
    assert.equal(await switchToSlots('load'), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    await checkLoadHook(beforeRestoreTags);
    const inGameBgm = await restoredBgm(beforeRestoreAudio);
    assert.ok(inGameBgm.sourceRate > 0 && inGameBgm.rms > 0);
    assert.equal(
      digest(await evaluate(dialogue)),
      savedText,
      'In-game Load used the overwritten slot',
    );
    const menuTrace = await evaluate(`siglusTags.slice(${fromLoad}).filter(({scene}) =>
      scene === '${configScene}' || scene === '${slotScene}' || scene === '__sys_system_call')`);
    compareTags(menuTrace, scripts, {compareSourceLine: false});
    const jumps = (from) =>
      menuTrace.filter(
        ({scene, path, args}) =>
          scene === from && path?.join('.') === '4' && [configScene, slotScene].includes(args[0]),
      );
    assert.ok(jumps(slotScene).some(({args}) => args[0] === configScene));
    assert.ok(jumps(configScene).some(({args}) => args[0] === slotScene));
    console.log(
      'Configuration switched between the original Load and Save menus and retained the scene capture.',
    );
    await reopenPlayer();
    await click('#siglus-surface button[aria-label="Load Game"]');
    await waitFor(slotLoop);
    const canvasShape = await evaluate(`Array.from(siglusSurface.querySelectorAll('canvas'))
      .filter(({width, height}) => width === 354 && height === 199).length`);
    assert.ok(canvasShape > 0, 'The scripted slot created the stored thumbnail');
    const beforeTitleLoad = await evaluate('siglusTags.length');
    assert.equal(await chooseSlot('load', 0), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    await checkLoadHook(beforeTitleLoad);
    const reopenedBgm = await restoredBgm(0);
    for (const field of [
      'frames',
      'rate',
      'sourceRate',
      'loopStartSample',
      'loopEndSample',
      'gain',
    ])
      assert.equal(reopenedBgm[field], inGameBgm[field], field);
    assert.ok(Math.abs(reopenedBgm.rms - inGameBgm.rms) < 0.001);
    assert.equal(digest(await evaluate(dialogue)), savedText);
    assert.equal(await evaluate('siglusSurface.dataset.background'), savedState.background);
    assert.equal(await evaluate('siglusSurface.dataset.cast'), savedState.cast);
    assert.equal(await evaluate('siglusSurface.dataset.bgm'), savedState.bgm);
    const restoredPage = await evaluate('Number(siglusSurface.dataset.page)');
    await waitForDialogueControls();
    await click('[data-siglus-action="msg_log"]');
    await waitFor("document.querySelector('[data-siglus-history]')");
    await click('[data-siglus-history] button[aria-label="Close message history"]');
    await waitForDialogueControls();
    const lastSlotFrame = await evaluate(slotLoop);
    await click('[data-siglus-action="save"]');
    await waitFor(`${slotLoop} > ${lastSlotFrame}`);
    await closeSlotMenu();
    assert.equal(await evaluate('Number(siglusSurface.dataset.page)'), restoredPage);
    assert.equal(digest(await evaluate(dialogue)), savedText);
    console.log('History and Save opened from the restored page before advancing.');
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) > ${restoredPage}`);
    assert.equal(
      digest(await evaluate(dialogue)),
      nextText,
      'The script continued at the saved VM position',
    );
    const commands = await evaluate(`siglusTags.filter(({scene}) => scene === '${slotScene}')`);
    compareTags(commands, scripts, {compareSourceLine: false});
    console.log(
      `Original Load restored the dialogue, stage and thumbnail after reopening, then resumed the script. Matched ${saveCommands.length + commands.length} Save/Load tags.`,
    );
    console.log('BGM restored at the configured start:', savedBgm, inGameBgm.startSample);
  } else if (configOnly) {
    await click('#siglus-surface button[aria-label="Configuration"]');
    await waitFor(`siglusTags.some(({scene, path}) =>
      scene === '__sys_menu_config01' && path?.join('.') === '86.3')`);
    const configScene = '__sys_menu_config01';
    const configLoop = `siglusTags.filter(({scene, path}) => scene === '${configScene}' && path?.join('.') === '86.3').length`;
    const configCommand = (path, start) =>
      `siglusTags.slice(${start}).some(({scene, path}) =>
        scene === '${configScene}' && path?.join('.') === '${path}')`;
    async function clickConfig(gameX, gameY, button = 'left', heldFrames = 1) {
      const [x, y] = await evaluate(`(() => {
        const rect = siglusSurface.querySelector('div[tabindex="0"]').getBoundingClientRect();
        return [rect.left + rect.width * ${gameX} / 1920, rect.top + rect.height * ${gameY} / 1080];
      })()`);
      const frame = await evaluate(configLoop);
      await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
      await send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button, clickCount: 1});
      await waitFor(`${configLoop} >= ${frame + heldFrames}`);
      await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button, clickCount: 1});
    }
    const initial = await evaluate('siglusTags.length');
    await clickConfig(1045, 561);
    await waitFor(configCommand('63.119', initial));
    const wheel = await evaluate(`(() => {
      const key = Object.keys(localStorage).find((key) => key.endsWith(':options'));
      return JSON.parse(localStorage.getItem(key)).WHEEL_NEXT_MESSAGE_ONOFF;
    })()`);
    assert.equal(typeof wheel, 'boolean');
    console.log('Configuration: wheel setting changed through the original checkbox.');
    const expanded = "document.querySelector('#display').hasAttribute('data-expanded')";
    const beforeFullscreen = await evaluate('siglusTags.length');
    await clickConfig(630, 192);
    await waitFor(`${configCommand('63.4', beforeFullscreen)} && ${expanded}`);
    const beforeWindow = await evaluate('siglusTags.length');
    await clickConfig(470, 192);
    await waitFor(`${configCommand('63.4', beforeWindow)} && !(${expanded})`);
    console.log('Configuration: original window and fullscreen buttons changed the viewport.');
    const screenDialog = 'dialog[data-siglus-configuration="screen"]';
    const screenControl = (id) => `${screenDialog} [data-siglus-control="${id}"]`;
    const stageWidth = 'siglusSurface.firstElementChild.getBoundingClientRect().width';
    const oldWidth = await evaluate(stageWidth);
    const openScreenDialog = async () => {
      const start = await evaluate('siglusTags.length');
      await clickConfig(785, 193);
      await waitFor(
        `${configCommand('63.138', start)} && document.querySelector('${screenDialog}')?.open`,
      );
    };
    await openScreenDialog();
    assert.equal(
      await evaluate(`document.querySelector('${screenDialog}').getAttribute('aria-label')`),
      '画面の設定',
    );
    await click(`${screenControl(1170)} input`);
    const halfWidth = await evaluate(stageWidth);
    assert.ok(Math.abs(halfWidth - 960) < 1 && halfWidth < oldWidth);
    await click(`${screenControl(1166)} input`);
    await waitFor(expanded);
    await click(`${screenControl(1155)} input`);
    const customWidth = await evaluate(stageWidth);
    assert.ok(Math.abs(customWidth - 1920) < 1);
    await click(screenControl(1181));
    assert.notEqual(await evaluate(stageWidth), customWidth);
    assert.equal(
      await evaluate(`document.querySelector('${screenControl(1181)}').value`),
      await evaluate(`document.querySelector('${screenControl(1182)}').value`),
    );
    const stageLeft = 'siglusSurface.firstElementChild.getBoundingClientRect().left';
    const centered = await evaluate(stageLeft);
    await click(screenControl(1179));
    for (const type of ['keyDown', 'keyUp'])
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'End',
        code: 'End',
        windowsVirtualKeyCode: 35,
      });
    assert.ok((await evaluate(stageLeft)) > centered + 100);
    await click(screenControl(1020));
    await waitFor(`!(${expanded}) && Math.abs(${stageWidth} - ${oldWidth}) < 1`);
    await click(`${screenControl(1170)} input`);
    await click(screenControl(1036));
    await waitFor(
      `!document.querySelector('${screenDialog}') && document.activeElement === siglusSurface.firstElementChild`,
    );
    console.log(
      'Configuration: screen dialog applied native window sizes, custom fullscreen scale, and defaults.',
    );
    const movieDialog = 'dialog[data-siglus-configuration="movie"]';
    const openMovieDialog = async () => {
      const start = await evaluate('siglusTags.length');
      await clickConfig(1360, 731);
      await waitFor(
        `${configCommand('63.167', start)} && document.querySelector('${movieDialog}')?.open`,
      );
    };
    await openMovieDialog();
    assert.equal(
      await evaluate(`document.querySelector('${movieDialog}').getAttribute('aria-label')`),
      'ムービーの再生方法の設定',
    );
    assert.equal(
      await evaluate(`document.querySelector('${movieDialog} input:checked').value`),
      'wmp',
    );
    await click(`${movieDialog} [data-siglus-control="1164"]`);
    await click(`${movieDialog} [data-siglus-control="1026"]`);
    await waitFor(
      `!document.querySelector('${movieDialog}') && document.activeElement === siglusSurface.firstElementChild`,
    );
    console.log(
      'Configuration: original movie settings opened, selected MCI and returned to the menu.',
    );
    const beforeText = await evaluate('siglusTags.length');
    await clickConfig(1450, 22);
    await waitFor(configCommand('65.1.2.-1.63.93.-1.23.39', beforeText));
    await waitFor(`siglusTags.slice(${beforeText}).some(({scene, path}) =>
      scene === '${configScene}' && path?.join('.') === '86.3')`);
    console.log('Configuration: the Text tab created its original sample.');
    const savedFont = `JSON.parse(localStorage.getItem(Object.keys(localStorage)
      .find((key) => /^siglus:.*:options$/.test(key))))?.font`;
    const dialogueFont =
      "siglusSurface.querySelector('[data-siglus-dialogue]').parentElement.style.fontFamily";
    const oldFont = await evaluate(dialogueFont);
    const fontChoice = (await evaluate(savedFont)) === 'Kosugi' ? 'Kosugi Maru' : 'Kosugi';
    const beforeFont = await evaluate('siglusTags.length');
    await clickConfig(fontChoice === 'Kosugi' ? 530 : 390, 192);
    await waitFor(
      `${configCommand('63.283', beforeFont)} && ${savedFont} === ${JSON.stringify(fontChoice)}`,
    );
    const chosenFont = await evaluate(dialogueFont);
    assert.notEqual(chosenFont, oldFont);
    console.log('Configuration: original font button changed the dialogue font.', fontChoice);
    const fontDialog = 'dialog[data-siglus-configuration="font"]';
    const beforeAdvancedFont = await evaluate('siglusTags.length');
    await clickConfig(665, 192);
    await waitFor(
      `${configCommand('63.142', beforeAdvancedFont)} && document.querySelector('${fontDialog}')?.open`,
    );
    const fontControl = (input) => `${fontDialog} ${input}`;
    const bold = fontControl('input[name="bold"]');
    const proportional = fontControl('input[name="proportional"]');
    await click(proportional);
    const availableFonts = await evaluate(
      `Array.from(document.querySelector('${fontDialog} select').options, option => option.value)`,
    );
    assert.ok(availableFonts.includes('Kosugi') && availableFonts.includes('Kosugi Maru'));
    await click(bold);
    await click(fontControl('input[name="shadow"][value="3"]'));
    const messageFontStyle = `(() => {
      const text = siglusSurface.querySelector('[data-siglus-dialogue]');
      return {bold: getComputedStyle(text).fontWeight, shadow: text.style.textShadow};
    })()`;
    const changedFontStyle = await evaluate(messageFontStyle);
    assert.equal(changedFontStyle.bold, '700');
    assert.match(changedFontStyle.shadow, /1px 2px 3px/);
    await click(fontControl('button[type="submit"]'));
    await waitFor(
      `!document.querySelector('${fontDialog}') && document.activeElement === siglusSurface.firstElementChild`,
    );
    console.log(
      'Configuration: detailed font settings updated the message weight and outline/shadow.',
    );
    const settingsWrite = async (member, x, y) => {
      const start = await evaluate('siglusTags.length');
      const heldFrames = member === 49 || member === 97 ? 1 : 6;
      await clickConfig(x, y, 'left', heldFrames);
      return waitFor(`siglusTags.slice(${start}).findLast(({scene, path}) =>
        scene === '${configScene}' && path?.join('.') === '63.${member}')?.args`);
    };
    const [messageNowait] = await settingsWrite(49, 188, 244);
    const [messageSpeed] = await settingsWrite(46, 560, 245);
    const [red] = await settingsWrite(82, 535, 421);
    const [characterWait] = await settingsWrite(51, 1510, 484);
    const [minimumWait] = await settingsWrite(54, 1520, 534);
    assert.equal(messageNowait, 0);
    for (const [value, original] of [
      [messageSpeed, 30],
      [red, 170],
      [characterWait, 30],
      [minimumWait, 1000],
    ])
      assert.notEqual(value, original);
    const beforeSound = await evaluate('siglusTags.length');
    await clickConfig(1630, 22);
    await waitFor(`siglusTags.slice(${beforeSound}).some(({scene, args}) =>
      scene === '${configScene}' && args?.[0] === '__sys_cf_btn33')`);
    await waitFor(`siglusTags.slice(${beforeSound}).some(({scene, path}) =>
      scene === '${configScene}' && path?.join('.') === '86.3')`);
    console.log('Configuration: the Sound tab created its original controls.');
    const volumePreviews = [
      [242, 255],
      [307, 158],
      [372, 204],
      [437, 255],
      [502, 190],
      [567, 120],
      [632, 100],
    ];
    let effectShape;
    for (const [buttonY, volume] of volumePreviews) {
      const preview = await evaluate('siglusAudio.length');
      const beforePreview = await evaluate('siglusTags.length');
      await clickConfig(875, buttonY + 15);
      const sample = await waitFor(`siglusAudio.slice(${preview}).find(({channel, resource}) =>
        channel === 'pcm15' && resource === 'system_decide')`);
      assert.equal(sample.volumeType, 31);
      const setGain = await evaluate(`siglusTags.slice(${beforePreview}).findLast(({scene, path}) =>
        scene === '${configScene}' && path?.join('.') === '63.277')?.args`);
      assert.deepEqual(setGain, [31, volume], `Sound preview at y=${buttonY}`);
      assert.ok(
        Math.abs(sample.gain - volume / 255) < 1e-7,
        `gain at y=${buttonY}: ${sample.gain}`,
      );
      const {frames, rate, peak, rms} = sample;
      const shape = {frames, rate, peak, rms};
      assert.ok(frames > 0 && rate > 0 && peak >= rms && rms > 0);
      if (effectShape) assert.deepEqual(shape, effectShape);
      effectShape = shape;
    }
    let voicePreview;
    if (!freshConfiguration) {
      const voice = await evaluate('siglusAudio.length');
      await clickConfig(1163, 247);
      voicePreview = await waitFor(`siglusAudio.slice(${voice}).find(({channel, resource}) =>
        channel === 'pcm15' && resource === 300914)`);
      assert.equal(voicePreview.volumeType, 1);
      assert.equal(voicePreview.gain, 1);
      assert.ok(voicePreview.frames > 0 && voicePreview.rate > 0);
      assert.ok(voicePreview.peak >= voicePreview.rms && voicePreview.rms > 0);
    }
    console.log('Configuration audio previews', {effectShape, voicePreview});
    const [duckLevel] = await settingsWrite(94, 570, 384);
    const [duckEnabled] = await settingsWrite(97, 188, 385);
    assert.notEqual(duckLevel, 204);
    assert.equal(duckEnabled, 0);
    const storedSettings = `JSON.parse(localStorage.getItem(Object.keys(localStorage)
      .find((key) => /^siglus:.*:options$/.test(key))))`;
    assert.deepEqual(await evaluate(`${storedSettings}.playback`), {
      messageSpeed,
      messageNowait: false,
      autoCharacterWait: characterWait,
      autoMinimumWait: minimumWait,
      voiceDuckLevel: duckLevel,
      voiceDuckEnabled: false,
    });
    assert.deepEqual(await evaluate(`${storedSettings}.filter`), [red, 80, 60, 178]);
    await clickConfig(1630, 22, 'right');
    await waitFor(`(() => {
      const button = siglusSurface.querySelector('button[aria-label="New Game"]');
      return Boolean(button && !button.closest('[inert]'));
    })()`);
    const tags = await evaluate(`siglusTags.slice(${initial})`);
    // A jump can skip CD_NL, leaving the live source line at the last executed
    // marker. The independent disassembly prints lines in byte order.
    compareTags(tags, scripts, {compareSourceLine: false});
    console.log(`Configuration: returned to title and matched ${tags.length} command tags.`);
    await reopenPlayer();
    assert.equal(await evaluate(dialogueFont), chosenFont);
    assert.deepEqual(await evaluate(messageFontStyle), changedFontStyle);
    assert.ok(Math.abs((await evaluate(stageWidth)) - halfWidth) < 1);
    await click('#siglus-surface button[aria-label="Configuration"]');
    await waitFor(`document.querySelector('#siglus-surface canvas') && ${configLoop}`);
    await openMovieDialog();
    assert.equal(
      await evaluate(`document.querySelector('${movieDialog} input:checked').value`),
      'mci',
    );
    for (const type of ['keyDown', 'keyUp'])
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
    await waitFor(
      `!document.querySelector('${movieDialog}') && document.activeElement === siglusSurface.firstElementChild`,
    );
    console.log(
      'Configuration: movie mode persisted across reopening and Escape restored game focus.',
    );
    const sliderPositions = async (tab, rows) => {
      const start = await evaluate('siglusTags.length');
      await clickConfig(tab, 22);
      return waitFor(`(() => {
        const rows = ${JSON.stringify(rows)};
        const controls = new Map(siglusTags.slice(${start}).filter(({scene, args}) =>
          scene === '${configScene}' && args?.[0] === '__sys_cf_ctl01'
          && rows.includes(args[3])).map(({args}) => [args[3], args[2]]));
        return rows.every((row) => controls.has(row)) && rows.map((row) => controls.get(row));
      })()`);
    };
    assert.deepEqual(await sliderPositions(1450, [234, 409, 473, 523]), [
      794 + Math.trunc((-384 * messageSpeed) / 100),
      410 + Math.trunc((384 * red) / 255),
      1347 + Math.trunc((300 * characterWait) / 500),
      1347 + Math.trunc((300 * minimumWait) / 5000),
    ]);
    assert.deepEqual(await sliderPositions(1630, [374]), [
      410 + Math.trunc((384 * duckLevel) / 255),
    ]);
    console.log(
      'Configuration: Text and Sound rebuilt their sliders from settings restored after reopening.',
    );
  } else if (musicOnly) {
    const music = '#siglus-surface button[aria-label="Music"]';
    await click(music);
    await waitFor(`siglusTags.filter(({scene, path}) =>
      scene === '_extra_music' && path?.join('.') === '38.6.-1.0.3').length >= 2`);
    await click('#siglus-surface [data-siglus-button="0"]');
    await waitFor("siglusSurface.dataset.bgm?.toLowerCase() === 'bgm01'");
    await click('#siglus-surface [data-siglus-button="105"]');
    await waitFor("siglusSurface.dataset.bgm?.toLowerCase() === 'bgm02'");
    await click('#siglus-surface [data-siglus-button="103"]');
    await waitFor('!siglusSurface.dataset.bgm');
    await click('#siglus-surface [data-siglus-button="102"]');
    await waitFor("siglusSurface.dataset.bgm?.toLowerCase() === 'bgm02'");
    await click('#siglus-surface [data-siglus-button="15"]');
    const loopedBgm = await waitFor(`siglusAudio.find(({channel, resource}) =>
      channel === 'bgm' && resource?.toLowerCase() === 'bgm16')`);
    assert.equal(loopedBgm.loop, true);
    assert.equal(loopedBgm.startSample, 44100);
    assert.equal(loopedBgm.loopStartSample, 853475);
    assert.equal(loopedBgm.loopEndSample, 4885472);
    console.log('Music: BGM16 start and loop points matched Gameexe.dat.');
    const slider = '#siglus-surface [data-siglus-button="107"]';
    const [sliderX, sliderY] = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(slider)}).getBoundingClientRect();
      return [rect.x + rect.width / 2, rect.y + rect.height / 2];
    })()`);
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: sliderX,
      y: sliderY,
      button: 'left',
      clickCount: 1,
    });
    const writeVolume = "tag.scene === '_extra_music' && tag.path?.join('.') === '63.21'";
    await waitFor(`siglusTags.some(tag => ${writeVolume})`);
    const initialVolume = await evaluate(`siglusTags.findLast(tag => ${writeVolume}).args[0]`);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: sliderX + 24,
      y: sliderY,
      button: 'left',
      buttons: 1,
    });
    await waitFor(`siglusTags.findLast(tag => ${writeVolume})?.args[0] > ${initialVolume}`);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: sliderX + 24,
      y: sliderY,
      button: 'left',
      clickCount: 1,
    });
    await click('#siglus-surface [data-siglus-button="100"]');
    await waitFor(`document.querySelector(${JSON.stringify(music)})?.isConnected`);
    const volume = await evaluate(`siglusTags.findLast(tag => ${writeVolume}).args[0]`);
    const savedMix = await evaluate(`(() => {
      const key = Object.keys(localStorage).find(key => /^siglus:[0-9a-f]{64}:audio$/.test(key));
      return key ? JSON.parse(localStorage.getItem(key)) : null;
    })()`);
    assert.equal(savedMix?.levels.BGM, volume);
    console.log('Music: selected track, next, stop, resume, volume drag, and return to title.');
    const trace = await evaluate('siglusTags');
    compareTags(trace, scripts);
    await click('#siglus-surface button[aria-label="Exit"]');
    await waitFor("document.querySelector('#play')?.disabled === false");
    await openPlayer();
    await playInstallation();
    await click(music);
    const restored = await waitFor(`(() => {
      const slider = siglusSurface.querySelector('[data-siglus-button="107"]');
      if (!slider) return false;
      return Number.parseFloat(slider.style.left) + 1;
    })()`);
    assert.equal(restored - 1, Math.trunc((volume * 347) / 255), 'Restored BGM volume slider');
    console.log('Music: BGM volume restored after reopening the player.');
  } else {
    if (!slideOnly && !pauseSaveOnly)
      await waitFor(`siglusTags.filter(({scene, path}) =>
        scene === '_titlemenu_dmy' && path?.join('.') === '38.6.-1.0.3').length >= 2`);
    await click('#siglus-surface button[aria-label="New Game"]');
  }
  if (
    musicOnly ||
    configOnly ||
    loadOnly ||
    quickOnly ||
    autoOnly ||
    manageOnly ||
    cancelOnly ||
    frameLockOnly ||
    skipOnly ||
    historyOnly
  ) {
    assert.equal(errors.length, 0);
  } else if (pauseSaveOnly) {
    const atOffset = (offset) =>
      `siglusTags.at(-1)?.scene === ${JSON.stringify(scene)} && siglusTags.at(-1)?.offset === ${offset}`;
    const dialogue = "siglusSurface.querySelector('[data-siglus-dialogue]').textContent";
    await runUntil(() => evaluate(atOffset(0x48c8)));
    const prefix = await evaluate(dialogue);
    assert.equal(digest(prefix), scripts.get(scene).tags.get(0x48b4).hash);
    assert.equal(await selectSlot('save'), 'confirm');
    await waitFor('siglusSurface.dataset.savedPage');
    await clickScriptMenu(slotLoop, 1540, 1023);
    await waitForDialogueControls();
    await clickStage();
    await waitFor(atOffset(0x491b));
    const completed = await evaluate(dialogue);
    assert.ok(completed.startsWith(prefix));
    assert.equal(digest(completed.slice(prefix.length)), scripts.get(scene).tags.get(0x4907).hash);
    assert.equal(await selectSlot('load'), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    assert.equal(await evaluate(dialogue), prefix);
    await clickStage();
    await waitFor(atOffset(0x491b));
    assert.equal(await evaluate(dialogue), completed);
    await verifyRenderedPages();
    console.log('Save and Load restored a partial page and its inline continuation.');
  } else if (slideOnly) {
    const chapter = [...scripts.keys()].find((name) => name.startsWith('02_'));
    const end = `siglusTags.some(({scene, offset}) => scene === ${JSON.stringify(chapter)} && offset === 0x344f8)`;
    await runUntil((current) => Number(current.page) >= 1);
    await control('keyDown');
    try {
      await waitFor(end, 300000);
    } finally {
      await control('keyUp').catch(() => {});
    }
    const {text: printed, translate, finalRowInk, reason} = await evaluate('siglusSlideProof');
    const reference = [...scripts.get(chapter).tags.values()].filter(
      ({offset, tag}) => tag === 'text' && offset >= 0x34250 && offset <= 0x344e4,
    );
    assert.deepEqual(
      printed.split('\n').map(digest),
      reference.map(({hash}) => hash),
    );
    assert.equal(reason, undefined, 'The last row of the long message is visible');
    if (domRoute) assert.ok(Number.parseFloat(translate.split(' ')[1]) <= -224, translate);
    else assert.ok(finalRowInk > 100, 'Native slide drew the final row');
    console.log('Slide checkpoint:', {translate, finalRowInk, lines: reference.length});
    await verifyRenderedPages();
  } else if (diagnosticPages > 0) {
    const firstPage = page;
    await runUntil((current) => Number(current.page) >= firstPage + 1);
    await control('keyDown');
    try {
      const checkpoint = await waitFor(
        `Number(siglusSurface.dataset.page) >= ${firstPage + diagnosticPages} || siglusSurface.dataset.movie`,
        120000,
      );
      console.log(
        'Diagnostic checkpoint',
        checkpoint,
        await evaluate(
          `({page: siglusSurface.dataset.page, movie: siglusSurface.dataset.movie,
           tags: siglusTags.length, position: siglusTags.at(-1)?.scene})`,
        ),
      );
    } finally {
      await control('keyUp').catch(() => {});
    }
    await verifyRenderedPages({requireReset: diagnosticPages >= 1000});
  } else if (openingOnly) {
    backgrounds.clear();
    voices.clear();
    sprites.clear();
    music = undefined;
    await runUntil((current) => current.lines === 50 && Number(current.page) > page);
    assert.ok(backgrounds.size > 1 && voices.size > 1 && sprites.size > 1 && music === 'bgm02');
    const pausedPage = await evaluate('siglusSurface.dataset.page');
    const dialogue = '#siglus-surface [data-siglus-dialogue]';
    assert.equal(await evaluate('siglusSurface.firstElementChild.dataset.textMode'), 'native');
    const metrics = await evaluate(`(() => {
      const canvas = siglusSurface.querySelector('[data-siglus-native-text]');
      const context = canvas.getContext('2d');
      const alpha = context.getImageData(0,0,canvas.width,canvas.height).data;
      let count = 0;
      for (let i = 3; i < alpha.length; i += 4) if (alpha[i]) count++;
      const text = siglusSurface.querySelector('[data-siglus-dialogue]');
      const speaker = text.previousElementSibling;
      context.save();
      context.textBaseline = 'top';
      const baseline = (element) => {
        const style = getComputedStyle(element);
        context.font = style.fontSize + ' ' + style.fontFamily;
        return parseFloat(element.style.top) - context.measureText('国').alphabeticBaseline;
      };
      const baselines = [baseline(text), speaker.textContent ? baseline(speaker) : null];
      context.restore();
      return {width: canvas.width, height: canvas.height, count, baselines};
    })()`);
    assert.ok(metrics.width > 0 && metrics.height > 0 && metrics.count > 100);
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(dialogue)}).hidden`),
      true,
    );
    await evaluate(`(() => {
      const selector = document.querySelector('#text-mode');
      selector.value = 'dom';
      selector.dispatchEvent(new Event('change'));
      return true;
    })()`);
    assert.equal(await evaluate('siglusSurface.firstElementChild.dataset.textMode'), 'dom');
    assert.equal(await evaluate('siglusSurface.dataset.page'), pausedPage);
    const domBaselines = await evaluate(`(() => {
      const text = siglusSurface.querySelector('[data-siglus-dialogue]');
      const speaker = text.previousElementSibling;
      const baseline = (element) => {
        const marker = document.createElement('span');
        marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        element.prepend(marker);
        const y = Number.parseFloat(element.style.top) + marker.offsetTop;
        marker.remove();
        return y;
      };
      return [baseline(text), speaker.textContent ? baseline(speaker) : null];
    })()`);
    for (const [index, nativeBaseline] of metrics.baselines.entries()) {
      if (nativeBaseline === null) continue;
      assert.ok(
        Math.abs(domBaselines[index] - nativeBaseline) <= 1,
        `DOM baseline ${domBaselines[index]} should align with Native ${nativeBaseline}`,
      );
    }
    console.log('First-line baselines in game pixels', {
      native: metrics.baselines,
      dom: domBaselines,
    });
    assert.equal(
      await evaluate(
        `getComputedStyle(document.querySelector(${JSON.stringify(dialogue)})).userSelect`,
      ),
      'text',
    );
    const [start, end, y] = await evaluate(`(() => {
      const text = document.querySelector(${JSON.stringify(dialogue)});
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.length < 3 || !node.data.trim()) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, node.length);
        for (const rect of range.getClientRects()) {
          const y = rect.top + rect.height / 2;
          const start = rect.left + 2;
          const end = Math.min(rect.right - 2, innerWidth - 2);
          if (end - start >= 16 && text.contains(document.elementFromPoint(start, y)))
            return [start, end, y];
        }
      }
      throw Error('No selectable dialogue range');
    })()`);
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start,
      y,
      button: 'left',
      clickCount: 1,
    });
    for (const fraction of [0.33, 0.66, 1])
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: start + (end - start) * fraction,
        y,
        button: 'left',
        buttons: 1,
      });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: end,
      y,
      button: 'left',
      clickCount: 1,
    });
    await waitFor('!getSelection().isCollapsed');
    assert.equal(await evaluate('siglusSurface.dataset.page'), pausedPage);
    const trace = await evaluate('siglusTags');
    const newGameTags = compareOpening(trace, scripts, scene, entry, 50);
    console.log(
      `50 text tags, ${newGameTags} New Game tags and ${trace.length} total tags matched. Console errors: ${errors.length}.`,
    );
    console.log(
      `New Game: ${backgrounds.size} backgrounds, ${sprites.size} portraits, ${voices.size} decoded voices, ${music}.`,
    );
    // Click the unused space in the dialogue box, outside the highlighted glyphs.
    await click(dialogue);
    await waitFor('Number(siglusSurface.dataset.page) > ' + pausedPage);
    const afterDom = await evaluate('Number(siglusSurface.dataset.page)');
    await evaluate(`(() => {
      const selector = document.querySelector('#text-mode');
      selector.value = 'native';
      selector.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) > ${afterDom}`);
    console.log('Native canvas metrics', metrics);
    console.log('Dragging selects dialogue, and clicking advances it.');
    await verifyRenderedPages();
  } else {
    const savePage = page + 3;
    await runUntil((current) => Number(current.page) >= savePage);
    const dialogue = "siglusSurface.querySelector('[data-siglus-dialogue]').textContent";
    const savedText = digest(await evaluate(dialogue));
    await selectSlot('save');
    const saved = await waitFor('siglusSurface.dataset.savedPage');
    assert.equal(Number(saved), savePage);
    console.log('Saved page', saved);
    // The script creates the Return to Game button at (1486, 998).
    await clickScriptMenu(slotLoop, 1540, 1023);
    await waitForDialogueControls();
    const beforeLoad = await evaluate('siglusTags.length');
    await clickStage();
    await waitFor('Number(siglusSurface.dataset.page) > ' + saved);
    assert.notEqual(digest(await evaluate(dialogue)), savedText, 'Advanced to another page');
    await selectSlot('load');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    assert.equal(digest(await evaluate(dialogue)), savedText, 'Loaded dialogue SHA-256');
    const afterLoad = await evaluate('siglusTags.length');
    await clickStage();
    console.log('Saved and loaded page', saved);
    const movies = ['op', 'chapter1', 'chapter2', 'chapter3', 'ed'];
    for (const [index, name] of movies.entries()) {
      await control('keyDown');
      await waitFor('siglusSurface.dataset.movie === ' + JSON.stringify(name), 600000);
      await control('keyUp');
      console.log('Movie started:', name);
      await waitFor('siglusMovies.length === ' + (index + 1), 360000);
      console.log('Movie completed:', name);
    }
    // The ending leaves a skippable scene fade before the real title menu.
    await clickStage();
    await waitFor(
      "siglusSurface.dataset.phase === 'title' && siglusSurface.dataset.bgm === 'bgm12'",
    );
    await waitFor(`siglusAudio.some(({channel, resource}) =>
      channel === 'pcm0' && [990011, 990012, 990013, 990015].includes(resource))`);
    await verifyRenderedPages({requireReset: true});
    const flags = new Map(
      await evaluate(`(() => {
      const key = Object.keys(localStorage).find((key) => /^siglus:[0-9a-f]{64}:system$/.test(key));
      return key ? JSON.parse(localStorage.getItem(key)) : [];
    })()`),
    );
    for (const index of [1006, 1571, 1572, 1573, 1574, 1575])
      assert.equal(flags.get(index), 1, 'Persistent Siglus flag G[' + index + ']');
    assert.equal(flags.get(1007), 3, 'Cleared title layout G[1007]');
    assert.equal(flags.get(1009), 0, 'The title consumes the one-shot clear voice request');
    assert.equal(await evaluate('siglusMovies.every((movie) => movie.frames > 0)'), true);
    const media = await evaluate('({audio: siglusAudio, movies: siglusMovies})');
    assert.deepEqual(
      media.movies.map((movie) => movie.name),
      movies,
    );
    assert.ok(
      media.audio.every(
        ({peak, rms, frames, rate}) =>
          Number.isFinite(peak) && Number.isFinite(rms) && frames > 0 && rate > 0,
      ),
    );
    for (const channel of ['bgm', 'voice', 'pcm0'])
      assert.ok(
        media.audio.some((audio) => audio.channel === channel && audio.rms > 0),
        channel,
      );

    const trace = [];
    const total = await evaluate('siglusTags.length');
    for (let i = 0; i < total; i += 1024)
      trace.push(...(await evaluate('siglusTags.slice(' + i + ',' + (i + 1024) + ')')));
    compareTags(
      trace.filter(({scene}) => scene !== slotScene),
      scripts,
    );
    compareTags(
      trace.filter(({scene}) => scene === slotScene),
      scripts,
      {compareSourceLine: false},
    );
    const chapters = [...scripts.keys()].filter((name) => /^0[1-8]_/.test(name)).sort();
    const calls = trace.filter(
      (tag) => tag.scene.startsWith('00') && tag.path?.length === 1 && tag.path[0] === 5,
    );
    assert.deepEqual(
      calls.map((tag) =>
        chapters.find((chapter) => chapter.toLowerCase() === String(tag.args[0]).toLowerCase()),
      ),
      [chapters[0], ...chapters],
    );
    assert.equal(calls[1].args[1], 2);
    compareChapterOrder(
      [...trace.slice(0, beforeLoad), ...trace.slice(afterLoad)],
      scripts,
      chapters,
      2,
    );
    assert.ok(
      trace.some(
        (tag) => tag.scene.startsWith('00') && tag.path?.length === 1 && tag.path[0] === 3,
      ),
    );
    console.log(
      `${total} tags matched. ${media.audio.length} decoded audio buffers, console errors ${errors.length}.`,
    );
    const music = '#siglus-surface button[aria-label="Music"]';
    await reopenPlayer();
    await waitFor(`siglusSurface.dataset.phase === 'title' && siglusSurface.dataset.bgm === 'bgm12'
      && document.querySelector(${JSON.stringify(music)})?.disabled === false`);
    assert.equal(await evaluate('siglusSurface.dataset.page'), undefined);
    await waitFor(`siglusAudio.some(({channel, resource}) =>
      channel === 'pcm0' && [900019, 900020].includes(resource))`);
    await click(music);
    await waitFor(`siglusTags.some(({scene, path}) =>
      scene === '_extra_music' && path?.join('.') === '38.6.-1.0.3')`);
    await click('#siglus-surface [data-siglus-button="100"]');
    await waitFor(`siglusSurface.dataset.phase === 'title' && siglusSurface.dataset.bgm === 'bgm12'
      && document.querySelector(${JSON.stringify(music)})?.disabled === false`);
    console.log('Reopened at the cleared title, entered the unlocked Music menu and returned.');
  }
  assert.deepEqual(errors, [], 'Browser console errors');
} finally {
  if (cdp?.socket.readyState === WebSocket.OPEN) {
    await cdp.command('Browser.close').catch(() => {});
    cdp.socket.close();
  }
  server.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const kill = setTimeout(() => child.kill(), 2000);
    await browserClosed;
    clearTimeout(kill);
  }
  await rm(profile, {recursive: true, force: true, maxRetries: 8, retryDelay: 100});
}
