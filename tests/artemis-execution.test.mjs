import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIet} from '../dist/formats/artemis/iet.js';
import {ArtemisLua, luaTag} from '../dist/engines/artemis/lua.js';
import {ArtemisScript} from '../dist/engines/artemis/script.js';
import {luaText} from '../dist/core/lua51/runtime.js';
const bytes = (s) => new TextEncoder().encode(s);

test('IET boot grammar retains label positions, comments, quoted brackets and positional arguments', () => {
  const program = parseIet(
    bytes(
      `; comment\r\n*top\r\n/* block\ncomment */[loading off logo][print data="a]b\\\"c"]\n*last\n[stop]`,
    ),
  );
  assert.equal(program.labels.get('top'), 0);
  assert.equal(program.labels.get('last'), 2);
  assert.equal(program.tags[0].args.get('0'), 'off');
  assert.equal(program.tags[0].args.get('1'), 'logo');
  assert.equal(program.tags[1].args.get('data'), 'a]b"c');
  assert.equal(program.tags[0].sourceLine, 3);
  for (const source of [
    'plain dialogue',
    '[x data="unterminated]',
    '[lua]bad',
    '/*bad',
    '[x',
    '*label suffix',
    '\0',
  ])
    assert.throws(() => parseIet(bytes(source)), /IET/);
});

test('IET loads all Lua definitions before dispatch, includes real bytes and pauses explicitly', () => {
  const sources = new Map([
    [
      'boot.iet',
      bytes(
        `*top\n[calllua function="boot"][wt][stop]\n[lua]\nfunction boot(e) e:include('module.lua'); result=moduleValue; e:tag{'record', data='雪', n=-1.2}; e:enqueueTag{'queued'} end\n[/lua]`,
      ),
    ],
    ['module.lua', bytes('moduleValue=42')],
    ['empty.lua', new Uint8Array()],
    ['binary', Uint8Array.of(0, 255)],
  ]);
  const events = [];
  const host = {
    readFile: (path) => sources.get(path) ?? null,
    fileExists: (path) => sources.has(path),
    now: () => 0x80000005,
    tag: (t) => events.push(['direct', t.name, t.args.get('data'), t.args.get('n')]),
    enqueueTag: (t) => events.push(['queue', t.name]),
    variable: () => 'value',
  };
  const lua = new ArtemisLua(host);
  try {
    const script = new ArtemisScript(lua, {
      readFile: host.readFile,
      dispatch: (tag) => {
        if (tag.name === 'wt') return 'waiting';
        if (tag.name === 'stop') return 'stopped';
        throw new Error('unsupported');
      },
    });
    script.load('boot.iet', 'top');
    assert.equal(script.run(), 'waiting');
    assert.equal(lua.vm.getGlobal('result'), 42);
    assert.deepEqual(events, [
      ['direct', 'record', '雪', '-2'],
      ['queue', 'queued'],
    ]);
    lua.vm.execute(
      bytes(
        `assert(e:now()==5); assert(e:file('binary')==string.char(0,255)); assert(e:file('absent')==nil); e:include('empty.lua')`.replaceAll(
          'e:',
          'engine:',
        ),
      ),
    );
    assert.equal(luaText(lua.vm.getGlobal('_VERSION')), 'Lua 5.1');
    script.resume();
    assert.equal(script.run(), 'stopped');
    assert.throws(() => script.resume(), /not waiting/);
    assert.throws(() => script.load('boot.iet', 'absent'), /Missing Artemis label/);
  } finally {
    lua.close();
  }
});

test('Unsupported native dispatch faults execution and never silently continues', () => {
  const readFile = () => bytes('[unsupported][stop]');
  const lua = new ArtemisLua({
    readFile,
    fileExists: () => true,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
  });
  try {
    const script = new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) => {
        throw new Error(`unsupported ${tag.name}`);
      },
    });
    script.load('boot');
    assert.throws(() => script.run(), /unsupported/);
    assert.equal(script.state, 'faulted');
    assert.equal(script.step(), 'faulted');
    assert.throws(
      () =>
        luaTag(
          new Map([
            [1, bytes('x')],
            ['boolean', true],
          ]),
        ),
      /Unsupported/,
    );
  } finally {
    lua.close();
  }
});

test('Live tag filters consume script tags while direct Lua tags bypass the filter', () => {
  const native = [],
    queued = [];
  const source = bytes(
    `[lua]\ntags={}; engine:setTagFilter(tags)\nfunction tags.wt(e,p) e:enqueueTag{'wait',time=0,input=1}; return 1 end\nfunction tags.echo(e,p) engine:tag{'echo',data=p.data}; return 1 end\n[/lua]\n[wt][echo data="雪"][stop]`,
  );
  let lua;
  const readFile = () => source;
  const dispatch = (tag) => {
    if (lua.filterTag(tag)) return;
    native.push(tag.name);
    if (tag.name === 'stop') return 'stopped';
  };
  lua = new ArtemisLua({
    readFile,
    fileExists: () => true,
    now: () => 0,
    tag: dispatch,
    enqueueTag: (t) => queued.push(t),
    variable: () => '',
  });
  try {
    const script = new ArtemisScript(lua, {readFile, dispatch});
    script.load('boot');
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(native, ['echo', 'stop']);
    assert.equal(queued[0].name, 'wait');
    assert.equal(queued[0].args.get('input'), '1');
    assert.equal(queued[0].sourceLine, -1);
  } finally {
    lua.close();
  }
});

