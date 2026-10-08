import test from 'node:test';
import assert from 'node:assert/strict';
import {Lua51, luaText} from '../dist/core/lua51/runtime.js';
const bytes = (text) => new TextEncoder().encode(text);

test('Lua 5.1 executes closures, environments, byte strings and isolated states', () => {
  const a = new Lua51(),
    b = new Lua51();
  try {
    a.execute(
      bytes(`
      assert(_VERSION == 'Lua 5.1')
      function make(x) return function(y) return x+y end end
      f=make(12); result=f(8)
      local g=loadstring('return secret'); setfenv(g,{secret=42}); envresult=g()
      binary=string.char(0,255,128,65)
      unpackresult=unpack({3,4})
      tree={}; tree.self=tree
    `),
    );
    assert.equal(a.getGlobal('result'), 20);
    assert.equal(a.getGlobal('envresult'), 42);
    assert.equal(a.getGlobal('unpackresult'), 3);
    assert.deepEqual(a.getGlobal('binary'), Uint8Array.of(0, 255, 128, 65));
    const tree = a.getGlobal('tree');
    assert.equal(tree.get('self'), tree);
    assert.equal(b.getGlobal('result'), null);
    a.setGlobal(
      'incoming',
      new Map([
        ['name', bytes('雪')],
        [1, 7],
      ]),
    );
    a.execute(bytes('assert(incoming.name == "雪" and incoming[1] == 7)'));
  } finally {
    a.close();
    b.close();
  }
});

test('Host callbacks preserve reentrant include, colon receiver and coroutine state', () => {
  const vm = new Lua51();
  const events = [];
  try {
    vm.bind('include', (args) => {
      events.push(luaText(args[0]));
      vm.execute(bytes('included = (included or 0) + 1'));
      return [];
    });
    vm.bind('echo', (args) => args);
    vm.execute(
      bytes(`
      function boot(e)
        e:include('first')
        assert(e:echo(string.char(0,255)) == string.char(0,255))
        local c=coroutine.create(function() engine:include('coroutine') end)
        assert(coroutine.resume(c))
      end
    `),
    );
    vm.call('boot');
    assert.deepEqual(events, ['first', 'coroutine']);
    assert.equal(vm.getGlobal('included'), 2);
  } finally {
    vm.close();
  }
});

test('Lua and host errors are protected and restore the VM stack', () => {
  const vm = new Lua51();
  try {
    vm.bind('failure', () => {
      throw new Error('host failure');
    });
    assert.throws(() => vm.execute(bytes('engine:failure()')), /host failure/);
    assert.throws(() => vm.execute(bytes('engine:missing()')), /Unsupported engine method/);
    assert.throws(() => vm.execute(bytes('function broken(')), /expected/);
    assert.throws(() => vm.execute(Uint8Array.of(27, 76, 117, 97)), /bytecode/);
    vm.execute(bytes(`ok,reason=pcall(function() engine:failure() end); result=123`));
    assert.equal(vm.getGlobal('ok'), false);
    assert.match(luaText(vm.getGlobal('reason')), /host failure/);
    assert.equal(vm.getGlobal('result'), 123);
    assert.throws(() => vm.call('noFunction'), /Missing Lua function/);
  } finally {
    vm.close();
  }
});

test('Instruction limit aborts even when Lua tries to catch errors, and invalidates the interrupted VM', () => {
  const vm = new Lua51(5000);
  assert.throws(
    () => vm.execute(bytes('while true do pcall(function() local x=1 end) end')),
    /instruction budget/,
  );
  assert.throws(() => vm.execute(bytes('result=1')), /closed or interrupted/);
  vm.close();
});

test('Live references observe later table edits, invoke closures and reject foreign or released handles', () => {
  const vm = new Lua51(),
    other = new Lua51();
  let retained;
  try {
    vm.bindReferences('keep', (refs) => {
      retained?.release();
      retained = refs[0].retain();
      return [];
    });
    vm.execute(
      bytes(
        'callbacks={}; engine:keep(callbacks); callbacks.run=function(e,p) return p+2, "ok" end',
      ),
    );
    const fn = retained.get('run');
    try {
      const result = fn.invoke([40], true);
      assert.equal(result[0], 42);
      assert.equal(luaText(result[1]), 'ok');
      assert.throws(() => other.setGlobal('foreign', fn), /Foreign/);
    } finally {
      fn.release();
    }
    assert.throws(() => fn.invoke(), /released/);
    const absent = retained.get('absent');
    assert.equal(absent.type, 0);
    assert.equal(absent.read(), null);
    absent.release();
    vm.execute(bytes('callbacks.run=function() error("callback failed") end'));
    const error = retained.get('run');
    try {
      assert.throws(() => error.invoke(), /callback failed/);
    } finally {
      error.release();
    }
    retained.release();
  } finally {
    vm.close();
    other.close();
  }
});

