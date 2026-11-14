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
  const {targetId} = await cdp.command('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await cdp.command('Target.attachToTarget', {targetId, flatten: true});
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
    siglusSurface.addEventListener('siglus-tag', (event) => siglusTags.push(event.detail));
    siglusSurface.addEventListener('siglus-audio', (event) => siglusAudio.push(event.detail));
    siglusSurface.addEventListener('siglus-movie-ended', (event) => siglusMovies.push(event.detail)); true`);
  }
  async function playInstallation() {
    await click('#play');
    await waitFor("siglusTags.some((tag) => tag.scene === '_start' && tag.path?.[0] === 55)");
    await delay(180);
    await advance();
  }
  await openPlayer();
  if (musicOnly || configOnly) {
    const pack = await readFile(join(resolve(folder), 'StartData', 'GameData', 'Scene.pck')).catch(
      () => readFile(join(resolve(folder), 'Scene.pck')),
    );
    const key = 'siglus:' + digest(pack) + ':system';
    await evaluate(
      `localStorage.setItem(${JSON.stringify(key)}, '[[1006,1],[1007,3],[1571,1],[1575,1]]')`,
    );
  }
  await playInstallation();
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
  if (configOnly) {
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
    const beforeText = await evaluate('siglusTags.length');
    await clickConfig(1450, 22);
    await waitFor(configCommand('65.1.2.-1.63.93.-1.23.39', beforeText));
    await waitFor(`siglusTags.slice(${beforeText}).some(({scene, path}) =>
      scene === '${configScene}' && path?.join('.') === '86.3')`);
    console.log('Configuration: the Text tab created its original sample.');
    const beforeSound = await evaluate('siglusTags.length');
    await clickConfig(1630, 22);
    await waitFor(`siglusTags.slice(${beforeSound}).some(({scene, args}) =>
      scene === '${configScene}' && args?.[0] === '__sys_cf_btn33')`);
    await waitFor(`siglusTags.slice(${beforeSound}).some(({scene, path}) =>
      scene === '${configScene}' && path?.join('.') === '86.3')`);
    console.log('Configuration: the Sound tab created its original controls.');
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
  if (musicOnly || configOnly) {
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
  } else if (openingOnly) {
    backgrounds.clear();
    voices.clear();
    sprites.clear();
    music = undefined;
    await runUntil((current) => current.lines === 50 && Number(current.page) > page);
    assert.ok(backgrounds.size > 1 && voices.size > 1 && sprites.size > 1 && music === 'bgm02');
    const pausedPage = await evaluate('siglusSurface.dataset.page');
    const dialogue = '#siglus-surface [data-siglus-dialogue]';
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
    console.log('Dragging selects dialogue, and clicking advances it.');
  } else {
    const savePage = page + 3;
    await runUntil((current) => Number(current.page) >= savePage);
    const dialogue = "siglusSurface.querySelector('[data-siglus-dialogue]').textContent";
    const savedText = digest(await evaluate(dialogue));
    await click('[data-siglus-action="save"]');
    const saved = await waitFor('siglusSurface.dataset.savedPage');
    assert.equal(Number(saved), savePage);
    const beforeLoad = await evaluate('siglusTags.length');
    await clickStage();
    await waitFor('Number(siglusSurface.dataset.page) > ' + saved);
    assert.notEqual(digest(await evaluate(dialogue)), savedText, 'Advanced to another page');
    await click('[data-siglus-action="load"]');
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
    compareTags(trace, scripts);
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
