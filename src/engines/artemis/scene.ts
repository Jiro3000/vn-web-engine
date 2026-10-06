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
class Node<T> {
  private current: Child<T>[] = [];
  private retained = this.current;
  private currentValue: T | undefined;
  private retainedValue: T | undefined;
  constructor(
    value: T | undefined,
    readonly acceptsChildren = true,
  ) {
    this.currentValue = this.retainedValue = value;
  }
  value(view: ArtemisSceneView): T | undefined {
    return view === 'current' ? this.currentValue : this.retainedValue;
  }
  edit(copy: (value: T) => T): T | undefined {
    if (this.currentValue !== undefined && this.currentValue === this.retainedValue)
      this.currentValue = copy(this.currentValue);
    return this.currentValue;
  }
  children(view: ArtemisSceneView): readonly Child<T>[] {
    return view === 'current' ? this.current : this.retained;
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
    const index = this.index(key, this.current);
    const exists = index < this.current.length && compare(this.current[index]!.key, key) === 0;
    if (!node && !exists) return false;
    if (this.current === this.retained) this.current = this.current.map((entry) => ({...entry}));
    if (!node) this.current.splice(index, 1);
    else if (exists) this.current[index]!.node = node;
    else this.current.splice(index, 0, {key, node});
    return true;
  }
  commit(): void {
    for (const entry of this.current) entry.node.commit();
    this.retained = this.current;
    this.retainedValue = this.currentValue;
  }
}

/** UTF-8 subset of CLayerSet's hierarchical child maps, independent of raster/geometry owners.
 * Mutation updates current child maps; commit releases the retained structural version.
 */
export class ArtemisScene<T> {
  private readonly root = new Node<T>(undefined);
  constructor(executableSha256: string) {
    artemisRevision(executableSha256);
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
        parent.assign(key, new Node<T>(undefined));
        child = parent.child(key, 'current')!;
      }
      parent = child.node;
    }
    return parent.acceptsChildren && parent.assign(parts.at(-1)!, new Node(value, acceptsChildren));
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
  /** Ordinary inner-actor copy-on-first-edit path, retaining the old payload until commit. */
  editValue(id: string, copy: (value: T) => T): T | undefined {
    let node = this.root;
    for (const key of this.path(id)) {
      if (!node.acceptsChildren) return undefined;
      const child = node.child(key, 'current');
      if (!child) return undefined;
      node = child.node;
    }
    return node.edit(copy);
  }
  /** All payloads held by reachable nodes, including inner retained versions. */
  payloads(): ReadonlySet<T> {
    const result = new Set<T>(),
      visited = new Set<Node<T>>();
    const visit = (node: Node<T>) => {
      if (visited.has(node)) return;
      visited.add(node);
      for (const view of ['current', 'retained'] as const) {
        const value = node.value(view);
        if (value !== undefined) result.add(value);
        for (const child of node.children(view)) visit(child.node);
      }
    };
    visit(this.root);
    return result;
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
  ): void {
    if (!node.acceptsChildren) return;
    for (const child of node.children(view)) {
      const id = prefix + child.key;
      result.push({id, value: child.node.value(view), acceptsChildren: child.node.acceptsChildren});
      this.visit(child.node, id + '.', view, result);
    }
  }
  /** Borrowed payloads in native child order; not the native layer-selection/enumeration API. */
  entries(view: ArtemisSceneView = 'current'): readonly ArtemisSceneEntry<T>[] {
    const result: ArtemisSceneEntry<T>[] = [];
    this.visit(this.root, '', view, result);
    return result;
  }
  commit(): void {
    this.root.commit();
  }
}
