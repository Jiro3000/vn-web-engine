import type {ByteSource} from '../../core/source.js';
import {PfsArchive, pfsPathKey, type PfsEntry} from '../../formats/artemis/pfs.js';

export type ArtemisFileLookup = (
  segments: readonly string[],
) => ByteSource | undefined | Promise<ByteSource | undefined>;
function segments(path: string): string[] {
  const parts = pfsPathKey(path).split('/');
  if (
    !path ||
    parts.some((p) => !p || p === '.' || p === '..' || p.includes(':') || p.includes('\0'))
  )
    throw new Error(`Unsupported installation-relative Artemis path ${path}`);
  return parts;
}

/** Loose-first resolution, numeric overlays and installation-relative native magic paths. */
export class ArtemisFiles {
  readonly archives: {readonly name: string; readonly archive: PfsArchive}[] = [];
  private readonly magicPaths = new Map<string, string>();
  private readonly entries = new Map<string, {archive: PfsArchive; entry: PfsEntry}>();
  private constructor(private readonly lookup: ArtemisFileLookup) {}

  static async mount(basePath: string, lookup: ArtemisFileLookup): Promise<ArtemisFiles> {
    segments(basePath);
    const files = new ArtemisFiles(lookup);
    for (let i = -1; i < 1000; i++) {
      const name = i < 0 ? basePath : `${basePath}.${String(i).padStart(3, '0')}`;
      const source = await lookup(segments(name));
      if (!source) {
        if (i < 0) throw new Error(`Missing Artemis base archive ${basePath}`);
        continue;
      }
      const archive = await PfsArchive.open(source);
      files.archives.push({name, archive});
      for (const entry of archive.entries)
        files.entries.set(pfsPathKey(entry.name), {archive, entry});
    }
    return files;
  }

  /** CLua 0x14012fa10: update one alias; an empty root deletes it. */
  setMagicPath(name: string, root: string): void {
    if (name.includes('\0') || root.includes('\0'))
      throw new Error('Unsupported Artemis magic path NUL');
    if (!root) {
      this.magicPaths.delete(name);
      return;
    }
    segments(root);
    this.magicPaths.set(name, pfsPathKey(root));
  }
  /** CArtemisPackFile 0x1401193d0 applies a single literal substitution before base lookup. */
  resolvePath(path: string): string {
    if (path.startsWith(':')) {
      const delimiter = path.slice(1).search(/[\\/]/);
      const end = delimiter < 0 ? path.length : delimiter + 1;
      const name = path.slice(1, end);
      const root = this.magicPaths.get(name);
      // Native reports success without opening for unknown/empty aliases. This
      // stateless ByteSource interface cannot represent a stale/unopened native handle.
      if (!name || root === undefined) throw new Error(`Unsupported Artemis magic path ${path}`);
      path = root + path.slice(end);
    }
    path = pfsPathKey(path);
    segments(path.endsWith('/') ? path.slice(0, -1) : path);
    return path;
  }
  async open(path: string): Promise<ByteSource | null> {
    path = this.resolvePath(path);
    if (path.endsWith('/')) return null;
    const loose = await this.lookup(segments(path));
    if (loose !== undefined) return loose;
    const found = this.entries.get(pfsPathKey(path));
    return found ? found.archive.entrySource(found.entry) : null;
  }

  /** Plain CFile namespace: no archive lookup or CArtemisPackFile magic aliases. */
  async readPlain(path: string): Promise<Uint8Array | null> {
    const source = await this.lookup(segments(path));
    return source ? source.read(0, source.size) : null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const source = await this.open(path);
    return source ? source.read(0, source.size) : null;
  }
}
