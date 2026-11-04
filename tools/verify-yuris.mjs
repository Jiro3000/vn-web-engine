/**
 * Numerical verification of a local YU-RIS installation: every YPF archive in `pac/` and the
 * `updateN.ypf` archives beside the executable are opened, each entry's name hash and stored
 * data hash are compared with the archive index, compressed entries are inflated, and every
 * `ysbin/*.ybn` is parsed. Only counts and failures are printed; no asset is written or
 * rendered. Run after `npm run build:runtime`:
 *
 *   node tools/verify-yuris.mjs "/path/to/game"
 */
import {readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openSource} from './file-source.mjs';
import {
  YpfArchive,
  YpfFileSystem,
  ypfDataMatches,
  ypfNameMatches,
} from '../dist/formats/yuris/ypf.js';

const root = resolve(process.argv[2] ?? 'targetgame/yuris');
const failures = [];
const counts = {};
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
  const archive = await YpfArchive.open(source);
  opened.push({name, archive});
  let bytes = 0;
  for (const entry of archive.entries) {
    count('entries');
    if (!ypfNameMatches(entry)) failures.push(`${name}: name hash of entry ${entry.offset}`);
    const stored = await archive.readStored(entry);
    bytes += stored.length;
    if (!ypfDataMatches(entry, stored)) failures.push(`${name}: data hash at ${entry.offset}`);
    if (entry.compression) {
      try {
        await archive.read(entry);
        count('inflated');
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
    }
    count(`type ${entry.type}`);
  }
  console.log(
    `${name}: version ${archive.version}, ${archive.entries.length} entries, ${bytes} stored bytes`,
  );
}
const files = new YpfFileSystem(opened);
console.log(`file system: ${files.size} files`);

const ybn = await import('../dist/formats/yuris/ybn.js');
const read = (name) => files.read(name);
const project = await ybn.loadYurisProject(read);
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
