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
const musicOnly = process.env.SIGLUS_MUSIC_ONLY === '1';
const autoOnly = process.env.SIGLUS_AUTOSAVE_ONLY === '1';
const quickOnly = process.env.SIGLUS_QUICK_ONLY === '1';
const historyOnly = process.env.SIGLUS_HISTORY_ONLY === '1';
const skipOnly = process.env.SIGLUS_READ_SKIP_ONLY === '1';
const cancelOnly = process.env.SIGLUS_CANCEL_ONLY === '1';
const manageOnly = process.env.SIGLUS_SLOT_MANAGEMENT_ONLY === '1';
const loadOnly = process.env.SIGLUS_LOAD_ONLY === '1';
const configOnly = process.env.SIGLUS_CONFIG_ONLY === '1';
const openingOnly = process.env.SIGLUS_OPENING_ONLY === '1';
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
try {
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
    await waitFor("!document.querySelector('[data-siglus-action=save]')?.parentElement.hidden");
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
    await send('Page.navigate', {
      url: `http://127.0.0.1:${server.address().port}/siglus.html?siglus-trace${configOnly ? '&siglus-probe-configuration' : ''}`,
    });
    await waitFor("document.querySelector('#files') !== null && !window.siglusSurface");
    const {root} = await send('DOM.getDocument');
    const {nodeId} = await send('DOM.querySelector', {nodeId: root.nodeId, selector: '#files'});
    await send('DOM.setFileInputFiles', {nodeId, files: [resolve(folder)]});
    await waitFor("document.querySelector('#play')?.disabled === false");
    await evaluate(`window.siglusTags = [];
    window.siglusAudio = [];
    window.siglusMovies = [];
    window.siglusSurface = document.querySelector('#siglus-surface');
    window.siglusPageAudit = {pages: 0, skipped: 0, textSizeResets: 0, failures: []};
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
      const rendered = native ? stage.querySelector('[data-siglus-native-text]') : text;
      const size = Number.parseFloat(text.style.fontSize);
      const viewport = stage.getBoundingClientRect();
      const rect = rendered.getBoundingClientRect();
      const intersects = (bounds) => bounds.width > 0 && bounds.height > 0 &&
        bounds.right > viewport.left && bounds.bottom > viewport.top &&
        bounds.left < viewport.right && bounds.top < viewport.bottom;
      let reason;
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
            for (let i = 3; i < alpha.length; i += 4) {
              if (alpha[i] >= 32) return;
            }
            reason = 'dialogue canvas has no visible ink';
          }
        } else {
          const range = document.createRange();
          range.selectNodeContents(text);
          if (![...range.getClientRects()].some(intersects)) reason = 'dialogue has no visible text bounds';
        }
      } else reason = 'dialogue is empty';
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
    configOnly ||
    loadOnly ||
    quickOnly ||
    autoOnly ||
    manageOnly ||
    cancelOnly ||
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
      if (finished(current)) return current;
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
    async function configuration() {
      await quickMenu();
      const configLoop = `siglusTags.filter(({scene, path}) =>
        scene === '__sys_menu_config01' && path?.join('.') === '86.3').length`;
      const frame = await evaluate(configLoop);
      await clickScriptMenu(loop, 1270, 630);
      await waitFor(`${configLoop} > ${frame}`);
      return configLoop;
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
    const configLoop = await configuration();
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
    assert.equal(await evaluate('siglusSurface.dataset.page'), pageAfterAuto);
    const tags = await evaluate(`siglusTags.filter((tag) => tag.scene === '${scene}')`);
    compareTags(tags, scripts, {compareSourceLine: false});
    console.log(
      `Right-click opened the original quick menu, dismissed it, entered Save and Configuration, toggled Auto, and hid and restored the same dialogue. Matched ${tags.length} tags.`,
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
    assert.equal(await selectSlot('save'), 'confirm', 'Overwriting the slot requires confirmation');
    await waitFor(`siglusSurface.dataset.savedPage === '${savedState.page}'`);
    await clickScriptMenu(slotLoop, 1540, 1023);
    await waitForDialogueControls();
    const saveCommands = await evaluate(`siglusTags.filter(({scene}) => scene === '${slotScene}')`);
    compareTags(saveCommands, scripts, {compareSourceLine: false});
    assert.match(await thumbnail(), /^data:image\/jpeg;base64,/);
    await clickStage();
    await waitFor(`Number(siglusSurface.dataset.page) > ${savedState.page}`);
    const nextText = digest(await evaluate(dialogue));
    assert.notEqual(nextText, savedText);
    await switchToConfiguration('save');
    assert.equal(await switchToSlots('load'), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
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
    assert.equal(await chooseSlot('load', 0), 'confirm');
    await waitFor("siglusSurface.dataset.loaded === 'true'");
    assert.equal(digest(await evaluate(dialogue)), savedText);
    assert.equal(await evaluate('siglusSurface.dataset.background'), savedState.background);
    assert.equal(await evaluate('siglusSurface.dataset.cast'), savedState.cast);
    assert.equal(await evaluate('siglusSurface.dataset.bgm'), savedState.bgm);
    const restoredPage = await evaluate('Number(siglusSurface.dataset.page)');
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
  } else if (configOnly) {
    await click('#siglus-surface button[aria-label="Configuration"]');
    await waitFor(`siglusTags.some(({scene, path}) =>
      scene === '__sys_menu_config01' && path?.join('.') === '86.3')`);
    const configScene = '__sys_menu_config01';
    const configLoop = `siglusTags.filter(({scene, path}) => scene === '${configScene}' && path?.join('.') === '86.3').length`;
    const configCommand = (path, start) =>
      `siglusTags.slice(${start}).some(({scene, path}) =>
        scene === '${configScene}' && path?.join('.') === '${path}')`;
    async function clickConfig(gameX, gameY, button = 'left') {
      const [x, y] = await evaluate(`(() => {
        const rect = siglusSurface.querySelector('div[tabindex="0"]').getBoundingClientRect();
        return [rect.left + rect.width * ${gameX} / 1920, rect.top + rect.height * ${gameY} / 1080];
      })()`);
      const frame = await evaluate(configLoop);
      await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
      await send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button, clickCount: 1});
      await waitFor(`${configLoop} > ${frame}`);
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
      await clickConfig(875, buttonY + 15);
      const sample = await waitFor(`siglusAudio.slice(${preview}).find(({channel, resource}) =>
        channel === 'pcm15' && resource === 'system_decide')`);
      assert.equal(sample.volumeType, 31);
      assert.ok(Math.abs(sample.gain - volume / 255) < 1e-7);
      const {frames, rate, peak, rms} = sample;
      const shape = {frames, rate, peak, rms};
      assert.ok(frames > 0 && rate > 0 && peak >= rms && rms > 0);
      if (effectShape) assert.deepEqual(shape, effectShape);
      effectShape = shape;
    }
    const voice = await evaluate('siglusAudio.length');
    await clickConfig(1163, 247);
    const voicePreview = await waitFor(`siglusAudio.slice(${voice}).find(({channel, resource}) =>
      channel === 'pcm15' && resource === 300914)`);
    assert.equal(voicePreview.volumeType, 1);
    assert.equal(voicePreview.gain, 1);
    assert.ok(voicePreview.frames > 0 && voicePreview.rate > 0);
    assert.ok(voicePreview.peak >= voicePreview.rms && voicePreview.rms > 0);
    console.log('Configuration audio previews', {effectShape, voicePreview});
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
    skipOnly ||
    historyOnly
  ) {
    assert.equal(errors.length, 0);
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
  }
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
