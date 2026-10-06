import {artemisRevision} from './revision.js';

export type ArtemisSceneView = 'current' | 'retained';
export interface ArtemisSceneEntry<T> {
  readonly id: string;
  readonly value: T | undefined;
  readonly acceptsChildren: boolean;
}
const encoder = new TextEncoder();
function integerKey(key: string): number | null {
  // Native 0x1401856c0 accepts a lone minus sign; atoi then yields zero.
  if (!/^-?\d*$/.test(key) || !key) return null;
  const number = key === '-' ? 0 : Number(key);
  if (!Number.isSafeInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis numeric layer id');
  return number;
}
function keyBytes(key: string): Uint8Array {
  if (key.includes('\0') || /[\uD800-\uDFFF]/u.test(key))
    throw new Error('Invalid Artemis UTF-8 layer id');
  // Numeric-looking nonnumeric keys can make the native comparator nontransitive.
  // Refuse this subset rather than substitute Array.sort ordering for the native tree.
  if (integerKey(key) === null && /^[\x2d-\x39]/.test(key))
    throw new Error('Unsupported Artemis mixed numeric layer id');
  return encoder.encode(key);
}
function compare(a: string, b: string): number {
  const left = integerKey(a),
    right = integerKey(b);
  if (left !== null && right !== null) return left < right ? -1 : left > right ? 1 : 0;
  const x = keyBytes(a),
    y = keyBytes(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++)
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
}
interface Child<T> {
  readonly key: string;
  node: Node<T>;
}
class PayloadLifetime<T> {
  readonly references = new Map<T, number>();
  constructor(private readonly released?: (value: T) => void) {}
  retain(value: T | undefined): void {
    if (value !== undefined) this.references.set(value, (this.references.get(value) ?? 0) + 1);
  }
  release(value: T | undefined): void {
    if (value === undefined) return;
    const count = this.references.get(value)! - 1;
    if (count) this.references.set(value, count);
    else {
      this.references.delete(value);
      this.released?.(value);
    }
  }
}
class Node<T> {
  private readonly maps: [Child<T>[], Child<T>[]] = [[], []];
  private readonly values: [T | undefined, T | undefined];
  private currentMap = 0;
  private retainedMap = 0;
  private currentValue = 0;
  private retainedValue = 0;
  private references = 0;
  constructor(
    value: T | undefined,
    readonly acceptsChildren: boolean,
    private readonly lifetime: PayloadLifetime<T>,
  ) {
    this.values = [value, undefined];
    lifetime.retain(value);
  }
  retain(): void {
    this.references++;
  }
  release(): void {
    if (--this.references) return;
    // 0x1400b1860 destroys map slots 1,0 before inner-actor slots 1,0.
    this.clearMap(1);
    this.clearMap(0);
    this.clearValue(1);
    this.clearValue(0);
  }
  private clearMap(index: number): void {
    const entries = this.maps[index]!;
    this.maps[index] = [];
    // Full-map clear 0x1400ec380 / 0x1400f0f70 releases descending keys.
    for (let i = entries.length - 1; i >= 0; i--) entries[i]!.node.release();
  }
  private clearValue(index: number): void {
    const value = this.values[index];
    this.values[index] = undefined;
    this.lifetime.release(value);
  }
  value(view: ArtemisSceneView): T | undefined {
    return this.values[view === 'current' ? this.currentValue : this.retainedValue];
  }
  edit(copy: (value: T) => T, create?: () => T): T | undefined {
    const value = this.value('current');
    if (
      (value !== undefined && this.currentValue === this.retainedValue) ||
      (value === undefined && create)
    ) {
      const replacement = value === undefined ? create!() : copy(value);
      this.currentValue = 1 - this.retainedValue;
      this.values[this.currentValue] = replacement;
      this.lifetime.retain(replacement);
    }
    return this.value('current');
  }
  children(view: ArtemisSceneView): readonly Child<T>[] {
    return this.maps[view === 'current' ? this.currentMap : this.retainedMap]!;
  }
  private index(key: string, entries: readonly Child<T>[]): number {
    let low = 0,
      high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(entries[middle]!.key, key) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  child(key: string, view: ArtemisSceneView): Child<T> | undefined {
    const entries = this.children(view),
      entry = entries[this.index(key, entries)];
    return entry && compare(entry.key, key) === 0 ? entry : undefined;
  }
  assign(key: string, node: Node<T> | null): boolean {
    let entries = this.maps[this.currentMap]!;
    const index = this.index(key, entries);
    const exists = index < entries.length && compare(entries[index]!.key, key) === 0;
    if (!node && !exists) return false;
    if (this.currentMap === this.retainedMap) {
      this.currentMap = 1 - this.retainedMap;
      entries = entries.map((entry) => {
        entry.node.retain();
        return {...entry};
      });
      this.maps[this.currentMap] = entries;
    }
    const old = exists ? entries[index]!.node : undefined;
    node?.retain();
    if (!node) entries.splice(index, 1);
    else if (exists) entries[index]!.node = node;
    else entries.splice(index, 0, {key, node});
    old?.release();
    return true;
  }
  commit(): void {
    // 0x1400b3340 commits current children ascending, then releases its old
    // inner actor before clearing the old child map.
    for (const entry of this.children('current')) entry.node.commit();
    if (this.retainedValue !== this.currentValue) this.clearValue(this.retainedValue);
    if (this.retainedMap !== this.currentMap) this.clearMap(this.retainedMap);
    this.retainedMap = this.currentMap;
    this.retainedValue = this.currentValue;
  }
}

/** UTF-8 subset of CLayerSet's hierarchical child maps, independent of raster/geometry owners.
 * Mutation updates current child maps; commit releases the retained structural version.
 */
export class ArtemisScene<T> {
  private root: Node<T>;
  private readonly lifetime: PayloadLifetime<T>;
  /** Release notifications must only record effects, without throwing or mutating this scene. */
  constructor(executableSha256: string, onPayloadReleased?: (value: T) => void) {
    artemisRevision(executableSha256);
    this.lifetime = new PayloadLifetime(onPayloadReleased);
    this.root = new Node(undefined, true, this.lifetime);
    this.root.retain();
  }
  private path(id: string): string[] {
    const parts = id.split('.');
    if (parts.length > 256) throw new Error('Artemis layer id depth limit exceeded');
    for (const part of parts) keyBytes(part);
    return parts;
  }
  /** Image-backed constructor 0x1400b1690 has type 1; empty groups have type 0. */
  set(id: string, value: T | undefined, acceptsChildren = false): boolean {
    const parts = this.path(id);
    let parent = this.root;
    for (const key of parts.slice(0, -1)) {
      if (!parent.acceptsChildren) return false;
      let child = parent.child(key, 'current');
      if (!child) {
        parent.assign(key, new Node<T>(undefined, true, this.lifetime));
        child = parent.child(key, 'current')!;
      }
      parent = child.node;
    }
    return (
      parent.acceptsChildren &&
      parent.assign(parts.at(-1)!, new Node(value, acceptsChildren, this.lifetime))
    );
  }
  remove(id: string): boolean {
    const parts = this.path(id);
    let parent = this.root;
    for (const key of parts.slice(0, -1)) {
      const child = parent.child(key, 'current');
      if (!parent.acceptsChildren || !child) return false;
      parent = child.node;
    }
    return parent.acceptsChildren && parent.assign(parts.at(-1)!, null);
  }
  entry(id: string, view: ArtemisSceneView = 'current'): ArtemisSceneEntry<T> | undefined {
    let parent = this.root;
    const canonical: string[] = [];
    for (const key of this.path(id)) {
      if (!parent.acceptsChildren) return undefined;
      const child = parent.child(key, view);
      if (!child) return undefined;
      canonical.push(child.key);
      parent = child.node;
    }
    return {
      id: canonical.join('.'),
      value: parent.value(view),
      acceptsChildren: parent.acceptsChildren,
    };
  }
  /** Inner-actor copy on first edit; empty group defaults may be materialized lazily.
   * The retained view keeps its old payload (or default identity) until commit. */
  editValue(id: string, copy: (value: T) => T, createGroup?: () => T): T | undefined {
    let node = this.root;
    for (const key of this.path(id)) {
      if (!node.acceptsChildren) return undefined;
      const child = node.child(key, 'current');
      if (!child) return undefined;
      node = child.node;
    }
    if (createGroup && !node.acceptsChildren)
      throw new Error('Cannot initialize a non-group scene payload');
    return node.edit(copy, createGroup);
  }
  /** All payloads held by reachable nodes, including inner retained versions. */
  payloads(): ReadonlySet<T> {
    return new Set(this.lifetime.references.keys());
  }
  /** Destroy both physical structural buffers in native member order. */
  clear(): void {
    this.root.release();
    this.root = new Node(undefined, true, this.lifetime);
    this.root.retain();
  }
  /** Native 0x140113e50 selects the node and its descendants using the requested prefix.
   * Numeric aliases retain the caller's spelling in the selected identifiers.
   */
  select(id: string): readonly ArtemisSceneEntry<T>[] {
    let node = this.root;
    for (const key of this.path(id)) {
      if (!node.acceptsChildren) return [];
      const child = node.child(key, 'current');
      if (!child) return [];
      node = child.node;
    }
    const result: ArtemisSceneEntry<T>[] = [
      {id, value: node.value('current'), acceptsChildren: node.acceptsChildren},
    ];
    this.visit(node, id + '.', 'current', result);
    return result;
  }
  private visit(
    node: Node<T>,
    prefix: string,
    view: ArtemisSceneView,
    result: ArtemisSceneEntry<T>[],
    reverse = false,
  ): void {
    if (!node.acceptsChildren) return;
    const children = node.children(view);
    for (let index = 0; index < children.length; index++) {
      const child = children[reverse ? children.length - index - 1 : index]!;
      const id = prefix + child.key;
      result.push({id, value: child.node.value(view), acceptsChildren: child.node.acceptsChildren});
      this.visit(child.node, id + '.', view, result, reverse);
    }
  }
  /** Borrowed payloads in native child order; not the native layer-selection/enumeration API. */
  entries(view: ArtemisSceneView = 'current'): readonly ArtemisSceneEntry<T>[] {
    const result: ArtemisSceneEntry<T>[] = [];
    this.visit(this.root, '', view, result);
    return result;
  }
  /** Native 0x1401864a0 draws each group's own actor, then children in descending order. */
  drawEntries(view: ArtemisSceneView = 'retained'): readonly ArtemisSceneEntry<T>[] {
    const result: ArtemisSceneEntry<T>[] = [];
    this.visit(this.root, '', view, result, true);
    return result;
  }
  commit(): void {
    this.root.commit();
  }
}
