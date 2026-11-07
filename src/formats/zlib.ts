/**
 * The zlib stream format (RFC 1950) through the browser's CompressionStream 'deflate'. The
 * compression level is the browser's; any conforming inflater reads the output.
 */

/** The inflated bytes; a malformed stream rejects. */
export async function zlibUncompress(bytes: Uint8Array): Promise<Uint8Array> {
  return transform(bytes, new DecompressionStream('deflate'));
}

/** Bytes written in order, such as a stream being inflated, readable as their prefix fills. */
export interface ProgressiveBytes {
  /** The full-size buffer; bytes past the written prefix are still zero. */
  readonly bytes: Uint8Array;
  /** Resolves once bytes [0, end) are written; rejects if the stream fails first. */
  until(end: number): Promise<void>;
}

const written = Promise.resolve();

/** Bytes that are already complete. */
export function completeBytes(bytes: Uint8Array): ProgressiveBytes {
  return {bytes, until: () => written};
}

/**
 * Inflates a zlib stream of known output size, reading its `storedSize` bytes in `chunk`-byte
 * pieces, so that a reader of the start need not wait for the whole stream. A malformed
 * stream or a different inflated size rejects every pending and later `until`.
 */
export function zlibUncompressProgressive(
  read: (offset: number, length: number) => Promise<Uint8Array>,
  storedSize: number,
  size: number,
  chunk = 512 * 1024,
): ProgressiveBytes {
  const bytes = new Uint8Array(size);
  let filled = 0,
    failure: unknown = null,
    waiters: {end: number; resolve: () => void; reject: (e: unknown) => void}[] = [];
  const wake = (): void => {
    waiters = waiters.filter((w) => {
      if (failure !== null) w.reject(failure);
      else if (w.end <= filled) w.resolve();
      else return true;
      return false;
    });
  };
  const fail = (e: unknown): void => {
    if (failure === null) failure = e ?? new Error('zlib stream failed');
    wake();
  };
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter(),
    reader = stream.readable.getReader();
  void (async () => {
    for (let at = 0; at < storedSize && failure === null; at += chunk)
      await writer.write(
        (await read(at, Math.min(chunk, storedSize - at))) as Uint8Array<ArrayBuffer>,
      );
    await writer.close();
  })().catch((e: unknown) => {
    fail(e);
    void writer.abort(e).catch(() => {});
  });
  void (async () => {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (filled + value.length > size) throw new Error(`zlib: inflated more than ${size} bytes`);
      bytes.set(value, filled);
      filled += value.length;
      wake();
    }
    if (filled !== size) throw new Error(`zlib: inflated ${filled} bytes, expected ${size}`);
  })().catch((e: unknown) => {
    fail(e);
    void reader.cancel(e).catch(() => {});
  });
  return {
    bytes,
    until(end) {
      if (end <= filled) return written;
      if (failure !== null) return Promise.reject(failure);
      if (end > size) return Promise.reject(new RangeError(`zlib: ${end} > ${size} bytes`));
      return new Promise((resolve, reject) => {
        waiters.push({end, resolve, reject});
      });
    },
  };
}

/** A zlib stream that inflates to `bytes`. */
export async function zlibCompress(bytes: Uint8Array): Promise<Uint8Array> {
  return transform(bytes, new CompressionStream('deflate'));
}

async function transform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const output = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}
