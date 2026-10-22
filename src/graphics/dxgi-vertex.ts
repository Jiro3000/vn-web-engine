/** Typed IA formats used by the native D3D11 input path. */
export interface DxgiVertexFormat {
  readonly bytes: number;
  readonly alignment: number;
  readonly components: number;
}
const float2: DxgiVertexFormat = Object.freeze({bytes: 8, alignment: 4, components: 2});
const float3: DxgiVertexFormat = Object.freeze({bytes: 12, alignment: 4, components: 3});
const bgra8: DxgiVertexFormat = Object.freeze({bytes: 4, alignment: 1, components: 4});

export function dxgiVertexFormat(format: number): DxgiVertexFormat | null {
  return format === 16 ? float2 : format === 6 ? float3 : format === 87 ? bgra8 : null;
}

/** Read one in-bounds element into a caller-owned float4. Missing components are0,0,0,1. */
export function readDxgiVertexElement(
  format: number,
  data: DataView,
  offset: number,
  output: Float32Array,
  destination: number,
): void {
  const spec = dxgiVertexFormat(format);
  if (!spec) throw new Error(`Unsupported DXGI vertex format ${format}`);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > data.byteLength - spec.bytes ||
    !Number.isSafeInteger(destination) ||
    destination < 0 ||
    destination > output.length - 4
  )
    throw new RangeError('Invalid DXGI vertex element range');
  if (format === 87) {
    const color = data.getUint32(offset, true);
    output[destination] = ((color >>> 16) & 255) / 255;
    output[destination + 1] = ((color >>> 8) & 255) / 255;
    output[destination + 2] = (color & 255) / 255;
    output[destination + 3] = (color >>> 24) / 255;
  } else {
    output[destination] = data.getFloat32(offset, true);
    output[destination + 1] = data.getFloat32(offset + 4, true);
    output[destination + 2] = format === 6 ? data.getFloat32(offset + 8, true) : 0;
    output[destination + 3] = 1;
  }
}
