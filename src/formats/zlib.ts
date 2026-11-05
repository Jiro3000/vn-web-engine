/**
 * The zlib stream format (RFC 1950) through the browser's CompressionStream 'deflate'. The
 * compression level is the browser's; any conforming inflater reads the output.
 */

/** The inflated bytes; a malformed stream rejects. */
export async function zlibUncompress(bytes: Uint8Array): Promise<Uint8Array> {
  return transform(bytes, new DecompressionStream('deflate'));
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
