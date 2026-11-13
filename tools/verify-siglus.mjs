import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DevToolsConnection} from './capture-browser-trace.mjs';
import {createStaticServer} from './serve-static.mjs';

const [folder, browser, disassemblyDirectory] = process.argv.slice(2);
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
    for (const instruction of lines.slice(start + 1)) {
      const match = /^([\dA-F]{8}): CD_(NL|COMMAND|TEXT|NAME) (.*)$/.exec(instruction);
      if (!match) continue;
      const [, offset, op, body] = match;
      if (op === 'NL') {
        line = Number(body);
        continue;
      }
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
        entry.value = quoted?.replace(
          /\\([\\rnt])/g,
          (_, c) => ({r: '\r', n: '\n', t: '\t', '\\': '\\'})[c],
        );
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
    scripts.set(name, {tags, entries});
  }
  return scripts;
}

function compareTrace(trace, scripts, scene, entry, lineCount) {
  for (const tag of trace) {
    const {tags} = scripts.get(tag.scene) ?? {};
    const expected = tags?.get(tag.offset);
    assert.ok(expected, `Missing reference tag at ${tag.scene}:${tag.offset.toString(16)}`);
    const {offset, line, readFlag} = tag;
    const fields = {offset, line, tag: tag.tag, readFlag};
    assert.deepEqual(
      tag.tag === 'command'
        ? {...fields, code: tag.path.at(-1), argc: tag.args.length}
        : {...fields, value: tag.value},
      expected,
    );
  }
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
      return [x + width / 2, y + height / 2];
    })()`);
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
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
  for (const domain of ['Page', 'DOM', 'Runtime', 'Log']) await send(domain + '.enable');
  await send('Page.navigate', {
    url: `http://127.0.0.1:${server.address().port}/siglus.html?siglus-trace`,
  });
  await waitFor("document.querySelector('#files') !== null");
  const {root} = await send('DOM.getDocument');
  const {nodeId} = await send('DOM.querySelector', {nodeId: root.nodeId, selector: '#files'});
  await send('DOM.setFileInputFiles', {nodeId, files: [resolve(folder)]});
  await waitFor("document.querySelector('#play')?.disabled === false");
  await evaluate(`window.siglusTags = [];
    window.siglusSurface = document.querySelector('#siglus-surface');
    siglusSurface.addEventListener('siglus-tag', (event) => siglusTags.push(event.detail)); true`);
  await click('#play');
  await waitFor("siglusTags.some((tag) => tag.scene === '_start' && tag.path?.[0] === 55)");
  await delay(180);
  await advance();
  const state = () =>
    evaluate(`({
    ...siglusSurface.dataset,
    title: !!siglusSurface.querySelector('button[aria-label="New Game"]'),
    dialogue: !!siglusSurface.querySelector('[data-siglus-dialogue]')?.textContent,
    lines: siglusTags.filter((tag) => tag.tag === 'text' && tag.scene === ${JSON.stringify(scene)} && tag.offset >= ${entry}).length
  })`);
  const deadline = Date.now() + 180000;
  let page = 0;
  const backgrounds = new Set();
  const voices = new Set();
  const sprites = new Set();
  let music;
  async function runUntil(finished) {
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
  await click('#siglus-surface button[aria-label="New Game"]');
  backgrounds.clear();
  voices.clear();
  sprites.clear();
  music = undefined;
  await runUntil((current) => current.lines === 50 && Number(current.page) > page);
  assert.ok(backgrounds.size > 1 && voices.size > 1 && sprites.size > 1 && music === 'bgm02');
  const trace = await evaluate('siglusTags');
  const newGameTags = compareTrace(trace, scripts, scene, entry, 50);
  console.log(
    `50 text tags, ${newGameTags} New Game tags and ${trace.length} total tags matched. Console errors: ${errors.length}.`,
  );
  console.log(
    `New Game: ${backgrounds.size} backgrounds, ${sprites.size} portraits, ${voices.size} decoded voices, ${music}.`,
  );
} finally {
  cdp?.socket.close();
  server.close();
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  await browserClosed;
  await rm(profile, {recursive: true, force: true});
}
