import {dxgiVertexByteAddress, fetchDxgiVertexElement} from '../../../graphics/dxgi-vertex.js';
import type {D3d11DeviceOwner} from './com.js';
import type {D3d11InputLayout} from './input-layout.js';
import type {D3d11Buffer} from './resources.js';

const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
interface Element {
  readonly format: number;
  readonly target: number;
  readonly data: DataView;
  readonly offset: number;
  readonly stride: number;
  readonly relative: number;
  readonly instance: boolean;
}

/** A borrowed draw-time view. The immediate context retains its buffers for the whole draw. */
export class D3d11VertexReader {
  private readonly elements: readonly Element[];
  readonly floatsPerVertex: number;

  constructor(
    owner: D3d11DeviceOwner,
    layout: D3d11InputLayout,
    registers: readonly number[],
    buffers: readonly (D3d11Buffer | null)[],
    strides: readonly number[],
    offsets: readonly number[],
  ) {
    if (
      !layout.live ||
      layout.lifetime !== owner.lifetime ||
      registers.length > 16 ||
      new Set(registers).size !== registers.length ||
      registers.some((r) => !uint(r) || r >= 32)
    )
      throw new Error('Invalid D3D11 input assembler layout');
    const targets = new Map(registers.map((r, i) => [r, i * 4])),
      views = new Map<number, DataView>();
    const elements: Element[] = [];
    for (const e of layout.elements) {
      if (e.register === null || !targets.has(e.register)) continue;
      const buffer = buffers[e.inputSlot] ?? null,
        stride = strides[e.inputSlot],
        offset = offsets[e.inputSlot];
      if (!uint(stride!) || stride! > 2048 || !uint(offset!))
        throw new Error('Invalid D3D11 vertex stream bounds');
      if (!buffer)
        throw new Error('Unbound D3D11 vertex streams are outside the supported input subset');
      if (
        !buffer.live ||
        buffer.lifetime !== owner.lifetime ||
        !(buffer.getDesc().bindFlags & 1) ||
        buffer.levels[0]!.mapped
      )
        throw new Error('Invalid D3D11 vertex stream');
      let data = views.get(e.inputSlot);
      if (!data) {
        const bytes = buffer.levels[0]!.bytes;
        views.set(
          e.inputSlot,
          (data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
        );
      }
      elements.push({
        format: e.format,
        target: targets.get(e.register)!,
        data,
        offset: offset!,
        stride: stride!,
        relative: e.offset,
        instance: e.inputSlotClass === 1,
      });
    }
    if (registers.some((r) => !layout.elements.some((e) => e.register === r)))
      throw new Error('Missing D3D11 vertex input');
    this.elements = elements;
    this.floatsPerVertex = registers.length * 4;
  }

  /** Draw/DrawIndexed use instance0. Each supported input register receives one full float4. */
  read(vertex: number, output: Float32Array, destination = 0): void {
    if (
      !uint(vertex) ||
      !Number.isSafeInteger(destination) ||
      destination < 0 ||
      destination > output.length - this.floatsPerVertex
    )
      throw new RangeError('Invalid D3D11 vertex read');
    for (const e of this.elements) {
      const address = dxgiVertexByteAddress(
        e.offset,
        e.stride,
        e.instance ? 0 : vertex,
        e.relative,
      );
      fetchDxgiVertexElement(e.format, e.data, address, e.offset, output, destination + e.target);
    }
  }
}

/** Native16/32-bit index reads, with wrapping addresses and zero out-of-bounds values. */
export class D3d11IndexReader {
  private readonly data: DataView;
  private readonly width: number;
  constructor(
    owner: D3d11DeviceOwner,
    buffer: D3d11Buffer,
    format: number,
    private readonly offset: number,
  ) {
    if (
      !buffer.live ||
      buffer.lifetime !== owner.lifetime ||
      !(buffer.getDesc().bindFlags & 2) ||
      buffer.levels[0]!.mapped ||
      ![42, 57].includes(format) ||
      !uint(offset) ||
      offset % (format === 42 ? 4 : 2)
    )
      throw new Error('Invalid D3D11 index stream');
    const bytes = buffer.levels[0]!.bytes;
    this.data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.width = format === 42 ? 4 : 2;
  }
  read(index: number): number {
    if (!uint(index)) throw new RangeError('Invalid D3D11 index read');
    const address = (this.offset + Math.imul(index, this.width)) >>> 0;
    if (address < this.offset || address > this.data.byteLength - this.width) return 0;
    return this.width === 4
      ? this.data.getUint32(address, true)
      : this.data.getUint16(address, true);
  }
}
