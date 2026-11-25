import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openAsBlob, readFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Decode identical frames on both builds. Disk I/O and RGBA hashing are outside
// the timed decode. No frame data is displayed or written.
const [baseline, candidate, ...files] = process.argv.slice(2);
if (!baseline || !candidate || !files.length)
  throw new Error(
    'Usage: node tools/benchmark-siglus-omv.mjs BASELINE_DIST CANDIDATE_DIST FILE.omv [...]',
  );
const frames = Number(process.env.SIGLUS_BENCH_FRAMES ?? 45);
if (!Number.isSafeInteger(frames) || frames < 1) throw new Error('Invalid frame limit');
const builds = await Promise.all(
  [baseline, candidate].map(
    (dir) => import(pathToFileURL(join(resolve(dir), 'formats/siglus/omv.js'))),
  ),
);
const startup = process.env.SIGLUS_BENCH_STARTUP === '1';

function decode(SiglusOmv, bytes) {
  const openedAt = performance.now();
  const movie = new SiglusOmv(bytes);
  const openMs = performance.now() - openedAt;
  const count = Math.min(movie.frames, frames);
  const hash = createHash('sha256');
  let decodeMs = 0;
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    const pixels = movie.frame(index);
    decodeMs += performance.now() - start;
    hash.update(pixels);
  }
  return {
    openMs,
    decodeMs,
    count,
    hash: hash.digest('hex'),
    width: movie.width,
    height: movie.height,
  };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function firstFrame(SiglusOmv, file) {
  const blob = await openAsBlob(file);
  let bytesRead = 0;
  const source = {
    size: blob.size,
    async read(offset, length) {
      bytesRead += length;
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
  const start = performance.now();
  const movie = SiglusOmv.open
    ? await SiglusOmv.open(source)
    : new SiglusOmv(await source.read(0, source.size));
  const frame = movie.readFrame ? await movie.readFrame(0) : movie.frame(0);
  const elapsedMs = performance.now() - start;
  return {bytesRead, elapsedMs, hash: createHash('sha256').update(frame).digest('hex')};
}

for (const file of files) {
  if (startup) {
    const samples = [[], []];
    let hash;
    for (let round = 0; round < 4; round++) {
      for (const build of round % 2 ? [1, 0] : [0, 1]) {
        const {hash: result, ...sample} = await firstFrame(builds[build].SiglusOmv, file);
        hash ??= result;
        assert.equal(result, hash, `${file} first frame decoded differently`);
        if (round) samples[build].push(sample);
      }
    }
    const [before, after] = samples.map((runs) => ({
      bytesRead: median(runs.map(({bytesRead}) => bytesRead)),
      elapsedMs: median(runs.map(({elapsedMs}) => elapsedMs)),
    }));
    console.log(
      JSON.stringify({
        file: basename(file),
        hash,
        before,
        after,
        speedup: before.elapsedMs / after.elapsedMs,
      }),
    );
    continue;
  }
  const bytes = readFileSync(file);
  const samples = [[], []];
  let expected;
  for (let round = 0; round < 4; round++) {
    for (const build of round % 2 ? [1, 0] : [0, 1]) {
      const {openMs, decodeMs, ...result} = decode(builds[build].SiglusOmv, bytes);
      expected ??= result;
      assert.deepEqual(result, expected, `${file} decoded differently`);
      if (round) samples[build].push({openMs, decodeMs});
    }
  }
  const [before, after] = samples.map((runs) => ({
    openMs: median(runs.map(({openMs}) => openMs)),
    decodeMs: median(runs.map(({decodeMs}) => decodeMs)),
  }));
  console.log(
    JSON.stringify({
      file: basename(file),
      ...expected,
      before,
      after,
      speedup: before.decodeMs / after.decodeMs,
    }),
  );
}