test('Mode commands disable active skip/auto through status and effect services', async () => {
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const events = [];
  const modes = new ArtemisModes({
    writeStatus: (name, value) => events.push([name, value]),
    commandSkipChanged: (v) => events.push(['commandSkip', v]),
    controlSkipChanged: (v) => events.push(['controlSkip', v]),
    automodeChanged: (v) => events.push(['auto', v]),
    releaseScheduler: () => events.push(['release']),
  });
  const tag = (name, args) => ({
    kind: 'tag',
    name,
    args: new Map(Object.entries(args)),
    sourceLine: -1,
  });
  modes.setCommandSkip(true);
  modes.setControlSkip(true);
  modes.setAutomode(true);
  events.length = 0;
  modes.dispatch(tag('skip', {allow: '0', unread: '1'}));
  assert.equal(modes.skipAllowed, false);
  assert.equal(modes.skipUnread, true);
  assert.equal(modes.commandSkip, false);
  assert.equal(modes.controlSkip, false);
  modes.setCommandSkip(true);
  assert.equal(modes.commandSkip, false);
  modes.dispatch(tag('automode', {allow: '0', stopbyclick: '0', stopbystop: '1', syncse: ''}));
  assert.equal(modes.automode, false);
  assert.equal(modes.stopAutoByStop, true);
  assert.deepEqual(events, [
    ['s.status.commandskip', '0'],
    ['commandSkip', false],
    ['s.status.controlskip', '0'],
    ['controlSkip', false],
    ['s.status.automode', '0'],
    ['auto', false],
    ['release'],
  ]);
  modes.dispatch(tag('autosave', {allow: '2'}));
  modes.dispatch(tag('autosave', {allow: 'invalid'}));
  assert.equal(modes.autosave, 2);
  assert.equal(modes.dispatch(tag('unknown', {})), false);
});

test('Queued tags retain a copy and run before the next script command, across ASB call/return', () => {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const str = (s) => {
    const b = Buffer.from(s);
    return Buffer.concat([u32(b.length), b, Buffer.alloc(1)]);
  };
  const asb = Buffer.concat([
    Buffer.from([65, 83, 66, 0, 0]),
    u32(1),
    u32(0),
    str('return'),
    u32(0),
    u32(0),
  ]);
  const sources = new Map([
    [
      'boot',
      bytes(
        `[lua]\nloads=(loads or 0)+1\nfunction start(e) e:enqueueTag{'first'}; e:enqueueTag{'call',file='sub.asb'} end\n[/lua]\n[calllua function="start"][last][stop]`,
      ),
    ],
    ['sub.asb', asb],
  ]);
  let script;
  const events = [];
  const readFile = (p) => sources.get(p) ?? null;
  const lua = new ArtemisLua({
    readFile,
    fileExists: (p) => sources.has(p),
    now: () => 0,
    tag: () => {},
    enqueueTag: (t) => script.enqueue(t),
    variable: () => '',
  });
  try {
    script = new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) => {
        events.push(tag.name);
        if (tag.name === 'stop') return 'stopped';
      },
      pushLocal: () => events.push('push'),
      popLocal: () => events.push('pop'),
    });
    script.load('boot');
    const argument = new Map([['data', 'original']]);
    script.enqueue({kind: 'tag', name: 'copy', args: argument, sourceLine: -1});
    argument.set('data', 'changed');
    script.run(1);
    assert.deepEqual(events, ['copy']);
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(events, ['copy', 'first', 'push', 'pop', 'last', 'stop']);
    assert.equal(script.callDepth, 0);
    assert.equal(script.queuedTags, 0);
    script.load('boot');
    assert.equal(lua.vm.getGlobal('loads'), 1);
  } finally {
    lua.close();
  }
});

test('Literal variables preserve bytes and current-local scope; delete exact key precedes dotted descendants', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  const binary = Uint8Array.of(0, 255);
  variables.write('x', binary);
  binary[1] = 1;
  variables.pushLocal();
  variables.write('x', 'local', true);
  variables.pushLocal();
  assert.deepEqual(variables.read('x'), Uint8Array.of(0, 255));
  variables.popLocal();
  assert.equal(luaText(variables.read('x')), 'local');
  variables.popLocal();
  assert.deepEqual(variables.read('x'), Uint8Array.of(0, 255));
  variables.write('tree', 'root');
  variables.write('tree.child', 'leaf');
  variables.write('trees', 'keep');
  variables.delete('tree');
  assert.equal(luaText(variables.read('tree.child')), 'leaf');
  variables.delete('tree');
  assert.equal(variables.read('tree.child').length, 0);
  assert.equal(luaText(variables.read('trees')), 'keep');
  assert.throws(() => variables.delete(''), /Unsupported/);
  assert.throws(() => variables.read('s.unknown'), /Unsupported/);
  assert.throws(() => variables.read('x + 1'), /expression/);
});

test('Stage variable queries use the current host dimensions and preserve local writes', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  let width = 800;
  const variables = new ArtemisVariables({stageSize: () => ({width, height: 600})});
  const tag = (query) => ({
    kind: 'tag',
    name: 'var',
    sourceLine: -1,
    args: new Map([
      ['name', 'size'],
      ['system', query],
      ['writelocal', '1'],
    ]),
  });
  variables.write('size', 'global');
  variables.pushLocal();
  variables.dispatch(tag('screen_width'));
  assert.equal(luaText(variables.read('size')), '800');
  width = 1920;
  variables.dispatch(tag('screen_width'));
  assert.equal(luaText(variables.read('size')), '1920');
  variables.dispatch(tag('screen_height'));
  assert.equal(luaText(variables.read('size')), '600');
  variables.popLocal();
  assert.equal(luaText(variables.read('size')), 'global');
  const unsupported = new ArtemisVariables();
  assert.throws(() => unsupported.dispatch(tag('screen_width')), /provider/);
});