test('Host conversion bounds large Lua tables and restores the stack after refusal', () => {
  const vm = new Lua51();
  try {
    vm.execute(bytes('large={}; for i=1,60000 do large[i]=i end; marker=7'));
    assert.throws(() => vm.getGlobal('large'), /host conversion limit/);
    assert.equal(vm.getGlobal('marker'), 7);
    vm.execute(bytes('large=nil; marker=8'));
    assert.equal(vm.getGlobal('marker'), 8);
  } finally {
    vm.close();
  }
});

test('Host-owned Lua threads retain locals, yield byte requests and resume with asynchronous results', () => {
  const vm = new Lua51(),
    requests = [];
  vm.bind('request', (args) => {
    requests.push(luaText(args[0]));
    return [];
  });
  vm.execute(
    bytes(`
    function load(e, initial)
      local total = initial
      e:request('first')
      local result = coroutine.yield('first', nil, {offset = total})
      total = total + result
      e:request('second')
      local next = coroutine.yield('second')
      return total + next, 'complete'
    end
  `),
  );
  const callback = vm.referenceGlobal('load'),
    thread = vm.createThread(callback, true);
  callback.release();
  try {
    const first = thread.resume([4]);
    assert.equal(first.status, 'yielded');
    assert.equal(luaText(first.values[0]), 'first');
    assert.equal(first.values[1], null);
    assert.equal(first.values[2].get('offset'), 4);
    // An independent chunk/coroutine may run while this thread is suspended.
    vm.execute(bytes(`other = 77`));
    const second = thread.resume([8]);
    assert.equal(second.status, 'yielded');
    assert.equal(luaText(second.values[0]), 'second');
    const final = thread.resume([16]);
    assert.equal(final.status, 'done');
    assert.equal(final.values[0], 28);
    assert.equal(luaText(final.values[1]), 'complete');
    assert.deepEqual(requests, ['first', 'second']);
    assert.equal(vm.getGlobal('other'), 77);
    assert.throws(() => thread.resume(), /finished/);
  } finally {
    thread.close();
    thread.close();
    vm.close();
  }
});

test('Thread errors preserve other VM work; budgets abort loops after a yield and close safely', () => {
  const vm = new Lua51(10000);
  vm.execute(
    bytes(`function broken() coroutine.yield(); error('failed after yield') end
    function spin() coroutine.yield('ready'); while true do pcall(function() while true do end end) end end`),
  );
  const broken = vm.referenceGlobal('broken'),
    task = vm.createThread(broken);
  broken.release();
  assert.equal(task.resume().status, 'yielded');
  assert.throws(() => task.resume(), /failed after yield/);
  assert.throws(() => task.resume(), /finished/);
  task.close();
  vm.execute(bytes(`valid = 1`));
  assert.equal(vm.getGlobal('valid'), 1);
  const spin = vm.referenceGlobal('spin'),
    loop = vm.createThread(spin);
  spin.release();
  assert.equal(loop.resume().status, 'yielded');
  assert.throws(() => loop.resume(), /instruction budget exceeded/);
  assert.throws(() => vm.getGlobal('valid'), /closed or interrupted/);
  loop.close();
  vm.close();
});

test('Prepared loadfile preserves header line numbers, text translation and binary reopen refusal', async () => {
  const {windowsTextFileBytes} = await import('../dist/platform/windows-text-file.js');
  const vm = new Lua51();
  try {
    const source = bytes('#!/lua\r\nresult=[[A\r\nB\rC]]\x1a invalid tail'),
      original = source.slice();
    vm.executeFile(source, 'module.lua', windowsTextFileBytes(source));
    assert.equal(luaText(vm.getGlobal('result')), 'A\nB\nC');
    assert.deepEqual(source, original);
    vm.executeFile(bytes('# header without newline'), 'empty.lua');
    const broken = bytes('# header\r\nfunction broken(');
    assert.throws(
      () => vm.compileFile(broken, 'broken.lua', windowsTextFileBytes(broken)),
      /broken.lua:2/,
    );
    assert.throws(
      () => vm.executeFile(Uint8Array.of(35, 10, 27, 76, 117, 97), 'binary.lua'),
      /bytecode/,
    );
    assert.throws(() => vm.execute(bytes('#!/lua\nresult=1')), /unexpected symbol/);
    assert.deepEqual(
      windowsTextFileBytes(Uint8Array.of(65, 13, 10, 66, 13, 67, 26, 68)),
      Uint8Array.of(65, 10, 66, 13, 67),
    );
  } finally {
    vm.close();
  }
});
