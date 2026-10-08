import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';

const encoder = new TextEncoder();
const copy = (tag: AsbTag): AsbTag => ({...tag, args: new Map(tag.args)});

/** Native layer command registry +0x68 and coalescing helper 0x140144570.
 * These are original command arguments, not native save serialization.
 */
export class ArtemisLayerCommands {
  private readonly lists = new Map<string, AsbTag[]>();
  constructor(executableSha256: string) {
    artemisRevision(executableSha256);
  }
  reset(id: string): void {
    this.lists.set(id, []);
  }
  clear(ids: readonly string[]): void {
    for (const id of ids) this.lists.delete(id);
  }
  record(tag: AsbTag, equalKeys: ReadonlySet<string> = new Set()): void {
    // Native find(id) returns without creating a list when the argument is absent.
    if (!tag.args.has('id')) return;
    const id = tag.args.get('id')!;
    let list = this.lists.get(id);
    if (!list) {
      list = [];
      this.lists.set(id, list);
    }
    for (let index = list.length - 1; index >= 0; index--) {
      const old = list[index]!;
      if (old.name !== tag.name) continue;
      if (
        [...equalKeys].some(
          (key) =>
            !old.args.has(key) || !tag.args.has(key) || old.args.get(key) !== tag.args.get(key),
        )
      )
        continue;
      const merged = new Map(old.args);
      for (const [key, value] of tag.args) merged.set(key, value);
      // Native only overwrites the argument map, retaining the earlier line/name.
      list[index] = {...old, args: merged};
      return;
    }
    list.push(copy(tag));
  }
  /** Unconditional append of a command copy to the id's list (find-or-create). */
  append(id: string, tag: AsbTag): void {
    let list = this.lists.get(id);
    if (!list) this.lists.set(id, (list = []));
    list.push(copy(tag));
  }
  /** Native 0x140144960: remove every command with this name whose arguments contain each
   * key/value of `keys`. The id's list is created when absent; nothing is appended. */
  erase(id: string, name: string, keys: ReadonlyMap<string, string>): void {
    const list = this.lists.get(id) ?? [];
    this.lists.set(
      id,
      list.filter(
        (tag) =>
          tag.name !== name ||
          [...keys].some(([key, value]) => !tag.args.has(key) || tag.args.get(key) !== value),
      ),
    );
  }
  commands(id: string): readonly AsbTag[] | undefined {
    return this.lists.get(id)?.map(copy);
  }
  snapshot(): ReadonlyMap<string, readonly AsbTag[]> {
    const entries = [...this.lists].map(([id, tags]) => ({id, tags, bytes: encoder.encode(id)}));
    entries.sort((a, b) => {
      for (let index = 0; index < Math.min(a.bytes.length, b.bytes.length); index++)
        if (a.bytes[index] !== b.bytes[index]) return a.bytes[index]! - b.bytes[index]!;
      return a.bytes.length - b.bytes.length;
    });
    return new Map(entries.map(({id, tags}) => [id, tags.map(copy)]));
  }
}
