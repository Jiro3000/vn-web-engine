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

/** Loose-first resolution and numeric PFS overlays; magic paths/additional packs are not implemented. */
export class ArtemisFiles {
  readonly archives: {readonly name: string; readonly archive: PfsArchive}[] = [];
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

  async open(path: string): Promise<ByteSource | null> {
    const loose = await this.lookup(segments(path));
    if (loose !== undefined) return loose;
    const found = this.entries.get(pfsPathKey(path));
    return found ? found.archive.entrySource(found.entry) : null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const source = await this.open(path);
    return source ? source.read(0, source.size) : null;
  }
}
