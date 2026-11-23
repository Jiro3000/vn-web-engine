interface ObjectTextRun {
  text: string;
  x: number;
  y: number;
  size: number;
  color?: number;
}

interface ObjectTextLayout {
  size: number;
  spaceX?: number;
  spaceY?: number;
  maxChars?: number;
  color?: number;
}

/** Lay out object strings using the control codes in 1.1.102.1 at 0x5ccde0. */
export function layoutObjectText(value: string, format: ObjectTextLayout): ObjectTextRun[] {
  const runs: ObjectTextRun[] = [];
  const maxUnits = 2 * (format.maxChars ?? 0);
  const spaceX = format.spaceX ?? 0;
  const spaceY = format.spaceY ?? 0;
  let size = format.size;
  let color = format.color;
  let x = 0;
  let y = 0;
  let units = 0;
  let run: ObjectTextRun | undefined;
  const nextLine = () => {
    x = units = 0;
    y += size + spaceY;
    run = undefined;
  };
  for (const [token, number, control] of value.matchAll(/##|#D|#([+-]?\d+)(RX|RY|[CSXY])|\r\n?|\n|[\s\S]/gu)) {
    if (token === '#D' || token === '\n' || token.startsWith('\r')) {
      nextLine();
      continue;
    }
    if (control) {
      const argument = Number(number) | 0;
      if (control === 'C') color = argument;
      else if (control === 'S') size = argument;
      else if (control === 'RX') x += argument;
      else if (control === 'RY') y += argument;
      else if (control === 'X') x = argument;
      else y = argument;
      run = undefined;
      continue;
    }
    const character = token === '##' ? '#' : token;
    const cp = character.codePointAt(0)!;
    const advance = cp <= 0x7f || (cp >= 0xff61 && cp <= 0xff9f) ? 1 : 2;
    if (maxUnits > 0 && units > 0 && units + advance > maxUnits) nextLine();
    if (!run) {
      run = {text: '', x, y, size, color};
      runs.push(run);
    }
    run.text += character;
    units += advance;
    x += (advance === 1 ? Math.trunc(size / 2) : size) + spaceX;
  }
  return runs;
}
