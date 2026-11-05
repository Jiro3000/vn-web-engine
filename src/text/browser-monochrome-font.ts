/** Browser rasterization of a TextOut-style monochrome top-down DIB. */
export class BrowserMonochromeFont {
  private readonly cache = new Map<string, Uint8Array>();
  constructor(private readonly decode: (text: string, face?: string) => string) {}
  textOut(request: {
    face: string;
    height: number;
    weight: number;
    cell: number;
    text: string;
  }): Uint8Array {
    const key = JSON.stringify(request),
      cached = this.cache.get(key);
    if (cached) return cached;
    const {cell} = request;
    const canvas = new OffscreenCanvas(cell, cell),
      c = canvas.getContext('2d', {willReadFrequently: true});
    if (!c) throw new Error('Font rasterization unavailable');
    const face = this.decode(request.face).replaceAll('"', '');
    c.font = `${request.weight} ${Math.abs(request.height)}px "${face}", sans-serif`;
    c.textBaseline = 'top';
    c.fillStyle = 'white';
    c.fillRect(0, 0, cell, cell);
    c.fillStyle = 'black';
    c.fillText(this.decode(request.text, request.face), 0, 0);
    const rgba = c.getImageData(0, 0, cell, cell).data,
      bits = new Uint8Array((cell * cell) / 8).fill(255);
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++)
        if (rgba[(y * cell + x) * 4]! < 128) bits[y * (cell / 8) + (x >> 3)]! &= ~(128 >> (x & 7));
    this.cache.set(key, bits);
    return bits;
  }
}
