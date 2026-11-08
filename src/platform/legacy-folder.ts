import {OverlayFileSystem, SourceFileSystem, FileError} from './filesystem.js';
import type {ByteSource} from '../core/source.js';
import type {RecordStore} from './store.js';

/** A legacy program's writable virtual working folder over read-only installation sources. */
export class LegacyFolder {
  readonly files: OverlayFileSystem;
  private cwd = '/';
  private readonly known = new Set<string>();
  /** Files written through this folder, which the store holds with the same bytes. */
  private readonly written = new Map<string, Uint8Array>();
  constructor(
    sources: ReadonlyMap<string, ByteSource>,
    readonly store: RecordStore,
    private readonly decode: (s: string) => string,
    private readonly encode: (s: string) => string,
  ) {
    const installed = new SourceFileSystem();
    for (const [path, source] of sources) {
      const key = '/' + path.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
      installed.attach(key, source);
      this.known.add(key);
    }
    this.files = new OverlayFileSystem(installed, store, (p) => p.toLowerCase());
  }
  async initialize(): Promise<void> {
    for (const key of (await this.store.snapshot()).keys()) {
      if (key.startsWith('file:')) this.known.add(key.slice(5));
      else if (key.startsWith('tombstone:')) this.known.delete(key.slice(10));
    }
  }
  path(raw: string): string {
    let name = this.decode(raw)
      .replaceAll('\\', '/')
      .replace(/^[a-z]:/i, '');
    if (!name.startsWith('/')) name = this.cwd + '/' + name;
    const parts: string[] = [];
    for (const p of name.split('/'))
      if (p === '..') parts.pop();
      else if (p && p !== '.') parts.push(p);
    return '/' + parts.join('/').toLowerCase();
  }
  existsFile(raw: string): boolean {
    return this.known.has(this.path(raw));
  }
  async stat(raw: string): Promise<{directory: boolean; size: number} | null> {
    try {
      const f = await this.files.stat(this.path(raw));
      return {directory: f.kind === 'directory', size: f.size};
    } catch (e) {
      if (e instanceof FileError && e.code === 'NOT_FOUND') return null;
      throw e;
    }
  }
  async createDirectory(raw: string): Promise<void> {
    await this.files.installDirectories([this.path(raw)]);
  }
  async readFile(raw: string): Promise<Uint8Array | null> {
    // Every file this folder can hold is known (installed, stored before `initialize`, or
    // written here), so a miss needs no store snapshot.
    const path = this.path(raw);
    if (!this.known.has(path)) return null;
    // A program that rewrites a file reads it back without a store snapshot.
    const own = this.written.get(path);
    if (own) return own.slice();
    try {
      const s = await this.files.open(path);
      return await s.read(0, s.size);
    } catch (e) {
      if (e instanceof FileError && ['NOT_FOUND', 'IS_DIRECTORY'].includes(e.code)) return null;
      throw e;
    }
  }
  async writeFile(raw: string, data: Uint8Array): Promise<void> {
    const path = this.path(raw),
      contents = data.slice();
    this.written.delete(path);
    await this.files.commit([{kind: 'write', path, data: contents}]);
    this.known.add(path);
    this.written.set(path, contents);
  }
  async appendFile(raw: string, data: Uint8Array): Promise<void> {
    const before = (await this.readFile(raw)) ?? new Uint8Array();
    const joined = new Uint8Array(before.length + data.length);
    joined.set(before);
    joined.set(data, before.length);
    await this.writeFile(raw, joined);
  }
  async copyFile(from: string, to: string): Promise<void> {
    const bytes = await this.readFile(from);
    if (!bytes) throw new FileError('NOT_FOUND', this.path(from));
    await this.writeFile(to, bytes);
  }
  async deleteFile(raw: string): Promise<void> {
    this.written.delete(this.path(raw));
    if (await this.stat(raw)) await this.files.commit([{kind: 'delete', path: this.path(raw)}]);
    this.known.delete(this.path(raw));
  }
  async removeDirectory(raw: string): Promise<void> {
    const path = this.path(raw);
    try {
      if ((await this.files.list(path)).length) return;
    } catch {
      return;
    }
    await this.store.update((records) => {
      records.delete('directory:' + path);
    });
  }
  async list(raw: string): Promise<readonly {name: string; directory: boolean}[] | null> {
    try {
      return [
        {name: '.', directory: true},
        {name: '..', directory: true},
        ...(await this.files.list(this.path(raw))).map((f) => ({
          name: this.encode(f.path.slice(f.path.lastIndexOf('/') + 1)),
          directory: f.kind === 'directory',
        })),
      ];
    } catch (e) {
      if (e instanceof FileError) return null;
      throw e;
    }
  }
  async setCurrentDirectory(raw: string): Promise<void> {
    const f = await this.stat(raw);
    if (f?.directory) this.cwd = this.path(raw);
  }
}