test('End of a called script restores its caller; root end requires an exit provider', () => {
  const sources = new Map([
    ['root', bytes('[call file="sub"][done]')],
    ['sub', bytes('[inside]')],
  ]);
  let script;
  const events = [];
  const readFile = (path) => sources.get(path) ?? null;
  const lua = new ArtemisLua({
    readFile,
    fileExists: (path) => sources.has(path),
    now: () => 0,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: (tag) => script.enqueue(tag),
    variable: () => '',
  });
  try {
    script = new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) => {
        events.push(tag.name);
      },
      pushLocal: () => events.push('push'),
      popLocal: () => events.push('pop'),
    });
    script.load('root');
    assert.throws(() => script.run(), /exit\/save/);
    assert.deepEqual(events, ['push', 'inside', 'pop', 'done']);
    assert.equal(script.callDepth, 0);
    assert.equal(script.state, 'faulted');
  } finally {
    lua.close();
  }
});

test('Native boot constants require an exact executable hash and reject other revisions', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {initializeArtemisVariables, ARTEMIS_3179_EXECUTABLE_SHA256} =
    await import('../dist/engines/artemis/revision.js');
  const variables = new ArtemisVariables();
  assert.throws(
    () => initializeArtemisVariables(variables, '0'.repeat(64)),
    /Unsupported Artemis executable/,
  );
  assert.throws(() => variables.read('s.engineversion'), /Unsupported/);
  initializeArtemisVariables(variables, ARTEMIS_3179_EXECUTABLE_SHA256);
  assert.equal(luaText(variables.read('s.engineversion')), '3179');
  assert.equal(luaText(variables.read('s.savedataversion')), '1003');
  assert.equal(luaText(variables.read('s.status.automode')), '0');
  assert.throws(() => variables.read('s.windowsfeaturelevel'), /Unsupported/);
});

test('Windows version initialization preserves failed platform queries as native zero values', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {initializeArtemisWindowsVersion} = await import('../dist/engines/artemis/revision.js');
  const {BrowserWindowsSystemProfileHost} =
    await import('../dist/platform/browser-windows-system-profile.js');
  const variables = new ArtemisVariables(),
    host = new BrowserWindowsSystemProfileHost();
  initializeArtemisWindowsVersion(variables, () => host.readVersion());
  assert.equal(luaText(variables.read('s.windowsversion')), '0.0');
  initializeArtemisWindowsVersion(variables, () => ({major: 6, minor: 1}));
  assert.equal(luaText(variables.read('s.windowsversion')), '6.1');
  assert.throws(
    () => initializeArtemisWindowsVersion(variables, () => ({major: NaN, minor: 1})),
    /Invalid/,
  );
});

test('Mouse commands preserve visibility order, paired positions and unsigned auto-hide deadlines', async () => {
  const {ArtemisMouse} = await import('../dist/engines/artemis/mouse.js');
  const effects = [];
  let now = 0xfffffff0;
  const mouse = new ArtemisMouse(
    {setVisible: (v) => effects.push(v), setPosition: (x, y) => effects.push([x, y])},
    () => now,
  );
  const tag = (args) => ({
    kind: 'tag',
    name: 'mouse',
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  mouse.dispatch(tag({left: '12px'}));
  assert.deepEqual(effects, []);
  mouse.dispatch(tag({left: '12px', top: '-3', hide: '1', autohide: '0'}));
  assert.deepEqual(effects, [[12, -3], false, true]);
  assert.equal(mouse.explicitHidden, true);
  mouse.dispatch(tag({hide: '0', autohide: '32'}));
  effects.length = 0;
  mouse.tick(15);
  assert.deepEqual(effects, []);
  mouse.tick(16);
  assert.deepEqual(effects, [false]);
  mouse.tick(17);
  assert.deepEqual(effects, [false]);
  now = 0;
  mouse.dispatch(tag({autohide: '1'}));
  effects.length = 0;
  mouse.tick(2);
  assert.deepEqual(effects, []);
  assert.throws(() => mouse.dispatch(tag({autohide: '2147483648'})), /Unsupported/);
});

test('Named event registrations patch copied names, resolve dotted callbacks and disable failed frames', () => {
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
  });
  try {
    lua.vm.execute(
      bytes(`handlers={onEnterFrame='callbacks.frame',onSave='saved',onClickWait='clicked',unknown='ignored'}
      engine:setEventHandler(handlers); handlers.onSave='wrong'
      callbacks={frame=function(e,p) frameData=p and p.data; error('frame failed') end}
      function saved(e,p) savedData=p.data end
      function clicked(e) clicks=(clicks or 0)+1; return function() end end
      engine:setEventHandler{onLoad='saved',onSave=false}`),
    );
    assert.equal(lua.events.handler('onSave'), 'saved');
    assert.equal(lua.events.emit('onSave', new Map([['data', '雪']])), true);
    assert.equal(luaText(lua.vm.getGlobal('savedData')), '雪');
    lua.events.emit('onClickWaitIn');
    assert.equal(lua.vm.getGlobal('clicks'), 1);
    assert.throws(
      () => lua.events.emit('onEnterFrame', new Map([['data', 'frame']])),
      /frame failed/,
    );
    assert.equal(lua.events.emit('onEnterFrame'), false);
    lua.vm.execute(bytes(`engine:setEventHandler{onSave=''}`));
    assert.equal(lua.events.emit('onSave'), false);
    lua.vm.execute(bytes(`function clicked(e) error('click failed') end`));
    assert.throws(() => lua.events.emit('onClickWaitIn'), /click failed/);
    assert.equal(lua.events.emit('onClickWaitIn'), false);
  } finally {
    lua.close();
  }
});

