import {artemisRevision} from './revision.js';
import {ArtemisTextLine, type ArtemisTextLineSnapshot} from './text-line.js';
import type {ArtemisTextBlock} from './text-block.js';

export interface ArtemisWrappingBlock<T> {
  readonly block: ArtemisTextBlock<T>;
  readonly headProhibited: boolean;
  readonly footProhibited: boolean;
}
export interface ArtemisWrappingStyle {
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
  readonly align: 'left' | 'center' | 'right' | 'equalize';
  readonly hung: boolean;
}
interface Line<T> {
  geometry: ArtemisTextLine<T>;
  blocks: ArtemisWrappingBlock<T>[];
  wrapped: boolean;
  y: number;
}
export interface ArtemisWrappedLine<T> {
  readonly geometry: ArtemisTextLineSnapshot<T>;
  readonly y: number;
  readonly wrapped: boolean;
}
const f = Math.fround;
/** 195c10/195ec0/198690 unindented branch. Prohibition flags are supplied by the
 * native block classifier. Indent stacks, vertical display rotation, ownership
 * and glyph-count rollback remain text-layer responsibilities. Do not use this
 * state for a layer with active indentation.
 */
export class ArtemisUnindentedTextWrapping<T> {
  private readonly lines: Line<T>[] = [];
  private readonly style: ArtemisWrappingStyle;
  private hungGuard = false;
  constructor(
    private readonly hash: string,
    style: ArtemisWrappingStyle,
  ) {
    artemisRevision(hash);
    for (const value of [style.width, style.height, style.lineHeight])
      if (!Number.isFinite(value) || !Number.isFinite(f(value)) || value < 0)
        throw Error('Unsupported Artemis wrapping geometry');
    if (!['left', 'center', 'right', 'equalize'].includes(style.align))
      throw Error('Unsupported Artemis wrapping alignment');
    this.style = Object.freeze({
      ...style,
      width: f(style.width),
      height: f(style.height),
      lineHeight: f(style.lineHeight),
    });
    this.newLine(0, false);
  }
  append(value: ArtemisWrappingBlock<T>): 'ok' | 'unprintable' | 'overflow' {
    if (!Number.isFinite(value.block.width) || !Number.isFinite(value.block.height))
      throw Error('Unsupported Artemis wrapping block');
    if (f(value.block.width) > this.style.width) return 'unprintable';
    const snapshot = Object.freeze({...value});
    return this.insert(snapshot, 0) ? 'overflow' : 'ok';
  }
  /** Native explicit newline has no immediate vertical-overflow check. */
  newline(): void {
    this.advance(false);
  }
  private newLine(y: number, wrapped: boolean): Line<T> {
    if (this.lines.length >= 10000) throw Error('Artemis wrapping line budget exceeded');
    const line = {geometry: new ArtemisTextLine<T>(this.hash), blocks: [], wrapped, y};
    this.lines.push(line);
    return line;
  }
  private finalizeLine(line: Line<T>): ArtemisTextLineSnapshot<T> {
    return line.geometry.finalize(this.style.width, this.style.align, this.style.lineHeight);
  }
  private advance(wrapped: boolean): void {
    const line = this.lines[this.lines.length - 1]!;
    const height = this.finalizeLine(line).height;
    this.newLine(f(line.y + height), wrapped);
  }
  private pop(line: Line<T>): ArtemisWrappingBlock<T> {
    line.geometry.pop();
    return line.blocks.pop()!;
  }
  private insert(value: ArtemisWrappingBlock<T>, depth: number): boolean {
    if (depth > 1024) throw Error('Artemis wrapping recursion budget exceeded');
    let line = this.lines[this.lines.length - 1]!;
    if (f(line.geometry.width + f(value.block.width)) <= this.style.width) {
      if (f(line.y + f(value.block.height)) > this.style.height) return true;
      // A prohibited head on any empty noninitial line pulls the previous last block.
      if (this.lines.length > 1 && !line.blocks.length && value.headProhibited) {
        const previous = this.lines[this.lines.length - 2]!;
        if (previous.blocks.length > 1) {
          this.hungGuard = true;
          this.insert(this.pop(previous), depth + 1);
          this.finalizeLine(previous);
          return this.insert(value, depth + 1);
        }
      }
      this.hungGuard = false;
    } else if (
      !value.headProhibited ||
      !this.style.hung ||
      this.hungGuard ||
      line.geometry.width > this.style.width
    ) {
      const moved: ArtemisWrappingBlock<T>[] = [];
      while (line.blocks.length > 1 && line.blocks.at(-1)!.footProhibited)
        moved.unshift(this.pop(line));
      this.advance(true);
      for (const block of moved) this.insert(block, depth + 1);
      return this.insert(value, depth + 1);
    }
    // Native hanging punctuation bypasses the fitting branch's vertical check.
    line = this.lines[this.lines.length - 1]!;
    line.geometry.append(value.block);
    line.blocks.push(value);
    return false;
  }
  finalize(): readonly ArtemisWrappedLine<T>[] {
    return Object.freeze(
      this.lines.map((line) =>
        Object.freeze({geometry: this.finalizeLine(line), y: line.y, wrapped: line.wrapped}),
      ),
    );
  }
}
