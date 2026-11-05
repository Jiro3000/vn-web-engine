import type {
  WindowsMenuItem,
  WindowsMenusHost,
  WindowsTrayIcon,
} from '../../../platform/windows-menus.js';
import {decodeCp932} from '../../../text/cp932.js';
import {YurisError} from './errors.js';
import type {YurisMachine} from './machine.js';
import {LookupMode, YurisTree, type YurisNode, resolveNodePath} from './nodes.js';
import {type ByteString, cString, i64} from './numbers.js';
import {YurisType} from './variables.js';

/** 0x46BD0C: 0x18-byte menu payload; NAME, E, A, CHECK, CODE. */
export class YurisMenu {
  name: ByteString = '';
  e = 1;
  a = 256;
  check = 0;
  code = 0n;
}
const decode = (s: ByteString) => decodeCp932(Uint8Array.from(s, (c) => c.charCodeAt(0)));

/** MENU 0x448F74; MENUACT 0x449254; MENUEND 0x4493F4; MENUINFO 0x449570. */
export class YurisMenus {
  readonly tree = new YurisTree<YurisMenu>();
  private trayLabel: ByteString = '';
  private shownTrayLabel: ByteString = '';
  private trayIcon: WindowsTrayIcon | null = null;
  private trayItems: readonly WindowsMenuItem[] = [];
  private trayEnabled = false;
  constructor(
    private readonly m: YurisMachine,
    private readonly host: WindowsMenusHost,
  ) {
    // 0x46891C: the menu namespace starts in M0, like S0 for sound.
    this.tree.root.payload = new YurisMenu();
    this.tree.create('M0', true, 1n, new YurisMenu());
    m.define(0x3e, () => this.menu());
    m.define(0x3f, () => this.act());
    m.define(0x40, () => this.end());
    m.define(0x41, () => this.info());
    m.define(0x64, () => this.tray());
  }
  private target(id: ByteString): {
    path: ByteString;
    group: boolean;
    node: YurisNode<YurisMenu> | null;
  } {
    const path = resolveNodePath(this.m.system.names[3]!, cString(id));
    return {
      ...path,
      node: this.tree.lookup(path.path, path.group ? LookupMode.Group : LookupMode.Leaf),
    };
  }
  private readonly select = (code: number): void => {
    // Main-window WM_COMMAND (0x45CEBC): only LOWORD is stored, high word cleared.
    this.m.system.value84 = BigInt(code & 0xffff);
  };
  private menu(): number {
    const m = this.m,
      a = m.args;
    m.decode();
    const {path, group, node: old} = this.target(a.text(0));
    let node = old;
    let z = -1;
    if (a.has(2)) {
      // 0x449021..0x4490CA truncates every result to signed 32 bits, then sign-extends
      // it for the node's 64-bit Z. += wraps without a bound; subtraction, multiplication and division clamp to 1.
      const current = BigInt.asIntN(32, node?.z ?? 1n),
        value = a.int(2),
        op = a.op[a.has(2)]!;
      let result = current;
      if (op === 0) result = value;
      else if (op === 1) result = current + value;
      else if (op === 2) result = i64(current - value);
      else if (op === 3) result = i64(current * value);
      else if (op === 4 && value !== 0n) result = i64(current / value);
      if (op >= 2 && op <= 4 && !(op === 4 && value === 0n) && result < 1n) result = 1n;
      z = Number(BigInt.asIntN(32, result));
      if (node) this.tree.setZ(node, BigInt(z));
    }
    if (!node) {
      if (!a.has(1)) throw new YurisError(0x187a4, [m.commandName(0x3e), path]);
      if (z === -1) throw new YurisError(0x18790, [m.commandName(0x3e)]);
      node = this.tree.create(path, group, BigInt(z), new YurisMenu());
    }
    const d = node.payload!;
    if (a.has(1)) d.name = cString(a.text(1));
    if (a.has(3)) d.e = Number(BigInt.asIntN(8, a.int(3)));
    if (a.has(4)) d.a = Number(BigInt.asIntN(16, a.int(4)));
    if (a.has(5)) d.check = Number(BigInt.asIntN(8, a.int(5)));
    if (a.has(6)) d.code = a.int(6);
    return 0;
  }
  private end(): number {
    this.m.decode();
    const {node} = this.target(this.m.args.text(0));
    if (node) {
      const remove = (n: YurisNode<YurisMenu>) => {
        for (const c of [...n.children]) remove(c);
        this.tree.remove(n);
      };
      remove(node);
    }
    return 0;
  }
  private info(): number {
    const m = this.m,
      a = m.args;
    m.decode();
    const slot = a.has(0),
      id = a.variable[slot]!,
      index = a.variableIndex[slot]!;
    const {node} = this.target(a.text(1)),
      type = m.variables.get(id).type;
    const store = (v: bigint) => (m.setInt(id, index, v), 0);
    if (!node) {
      if (type === YurisType.String) m.setString(id, index, '');
      else m.setInt(id, index, 0n);
      return 0;
    }
    const d = node.payload!;
    if (a.has(3)) return store(1n);
    if (a.has(5)) return store(BigInt(d.e));
    if (a.has(6)) return store(BigInt(d.a));
    if (a.has(4)) return store(node.z);
    if (a.has(7)) return store(BigInt(d.check));
    if (a.has(8)) return store(d.code);
    if (a.has(2) && type === YurisType.String) m.setString(id, index, d.name);
    return 0;
  }
  /** 0x411F91 builds a snapshot in Z order: E hides, A==0 disables, empty NAME separates. */
  private snapshot(
    node: YurisNode<YurisMenu>,
    reserved: number,
  ): readonly WindowsMenuItem[] | null {
    let menus = reserved;
    const build = (n: YurisNode<YurisMenu>): WindowsMenuItem[] | null => {
      if (++menus > 0x7f) return null;
      const out: WindowsMenuItem[] = [];
      for (const c of n.children) {
        const d = c.payload!;
        if (!d.e) continue;
        const nested = !!d.name && c.group && c.children.length > 0;
        const children = nested ? build(c) : undefined;
        if (children === null) return null;
        out.push({
          label: decode(d.name),
          enabled: !!d.name && d.a !== 0,
          checked: d.check === 1,
          code: Number(BigInt.asUintN(32, d.code)),
          ...(children ? {children} : {}),
        });
      }
      return out;
    };
    return build(node);
  }
  private act(): number {
    const m = this.m,
      a = m.args;
    m.decode();
    const {node} = this.target(a.text(0));
    if (node && a.has(1) && a.int(1) === 1n) {
      const items = this.snapshot(node, 1);
      if (items === null) return -1;
      this.host.contextMenu(items, m.input.cursorX, m.input.cursorY, this.select);
    }
    return 0;
  }
  /** WINDOW MENUID (0x4561A8 -> 0x411EA0) destroys the old native menu before rebuilding. */
  windowMenu(no: number, id: ByteString): number {
    if (!id) {
      this.host.setWindowMenu(no, [], this.select);
      return 0;
    }
    const {node} = this.target(id);
    if (!node) throw new YurisError(0x18b82, [this.m.commandName(0x69), id]);
    this.host.setWindowMenu(no, [], this.select);
    const items = this.snapshot(node, 0);
    if (items === null) return -1;
    this.host.setWindowMenu(no, items, this.select);
    return 0;
  }
  /** TRAY 0x452FB4; custom icons are exactly 16x16; Shell_NotifyIcon uses app icon otherwise. */
  private tray(): number {
    const m = this.m,
      a = m.args;
    m.decode();
    let icon: WindowsTrayIcon | null = null;
    if (a.has(2)) {
      const id = a.text(2),
        path = resolveNodePath(m.system.names[0]!, id),
        node = m.layers.tree.lookup(path.path, path.group ? LookupMode.Group : LookupMode.Leaf);
      if (!node) return 0;
      const d = node.payload!;
      if (d.width === 16 && d.height === 16 && d.pixels)
        icon = {width: 16, height: 16, pixels: d.pixels.slice(0, 16 * 16 * 4)};
      else m.messageBox('ICON ERR.\r\nレイヤサイズが 16x16 ではありません。');
    }
    if (a.has(1)) this.trayLabel = cString(a.text(1));
    if (a.has(0)) {
      this.trayEnabled = a.int(0) === 1n;
      if (this.trayEnabled) {
        this.trayIcon = icon;
        this.shownTrayLabel = this.trayLabel;
      }
      this.publishTray();
    }
    if (a.has(3)) {
      const {node} = this.target(a.text(3));
      if (node) {
        const items = this.snapshot(node, 1);
        if (items === null) return -1;
        this.trayItems = items;
        if (this.trayEnabled) this.publishTray();
      }
    }
    return 0;
  }
  private publishTray(): void {
    this.host.setTray(
      this.trayEnabled
        ? {label: decode(this.shownTrayLabel), icon: this.trayIcon, items: this.trayItems}
        : null,
      this.select,
      () => {
        // 0x45D630: left click activates the owner; script handles restoring/minimising it.
        this.m.windows.windows[0]!.active = true;
      },
    );
  }
}
