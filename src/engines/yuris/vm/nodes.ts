import {YurisError} from './errors.js';
import {type ByteString, isLeadByte} from './numbers.js';

/**
 * A node of the CG, task and sound trees (0x48 bytes). Children are kept in Z order (+0
 * first, +4 last, +8/+0xC siblings); the hashed child index (+0x20..+0x30) serves leaf
 * lookups. `payload` is the object at +0x44.
 */
export class YurisNode<T> {
  parent: YurisNode<T> | null = null;
  /** Children in ascending Z; equal Z keeps insertion order. */
  readonly children: YurisNode<T>[] = [];
  /** Leaves by name, newest first (the index inserts before equal hashes). */
  private readonly leaves = new Map<ByteString, YurisNode<T>[]>();

  constructor(
    /** +0x14: the last path component. */
    readonly name: ByteString,
    /** +0x40: group nodes are matched by the group lookups and intermediate path components. */
    readonly group: boolean,
    /** +0x38: Z order among the siblings. */
    public z: bigint,
    public payload: T | null = null,
  ) {}

  /** 0x42C194: links `child` before the first sibling with a greater Z. */
  insert(child: YurisNode<T>): void {
    child.parent = this;
    let at = this.children.findIndex((c) => c.z > child.z);
    if (at < 0) at = this.children.length;
    this.children.splice(at, 0, child);
  }

  /** 0x42C114: unlinks `child` from the Z list. */
  unlink(child: YurisNode<T>): void {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
  }

  /** 0x463AEC: adds a leaf to the hashed index. */
  index(child: YurisNode<T>): void {
    if (child.group) return;
    const list = this.leaves.get(child.name);
    if (list) list.unshift(child);
    else this.leaves.set(child.name, [child]);
  }

  unindex(child: YurisNode<T>): void {
    const list = this.leaves.get(child.name);
    if (!list) return;
    const at = list.indexOf(child);
    if (at >= 0) list.splice(at, 1);
    if (!list.length) this.leaves.delete(child.name);
  }

  /** 0x40CDC0: the first group child named `name`, in Z order. */
  childGroup(name: ByteString): YurisNode<T> | null {
    return this.children.find((c) => c.group && c.name === name) ?? null;
  }

  /** The final component of 0x40CA7D: 0 leaves by index, 1 groups, 2 any node in Z order. */
  child(name: ByteString, mode: LookupMode): YurisNode<T> | null {
    if (mode === LookupMode.Leaf) return this.leaves.get(name)?.[0] ?? null;
    if (mode === LookupMode.Group) return this.childGroup(name);
    return this.children.find((c) => c.name === name) ?? null;
  }

  /** 0x43C230: the child at the 1-based position `at` in Z order. */
  childAt(at: number): YurisNode<T> | null {
    return this.children[Math.max(at, 1) - 1] ?? null;
  }
}

export const enum LookupMode {
  Leaf = 0,
  Group = 1,
  Any = 2,
}

const NON_ASCII = /[^\x00-\x7f]/;

/** Splits at '/', stepping over double-byte characters (lead byte table 0x59B0C0). */
function components(path: ByteString): {dirs: ByteString[]; last: ByteString} {
  if (!path.includes('/')) return {dirs: [], last: path};
  if (!NON_ASCII.test(path)) {
    const dirs = path.split('/');
    return {dirs, last: dirs.pop()!};
  }
  const dirs: ByteString[] = [];
  let start = 0;
  for (let i = 0; i < path.length;) {
    const c = path.charCodeAt(i);
    if (c === 0x2f) {
      dirs.push(path.slice(start, i));
      start = ++i;
    } else i += isLeadByte(c) ? 2 : 1;
  }
  return {dirs, last: path.slice(start)};
}

/** A node tree with a root (0x872414 CG, 0x87241C tasks, 0x872420 sounds, 0x872418). */
export class YurisTree<T> {
  readonly root = new YurisNode<T>('', true, 0n);

  /** 0x40CA7D: intermediate components are groups; the last is matched by `mode`. */
  lookup(path: ByteString, mode: LookupMode): YurisNode<T> | null {
    const {dirs, last} = components(path);
    let node: YurisNode<T> | null = this.root;
    for (const dir of dirs) {
      node = node.childGroup(dir);
      if (!node) return null;
    }
    return node.child(last, mode);
  }

  /** 0x463BD0: the parent group of `path`; error 0x18786 names the missing prefix. */
  parentOf(path: ByteString): YurisNode<T> {
    const {dirs} = components(path);
    let node = this.root,
      prefix = 0;
    for (const dir of dirs) {
      const next = node.childGroup(dir);
      if (!next) throw new YurisError(0x18786, [path.slice(0, prefix + dir.length)]);
      prefix += dir.length + 1;
      node = next;
    }
    return node;
  }