test('Dialog suspends script/ASB progress until completion and writes its native result before resuming', async () => {
  const {ArtemisDialog} = await import('../dist/engines/artemis/dialog.js');
  let script, complete;
  const order = [],
    requests = [];
  const readFile = () => bytes('[calllua function="begin"][after][stop]');
  const lua = new ArtemisLua({
    readFile,
    fileExists: () => true,
    now: () => 0,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: (tag) => script.enqueue(tag),
    variable: () => '',
  });
  const dialog = new ArtemisDialog(
    {
      present: (request, done) => {
        requests.push(request);
        complete = done;
      },
    },
    {
      blocked: () => false,
      beginWait: () => script.pause(),
      endWait: () => {
        order.push('resume');
        script.resume();
      },
      writeVariable: (key, value) => order.push([key, value]),
    },
  );
  try {
    lua.vm.execute(
      bytes(
        `function begin(e,p) assert(p['function']=='begin'); e:tag{'dialog',message='雪',varname='answer'} end`,
      ),
    );
    script = new ArtemisScript(lua, {
      readFile,
      dispatch: (tag) => {
        if (dialog.dispatch(tag)) return;
        order.push(tag.name);
        if (tag.name === 'stop') return 'stopped';
      },
    });
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(dialog.pending, true);
    assert.deepEqual(order, []);
    assert.equal(requests[0].message, '雪');
    assert.equal(requests[0].canCancel, true);
    complete({result: 1});
    assert.deepEqual(order, [['answer', '1'], 'resume']);
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(order, [['answer', '1'], 'resume', 'after', 'stop']);
    assert.throws(() => complete({result: 1}), /Stale or repeated/);
    assert.throws(
      () =>
        dialog.dispatch({
          kind: 'tag',
          name: 'dialog',
          sourceLine: -1,
          args: new Map([['textfield', 'x']]),
        }),
      /text entry/,
    );
  } finally {
    lua.close();
  }
});

test('Synchronous dialog completion leaves no pending wait and preserves native defaults', async () => {
  const {ArtemisDialog} = await import('../dist/engines/artemis/dialog.js');
  const order = [];
  const dialog = new ArtemisDialog(
    {
      present: (request, done) => {
        assert.deepEqual(request, {
          title: '',
          message: '',
          canCancel: false,
          fontSize: 20,
          minimumWidth: 240,
          applyDesktopScale: false,
        });
        done({result: 0});
      },
    },
    {
      blocked: () => false,
      beginWait: () => order.push('begin'),
      endWait: () => order.push('end'),
      writeVariable: () => assert.fail(),
    },
  );
  dialog.dispatch({kind: 'tag', name: 'dialog', sourceLine: -1, args: new Map()});
  assert.equal(dialog.pending, false);
  assert.deepEqual(order, ['begin', 'end']);
});

test('Stale dialog callbacks cannot complete a subsequent dialog', async () => {
  const {ArtemisDialog} = await import('../dist/engines/artemis/dialog.js');
  const callbacks = [],
    writes = [];
  const dialog = new ArtemisDialog(
    {present: (_, done) => callbacks.push(done)},
    {
      blocked: () => false,
      beginWait: () => {},
      endWait: () => {},
      writeVariable: (k, v) => writes.push([k, v]),
    },
  );
  const tag = {kind: 'tag', name: 'dialog', sourceLine: -1, args: new Map([['varname', 'answer']])};
  dialog.dispatch(tag);
  callbacks[0]({result: 1});
  dialog.dispatch(tag);
  assert.throws(() => callbacks[0]({result: 0}), /Stale or repeated/);
  assert.equal(dialog.pending, true);
  callbacks[1]({result: 0});
  assert.equal(dialog.pending, false);
  assert.deepEqual(writes, [
    ['answer', '1'],
    ['answer', '0'],
  ]);
});

test('Native save-gate tracks changed global sf bytes and orders scenario/global/system effects', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const variables = new ArtemisVariables(),
    calls = [];
  const save = new ArtemisSave(variables, {
    beforeScenario: (file) => calls.push(['before', file]),
    reportEventError: (error) => calls.push(['error', String(error)]),
    writeScenario: (file, transient) => calls.push(['scenario', file, transient]),
    writeGlobal: () => calls.push('global'),
    writeSystem: () => calls.push('system'),
  });
  assert.equal(save.request(''), false);
  assert.deepEqual(calls, []);
  variables.write('sf.flag', Uint8Array.of(0, 255));
  assert.equal(variables.globalDirty, true);
  save.request('slot.dat', true);
  assert.deepEqual(calls, [
    ['before', 'slot.dat'],
    ['scenario', 'slot.dat', true],
    'global',
    'system',
  ]);
  assert.equal(variables.globalDirty, false);
  calls.length = 0;
  variables.write('sf.flag', Uint8Array.of(0, 255));
  assert.equal(variables.globalDirty, false);
  variables.pushLocal();
  variables.write('sf.flag', 'local', true);
  assert.equal(variables.globalDirty, false);
  variables.popLocal();
  variables.delete('sf.flag');
  assert.equal(variables.globalDirty, false);
  variables.write('sf', '');
  assert.equal(variables.globalDirty, true);
  save.request('');
  assert.deepEqual(calls, ['global', 'system']);
});

