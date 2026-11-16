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
): HTMLCanvasElement {
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
      (-bounds.left * width) / bounds.width,
      (-bounds.top * height) / bounds.height,
    );
    return context;
  };
  const result = createSurface();
  result.fillStyle = 'black';
  result.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);

  const draw = (context: CanvasRenderingContext2D, element: HTMLElement): void => {
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
      context.drawImage(group.canvas, bounds.left, bounds.top, bounds.width, bounds.height);
    } else drawContents(context);
    context.restore();
  };
  for (const layer of layers) draw(result, layer);
  return result.canvas;
}
