import type {ByteSource} from '../../core/source.js';

const bmpHeaderSize = 54;

export function encodeCaptureBmp(image: ImageData, flags: readonly number[]): Uint8Array {
  const {width, height, data} = image;
  const imageEnd = bmpHeaderSize + data.length;
  const output = new Uint8Array(imageEnd + flags.length * 4);
  const header = new DataView(output.buffer);
  // 1.1.102.1 0x5fde70 writes a top-down, 32-bit BMP. Its file size field
  // points to the end of the image, before the flags appended at 0x63629b.
  header.setUint16(0, 0x4d42, true);
  header.setUint32(2, imageEnd, true);
  header.setUint32(10, bmpHeaderSize, true);
  header.setUint32(14, 40, true);
  header.setInt32(18, width, true);
  header.setInt32(22, -height, true);
  header.setUint16(26, 1, true);
  header.setUint16(28, 32, true);
  for (let index = 0; index < data.length; index += 4) {
    output[bmpHeaderSize + index] = data[index + 2]!;
    output[bmpHeaderSize + index + 1] = data[index + 1]!;
    output[bmpHeaderSize + index + 2] = data[index]!;
    output[bmpHeaderSize + index + 3] = data[index + 3]!;
  }
  for (let index = 0; index < flags.length; index++) {
    header.setInt32(imageEnd + index * 4, flags[index]!, true);
  }
  return output;
}

export async function readCaptureBmpFlags(
  source: ByteSource,
  count: number,
  signal?: AbortSignal,
): Promise<number[]> {
  if (count <= 0 || source.size < bmpHeaderSize) return [];
  const prefix = await source.read(0, bmpHeaderSize, signal);
  const header = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  if (header.getUint16(0, true) !== 0x4d42) return [];
  const imageEnd = header.getUint32(2, true);
  const pixelStart = header.getUint32(10, true);
  const dibSize = header.getUint32(14, true);
  if (dibSize < 40 || pixelStart < 14 + dibSize || imageEnd <= pixelStart || imageEnd > source.size)
    return [];
  const length = Math.min(count, Math.floor((source.size - imageEnd) / 4));
  if (!length) return [];
  const bytes = await source.read(imageEnd, length * 4, signal);
  const flags = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({length}, (_, index) => flags.getInt32(index * 4, true));
}

function blendMode(mode: string): GlobalCompositeOperation {
  switch (mode) {
    case 'plus-lighter':
      return 'lighter';
    case 'multiply':
    case 'screen':
      return mode;
    default:
      return 'source-over';
  }
}

function insetBounds(clip: string, rect: DOMRect): [number, number, number, number] | undefined {
  const match = /^inset\(([-.0-9px% ]+)\)$/.exec(clip);
  if (!match) return;
  const edges = match[1]!.split(/ +/);
  const [top, right = top, bottom = top, left = right] = edges;
  const pixels = (edge: string, size: number): number =>
    Number.parseFloat(edge) * (edge.endsWith('%') ? size / 100 : 1);
  const x = pixels(left!, rect.width);
  const y = pixels(top!, rect.height);
  return [
    rect.left + x,
    rect.top + y,
    Math.max(0, rect.width - x - pixels(right!, rect.width)),
    Math.max(0, rect.height - y - pixels(bottom!, rect.height)),
  ];
}

/** Render the displayed game layers in stage coordinates before reducing the thumbnail. */
export function captureLayers(
  width: number,
  height: number,
  bounds: DOMRect,
  layers: readonly HTMLElement[],
  substitute?: {target: HTMLCanvasElement; image: HTMLCanvasElement; bounds: DOMRect},
  offsetX = 0,
  offsetY = 0,
  include?: (element: HTMLElement) => boolean,
): HTMLCanvasElement {
  const left = bounds.left - offsetX * bounds.width / width;
  const top = bounds.top - offsetY * bounds.height / height;
  const createSurface = () => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.setTransform(
      width / bounds.width,
      0,
      0,
      height / bounds.height,
      (-left * width) / bounds.width,
      (-top * height) / bounds.height,
    );
    return context;
  };
  const result = createSurface();
  result.fillStyle = 'black';
  result.fillRect(left, top, bounds.width, bounds.height);

  const draw = (context: CanvasRenderingContext2D, element: HTMLElement): void => {
    if (include && !include(element)) return;
    if (element === substitute?.target) {
      const {left, top, width, height} = substitute.bounds;
      context.drawImage(substitute.image, left, top, width, height);
      return;
    }
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const opacity = Number(style.opacity);
    if (!opacity) return;
    const blend = blendMode(style.mixBlendMode);
    const rect = element.getBoundingClientRect();
    const clip = insetBounds(style.clipPath, rect);
    context.save();
    if (style.overflow === 'hidden' || style.overflow === 'clip') {
      context.beginPath();
      context.rect(rect.left, rect.top, rect.width, rect.height);
      context.clip();
    }
    if (clip) {
      context.beginPath();
      context.rect(...clip);
      context.clip();
    }
    const drawContents = (target: CanvasRenderingContext2D): void => {
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        target.fillStyle = style.backgroundColor;
        target.fillRect(rect.left, rect.top, rect.width, rect.height);
      }
      if (element instanceof HTMLCanvasElement) {
        if (rect.width && rect.height)
          target.drawImage(element, rect.left, rect.top, rect.width, rect.height);
      } else {
        for (const child of element.children) if (child instanceof HTMLElement) draw(target, child);
      }
    };
    if (opacity < 1 || blend !== 'source-over' || style.filter !== 'none') {
      const group = createSurface();
      drawContents(group);
      context.globalAlpha = opacity;
      context.globalCompositeOperation = blend;
      context.filter = style.filter;
      context.drawImage(group.canvas, left, top, bounds.width, bounds.height);
    } else drawContents(context);
    context.restore();
  };
  for (const layer of layers) draw(result, layer);
  return result.canvas;
}