test('Timed wait preserves strict deadline, event/save/message ordering and zero sentinel', async () => {
  const {ArtemisTimedWait} = await import('../dist/engines/artemis/wait.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const calls = [];
  let clock = 100;
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
  });
  modes.autosave = 2;
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: (error) => calls.push(String(error)),
    beforeScenario: (file) => calls.push(['saveEvent', file]),
    writeScenario: (file) => calls.push(['save', file]),
    writeGlobal: () => calls.push('global'),
    writeSystem: () => calls.push('system'),
  });
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => clock,
    debugSkipActive: () => false,
    hasActiveMessage: () => false,
    beginWait: (input, skip) => calls.push(['begin', input, skip]),
    endWait: () => calls.push('end'),
    clickWaitEvent: (kind) => calls.push(kind),
    resumeMessageState: () => calls.push('message'),
  });
  const tag = (args) => ({
    kind: 'tag',
    name: 'wait',
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  wait.dispatch(tag({time: '10', input: '1'}));
  assert.deepEqual(calls, [
    ['begin', true, false],
    'in',
    ['saveEvent', 'autosave.dat'],
    ['save', 'autosave.dat'],
  ]);
  assert.equal(wait.tick(110), false);
  assert.equal(wait.tick(111), true);
  assert.deepEqual(calls.slice(-3), ['end', 'out', 'message']);
  assert.equal(wait.tick(112), false);
  clock = 0;
  calls.length = 0;
  modes.autosave = 0;
  wait.dispatch(tag({time: '0'}));
  assert.equal(wait.tick(1), false);
  assert.equal(wait.pending, true);
});

test('Input=2 skip bypasses setup; message/media wait paths fail before effects', async () => {
  const {ArtemisTimedWait} = await import('../dist/engines/artemis/wait.js');
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
  });
  const unexpected = () => assert.fail('unexpected effect');
  const save = new ArtemisSave(new ArtemisVariables(), {
    reportEventError: unexpected,
    beforeScenario: unexpected,
    writeScenario: unexpected,
    writeGlobal: unexpected,
    writeSystem: unexpected,
  });
  let message = false;
  const wait = new ArtemisTimedWait(modes, save, {
    now: () => 1,
    debugSkipActive: () => false,
    hasActiveMessage: () => message,
    beginWait: unexpected,
    endWait: unexpected,
    clickWaitEvent: unexpected,
    resumeMessageState: unexpected,
  });
  const tag = (args) => ({
    kind: 'tag',
    name: 'wait',
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  modes.setCommandSkip(true);
  assert.equal(wait.dispatch(tag({input: '2', video: 'x'})), true);
  assert.equal(wait.pending, false);
  modes.setCommandSkip(false);
  assert.throws(() => wait.dispatch(tag({video: 'x'})), /media\/scenario/);
  message = true;
  assert.throws(() => wait.dispatch(tag({time: '1'})), /message\/automode/);
  assert.equal(wait.pending, false);
});

test('Save callback errors are reported before native save continues, and dirty clears before system failure', async () => {
  const {ArtemisSave} = await import('../dist/engines/artemis/save.js');
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  variables.write('sf.dirty', '1');
  const calls = [];
  const save = new ArtemisSave(variables, {
    beforeScenario: () => {
      throw Error('callback');
    },
    reportEventError: (error) => calls.push(error.message),
    writeScenario: () => calls.push('scenario'),
    writeGlobal: () => calls.push('global'),
    writeSystem: () => {
      assert.equal(variables.globalDirty, false);
      throw Error('system failure');
    },
  });
  assert.throws(() => save.request('slot'), /system failure/);
  assert.deepEqual(calls, ['callback', 'scenario', 'global']);
});

test('Lua literal expression lookup creates absent zero variables and participates in sf dirty tracking', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  const variables = new ArtemisVariables();
  assert.equal(variables.read('g.config').length, 0);
  assert.equal(luaText(variables.queryLiteral('g.config')), '0');
  assert.equal(luaText(variables.read('g.config')), '0');
  assert.equal(variables.globalDirty, false);
  variables.pushLocal();
  variables.write('g.config', 'local', true);
  assert.equal(luaText(variables.queryLiteral('g.config')), 'local');
  variables.popLocal();
  assert.equal(luaText(variables.queryLiteral('sf.new')), '0');
  assert.equal(variables.globalDirty, true);
  assert.throws(() => variables.queryLiteral('s.unsupported'), /Unsupported/);
});

test('Fullscreen variable queries read the shared window geometry owner on every query', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  let fullscreen = false;
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 800, height: 600}),
    windowDisplay: () => ({width: 800, height: 600, fullscreen}),
  });
  const tag = {
    kind: 'tag',
    name: 'var',
    sourceLine: -1,
    args: new Map([
      ['name', 'mode'],
      ['system', 'fullscreen'],
    ]),
  };
  variables.dispatch(tag);
  assert.equal(luaText(variables.read('mode')), '0');
  fullscreen = true;
  variables.dispatch(tag);
  assert.equal(luaText(variables.read('mode')), '1');
  assert.throws(() => new ArtemisVariables().dispatch(tag), /display provider/);
});

test('Lua magic-path tuples update the host in native numeric-key iteration order', () => {
  const calls = [];
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
    setMagicPath: (name, root) => calls.push([name, root]),
  });
  try {
    lua.vm.execute(
      bytes(
        `engine:setMagicPath{'ui','system/雪'}; engine:setMagicPath{'ui',''}; engine:setMagicPath{ignored='value'}`,
      ),
    );
    assert.deepEqual(calls, [
      ['ui', 'system/雪'],
      ['ui', ''],
      ['', ''],
    ]);
    assert.throws(() => lua.vm.execute(bytes(`engine:setMagicPath('bad')`)), /tuple/);
  } finally {
    lua.close();
  }
});