  /** 0x46753D: creates a node under the parent group of `path`. */
  create(path: ByteString, group: boolean, z: bigint, payload: T | null = null): YurisNode<T> {
    const parent = this.parentOf(path);
    const node = new YurisNode<T>(components(path).last, group, z, payload);
    parent.index(node);
    parent.insert(node);
    return node;
  }

  /** 0x42C0C4: changes Z and re-sorts the node among its siblings. */
  setZ(node: YurisNode<T>, z: bigint): void {
    const parent = node.parent;
    node.z = z;
    if (!parent) return;
    parent.unlink(node);
    parent.insert(node);
  }

  /** 0x451AE8 with the index removal: detaches `node` from its parent. */
  remove(node: YurisNode<T>): void {
    const parent = node.parent;
    if (!parent) return;
    parent.unlink(node);
    parent.unindex(node);
    node.parent = null;
  }
}

/** The bytes 0x667EE0 marks as path syntax: '.', '/' and ':'. */
const PATH_SYNTAX = /[./:]/;
const RELATIVE_COMPONENT = /(?:^|\/)\.\.?\//;

/** Whether `text` contains path syntax outside double-byte characters. */
function hasSyntax(text: ByteString): boolean {
  if (!PATH_SYNTAX.test(text)) return false;
  if (!NON_ASCII.test(text)) return true;
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i);
    if (PATH_SYNTAX.test(text[i]!)) return true;
    i += isLeadByte(c) ? 2 : 1;
  }
  return false;
}

/**
 * The node id resolver 0x4573E8. A plain id is appended to the current path. An id with path
 * syntax is absolute after a leading ':' (and ':/'), else relative to the current path (a
 * leading '/' skipped); the result is normalised component by component: "./" components are
 * dropped, "../" removes the previous component, spaces are an error (0x18792) unless
 * `spaces` is set. A trailing '/' marks a group and is stripped.
 */
export function resolveNodePath(
  current: ByteString,
  id: ByteString,
  spaces = false,
): {path: ByteString; group: boolean} {
  if (!hasSyntax(id)) {
    // The plain branch tests the id itself for a trailing '/', which it cannot contain.
    return {path: current ? `${current}/${id}` : id, group: false};
  }
  let source: ByteString;
  if (id.charCodeAt(0) === 0x3a) source = id.charCodeAt(1) === 0x2f ? id.slice(2) : id.slice(1);
  else {
    source = current ? `${current}/` : '';
    source += id.charCodeAt(0) === 0x2f ? id.slice(1) : id;
  }
  if (!source) return {path: '', group: false};
  if (!NON_ASCII.test(source) && !RELATIVE_COMPONENT.test(source)) {
    if (!spaces && source.includes(' ')) throw new YurisError(0x18792, [source]);
    return source.endsWith('/')
      ? {path: source.slice(0, -1), group: true}
      : {path: source, group: false};
  }
  const out: number[] = [];
  let i = 0;
  while (i < source.length) {
    // Separators are copied as they come.
    while (source.charCodeAt(i) === 0x2f) {
      out.push(0x2f);
      i++;
    }
    const start = i;
    while (i < source.length && source.charCodeAt(i) !== 0x2f) {
      const c = source.charCodeAt(i);
      if (c === 0x20 && !spaces) throw new YurisError(0x18792, [source]);
      i += isLeadByte(c) ? 2 : 1;
    }
    if (i < source.length) i++; // the component keeps its '/'
    const component = source.slice(start, i);
    if (component.startsWith('../')) popComponent(out);
    else if (component.startsWith('./')) continue;
    else for (let k = 0; k < component.length; k++) out.push(component.charCodeAt(k));
  }
  let path = String.fromCharCode(...out);
  if (path.endsWith('/')) return {path: path.slice(0, -1), group: true};
  return {path, group: false};
}

/** The "../" walk of 0x4573E8: clears back over two separators and keeps the second. */
function popComponent(out: number[]): void {
  let o = out.length,
    separators = 2;
  for (; o !== 0; o--) {
    if (out[o] === 0x2f) {
      do {
        if (o < 1) break;
        out.length = o;
        o--;
      } while (out[o] === 0x2f);
      if (--separators === 0) {
        out.length = o + 1;
        out.push(0x2f);
        return;
      }
    }
    out.length = Math.min(out.length, o);
  }
  out.length = 0;
}
