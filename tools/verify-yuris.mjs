/**
 * Numerical verification of a local YU-RIS installation: every YPF archive in `pac/` and the
 * `updateN.ypf` archives beside the executable are opened, each entry's name hash and stored
 * data hash are compared with the archive index, compressed entries are inflated, and every
 * `ysbin/*.ybn` is parsed. Only counts and failures are printed; no asset is written or
 * rendered. Run after `npm run build:runtime`:
 *
 *   node tools/verify-yuris.mjs "/path/to/game" [--webp] [--ydg] [--opus]
 *
 * --webp also decodes every WebP with the native color conversion and hashes BGRA.
 * --ydg decodes every YDG image (version 500) and hashes its BGRA.
 * --opus reads every Ogg Opus file's head, link count and PCM length.
 */
import {readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {openSource} from './file-source.mjs';
import {decodeWebp} from '../dist/formats/webp/webp.js';
import {decodeYdg, ydgHeader, isYdg} from '../dist/formats/yuris/ydg.js';
import {readOggOpus} from '../dist/audio/opus-pcm16.js';
import {
  YpfArchive,
  YpfFileSystem,
  ypfDataMatches,
  YPF_DATA_XXHASH32,
  ypfNameMatches,
} from '../dist/formats/yuris/ypf.js';

const root = resolve(process.argv[2] ?? 'targetgame/yuris');
const failures = [];
const counts = {};
const checkWebp = process.argv.includes('--webp');
const webpHash = createHash('sha256');
const checkYdg = process.argv.includes('--ydg');
const ydgHash = createHash('sha256');
const checkOpus = process.argv.includes('--opus');
const count = (kind, n = 1) => (counts[kind] = (counts[kind] ?? 0) + n);

const archives = [];
for (const name of (await readdir(resolve(root, 'pac'))).filter((n) => /\.ypf$/i.test(n)).sort())
  archives.push({name, path: resolve(root, 'pac', name)});
for (const name of (await readdir(root)).filter((n) => /^update[1-9]\.ypf$/i.test(n)).sort())
  archives.push({name, path: resolve(root, name)});

const opened = [];
for (const {name, path} of archives) {
  const source = await openSource(path);
  if (!(await YpfArchive.isArchive(source))) {
    console.log(`${name}: not a YPF archive, skipped as the native registration skips it`);
    count('non-archive .ypf');
    await source.close();
    continue;
  }
  opened.push({name, archive: await YpfArchive.open(source)});
}
const files = new YpfFileSystem(opened);
console.log(`file system: ${files.size} files`);

const ybn = await import('../dist/formats/yuris/ybn.js');
const read = (name) => files.read(name);
const project = await ybn.loadYurisProject(read);
// The data hash is the engine build's: MurmurHash2 before YBN version 500, xxHash32 from it.
const dataHash = project.config.version === ybn.YBN_VERSION_500 ? YPF_DATA_XXHASH32 : 'murmur2';
console.log(`project: YBN version ${project.config.version}, data hash ${dataHash}`);

for (const {name, archive} of opened) {
  let bytes = 0;
  for (const entry of archive.entries) {
    count('entries');
    if (!ypfNameMatches(entry)) failures.push(`${name}: name hash of entry ${entry.offset}`);
    const stored = await archive.readStored(entry);
    bytes += stored.length;
    if (!ypfDataMatches(entry, stored, dataHash))
      failures.push(`${name}: data hash at ${entry.offset}`);
    if (entry.compression) {
      try {
        await archive.read(entry);
        count('inflated');
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
    }
    count(`type ${entry.type}`);
    const lower = String(entry.name).toLowerCase();
    if (checkYdg && lower.endsWith('.ydg')) {
      try {
        const bytes = entry.compression ? await archive.read(entry) : stored;
        if (!isYdg(bytes)) throw new Error('bad signature');
        const header = ydgHeader(bytes);
        const rows = header.strips.reduce((sum, strip) => sum + strip.rows, 0);
        if (rows !== header.height)
          throw new Error(`strips cover ${rows} of ${header.height} rows`);
        for (const strip of header.strips) count(`YDG strip codec ${strip.codec}`);
        const image = decodeYdg(bytes);
        if (image.failedStrips) throw new Error(`${image.failedStrips} strips failed to decode`);
        count('decoded YDG');
        count('YDG pixels', image.width * image.height);
        ydgHash.update(image.pixels);
      } catch (error) {
        failures.push(`${name}: YDG at ${entry.offset}: ${error.message}`);
      }
    }
    if (checkOpus && lower.endsWith('.opus')) {
      const bytes = entry.compression ? await archive.read(entry) : stored;
      const info = readOggOpus(bytes);
      if (!info || info.links !== 1 || info.channels === 0 || info.frames < 0)
        failures.push(`${name}: Opus at ${entry.offset}: ${JSON.stringify(info)}`);
      else {
        count('Opus files');
        count(`Opus ${info.channels} channels`);
        count('Opus frames', info.frames);
      }
    }
    if (checkWebp && lower.endsWith('.webp')) {
      try {
        const bytes = entry.compression ? await archive.read(entry) : stored;
        const image = decodeWebp(bytes, true);
        count('decoded WebP');
        count('WebP pixels', image.width * image.height);
        webpHash.update(image.pixels);
      } catch (error) {
        failures.push(`${name}: WebP at ${entry.offset}: ${error.message}`);
      }
    }
  }
  console.log(
    `${name}: version ${archive.version}, ${archive.entries.length} entries, ${bytes} stored bytes`,
  );
}

count('commands', project.commands.commands.length);
count('labels', project.labels.labels.length);
count('variable declarations', project.variables.length);
count('error messages', project.errors.size);
count('listed scripts', project.files.length);
for (const ref of [...files.files()].filter((f) => /^ysbin\\.*\.ybn$/i.test(f.entry.name))) {
  try {
    const bytes = await ref.archive.read(ref.entry);
    const signature = ybn.ybnSignature(bytes);
    count(`ybn ${signature}`);
    switch (signature) {
      case 'YSCM':
        ybn.parseYscm(bytes);
        break;
      case 'YSLB':
        ybn.parseYslb(bytes);
        break;
      case 'YSTD':
        ybn.parseYstd(bytes);
        break;
      case 'YSTL':
        ybn.parseYstl(bytes);
        break;
      case 'YSVR':
        ybn.parseYsvr(bytes);
        break;
      case 'YSCF':
        ybn.parseYscf(bytes);
        break;
      case 'YSER':
        ybn.parseYser(bytes);
        break;
      case 'YSTB': {
        const script = ybn.parseYstb(bytes, project.key, project.commands);
        count('instructions', script.instructions.length);
        for (const instruction of script.instructions) {
          count('arguments', instruction.args.length);
          for (const arg of instruction.args) if (arg.tokens) count('tokens', arg.tokens.length);
        }
        break;
      }
    }
  } catch (error) {
    failures.push(`${ref.entry.name}: ${error.message}`);
  }
}
for (const [index, label] of project.labels.labels.entries())
  if (ybn.findYurisLabel(project.labels, label.name) !== index)
    failures.push(`label ${index} is not found by its own name`);

console.log(counts);
console.log(`${failures.length} failures`);
for (const failure of failures.slice(0, 40)) console.log(`  ${failure}`);
process.exitCode = failures.length ? 1 : 0;

for (const {archive} of opened) await archive.source.close();
if (checkWebp) console.log('WebP BGRA SHA-256', webpHash.digest('hex'));
if (checkYdg) console.log('YDG BGRA SHA-256', ydgHash.digest('hex'));