test('Application argument query copies native dotted keys into the selected scope without clearing old entries', async () => {
  const {ArtemisVariables} = await import('../dist/engines/artemis/variables.js');
  let argumentsMap = new Map([
    ['recovery', 'save'],
    ['日本語', '雪'],
  ]);
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 800, height: 600}),
    applicationArguments: {readApplicationArguments: () => argumentsMap},
  });
  const tag = {
    kind: 'tag',
    name: 'var',
    sourceLine: -1,
    args: new Map([
      ['name', 'params'],
      ['system', 'get_exe_parameter'],
      ['writelocal', '1'],
    ]),
  };
  variables.write('params.recovery', 'global');
  variables.pushLocal();
  variables.dispatch(tag);
  assert.equal(luaText(variables.read('params.recovery')), 'save');
  assert.equal(luaText(variables.read('params.日本語')), '雪');
  argumentsMap = new Map();
  variables.dispatch(tag);
  assert.equal(luaText(variables.read('params.recovery')), 'save');
  variables.popLocal();
  assert.equal(luaText(variables.read('params.recovery')), 'global');
  assert.throws(() => new ArtemisVariables().dispatch(tag), /argument provider/);
});

test('Recording/right-click controls preserve native missing-option and retained-script rules', async () => {
  const {ArtemisModes} = await import('../dist/engines/artemis/modes.js');
  const modes = new ArtemisModes({
    writeStatus: () => {},
    commandSkipChanged: () => {},
    controlSkipChanged: () => {},
    automodeChanged: () => {},
    releaseScheduler: () => {},
  });
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  modes.dispatch(tag('alreadyread'));
  assert.equal(modes.alreadyReadEnabled, true);
  modes.dispatch(tag('writebacklog'));
  assert.equal(modes.writeBacklog, false);
  modes.dispatch(tag('alreadyread', {mode: '0'}));
  assert.equal(modes.alreadyReadEnabled, false);
  modes.dispatch(tag('writebacklog', {mode: '00'}));
  assert.equal(modes.writeBacklog, true);
  modes.dispatch(tag('rclick', {file: 'menu.iet', allow: '0'}));
  assert.equal(modes.rightClickAllowed, false);
  modes.dispatch(tag('rclick'));
  assert.equal(modes.rightClickAllowed, true);
  assert.equal(modes.rightClickScript, 'menu.iet');
  modes.dispatch(tag('rclick', {file: ''}));
  assert.equal(modes.rightClickScript, '');
});

test('Backlog configuration selects missing message layers, resets override use and preserves native lists', async () => {
  const {ArtemisTextControls} = await import('../dist/engines/artemis/text-controls.js');
  let current = 'message';
  const layers = new Set(['message']),
    calls = [];
  const controls = new ArtemisTextControls({
    currentMessageLayer: () => current,
    messageLayerExists: (id) => layers.has(id),
    selectMessageLayer: (id) => {
      layers.add(id);
      calls.push(id);
    },
    clearBacklog: () => calls.push('clear'),
  });
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  controls.dispatch(
    tag('backlog', {
      allow: '0',
      messagelayer: 'log',
      layer: 'override',
      hide: 'a,, a,a',
      includefont: '0',
    }),
  );
  assert.deepEqual(calls, ['log', 'message']);
  assert.equal(controls.backlogAllowed, false);
  assert.equal(controls.backlogIncludeFont, false);
  assert.deepEqual(controls.backlogLayer('message'), {useOverride: true, layer: 'override'});
  assert.deepEqual([...controls.hiddenBacklogLayers], ['a', '', ' a']);
  controls.dispatch(tag('backlog', {messagelayer: 'log'}));
  assert.equal(controls.backlogAllowed, true);
  assert.deepEqual(controls.backlogLayer('message'), {useOverride: false, layer: 'override'});
  assert.deepEqual(calls, ['log', 'message']);
  current = 'second';
  controls.dispatch(tag('backlog', {clear: '00'}));
  assert.deepEqual(controls.backlogLayer('second'), {useOverride: false, layer: ''});
  assert.equal(calls.at(-1), 'clear');
  controls.dispatch(tag('hide', {allow: '0', window: ''}));
  assert.equal(controls.hideAllowed, false);
  assert.deepEqual([...controls.hiddenWindows], ['']);
  controls.dispatch(tag('hide'));
  assert.equal(controls.hideAllowed, true);
  assert.deepEqual([...controls.hiddenWindows], ['']);
});

test('Key configuration replaces ordinary keys and special flags; delonpush removes both copied handlers', async () => {
  const {ArtemisKeyBindings} = await import('../dist/engines/artemis/key-bindings.js');
  const bindings = new ArtemisKeyBindings();
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    sourceLine: -1,
    args: new Map(Object.entries(args)),
  });
  bindings.dispatch(tag('keyconfig', {role: '0', keys: '1,13,136,137,13,, -2'}));
  assert.deepEqual([...bindings.role(0).keys], [-2, 0, 1, 13]);
  assert.equal(bindings.role(0).special136, true);
  assert.equal(bindings.role(0).special137, true);
  const copy = bindings.role(0);
  copy.keys.clear();
  assert.equal(bindings.role(0).keys.size, 4);
  bindings.dispatch(tag('keyconfig', {role: '0'}));
  assert.equal(bindings.role(0).keys.size, 0);
  assert.equal(bindings.role(0).special136, false);
  bindings.dispatch(tag('keyconfig', {role: '0', keys: ''}));
  assert.deepEqual([...bindings.role(0).keys], [0]);
  const command = tag('call', {file: 'sub'});
  bindings.storePushHandler(3, 0, command);
  bindings.storePushHandler(3, 1, command);
  command.args.set('file', 'changed');
  assert.equal(bindings.pushHandler(3, 0).args.get('file'), 'sub');
  bindings.dispatch(tag('delonpush', {key: '3'}));
  assert.equal(bindings.pushHandler(3, 0), undefined);
  assert.equal(bindings.pushHandler(3, 1), undefined);
  bindings.storePushHandler(0, 0, command);
  bindings.dispatch(tag('delonpush'));
  assert.equal(bindings.pushHandler(0, 0), undefined);
  assert.throws(() => bindings.dispatch(tag('keyconfig')), /Missing/);
});

