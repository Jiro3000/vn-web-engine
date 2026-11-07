import {Ymv} from '../../../formats/yuris/ymv.js';
import type {YurisMachine} from './machine.js';
import type {YurisImageHost, YurisCgNode} from './cg.js';
import {YurisError} from './errors.js';
import {windowsPath} from './fileact.js';
import {YurisFileType} from './files.js';

const YMV = 0x6d,
  YMVEND = 0x6e,
  YMVINFO = 0x6f;

/** The file each movie was opened from, for errors of its progressive read. */
const names = new WeakMap<Ymv, string>();

/** 0x45886C / 0x459274 / 0x4593AC; YMV lifetime belongs to the shared CG object (+0x108). */
export function installYmv(m: YurisMachine, images: YurisImageHost): void {
  const target = (): YurisCgNode => {
    const {path} = m.layers.target(0, 1),
      node = m.layers.lookup(path, false);
    if (!node) throw new YurisError(0x18b82, [m.commandName(m.instruction.command), path]);
    return node;
  };
  m.define(YMV, async () => {
    m.decode();
    const node = target(),
      cg = node.payload;
    if (!cg) return 0;
    const a = m.args;
    if (a.has(2)) {
      const name = windowsPath(a.text(2));
      // The browser host inflates the archived file progressively; native 0x45886C reads it
      // whole. A read that fails later raises the same open error at the frame that needs it.
      let movie: Ymv;
      try {
        movie = await Ymv.open(await m.files.readProgressive(name));
      } catch {
        throw new YurisError(0x1964a, [name]);
      }
      names.set(movie, name);
      cg.ymv = movie;
    }
    if (a.has(3) && cg.ymv) {
      // 0x458B68/0x458C10: decode color JPEG into the layer; JPEG dimensions
      // drive any reallocation. 0x459174 copies grayscale JPEG samples to A.
      const movie = cg.ymv,
        index = Number(BigInt.asIntN(32, a.int(3)));
      try {
        await movie.ready(index);
      } catch {
        throw new YurisError(0x1964a, [names.get(movie) ?? '']);
      }
      let color = await images.decodeYmvFrame?.(movie, index);
      if (!color) {
        const frame = movie.frame(index);
        color = await images.decodeImage(frame.color, YurisFileType.Jpg, '');
        if (movie.alphaMode !== 0 && frame.alpha) {
          const alpha = await images.decodeImage(frame.alpha, YurisFileType.Jpg, '');
          if (alpha.width !== color.width || alpha.height !== color.height)
            throw new Error('YMV: alpha JPEG dimensions differ from color');
          for (let i = 0; i < color.width * color.height; i++)
            color.pixels[i * 4 + 3] = alpha.pixels[i * 4]!;
        }
      }
      m.layers.markDirty(node);
      cg.replace(color.pixels, color.width, color.height);
      cg.masked = movie.alphaMode === 1 ? 1 : 0;
      m.layers.markDirty(node);
    }
    return 0;
  });
  m.define(YMVEND, () => {
    m.decode();
    const cg = target().payload;
    if (cg) cg.ymv = null;
    return 0;
  });
  m.define(YMVINFO, () => {
    m.decode();
    const movie = target().payload?.ymv,
      a = m.args,
      slot = a.has(2);
    let value = 0;
    if (movie) {
      if (a.has(3)) value = movie.count;
      else if (a.has(4)) value = movie.width;
      else if (a.has(5)) value = movie.height;
      else if (a.has(6)) value = movie.fps;
      else return 0;
    }
    m.setInt(a.variable[slot]!, a.variableIndex[slot]!, BigInt(value));
    return 0;
  });
}
