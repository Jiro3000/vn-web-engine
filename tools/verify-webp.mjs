// Differential check; synthetic pixels only, never displays an image.
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {decodeWebp} from '../dist/formats/webp/webp.js';
const dir = await mkdtemp(join(tmpdir(), 'yuris-webp-'));
let cases = 0,
  failures = 0;
try {
  for (const [w, h] of [
    [1, 1],
    [2, 3],
    [7, 9],
    [16, 16],
    [17, 33],
    [64, 47],
    [129, 127],
  ]) {
    for (const pattern of ['flat', 'gradient', 'noise', 'palette']) {
      const px = Buffer.alloc(w * h * 4);
      let seed = 12345;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < 4; c++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            px[(y * w + x) * 4 + c] =
              pattern === 'flat'
                ? [35, 140, 233, 123][c]
                : pattern === 'gradient'
                  ? (x * 7 + y * 11 + c * 61) & 255
                  : pattern === 'palette'
                    ? ((x + y) % 3) * 85
                    : seed >>> 24;
          }
      const input = join(dir, 'in.pam'),
        webp = join(dir, 'out.webp'),
        pam = join(dir, 'ref.pam');
      await writeFile(
        input,
        Buffer.concat([
          Buffer.from(
            `P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`,
          ),
          px,
        ]),
      );
      for (const flags of [
        ['-lossless'],
        ['-q', '20'],
        ['-q', '75'],
        ['-q', '100'],
        ['-q', '75', '-alpha_method', '0'],
        ['-q', '75', '-alpha_filter', 'best'],
      ]) {
        execFileSync('cwebp', ['-quiet', ...flags, input, '-o', webp]);
        execFileSync('dwebp', [webp, '-pam', '-o', pam], {stdio: 'ignore'});
        const refFile = await readFile(pam),
          ref = refFile.subarray(refFile.indexOf('ENDHDR\n') + 7);
        cases++;
        try {
          const d = decodeWebp(await readFile(webp));
          let bad = 0,
            max = 0,
            alphaBad = 0;
          for (let p = 0; p < ref.length; p++) {
            const q = (p & ~3) + [2, 1, 0, 3][p & 3];
            const delta = Math.abs(ref[p] - d.pixels[q]);
            if (delta) {
              bad++;
              max = Math.max(max, delta);
              if ((p & 3) === 3) alphaBad++;
            }
          }
          if (d.width !== w || d.height !== h || bad) {
            failures++;
            console.log(JSON.stringify({w, h, pattern, flags, bad, max, alphaBad}));
          }
        } catch (e) {
          failures++;
          console.log(JSON.stringify({w, h, pattern, flags, error: e.message}));
        }
      }
    }
  }
} finally {
  await rm(dir, {recursive: true, force: true});
}
console.log(JSON.stringify({cases, failures}));
process.exitCode = failures ? 1 : 0;