test('Native multi-touch configuration accepts numeric limits and truncates toward zero', () => {
  const limits = [];
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
    setTouchLimit: (limit) => limits.push(limit),
  });
  try {
    lua.vm.execute(bytes(`engine:setUseMultiTouch(3); engine:setUseMultiTouch(-2.9)`));
    assert.deepEqual(limits, [3, -2]);
    assert.throws(() => lua.vm.execute(bytes(`engine:setUseMultiTouch(true)`)), /touch limit/);
    assert.throws(() => lua.vm.execute(bytes(`engine:setUseMultiTouch('3')`)), /touch limit/);
  } finally {
    lua.close();
  }
});

test('Event filters retain the function and preserve native numeric outcomes separately from tags', () => {
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    tag: () => {},
    enqueueTag: () => {},
    variable: () => '',
  });
  const event = {kind: 'tag', name: 'click', args: new Map([['code', '2']]), sourceLine: -1};
  try {
    assert.equal(lua.filterEvent(event), 0);
    lua.vm.execute(
      bytes(`
      local offset = 0
      function selected(e,n,p)
        assert(e == engine and n == 'click')
        return tonumber(p.code) + offset
      end
      engine:setEventFilter(selected)
      selected = function() return 99 end
      function change() offset = -1 end
    `),
    );
    assert.equal(lua.filterEvent(event), 2);
    lua.call('change');
    assert.equal(lua.filterEvent(event), 1);
    assert.equal(lua.filterTag(event), false);
    assert.equal(lua.filterEvent({...event, name: ''}), 0);
    lua.vm.execute(bytes(`engine:setEventFilter(function() return -2.9 end)`));
    assert.equal(lua.filterEvent(event), -2);
    lua.vm.execute(bytes(`engine:setEventFilter(function() return 4294967298 end)`));
    assert.equal(lua.filterEvent(event), 2);
    lua.vm.execute(bytes(`engine:setEventFilter(function() return '2' end)`));
    assert.throws(() => lua.filterEvent(event), /event filter result/);
    lua.vm.execute(bytes(`engine:setEventFilter(function() error('filter failed') end)`));
    assert.throws(() => lua.filterEvent(event), /filter failed/);
    assert.throws(() => lua.vm.execute(bytes(`engine:setEventFilter({})`)), /filter function/);
  } finally {
    lua.close();
  }
});

test('Command event registrations capture label-only filenames and keep both push slots', async () => {
  const {ArtemisEventCommands} = await import('../dist/engines/artemis/event-commands.js');
  const {ArtemisKeyBindings} = await import('../dist/engines/artemis/key-bindings.js');
  let current = 'system/first.iet';
  const events = new ArtemisEventCommands(() => current);
  const keys = new ArtemisKeyBindings(() => current);
  const tag = (name, args = {}) => ({
    kind: 'tag',
    name,
    args: new Map(Object.entries(args)),
    sourceLine: -1,
  });
  const original = tag('setoncontrolskipin', {label: 'last'});
  events.dispatch(original);
  current = 'other.asb';
  original.args.set('label', 'changed');
  assert.equal(events.command('setoncontrolskipin').args.get('label'), 'last');
  assert.equal(events.command('setoncontrolskipin').args.get('file'), 'system/first.iet');
  events.dispatch(tag('setoncontrolskipout', {file: '', label: 'last'}));
  assert.equal(events.command('setoncontrolskipout').args.get('file'), '');
  events.dispatch(tag('setoncontrolskipin', {handler: 'calllua', function: 'callback'}));
  assert.equal(events.command('setoncontrolskipin').args.has('file'), false);
  keys.dispatch(tag('setonpush', {key: '13', label: 'enter'}));
  keys.dispatch(tag('setonpush', {key: '13', keyrepeat: '00', label: 'repeat'}));
  assert.equal(keys.pushHandler(13, 0).args.get('label'), 'enter');
  assert.equal(keys.pushHandler(13, 1).args.get('label'), 'repeat');
  assert.equal(keys.pushHandler(13, 1).args.get('file'), 'other.asb');
  keys.dispatch(tag('setonpush', {key: '13', keyrepeat: '0', label: 'replace'}));
  assert.equal(keys.pushHandler(13, 0).args.get('label'), 'replace');
  assert.equal(keys.pushHandler(13, 1).args.get('label'), 'repeat');
  keys.dispatch(tag('delonpush', {key: '13'}));
  assert.equal(keys.pushHandler(13, 0), undefined);
  assert.equal(keys.pushHandler(13, 1), undefined);
});

