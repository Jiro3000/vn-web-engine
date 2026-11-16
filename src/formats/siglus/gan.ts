import {byteDataView, checkRange} from '../../core/binary.js';

export interface GanFrame {
  pattern: number;
  x: number;
  y: number;
  alpha: number;
  duration: number;
}

export function readGan(bytes: Uint8Array): GanFrame[][] {
  const view = byteDataView(bytes);
  let offset = 0;
  const next = () => {
    const value = view.getInt32(offset, true);
    offset += 4;
    return value;
  };
  const invalid = () => new Error('Invalid Siglus GAN');
  if (next() !== 10000 || next() !== 10000) throw invalid();
  let tag = next();
  while (tag === 10100) {
    const length = next();
    checkRange(bytes.length, offset, length);
    offset += length;
    tag = next();
  }
  if (tag !== 20000) throw invalid();
  const count = next();
  checkRange(bytes.length, offset, count * 8);
  const sequences: GanFrame[][] = [];
  for (let sequence = 0; sequence < count; sequence++) {
    if (next() !== 30000) throw invalid();
    const frameCount = next();
    checkRange(bytes.length, offset, frameCount * 4);
    const frames: GanFrame[] = [];
    for (let index = 0; index < frameCount; index++) {
      const frame: GanFrame = {pattern: 0, x: 0, y: 0, alpha: 255, duration: 0};
      for (let field = next(); field !== 999999; field = next()) {
        switch (field) {
          case 30100:
            frame.pattern = next();
            break;
          case 30101:
            frame.x = next();
            break;
          case 30102:
            frame.y = next();
            break;
          case 30103:
            frame.duration = next();
            break;
          case 30104:
            frame.alpha = next() & 255;
            break;
          case 30105:
            next();
            break;
          default:
            throw invalid();
        }
      }
      frames.push(frame);
    }
    sequences.push(frames);
  }
  return sequences;
}
