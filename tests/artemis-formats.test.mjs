import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PfsArchive} from '../dist/formats/artemis/pfs.js';
import {parseAsb} from '../dist/formats/artemis/asb.js';
import {ArtemisFiles} from '../dist/engines/artemis/files.js';

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const str = (s) => {
  const b = Buffer.from(s);
  return Buffer.concat([u32(b.length), b, Buffer.alloc(1)]);
};
const memory = (bytes) => ({
  size: bytes.length,
  read: async (offset, size) => bytes.subarray(offset, offset + size),
});

function pfs(files, trailer = Buffer.from('offset-table')) {
  const indexSize =
    4 + files.reduce((n, [name]) => n + 16 + Buffer.byteLength(name), 0) + trailer.length;
  let offset = 7 + indexSize;
  const rows = files.map(([name, body]) => {
    const b = Buffer.from(name),
      row = Buffer.concat([u32(b.length), b, u32(0), u32(offset), u32(body.length)]);
    offset += body.length;
    return row;
  });
  const index = Buffer.concat([u32(files.length), ...rows, trailer]);
  const key = createHash('sha1').update(index).digest();
  const bodies = files.map(([, body]) => Buffer.from(body.map((b, i) => b ^ key[i % 20])));
  return new Uint8Array(Buffer.concat([Buffer.from('pf8'), u32(index.length), index, ...bodies]));
}

test('PF8 lazily decrypts Unicode entries and partial reads without mutating borrowed ciphertext', async () => {
  const body = Uint8Array.from({length: 70}, (_, i) => i * 3);
  const bytes = pfs([['script\\雪.ast', body]]),
    original = bytes.slice(),
    reads = [];
  const source = memory(bytes);
  const archive = await PfsArchive.open({
    size: source.size,
    read: async (o, n) => {
      reads.push([o, n]);
      return source.read(o, n);
    },
  });
  const entry = archive.find('script/雪.ast');
  assert.equal(reads.length, 2);
  assert.equal(archive.find('SCRIPT/雪.ast'), undefined);
  const slice = archive.entrySource(entry);
  assert.deepEqual(await slice.read(19, 31), body.slice(19, 50));
  assert.deepEqual(await archive.read(entry), body);
  assert.deepEqual(bytes, original);
  await assert.rejects(slice.read(70, 1), /Invalid range/);
  assert.throws(() => archive.entrySource({...entry}), /Foreign/);
});

test('PF8 refuses unsupported versions, impossible counts, short reads and out-of-bounds payloads', async () => {
  const bytes = pfs([['a', Buffer.from('123')]]);
  const version = bytes.slice();
  version[2] = 55;
  await assert.rejects(PfsArchive.open(memory(version)), /Unsupported PFS/);
  const count = bytes.slice();
  new DataView(count.buffer).setUint32(7, 0xffffffff, true);
  await assert.rejects(PfsArchive.open(memory(count)), /entry count/);
  await assert.rejects(PfsArchive.open(memory(bytes.slice(0, -1))), /Invalid range/);
  await assert.rejects(
    PfsArchive.open({size: bytes.length, read: async () => new Uint8Array()}),
    /Truncated/,
  );
});

test('Artemis overlays continue across numeric gaps, retain the winning key and prefer empty loose files', async () => {
  const base = pfs([
    ['system/auth.lua', Buffer.from('base')],
    ['script/雪.ast', Buffer.from('old')],
  ]);
  const early = pfs([['script/雪.ast', Buffer.from('early')]]);
  const late = pfs([['script/雪.ast', Buffer.from('late')]], Buffer.from('different index key'));
  const installed = new Map([
    ['game.pfs', memory(base)],
    ['game.pfs.000', memory(early)],
    ['game.pfs.012', memory(late)],
    ['system/auth.lua', memory(Buffer.alloc(0))],
  ]);
  const files = await ArtemisFiles.mount('game.pfs', (parts) => installed.get(parts.join('/')));
  assert.deepEqual(
    files.archives.map((a) => a.name),
    ['game.pfs', 'game.pfs.000', 'game.pfs.012'],
  );
  assert.equal(Buffer.from(await files.read('script\\雪.ast')).toString(), 'late');
  assert.equal((await files.read('system/auth.lua')).byteLength, 0);
  assert.equal(await files.read('absent'), null);
  await assert.rejects(files.open('../outside'), /Unsupported/);
  await assert.rejects(files.open(':bg/file'), /Unsupported/);
});

function asb(records) {
  return new Uint8Array(
    Buffer.concat([Buffer.from([65, 83, 66, 17, 0]), u32(records.length), ...records]),
  );
}
const label = (name) => Buffer.concat([u32(1), str(name)]);
const tag = (name, line, args = []) =>
  Buffer.concat([
    u32(0),
    str(name),
    u32(line),
    u32(args.length),
    ...args.flatMap(([k, v]) => [str(k), str(v)]),
  ]);

test('ASB preserves tag arguments/source lines and labels point into the tag sequence', () => {
  const bytes = asb([
    label('top'),
    tag('print', 42, [
      ['data', '雪'],
      ['__proto__', 'literal'],
      ['data', '花'],
    ]),
    label('last'),
    tag('return', 44),
  ]);
  const program = parseAsb(bytes);
  assert.equal(program.reservedByte, 17);
  assert.equal(program.records.length, 4);
  assert.deepEqual(
    [...program.labels],
    [
      ['top', 0],
      ['last', 1],
    ],
  );
  assert.deepEqual(
    program.tags.map((t) => [t.name, t.sourceLine]),
    [
      ['print', 42],
      ['return', 44],
    ],
  );
  assert.equal(program.tags[0].args.get('data'), '花');
  assert.equal(program.tags[0].args.get('__proto__'), 'literal');
});

test('ASB refuses malformed records/strings and trailing bytes instead of returning a partial program', () => {
  const bytes = asb([tag('return', 1)]);
  assert.throws(() => parseAsb(bytes.slice(0, -1)), /Invalid range/);
  assert.throws(() => parseAsb(Buffer.concat([bytes, Buffer.alloc(1)])), /Trailing/);
  const version = bytes.slice();
  version[4] = 1;
  assert.throws(() => parseAsb(version), /Unsupported ASB/);
  assert.throws(() => parseAsb(asb([Buffer.concat([u32(2), str('invalid')])])), /record kind/);
  const badString = asb([label('x')]);
  badString[badString.length - 1] = 1;
  assert.throws(() => parseAsb(badString), /terminator/);
});