test('Native DLL strings are copied before Delete; missing modules, methods and Delete return empty', async () => {
  const {ArtemisNativeLibrary} = await import('../dist/engines/artemis/native-library.js');
  const {BrowserWindowsDynamicLibraryHost} =
    await import('../dist/platform/windows-dynamic-library.js');
  const output = [];
  const browser = new ArtemisNativeLibrary(new BrowserWindowsDynamicLibraryHost(), (name, bytes) =>
    output.push([name, luaText(bytes)]),
  );
  browser.dispatch({
    kind: 'tag',
    name: 'callnative',
    sourceLine: -1,
    args: new Map([
      ['module', 'example.dll'],
      ['method', 'Version'],
      ['result', 't.result'],
    ]),
  });
  assert.deepEqual(output, [['t.result', '']]);
  const library = {},
    procedure = {},
    release = {},
    calls = [],
    returned = bytes('version');
  let hasDelete = true;
  const native = new ArtemisNativeLibrary(
    {
      loadLibraryA: (path) => {
        calls.push(['load', luaText(path)]);
        return library;
      },
      getProcAddress: (owner, name) => {
        assert.equal(owner, library);
        calls.push(['lookup', name]);
        return name === 'Version' ? procedure : name === 'Delete' && hasDelete ? release : null;
      },
      invoke: (fn, args) => {
        if (fn === procedure) {
          assert.equal(args[0].kind, 'memory');
          assert.deepEqual([...args[0].pointer.bytes], [...bytes('parameter'), 0]);
          calls.push(['call']);
          return 123n;
        }
        assert.equal(fn, release);
        assert.equal(args[0].value, 123n);
        calls.push(['delete']);
        returned.fill(0);
        return undefined;
      },
      readCString: (pointer) => {
        assert.equal(pointer, 123n);
        calls.push(['read']);
        return returned;
      },
      freeLibrary: () => {
        throw new Error('unexpected release');
      },
      mainWindowHandle: () => null,
    },
    () => {},
  );
  assert.equal(luaText(native.call('example.dll', 'Version', 'parameter')), 'version');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['load', 'lookup', 'call', 'read', 'lookup', 'delete'],
  );
  assert.equal(native.call('example.dll', 'Absent', '').length, 0);
  assert.equal(calls.filter((c) => c[0] === 'load').length, 1);
  hasDelete = false;
  assert.equal(native.call('example.dll', 'Version', 'parameter').length, 0);
  assert.equal(calls.filter((c) => c[0] === 'delete').length, 1);
  assert.throws(() => native.call('日本語.dll', 'Version', ''), /ANSI/);
});

test('Native module teardown releases the sorted registry once and permits later loading', async () => {
  const {ArtemisNativeLibrary} = await import('../dist/engines/artemis/native-library.js');
  const released = [],
    loaded = [];
  const owner = new ArtemisNativeLibrary(
    {
      loadLibraryA: (path) => {
        const library = {path: luaText(path)};
        loaded.push(library);
        return library;
      },
      getProcAddress: () => null,
      invoke: () => 0n,
      freeLibrary: (library) => released.push(library.path),
      mainWindowHandle: () => null,
    },
    () => {},
  );
  owner.call('z.dll', 'none', '');
  owner.call('a.dll', 'none', '');
  owner.reset();
  owner.reset();
  assert.deepEqual(released, ['a.dll', 'z.dll']);
  owner.call('a.dll', 'none', '');
  assert.equal(loaded.length, 3);
  owner.reset();
  assert.deepEqual(released, ['a.dll', 'z.dll', 'a.dll']);
});

test('Script callbacks await resource work, resume nested calls, then consume queued tags', async () => {
  const source = bytes(`[lua]
    function child(e,p)
      local path=p.file
      e:tag{'asset',file=path}
      assert(e:var('asset.ready')=='yes')
      e:enqueueTag{'record',data=path}
      return function() end
    end
    function parent(e)
      e:tag{'calllua',['function']='child',file='synthetic.png'}
      e:enqueueTag{'record',data='parent'}
      return function() end
    end
  [/lua][calllua function="parent"][stop]`);
  let script;
  let ready = '';
  const records = [],
    requests = [];
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => ready,
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: (tag) => script.enqueue(tag),
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) => {
      if (tag.name === 'asset') {
        requests.push(tag.args.get('file'));
        return 'suspended';
      }
      if (tag.name === 'record') records.push(tag.args.get('data'));
      if (tag.name === 'stop') return 'stopped';
    },
  });
  try {
    script.load('boot');
    assert.equal(script.run(), 'waiting');
    assert.equal(script.pendingLuaCalls, 2);
    assert.equal(script.queuedTags, 0);
    assert.deepEqual(requests, ['synthetic.png']);
    assert.throws(() => script.resume(), /resumeLua/);
    ready = await Promise.resolve('yes');
    assert.equal(script.resumeLua(), 'ready');
    assert.equal(script.pendingLuaCalls, 0);
    assert.equal(script.run(), 'stopped');
    assert.deepEqual(records, ['synthetic.png', 'parent']);
  } finally {
    script.cancelLuaCalls();
    lua.close();
  }
});

test('Resource failures propagate through suspended callbacks and a new script cancels old continuations', () => {
  const source = bytes(`[lua]
    function child(e) e:tag{'asset'} end
    function parent(e) e:tag{'calllua',['function']='child'}; should_not_run=true end
  [/lua][calllua function="parent"][stop]`);
  let script;
  const lua = new ArtemisLua({
    readFile: () => source,
    fileExists: () => true,
    now: () => 0,
    variable: () => '',
    suspendableTags: true,
    tag: (tag) => script.executeTag(tag),
    enqueueTag: () => {},
  });
  script = new ArtemisScript(lua, {
    readFile: () => source,
    dispatch: (tag) =>
      tag.name === 'asset' ? 'suspended' : tag.name === 'stop' ? 'stopped' : undefined,
  });
  try {
    script.load('boot');
    script.run();
    assert.throws(() => script.resumeLua([false, bytes('asset failed')]), /asset failed/);
    assert.equal(script.state, 'faulted');
    assert.equal(script.pendingLuaCalls, 0);
    assert.equal(lua.vm.getGlobal('should_not_run'), null);
    script.load('boot');
    script.run();
    assert.equal(script.pendingLuaCalls, 2);
    script.load('replacement');
    assert.equal(script.pendingLuaCalls, 0);
    assert.throws(() => script.resumeLua(), /No suspended/);
  } finally {
    script.cancelLuaCalls();
    lua.close();
  }
});
